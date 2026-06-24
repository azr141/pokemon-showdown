/**
 * Plugin Player AI — in-game NPC AI policies.
 *
 * Replicates the mainline Pokemon trainer AI as faithfully as the available
 * information allows. The goal is predictability: an expert who knows these
 * rules should be able to predict the AI's move.
 *
 * ## The real algorithm (Gen 3+)
 *
 * The mainline AI assigns every move a score starting at a base of 100, runs
 * a series of evaluation routines that each adjust the score by small amounts,
 * then picks the highest-scoring move (choosing randomly among ties). The
 * routines, in the order the games run them:
 *
 *   1. AI_CheckBadMove — penalize moves that clearly won't work: type
 *      immunities, ability immunities (Gen 4+), re-applying a status the foe
 *      already has.
 *   2. AI_TryToFaint — the damage core. Computes the damage of every move and
 *      strongly favors a move that can KO this turn, weighted by whether the
 *      AI moves first (speed / priority).
 *   3. AI_CheckViability — situational tweaks: don't Explode unless it KOs,
 *      don't heal at high HP, don't set up at low HP, don't re-set weather.
 *
 * Gen 4 onward also reliably prefers the single highest-damage move (the
 * `bestDamageBonus`); Gen 3 weights this only slightly, which is why Gen 3
 * trainers visibly use sub-optimal moves more often.
 *
 * ## Damage
 *
 * `AI_TryToFaint` needs damage numbers. We compute them with `damage-estimate.ts`
 * using our real attack stats (from the request) and the foe's defenses
 * estimated from its base stats (31 IV / 0 EV / neutral nature). See that file
 * for the documented assumptions.
 *
 * ## Gen 1-2
 *
 * Gen 1-2 trainer AI is NOT damage-based. It is a weighted-random selection
 * driven by the move type's effectiveness against the foe (applied even to
 * status moves — the famous Gen 1 behavior). Modeled in `gen1WeightedRandom`.
 *
 * ## Known limitations (cannot be read from the protocol)
 *
 *   - Our own stat boosts and volatiles aren't visible, so we can't penalize
 *     redundant setup (Swords Dance at +6) or redundant Substitute exactly.
 *   - Our own side conditions (Reflect/Light Screen already up) aren't visible.
 *   - The foe's real EVs/IVs/nature are unknown; damage is an estimate.
 *   - Per-move AI scripts (Dream Eater needs sleep, Hex needs status, etc.)
 *     are not individually replicated beyond the common cases below.
 */

import { toID } from '../../dex';
import type {
	ActionPolicy, ActiveContext, MoveCandidate, MoveDecision,
} from './types';
import { typeMultiplier, effectiveTypes } from './policies';
import type { FoePokemon } from './battle-view';
import { estimateDamage, weOutspeed, type DamageEstimate } from './damage-estimate';

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

export function parseHpPercent(condition: string): number {
	if (!condition) return 100;
	const hpPart = condition.split(' ')[0];
	const slash = hpPart.indexOf('/');
	if (slash < 0) return condition.includes('fnt') ? 0 : 100;
	const num = parseInt(hpPart.slice(0, slash));
	const den = parseInt(hpPart.slice(slash + 1));
	if (!den || isNaN(num)) return 100;
	return Math.max(0, Math.min(100, (num / den) * 100));
}

/** Weather-setting move IDs mapped to the weather they cause. */
const WEATHER_MOVES: Record<string, string> = {
	sunnyday: 'sunnyday', raindance: 'raindance',
	sandstorm: 'sandstorm', hail: 'hail', snowscape: 'snow', chillyreception: 'snow',
};

/** Abilities that grant a full type immunity the AI (Gen 4+) respects. */
const ABILITY_IMMUNITIES: Record<string, string> = {
	levitate: 'Ground',
	flashfire: 'Fire',
	waterabsorb: 'Water',
	voltabsorb: 'Electric',
	lightningrod: 'Electric',
	stormdrain: 'Water',
	sapsipper: 'Grass',
	motordrive: 'Electric',
	dryskin: 'Water',
};

const SELF_KO_MOVES = new Set([
	'selfdestruct', 'explosion', 'memento', 'finalgambit', 'mistyexplosion',
]);

function isStatusInflicting(move: { status?: string; volatileStatus?: string }): boolean {
	return !!(move.status || move.volatileStatus);
}

