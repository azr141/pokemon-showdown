/**
 * Plugin Player AI — built-in policies.
 *
 * These are the building blocks a chain composes. Each policy is a small
 * pure function from a context to a Decision (or null to abstain). The two
 * "random" policies match the behavior of the existing RandomPlayerAI and
 * are meant to live at the end of a chain so the chain always terminates.
 *
 * The tactical policies (super-effective move, switch-to-resist) are
 * intentionally simple — they're examples to validate the framework, not
 * production-grade heuristics.
 */

import { toID } from '../../dex';
import type {
	ActionPolicy, ForceSwitchPolicy, TeamPreviewPolicy,
	ActiveContext, ForceSwitchContext, MoveCandidate, SwitchCandidate,
} from './types';
import type { FoePokemon } from './battle-view';

// ----------------------------------------------------------------------
// Random fallback policies (match RandomPlayerAI behavior)
// ----------------------------------------------------------------------

export interface RandomActionOptions {
	/**
	 * Probability of choosing a move over switching when both are available.
	 * Mirrors `move` in RandomPlayerAI. Default: 1.0 (always move).
	 */
	moveRatio?: number;
	/**
	 * Probability of opting into a form change (mega/ultra/dynamax/tera) when
	 * one is available. Mirrors `mega` in RandomPlayerAI. Default: 0.
	 */
	formChangeRatio?: number;
}

/** Random action: matches RandomPlayerAI's move/switch/form-change behavior. */
export function randomAction(opts: RandomActionOptions = {}): ActionPolicy {
	const moveRatio = opts.moveRatio ?? 1.0;
	const formChangeRatio = opts.formChangeRatio ?? 0;
	return (ctx: ActiveContext) => {
		const hasMoves = ctx.moves.length > 0;
		const hasSwitches = ctx.switches.length > 0;
		// Switch decision mirrors RandomPlayerAI: switch if we can and either
		// no moves or PRNG says so.
		if (hasSwitches && (!hasMoves || ctx.prng.random() > moveRatio)) {
			const candidate = ctx.prng.sample(ctx.switches);
			return { kind: 'switch', candidate };
		}
		if (!hasMoves) return null;

		// Pick a regular (non-max) move so we don't double-count maxMove variants.
		// Form changes are decided separately.
		const regular = ctx.moves.filter(m => !m.maxMove && !m.zMove);
		const movePool = regular.length ? regular : ctx.moves;
		const candidate = ctx.prng.sample(movePool);

		const wantFormChange = (ctx.canMega || ctx.canUltra || ctx.canDynamax || ctx.canTerastallize) &&
			ctx.prng.random() < formChangeRatio;
		let formChange: import('./types').FormChange | undefined;
		if (wantFormChange) {
			// Preference order mirrors RandomPlayerAI: tera, dynamax, mega, ultra.
			if (ctx.canTerastallize) formChange = 'terastallize';
			else if (ctx.canDynamax) formChange = 'dynamax';
			else if (ctx.canMega) formChange = 'mega';
			else if (ctx.canUltra) formChange = 'ultra';
		}

		// Targeting: in doubles, pick a random foe slot for normal/any/adjacentFoe.
		let targetLoc: number | undefined;
		const isMulti = ctx.request.active.length > 1;
		if (isMulti) {
			if (['normal', 'any', 'adjacentFoe'].includes(candidate.target)) {
				targetLoc = 1 + ctx.prng.random(2);
			} else if (candidate.target === 'adjacentAlly') {
				targetLoc = -((ctx.activeIndex ^ 1) + 1);
			} else if (candidate.target === 'adjacentAllyOrSelf') {
				const allies = ctx.request.side.pokemon;
				const hasAlly = allies.length > 1 && !allies[ctx.activeIndex ^ 1]?.condition.endsWith(' fnt');
				targetLoc = hasAlly ? -(1 + ctx.prng.random(2)) : -(ctx.activeIndex + 1);
			}
		}

		return { kind: 'move', candidate, targetLoc, formChange };
	};
}

/** Random forced-switch: pick a uniformly random legal switch target. */
export const randomForceSwitch: ForceSwitchPolicy = (ctx: ForceSwitchContext) => {
	if (!ctx.switches.length) return null;
	const candidate = ctx.prng.sample(ctx.switches);
	return { kind: 'switch', candidate };
};

/** Default team preview: send team as-is (`default`). */
export const defaultTeamPreview: TeamPreviewPolicy = () => 'default';

