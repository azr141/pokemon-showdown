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
 *      AI moves first (speed / priority). Self-KO moves (Explosion) are
 *      excluded here, exactly as the games do — the AI won't sacrifice its
 *      Pokemon just to secure a KO.
 *   3. AI_CheckViability — situational tweaks: keep Explosion as a last resort,
 *      don't heal at high HP, don't set up at low HP, don't re-set weather.
 *
 * Gen 4 onward also reliably prefers the single highest-damage move (the
 * `bestDamageBonus`); Gen 3 weights this only slightly, which is why Gen 3
 * trainers visibly use sub-optimal moves more often.
 *
 * ## Damage
 *
 * `AI_TryToFaint` needs damage numbers. We compute them with `damage-estimate.ts`
 * using our real attack stats (from the request) and the foe's REAL defenses
 * when the opposing team was registered (scenario play — matching the games'
 * omniscient AI), falling back to base-stat estimates (31 IV / 0 EV / neutral
 * nature) otherwise. See that file for the documented assumptions.
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
	SwitchCandidate, SwitchDecision,
} from './types';
import { typeMultiplier, effectiveTypes } from './policies';
import type { FoePokemon } from './battle-view';
import { estimateDamage, weOutspeed, type DamageEstimate } from './damage-estimate';

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

function parseHpPercent(condition: string): number {
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

/**
 * Abilities that grant a full type immunity, gated by the generation the
 * immunity effect actually existed. Lightning Rod / Storm Drain only redirect
 * (no immunity) before Gen 5; Motor Drive / Dry Skin are Gen 4; Sap Sipper is
 * Gen 5. The mainline AI "cheats" and avoids these moves using the foe's true
 * ability, which is why it won't Earthquake a Levitate mon before it's shown.
 */
const ABILITY_IMMUNITY: Record<string, { type: string, sinceGen: number }> = {
	levitate: { type: 'Ground', sinceGen: 3 },
	flashfire: { type: 'Fire', sinceGen: 3 },
	waterabsorb: { type: 'Water', sinceGen: 3 },
	voltabsorb: { type: 'Electric', sinceGen: 3 },
	motordrive: { type: 'Electric', sinceGen: 4 },
	dryskin: { type: 'Water', sinceGen: 4 },
	stormdrain: { type: 'Water', sinceGen: 5 },
	lightningrod: { type: 'Electric', sinceGen: 5 },
	sapsipper: { type: 'Grass', sinceGen: 5 },
};

const SELF_KO_MOVES = new Set([
	'selfdestruct', 'explosion', 'memento', 'finalgambit', 'mistyexplosion',
]);

function isStatusInflicting(move: { status?: string, volatileStatus?: string }): boolean {
	return !!(move.status || move.volatileStatus);
}

function isSelfBoostingMove(move: AnyObject): boolean {
	if (move.boosts) return true;
	if (move.self?.boosts) return true;
	if (move.selfBoost?.boosts) return true;
	return false;
}

/** The foe's ability — true value from the known set, else revealed. */
function foeAbility(foe: FoePokemon, ctx: ActiveContext): ID | undefined {
	return ctx.view.foeKnownSets.get(foe.speciesId)?.ability ?? foe.revealedAbility;
}

/**
 * Whether the foe's ability nullifies this damaging move. Covers gen-gated
 * type-immunity abilities plus Wonder Guard (only super-effective hits land).
 * `effectiveness` is the move's type multiplier (needed for Wonder Guard).
 */
function abilityMakesImmune(
	foe: FoePokemon, ctx: ActiveContext, moveType: string, effectiveness: number
): boolean {
	const ability = foeAbility(foe, ctx);
	if (!ability) return false;
	const entry = ABILITY_IMMUNITY[ability as string];
	if (entry && entry.sinceGen <= ctx.gen && entry.type === moveType) return true;
	if (ability === 'wonderguard' && effectiveness < 2) return true;
	return false;
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
	/**
	 * Standing discouragement for self-KO moves (Explosion / Self-Destruct).
	 * The real Gen 3+ AI excludes these from the faint bonus entirely — a
	 * trainer won't sacrifice its Pokemon just because the move would KO — and
	 * only discourages them in the viability pass. So they never lead; they
	 * surface as a last resort when every other move scores worse.
	 */
	selfKoPenalty: number;
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
 * Avoids ability-nullified moves (Levitate/absorbs/Wonder Guard, Gen 3 set).
 * Keeps Explosion as a last resort (RSE gives it a mild viability penalty).
 */
export const GEN3_CONFIG: IngameConfig = {
	koFasterBonus: 6,
	priorityKoBonus: 5,
	koSlowerBonus: 4,
	bestDamageBonus: 1,
	immunePenalty: -10,
	reapplyStatusPenalty: -12,
	statusBonus: 2,
	selfKoPenalty: -2,
	highHpHealPenalty: -8,
	lowHpHealBonus: 6,
	setupHighHpBonus: 2,
	setupLowHpPenalty: -8,
	redundantWeatherPenalty: -10,
	// RSE's AI_CheckBadMove already avoids moves the target's ability nullifies
	// (Levitate, the absorb abilities, Wonder Guard). The gen-gated table keeps
	// it to abilities whose immunity existed in Gen 3.
	checkAbilityImmunity: true,
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
	selfKoPenalty: -8,
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
			if (move && abilityMakesImmune(foe, ctx, move.type, est.effectiveness)) {
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

	// --- AI_CheckBadMove: moves whose fail condition is currently true ---
	// The real AI knows when a move simply cannot work and treats it like a
	// bad move (same -10 as an immune hit in the pokeemerald sources).
	{
		const condParts = (ctx.pokemon.condition || '').split(' ');
		const ownStatus = condParts.length > 1 && condParts[1] !== 'fnt' ? condParts[1] : undefined;
		let willFail = false;
		if ((move.id === 'dreameater' || move.id === 'nightmare') && foe && foe.status !== 'slp') willFail = true;
		if ((move.id === 'snore' || move.id === 'sleeptalk') && ownStatus !== 'slp') willFail = true;
		if (move.id === 'bellydrum' && ownHp <= 50) willFail = true;
		if (willFail) {
			score += config.immunePenalty;
			return score;
		}
	}

	if (isDamaging) {
		// --- AI_CheckBadMove: immunity (type or ability) ---
		if (est.effectiveness === 0) {
			score += config.immunePenalty;
			return score; // immune move: no further bonuses
		}

		// --- Self-KO moves (Explosion / Self-Destruct) ---
		// The real Gen 3+ AI excludes these from AI_TryToFaint: it will NOT
		// sacrifice its Pokemon just because the move would KO. They get only a
		// standing viability discouragement, so they never lead and surface as
		// a last resort when everything else scores worse.
		if (SELF_KO_MOVES.has(move.id as string)) {
			score += config.selfKoPenalty;
			return score;
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
	// The "strongest move" preference ignores self-KO moves — a suicide move
	// isn't the AI's preferred attacker even when it deals the most damage.
	const bestDamagePercent = scored.reduce((max, sc) => {
		if (SELF_KO_MOVES.has(sc.cand.raw.id ?? toID(sc.cand.move))) return max;
		return Math.max(max, sc.est.percent);
	}, 0);

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

// ----------------------------------------------------------------------
// Switching (Gen 8-9)
// ----------------------------------------------------------------------

/**
 * How willing a generation's AI is to switch out of a bad matchup.
 *
 * Gens 1-7 never voluntarily switch, so they don't use this policy at all.
 *
 * Gen 8 (SwSh) is a Dynamax-and-swing AI: it only bails when the current
 * mon is both super-effectively threatened AND can't hit back hard (a
 * genuinely hopeless matchup). Story trainers rarely switch.
 *
 * Gen 9 (SV) is the first mainline AI that pivots proactively: it reads the
 * opposing Pokemon's type and switches to a defensive answer whenever the
 * active is at a super-effective disadvantage — unless it can already KO
 * the foe this turn (then it just attacks).
 */
export interface SwitchConfig {
	/** Switch even when we can hit back super-effectively (Gen 9). */
	onTypeDisadvantage: boolean;
}

export const GEN8_SWITCH: SwitchConfig = { onTypeDisadvantage: false };
export const GEN9_SWITCH: SwitchConfig = { onTypeDisadvantage: true };

/** Species types of our active pokemon, from the request details. */
function ownActiveTypes(ctx: ActiveContext): readonly string[] {
	return ctx.dex.species.get(toID(ctx.pokemon.details.split(',')[0]))?.types ?? [];
}

/**
 * The foe's attacking types: its revealed damaging-move types plus its
 * species' own types (STAB proxy — the AI reads your Pokemon's type even
 * before you've attacked, which is how SV switches to counter your lead).
 */
function foeAttackingTypes(foe: FoePokemon, ctx: ActiveContext): string[] {
	const types = new Set<string>(ctx.dex.species.get(foe.speciesId)?.types ?? []);
	for (const id of foe.revealedMoves) {
		const m = ctx.dex.moves.get(id);
		if (m?.exists && m.category !== 'Status') types.add(m.type);
	}
	return [...types];
}

/** Best type multiplier any of `attackTypes` gets against `defenderTypes`. */
function worstIncoming(attackTypes: string[], defenderTypes: readonly string[], ctx: ActiveContext): number {
	let max = 0;
	for (const t of attackTypes) max = Math.max(max, typeMultiplier(ctx.dex, t, defenderTypes));
	return max;
}

/** Best type multiplier our current moves get against the foe. */
function ourBestOffense(ctx: ActiveContext, foe: FoePokemon): number {
	const foeTypes = effectiveTypes(foe, ctx.dex);
	if (!foeTypes.length) return 1;
	let max = 0;
	for (const cand of ctx.moves) {
		const m = ctx.dex.moves.get(cand.raw.id ?? toID(cand.move));
		if (!m?.exists || m.category === 'Status') continue;
		max = Math.max(max, typeMultiplier(ctx.dex, m.type, foeTypes));
	}
	return max;
}

/** Whether a bench pokemon has a super-effective move against the foe. */
function benchThreatensFoe(sw: SwitchCandidate, foe: FoePokemon, ctx: ActiveContext): boolean {
	const foeTypes = effectiveTypes(foe, ctx.dex);
	if (!foeTypes.length) return false;
	for (const id of sw.pokemon.moves ?? []) {
		const m = ctx.dex.moves.get(id);
		if (!m?.exists || m.category === 'Status') continue;
		if (typeMultiplier(ctx.dex, m.type, foeTypes) >= 2) return true;
	}
	return false;
}

/** Whether we can KO the foe this turn AND move first — reason to stay in. */
function weCanKOFirst(ctx: ActiveContext, foe: FoePokemon): boolean {
	if (!weOutspeed(ctx, foe)) return false;
	for (const cand of ctx.moves) {
		if (cand.maxMove || cand.zMove) continue;
		if (estimateDamage(cand, ctx, foe).canKO) return true;
	}
	return false;
}

/**
 * Switch out of a super-effective disadvantage to the best defensive answer
 * on the bench. Abstains (letting the scoring policy attack) when the matchup
 * is fine, when we can KO the foe first, or when no bench mon is a real
 * defensive upgrade.
 */
export function switchOnBadMatchup(config: SwitchConfig): ActionPolicy {
	return (ctx: ActiveContext): SwitchDecision | null => {
		if (!ctx.switches.length) return null;
		const foe = ctx.view.primaryFoe();
		if (!foe) return null;

		const attackTypes = foeAttackingTypes(foe, ctx);
		const incoming = worstIncoming(attackTypes, ownActiveTypes(ctx), ctx);
		if (incoming < 2) return null; // not a super-effective disadvantage

		// If we can just KO the foe first, do that instead of switching.
		if (weCanKOFirst(ctx, foe)) return null;

		// Gen 8 (SwSh): only bail when we also can't hit back hard.
		if (!config.onTypeDisadvantage && ourBestOffense(ctx, foe) >= 2) return null;

		// Pick the bench mon that best neutralizes the incoming threat,
		// tie-broken by whether it threatens the foe back.
		let best: { candidate: SwitchCandidate, score: number } | null = null;
		for (const sw of ctx.switches) {
			const benchTypes = ctx.dex.species.get(toID(sw.pokemon.details.split(',')[0]))?.types ?? [];
			const benchIncoming = worstIncoming(attackTypes, benchTypes, ctx);
			if (benchIncoming >= incoming) continue; // not a defensive upgrade
			if (benchIncoming >= 2) continue; // don't switch into another SE hit
			const score = (2 - benchIncoming) * 10 + (benchThreatensFoe(sw, foe, ctx) ? 5 : 0);
			if (!best || score > best.score) best = { candidate: sw, score };
		}
		if (!best) return null;
		return { kind: 'switch', candidate: best.candidate };
	};
}