function isSelfBoostingMove(move: AnyObject): boolean {
	if (move.boosts) return true;
	if (move.self?.boosts) return true;
	if (move.selfBoost?.boosts) return true;
	return false;
}

function abilityAbsorbs(foe: FoePokemon | undefined, moveType: string): boolean {
	if (!foe?.revealedAbility) return false;
	return ABILITY_IMMUNITIES[foe.revealedAbility as string] === moveType;
}

// ----------------------------------------------------------------------
// Gen 1-2: weighted-random by type effectiveness
// ----------------------------------------------------------------------

/**
 * Gen 1-2 "Good AI" — weighted random by the MOVE TYPE'S effectiveness
 * against the foe, applied to all moves including status moves.
 *
 * Weights: immune 0 (excluded), NVE 1, neutral 2, super-effective 6.
 * No damage calc, no STAB, no base power, no switching.
 */
export function gen1WeightedRandom(): ActionPolicy {
	return (ctx: ActiveContext) => {
		const foe = ctx.view.primaryFoe();
		const foeTypes = foe ? effectiveTypes(foe, ctx.dex) : [];
		const regular = ctx.moves.filter(m => !m.maxMove && !m.zMove);
		const pool = regular.length ? regular : ctx.moves;
		if (!pool.length) return null;

		const weights: number[] = [];
		for (const cand of pool) {
			if (foeTypes.length === 0) { weights.push(2); continue; }
			const move = ctx.dex.moves.get(cand.raw.id ?? toID(cand.move));
			if (!move?.exists) { weights.push(2); continue; }
			const mult = typeMultiplier(ctx.dex, move.type, foeTypes);
			if (mult === 0) weights.push(0);
			else if (mult < 1) weights.push(1);
			else if (mult > 1) weights.push(6);
			else weights.push(2);
		}

		const total = weights.reduce((a, b) => a + b, 0);
		if (total <= 0) return { kind: 'move', candidate: ctx.prng.sample(pool) };

		let roll = ctx.prng.random() * total;
		for (let i = 0; i < pool.length; i++) {
			roll -= weights[i];
			if (roll <= 0) return { kind: 'move', candidate: pool[i] };
		}
		return { kind: 'move', candidate: pool[pool.length - 1] };
	};
}

// ----------------------------------------------------------------------
// Gen 3+ scoring engine
// ----------------------------------------------------------------------

export interface IngameConfig {
	/** Bonus for a KO move when we outspeed (default +6). */
	koFasterBonus: number;
	/** Bonus for a KO move via positive priority when we'd be slower (default +5). */
	priorityKoBonus: number;
	/** Bonus for a KO move when we're slower and have no priority (default +4). */
	koSlowerBonus: number;
	/** Bonus for the single highest-damage move. Gen 3 weights this low. */
	bestDamageBonus: number;
	/** Penalty for a type-immune move (vanilla uses -10). */
	immunePenalty: number;
	/** Penalty for re-applying a status the foe already has (default -12). */
	reapplyStatusPenalty: number;
	/** Bonus for inflicting a fresh status on an unstatused foe (default +2). */
	statusBonus: number;
	/** Penalty for a self-KO move (Explosion) that would NOT KO (default -8). */
	explosionNoKoPenalty: number;
	/** Penalty for a healing move when own HP is high (default -8). */
	highHpHealPenalty: number;
	/** Bonus for a healing move when own HP is low (default +6). */
	lowHpHealBonus: number;
	/** Bonus for a setup move when own HP is high (default +2). */
	setupHighHpBonus: number;
	/** Penalty for a setup move when own HP is low (default -8). */
	setupLowHpPenalty: number;
	/** Penalty for re-setting weather that's already active (default -10). */
	redundantWeatherPenalty: number;
	/** Whether to respect the foe's revealed ability immunities (Gen 4+). */
	checkAbilityImmunity: boolean;
}

/**
 * Gen 3 (RSE) — loose. KO detection drives play, but with only a slight
 * preference for the strongest non-KO move, so sub-optimal picks are common.
 * No ability-immunity awareness; no Explosion caution.
 */
