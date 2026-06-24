/**
 * Plugin Player AI — in-game NPC AI policies.
 *
 * Replicates mainline Pokemon game trainer AI behavior as faithfully as
 * possible given the information available through the BattleView and
 * request objects.
 *
 * ## How the real games work
 *
 * **Gen 1-2 ("Good AI")**: Weighted random. Each move gets a weight based
 * on type effectiveness against the foe. Super-effective moves are ~3x as
 * likely to be chosen, not-very-effective ~0.5x, immune moves are excluded.
 * There is no scoring, no STAB consideration, no power consideration.
 *
 * **Gen 3 (flag-based)**: Trainers have AI flag bits. The "check viability"
 * flag runs a simple score system: penalize immune/NVE, bonus for SE, small
 * penalty for reapplying status, small bonus for damage when foe is low.
 * No STAB or base power weighting. No switching.
 *
 * **Gen 4-5 (full scoring)**: Expanded score system starting at base 100.
 * Modifiers for type effectiveness, STAB, base power, accuracy, weather
 * boost, status reapplication, recovery at low HP, priority on low-foe,
 * ability-based immunities (Levitate, etc.), setup move restrictions.
 *
 * **Gen 6+**: Same scoring as gen 4/5 with gimmick-specific policies:
 * - Gen 6 Mega: always mega evolve immediately (hardcoded, unconditional)
 * - Gen 7 Z-Move: use aggressively on first opportunity, best attack
 * - Gen 8 Dynamax: save for last Pokemon (ace)
 * - Gen 9 Tera: save for last Pokemon (ace)
 *
 * Trainers NEVER voluntarily switch in any generation (with extremely rare
 * hardcoded exceptions we don't replicate here).
 */

import { toID } from '../../dex';
import type { ModdedDex } from '../../dex';
import type {
	ActionPolicy, ActiveContext, MoveCandidate, MoveDecision,
} from './types';
import { typeMultiplier, effectiveTypes } from './policies';
import type { FoePokemon } from './battle-view';

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

function getOwnTypes(ctx: ActiveContext): readonly string[] {
	const speciesName = ctx.pokemon.details.split(',')[0];
	const species = ctx.dex.species.get(toID(speciesName));
	return species?.types ?? [];
}

/** Only Sun and Rain actually boost move damage. Sandstorm/Snow do not. */
const WEATHER_TYPE_BOOST: Record<string, string> = {
	sunnyday: 'Fire', desolateland: 'Fire',
	raindance: 'Water', primordialsea: 'Water',
};

/** Abilities that grant type immunities the AI should respect. */
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

/** Move IDs that KO or severely hurt the user. */
const SELF_KO_MOVES = new Set([
	'selfdestruct', 'explosion', 'memento', 'healingwish', 'lunardance',
	'finalgambit', 'mistyexplosion',
]);

function isStatusInflicting(move: {status?: string; volatileStatus?: string}): boolean {
	return !!(move.status || move.volatileStatus);
}

// ----------------------------------------------------------------------
// Gen 1-2: Weighted random selection
// ----------------------------------------------------------------------