// ----------------------------------------------------------------------
// Tactical example policies
// ----------------------------------------------------------------------

/**
 * Effectiveness multiplier for `moveType` against `targetTypes` using the
 * dex's type chart. Returns 0 for immunity, otherwise 0.25/0.5/1/2/4 etc.
 */
function typeMultiplier(dex: import('../../dex').ModdedDex, moveType: string, targetTypes: readonly string[]): number {
	if (!dex.getImmunity(moveType, targetTypes as string[])) return 0;
	const eff = dex.getEffectiveness(moveType, targetTypes as string[]);
	return Math.pow(2, eff);
}

/** Types a foe is effectively typed as right now (accounts for tera). */
function effectiveTypes(foe: FoePokemon, dex: import('../../dex').ModdedDex): readonly string[] {
	if (foe.terastallized) {
		// Capitalize: type ids are lowercase in our store but the chart keys
		// expect 'Water', 'Fire' etc.
		const t = String(foe.terastallized);
		return [t.charAt(0).toUpperCase() + t.slice(1)];
	}
	const species = dex.species.get(foe.speciesId);
	return species?.types ?? [];
}

/**
 * Returns a damaging move that is super-effective against the current foe,
 * if one exists. Abstains otherwise. STAB is preferred as a soft tiebreaker.
 */
export const superEffectiveMove: ActionPolicy = (ctx: ActiveContext) => {
	const foe = ctx.view.primaryFoe();
	if (!foe) return null;
	const foeTypes = effectiveTypes(foe, ctx.dex);
	if (!foeTypes.length) return null;

	const ourSpecies = ctx.dex.species.get(toID(ctx.pokemon.details.split(',')[0]));
	const ourTypes = ourSpecies?.types ?? [];

	let best: { candidate: MoveCandidate, score: number } | null = null;
	for (const cand of ctx.moves) {
		const move = ctx.dex.moves.get(cand.raw.id ?? toID(cand.move));
		if (!move?.exists) continue;
		if (move.category === 'Status') continue;
		const mult = typeMultiplier(ctx.dex, move.type, foeTypes);
		if (mult <= 1) continue; // not super effective
		const stab = ourTypes.includes(move.type) ? 1.5 : 1;
		const score = mult * stab * (move.basePower || 60);
		if (!best || score > best.score) best = { candidate: cand, score };
	}
	if (!best) return null;
	return { kind: 'move', candidate: best.candidate };
};

/**
 * If our active pokemon is hit super-effectively by any of the foe's
 * revealed moves, look for a bench pokemon that resists or is immune to all
 * of those moves. Abstains if there's nothing on the bench that fits, or if
 * the foe hasn't revealed any threatening moves yet.
 */
export const switchToResist: ActionPolicy = (ctx: ActiveContext) => {
	if (!ctx.switches.length) return null;
	const foe = ctx.view.primaryFoe();
	if (!foe) return null;
	if (!foe.revealedMoves.length) return null;

	const ourSpecies = ctx.dex.species.get(toID(ctx.pokemon.details.split(',')[0]));
	const ourTypes = ourSpecies?.types ?? [];

	// Identify threatening attacks (super-effective damaging moves).
	const threats: { moveType: string }[] = [];
	for (const id of foe.revealedMoves) {
		const move = ctx.dex.moves.get(id);
		if (!move?.exists) continue;
		if (move.category === 'Status') continue;
		const mult = typeMultiplier(ctx.dex, move.type, ourTypes);
		if (mult > 1) threats.push({ moveType: move.type });
	}
	if (!threats.length) return null;

	// Score each bench pokemon by aggregate resistance to the threats. Lower
	// total multiplier is better; immunities count as 0.
	let best: { candidate: SwitchCandidate, score: number } | null = null;
	for (const sw of ctx.switches) {
		const species = ctx.dex.species.get(toID(sw.pokemon.details.split(',')[0]));
		if (!species) continue;
		let total = 0;
		for (const t of threats) total += typeMultiplier(ctx.dex, t.moveType, species.types);
		// Only consider switching if the candidate is strictly better than staying in.
		const currentTotal = threats.reduce((s, t) => s + typeMultiplier(ctx.dex, t.moveType, ourTypes), 0);
		if (total >= currentTotal) continue;
		if (!best || total < best.score) best = { candidate: sw, score: total };
	}
	if (!best) return null;
	return { kind: 'switch', candidate: best.candidate };
};