export const GEN3_CONFIG: IngameConfig = {
	koFasterBonus: 6,
	priorityKoBonus: 5,
	koSlowerBonus: 4,
	bestDamageBonus: 1,
	immunePenalty: -10,
	reapplyStatusPenalty: -12,
	statusBonus: 2,
	explosionNoKoPenalty: 0,
	highHpHealPenalty: -8,
	lowHpHealBonus: 6,
	setupHighHpBonus: 2,
	setupLowHpPenalty: -8,
	redundantWeatherPenalty: -10,
	checkAbilityImmunity: false,
};

/**
 * Gen 4-9 — reliably uses the strongest damaging move, respects ability
 * immunities, and avoids reckless Explosion. Gimmick handling layered on top
 * by the per-gen chains.
 */
export const GEN4_CONFIG: IngameConfig = {
	koFasterBonus: 6,
	priorityKoBonus: 5,
	koSlowerBonus: 4,
	bestDamageBonus: 3,
	immunePenalty: -10,
	reapplyStatusPenalty: -12,
	statusBonus: 2,
	explosionNoKoPenalty: -8,
	highHpHealPenalty: -8,
	lowHpHealBonus: 6,
	setupHighHpBonus: 2,
	setupLowHpPenalty: -8,
	redundantWeatherPenalty: -10,
	checkAbilityImmunity: true,
};

interface ScoredCandidate {
	cand: MoveCandidate;
	est: DamageEstimate;
}

/** Compute damage estimates for the pool, zeroing ability-immune moves. */
function estimatePool(
	pool: MoveCandidate[], ctx: ActiveContext, config: IngameConfig, foe: FoePokemon | undefined
): ScoredCandidate[] {
	return pool.map(cand => {
		if (!foe) return { cand, est: { percent: 0, canKO: false, effectiveness: 1 } };
		let est = estimateDamage(cand, ctx, foe);
		if (config.checkAbilityImmunity && est.percent > 0) {
			const move = ctx.dex.moves.get(cand.raw.id ?? toID(cand.move));
			if (move && abilityAbsorbs(foe, move.type)) {
				est = { percent: 0, canKO: false, effectiveness: 0 };
			}
		}
		return { cand, est };
	});
}

function scoreCandidate(
	sc: ScoredCandidate, ctx: ActiveContext, config: IngameConfig,
	foe: FoePokemon | undefined, ownHp: number, bestDamagePercent: number
): number {
	const { cand, est } = sc;
	const move = ctx.dex.moves.get(cand.raw.id ?? toID(cand.move));
	if (!move?.exists) return 100;

	let score = 100;
	const isDamaging = move.category !== 'Status';

	if (isDamaging) {
		// --- AI_CheckBadMove: immunity (type or ability) ---
		if (est.effectiveness === 0) {
			score += config.immunePenalty;
			return score; // immune move: no further bonuses
		}

		// --- AI_TryToFaint: KO detection, speed-weighted ---
		if (est.canKO && foe) {
			if (weOutspeed(ctx, foe)) {
				score += config.koFasterBonus;
			} else if (move.priority > 0) {
				score += config.priorityKoBonus;
			} else {
				score += config.koSlowerBonus;
			}
		}

		// --- Damage ranking: the single strongest move ---
		if (est.percent > 0 && est.percent === bestDamagePercent) {
			score += config.bestDamageBonus;
		}

		// --- AI_CheckViability: reckless self-KO ---
		if (config.explosionNoKoPenalty && SELF_KO_MOVES.has(move.id as string) && !est.canKO) {
			score += config.explosionNoKoPenalty;
		}
		return score;
	}

	// --- Status moves ---
	// Status infliction.
	if (isStatusInflicting(move)) {
		if (foe?.status) score += config.reapplyStatusPenalty;
		else score += config.statusBonus;
	}

	// Recovery.
	if (move.flags?.heal) {
		if (ownHp > 70) score += config.highHpHealPenalty;
		else if (ownHp < 40) score += config.lowHpHealBonus;
	}

	// Setup / stat boosts.
	if (isSelfBoostingMove(move)) {
		if (ownHp < 40) score += config.setupLowHpPenalty;
		else if (ownHp >= 70) score += config.setupHighHpBonus;
	}

	// Redundant weather.
	if (ctx.view.weather) {
		const weatherFromMove = WEATHER_MOVES[move.id as string];
		if (weatherFromMove && weatherFromMove === (ctx.view.weather as string)) {
			score += config.redundantWeatherPenalty;
		}
	}

	return score;
}