/**
 * Gen 1-2 "Good AI" — weighted random, not deterministic.
 *
 * Each move gets a weight based on type effectiveness:
 * - Immune: weight 0 (excluded)
 * - Not very effective: weight 1
 * - Neutral: weight 2
 * - Super effective: weight 6
 *
 * A move is then randomly selected weighted by these values.
 * No STAB, no base power, no status logic.
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
			if (foeTypes.length === 0) {
				weights.push(2);
				continue;
			}
			const move = ctx.dex.moves.get(cand.raw.id ?? toID(cand.move));
			if (!move?.exists) {
				weights.push(2);
				continue;
			}
			if (move.category === 'Status') {
				weights.push(2);
				continue;
			}
			const mult = typeMultiplier(ctx.dex, move.type, foeTypes);
			if (mult === 0) {
				weights.push(0);
			} else if (mult < 1) {
				weights.push(1);
			} else if (mult > 1) {
				weights.push(6);
			} else {
				weights.push(2);
			}
		}

		const totalWeight = weights.reduce((a, b) => a + b, 0);
		if (totalWeight <= 0) {
			const candidate = ctx.prng.sample(pool);
			return { kind: 'move', candidate };
		}

		let roll = ctx.prng.random() * totalWeight;
		for (let i = 0; i < pool.length; i++) {
			roll -= weights[i];
			if (roll <= 0) {
				return { kind: 'move', candidate: pool[i] };
			}
		}
		return { kind: 'move', candidate: pool[pool.length - 1] };
	};
}

// ----------------------------------------------------------------------
// Gen 3+ scoring config & engine
// ----------------------------------------------------------------------

export interface IngameConfig {
	/** Penalty for moves the foe is immune to (default -1000). */
	immunePenalty: number;
	/** Penalty for not-very-effective moves (default -20). */
	nvePenalty: number;
	/** Bonus for super-effective moves (default +20). */
	seBonus: number;
	/** Bonus for STAB moves (default +10). */
	stabBonus: number;
	/** Weight applied to basePower/10 (default 0.5, so 100BP = +5). */
	basePowerWeight: number;
	/** Weight applied to accuracy (default 0.3, so 70% acc = -9 vs 100%). */
	accuracyWeight: number;
	/** Penalty for status-category moves (default -10). */
	statusPenalty: number;
	/** Extra penalty for reapplying a status the foe already has (default -80). */
	reapplyStatusPenalty: number;
	/** Bonus for healing moves when own HP < 33% (default +15). */
	lowHpRecoveryBonus: number;
	/** Bonus for attacking moves when foe HP < 25% (default +10). */
	lowHpFoeKillBonus: number;
	/** Bonus for priority moves when foe HP < 25% (default +15). */
	priorityKillBonus: number;
	/** Bonus for weather-boosted moves — only Sun/Rain (default +10). */
	weatherBonus: number;
	/** Penalty for self-KO moves like Explosion (default -40). */
	selfKoPenalty: number;
	/** Penalty for setup moves when own HP < 40% (default -30). */
	lowHpSetupPenalty: number;
	/** Whether to check foe's revealed ability for type immunities (default true). */
	checkAbilityImmunity: boolean;
}

export const GEN3_CONFIG: IngameConfig = {
	immunePenalty: -1000,
	nvePenalty: -10,
	seBonus: 15,
	stabBonus: 0,
	basePowerWeight: 0,
	accuracyWeight: 0,
	statusPenalty: -10,
	reapplyStatusPenalty: -80,
	lowHpRecoveryBonus: 0,
	lowHpFoeKillBonus: 5,
	priorityKillBonus: 0,
	weatherBonus: 0,
	selfKoPenalty: -20,
	lowHpSetupPenalty: 0,
	checkAbilityImmunity: false,
};

export const GEN4_CONFIG: IngameConfig = {
	immunePenalty: -1000,
	nvePenalty: -20,
	seBonus: 20,
	stabBonus: 10,
	basePowerWeight: 0.5,
	accuracyWeight: 0.3,
	statusPenalty: -10,
	reapplyStatusPenalty: -80,
	lowHpRecoveryBonus: 15,
	lowHpFoeKillBonus: 10,
	priorityKillBonus: 15,
	weatherBonus: 10,
	selfKoPenalty: -40,
	lowHpSetupPenalty: -30,
	checkAbilityImmunity: true,
};

