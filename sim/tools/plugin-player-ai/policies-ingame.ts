/**
 * Plugin Player AI — in-game NPC AI policies.
 *
 * Replicates mainline Pokemon game trainer AI behavior. A parameterizable
 * score-based move selection policy is tuned per-generation, and separate
 * gimmick policies handle Mega/Z-Move/Dynamax/Tera with game-accurate
 * trigger conditions.
 */

import { toID } from '../../dex';
import type { ModdedDex } from '../../dex';
import type {
	ActionPolicy, ActiveContext, MoveCandidate, MoveDecision, FormChange,
} from './types';
import { typeMultiplier, effectiveTypes } from './policies';
import type { FoePokemon } from './battle-view';

// ----------------------------------------------------------------------
// Scoring config
// ----------------------------------------------------------------------

export interface IngameConfig {
	immunePenalty: number;
	nvePenalty: number;
	seBonus: number;
	stabBonus: number;
	basePowerWeight: number;
	statusPenalty: number;
	reapplyStatusPenalty: number;
	lowHpRecoveryBonus: number;
	lowHpFoeKillBonus: number;
	weatherBonus: number;
}

export const DEFAULT_CONFIG: IngameConfig = {
	immunePenalty: -1000,
	nvePenalty: -20,
	seBonus: 20,
	stabBonus: 10,
	basePowerWeight: 0.5,
	statusPenalty: -10,
	reapplyStatusPenalty: -50,
	lowHpRecoveryBonus: 15,
	lowHpFoeKillBonus: 10,
	weatherBonus: 10,
};

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

const WEATHER_TYPE_BOOST: Record<string, string> = {
	sunnyday: 'Fire', desolateland: 'Fire',
	raindance: 'Water', primordialsea: 'Water',
	sandstorm: 'Rock',
	snow: 'Ice', hail: 'Ice',
};

function scoreMove(
	cand: MoveCandidate, ctx: ActiveContext, config: IngameConfig,
	foe: FoePokemon | undefined, foeTypes: readonly string[], ownTypes: readonly string[],
	ownHp: number, foeHp: number
): number {
	const move = ctx.dex.moves.get(cand.raw.id ?? toID(cand.move));
	if (!move?.exists) return 100;

	let score = 100;

	if (foeTypes.length > 0 && move.category !== 'Status') {
		const mult = typeMultiplier(ctx.dex, move.type, foeTypes);
		if (mult === 0) score += config.immunePenalty;
		else if (mult < 1) score += config.nvePenalty;
		else if (mult > 1) score += config.seBonus;
	}

	if (config.stabBonus && ownTypes.includes(move.type)) {
		score += config.stabBonus;
	}

	if (config.basePowerWeight && move.category !== 'Status') {
		score += (move.basePower / 10) * config.basePowerWeight;
	}

	if (move.category === 'Status') {
		score += config.statusPenalty;
		if (foe?.status && isStatusMove(move)) {
			score += config.reapplyStatusPenalty;
		}
	}

	if (config.lowHpRecoveryBonus && ownHp < 33 && move.flags?.heal) {
		score += config.lowHpRecoveryBonus;
	}

	if (config.lowHpFoeKillBonus && foeHp < 33 && foeHp > 0 && move.category !== 'Status') {
		score += config.lowHpFoeKillBonus;
	}

	if (config.weatherBonus && ctx.view.weather) {
		const boostedType = WEATHER_TYPE_BOOST[ctx.view.weather as string];
		if (boostedType && move.type === boostedType) {
			score += config.weatherBonus;
		}
	}

	return score;
}

function isStatusMove(move: {status?: string; volatileStatus?: string; boosts?: AnyObject}): boolean {
	return !!(move.status || move.volatileStatus);
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
// Core scoring policy
// ----------------------------------------------------------------------

export function ingameScoreMove(config: IngameConfig = DEFAULT_CONFIG): ActionPolicy {
	return (ctx: ActiveContext) => pickBestMove(ctx, config);
}

// ----------------------------------------------------------------------
// Gimmick policies — game-accurate trigger conditions
// ----------------------------------------------------------------------

/** Gen 6: NPCs always mega evolve on their first available turn. */
export function megaImmediately(config: IngameConfig = DEFAULT_CONFIG): ActionPolicy {
	return (ctx: ActiveContext) => {
		if (!ctx.canMega) return null;
		const decision = pickBestMove(ctx, config);
		if (!decision) return null;
		decision.formChange = 'mega';
		return decision;
	};
}

/** Gen 7: NPCs use Z-moves aggressively on the first opportunity. */
export function useZMoveAggressively(config: IngameConfig = DEFAULT_CONFIG): ActionPolicy {
	return (ctx: ActiveContext) => {
		if (!ctx.canZMove) return null;

		const zMoves = ctx.moves.filter(m => m.zMove);
		if (!zMoves.length) return null;

		const foe = ctx.view.primaryFoe();
		const foeTypes = foe ? effectiveTypes(foe, ctx.dex) : [];
		const ownTypes = getOwnTypes(ctx);
		const ownHp = parseHpPercent(ctx.pokemon.condition);
		const foeHp = foe?.hpPercent ?? 100;

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
export function dynamaxOnLastMon(config: IngameConfig = DEFAULT_CONFIG): ActionPolicy {
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
export function teraOnLastMon(config: IngameConfig = DEFAULT_CONFIG): ActionPolicy {
	return (ctx: ActiveContext) => {
		if (!ctx.canTerastallize) return null;
		if (ctx.switches.length > 0) return null;

		const decision = pickBestMove(ctx, config);
		if (!decision) return null;
		decision.formChange = 'terastallize';
		return decision;
	};
}