function pickBestMove(ctx: ActiveContext, config: IngameConfig): MoveDecision | null {
	const foe = ctx.view.primaryFoe();
	const ownHp = parseHpPercent(ctx.pokemon.condition);

	const regular = ctx.moves.filter(m => !m.maxMove && !m.zMove);
	const pool = regular.length ? regular : ctx.moves;
	if (!pool.length) return null;

	const scored = estimatePool(pool, ctx, config, foe);
	const bestDamagePercent = scored.reduce((max, sc) => Math.max(max, sc.est.percent), 0);

	let bestScore = -Infinity;
	let bestCands: MoveCandidate[] = [];
	for (const sc of scored) {
		const s = scoreCandidate(sc, ctx, config, foe, ownHp, bestDamagePercent);
		if (s > bestScore) {
			bestScore = s;
			bestCands = [sc.cand];
		} else if (s === bestScore) {
			bestCands.push(sc.cand);
		}
	}

	const candidate = bestCands.length === 1 ? bestCands[0] : ctx.prng.sample(bestCands);
	return { kind: 'move', candidate };
}

export function ingameScoreMove(config: IngameConfig): ActionPolicy {
	return (ctx: ActiveContext) => pickBestMove(ctx, config);
}

// ----------------------------------------------------------------------
// Gimmick policies — game-accurate trigger conditions
// ----------------------------------------------------------------------

/** Gen 6: NPCs always mega evolve on their first available turn. Unconditional. */
export function megaImmediately(config: IngameConfig): ActionPolicy {
	return (ctx: ActiveContext) => {
		if (!ctx.canMega) return null;
		const decision = pickBestMove(ctx, config);
		if (!decision) return null;
		decision.formChange = 'mega';
		return decision;
	};
}

/** Gen 7: NPCs use Z-moves aggressively on the first opportunity. */
export function useZMoveAggressively(config: IngameConfig): ActionPolicy {
	return (ctx: ActiveContext) => {
		if (!ctx.canZMove) return null;
		const zMoves = ctx.moves.filter(m => m.zMove);
		if (!zMoves.length) return null;

		const foe = ctx.view.primaryFoe();
		const ownHp = parseHpPercent(ctx.pokemon.condition);
		const scored = estimatePool(zMoves, ctx, config, foe);
		const bestDamagePercent = scored.reduce((max, sc) => Math.max(max, sc.est.percent), 0);

		let bestScore = -Infinity;
		let bestCand: MoveCandidate | null = null;
		for (const sc of scored) {
			const s = scoreCandidate(sc, ctx, config, foe, ownHp, bestDamagePercent);
			if (s > bestScore) { bestScore = s; bestCand = sc.cand; }
		}
		if (!bestCand) return null;
		return { kind: 'move', candidate: bestCand };
	};
}

/** Gen 8: NPCs dynamax their last Pokemon (ace). */
export function dynamaxOnLastMon(config: IngameConfig): ActionPolicy {
	return (ctx: ActiveContext) => {
		if (!ctx.canDynamax) return null;
		if (ctx.switches.length > 0) return null;

		const maxMoves = ctx.moves.filter(m => m.maxMove);
		if (!maxMoves.length) {
			const decision = pickBestMove(ctx, config);
			if (!decision) return null;
			decision.formChange = 'dynamax';
			return decision;
		}

		const foe = ctx.view.primaryFoe();
		const ownHp = parseHpPercent(ctx.pokemon.condition);
		const scored = estimatePool(maxMoves, ctx, config, foe);
		const bestDamagePercent = scored.reduce((max, sc) => Math.max(max, sc.est.percent), 0);

		let bestScore = -Infinity;
		let bestCand: MoveCandidate | null = null;
		for (const sc of scored) {
			const s = scoreCandidate(sc, ctx, config, foe, ownHp, bestDamagePercent);
			if (s > bestScore) { bestScore = s; bestCand = sc.cand; }
		}
		if (!bestCand) return null;
		return { kind: 'move', candidate: bestCand, formChange: 'dynamax' };
	};
}

/** Gen 9: NPCs terastallize their last Pokemon (ace). */
export function teraOnLastMon(config: IngameConfig): ActionPolicy {
	return (ctx: ActiveContext) => {
		if (!ctx.canTerastallize) return null;
		if (ctx.switches.length > 0) return null;

		const decision = pickBestMove(ctx, config);
		if (!decision) return null;
		decision.formChange = 'terastallize';
		return decision;
	};
}