function scoreMove(
	cand: MoveCandidate, ctx: ActiveContext, config: IngameConfig,
	foe: FoePokemon | undefined, foeTypes: readonly string[], ownTypes: readonly string[],
	ownHp: number, foeHp: number
): number {
	const move = ctx.dex.moves.get(cand.raw.id ?? toID(cand.move));
	if (!move?.exists) return 100;

	let score = 100;

	// --- Type effectiveness ---
	if (foeTypes.length > 0 && move.category !== 'Status') {
		const mult = typeMultiplier(ctx.dex, move.type, foeTypes);
		if (mult === 0) {
			score += config.immunePenalty;
		} else if (mult < 1) {
			score += config.nvePenalty;
		} else if (mult > 1) {
			score += config.seBonus;
			if (mult >= 4) score += config.seBonus;
		}
	}

	// --- Ability-based immunity (Levitate vs Ground, etc.) ---
	if (config.checkAbilityImmunity && foe?.revealedAbility && move.category !== 'Status') {
		const immuneType = ABILITY_IMMUNITIES[foe.revealedAbility as string];
		if (immuneType && move.type === immuneType) {
			score += config.immunePenalty;
		}
	}

	// --- STAB ---
	if (config.stabBonus && move.category !== 'Status' && ownTypes.includes(move.type)) {
		score += config.stabBonus;
	}

	// --- Base power ---
	if (config.basePowerWeight && move.category !== 'Status') {
		score += (move.basePower / 10) * config.basePowerWeight;
	}

	// --- Accuracy ---
	if (config.accuracyWeight && typeof move.accuracy === 'number' && move.accuracy < 100) {
		score -= (100 - move.accuracy) * config.accuracyWeight;
	}

	// --- Status moves ---
	if (move.category === 'Status') {
		score += config.statusPenalty;
		if (foe?.status && isStatusInflicting(move)) {
			score += config.reapplyStatusPenalty;
		}
	}

	// --- Recovery at low HP ---
	if (config.lowHpRecoveryBonus && ownHp < 33 && move.flags?.heal) {
		score += config.lowHpRecoveryBonus;
	}

	// --- Kill pressure on low-HP foe ---
	if (foeHp > 0 && foeHp < 25 && move.category !== 'Status') {
		score += config.lowHpFoeKillBonus;
		if (config.priorityKillBonus && move.priority > 0) {
			score += config.priorityKillBonus;
		}
	}

	// --- Weather boost (only Sun→Fire, Rain→Water) ---
	if (config.weatherBonus && ctx.view.weather) {
		const boostedType = WEATHER_TYPE_BOOST[ctx.view.weather as string];
		if (boostedType && move.type === boostedType) {
			score += config.weatherBonus;
		}
	}

	// --- Self-KO moves (Explosion, Selfdestruct, etc.) ---
	if (config.selfKoPenalty && SELF_KO_MOVES.has(move.id as string)) {
		score += config.selfKoPenalty;
	}

	// --- Setup moves at low HP ---
	if (config.lowHpSetupPenalty && ownHp < 40 && move.category === 'Status' && move.boosts) {
		score += config.lowHpSetupPenalty;
	}

	return score;
}

function pickBestMove(ctx: ActiveContext, config: IngameConfig): MoveDecision | null {
	const foe = ctx.view.primaryFoe();
	const foeTypes = foe ? effectiveTypes(foe, ctx.dex) : [];
	const ownTypes = getOwnTypes(ctx);
	const ownHp = parseHpPercent(ctx.pokemon.condition);
	const foeHp = foe?.hpPercent ?? 100;

	const regular = ctx.moves.filter(m => !m.maxMove && !m.zMove);
	const pool = regular.length ? regular : ctx.moves;
	if (!pool.length) return null;

	let bestScore = -Infinity;
	let bestCands: MoveCandidate[] = [];
	for (const cand of pool) {
		const s = scoreMove(cand, ctx, config, foe, foeTypes, ownTypes, ownHp, foeHp);
		if (s > bestScore) {
			bestScore = s;
			bestCands = [cand];
		} else if (s === bestScore) {
			bestCands.push(cand);
		}
	}

	const candidate = bestCands.length === 1 ? bestCands[0] : ctx.prng.sample(bestCands);
	return { kind: 'move', candidate };
}

// ----------------------------------------------------------------------
// Core scoring policy (gen 3+)
// ----------------------------------------------------------------------

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
		const foeTypes = foe ? effectiveTypes(foe, ctx.dex) : [];
		const ownTypes = getOwnTypes(ctx);
		const ownHp = parseHpPercent(ctx.pokemon.condition);
		const foeHp = foe?.hpPercent ?? 100;

		// Pick the best Z-move by score, preferring damaging ones.
		let bestScore = -Infinity;
		let bestCand: MoveCandidate | null = null;
		for (const cand of zMoves) {
			const s = scoreMove(cand, ctx, config, foe, foeTypes, ownTypes, ownHp, foeHp);
			if (s > bestScore) {
				bestScore = s;
				bestCand = cand;
			}
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
		const foeTypes = foe ? effectiveTypes(foe, ctx.dex) : [];
		const ownTypes = getOwnTypes(ctx);
		const ownHp = parseHpPercent(ctx.pokemon.condition);
		const foeHp = foe?.hpPercent ?? 100;

		let bestScore = -Infinity;
		let bestCand: MoveCandidate | null = null;
		for (const cand of maxMoves) {
			const s = scoreMove(cand, ctx, config, foe, foeTypes, ownTypes, ownHp, foeHp);
			if (s > bestScore) {
				bestScore = s;
				bestCand = cand;
			}
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
