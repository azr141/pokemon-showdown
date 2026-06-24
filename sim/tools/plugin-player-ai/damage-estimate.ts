/**
 * Plugin Player AI — damage estimation.
 *
 * The mainline in-game AI's core routine (`AI_TryToFaint` and the
 * damage-ranking selection in Gen 4+) runs a real damage calculation and
 * prefers the move that deals the most damage / can KO. To replicate this
 * at the policy layer we need a damage estimate.
 *
 * What we know exactly (from the move request):
 *   - our own real stats (atk/def/spa/spd/spe) via `ctx.pokemon.stats`
 *   - our level, types, and each move's base power/type/category (via dex)
 *
 * What we must estimate (the foe is only partially revealed):
 *   - the foe's defensive stats — computed from the species' BASE stats at
 *     the foe's level, assuming 31 IVs, 0 EVs, and a neutral nature. These
 *     are the documented assumptions; a foe running invested defenses will
 *     take less than estimated, and vice-versa.
 *   - the foe's max HP (same assumptions) so we can convert HP% to an
 *     absolute value for KO detection.
 *
 * The damage formula is the standard Gen 3+ formula. We deliberately use a
 * FIXED damage roll (the maximum, random factor = 1.0) rather than a range,
 * because the mainline AI's KO check is computed on a single optimistic
 * roll — the AI will commit to a move it believes can KO even when the low
 * roll would fall short. This matches observed in-game behavior.
 */

import { toID } from '../../dex';
import type { ActiveContext, MoveCandidate } from './types';
import type { FoePokemon } from './battle-view';
import { typeMultiplier, effectiveTypes } from './policies';

/** Standard stat formula for a non-HP stat. Neutral nature, 31 IV, 0 EV. */
function estimateStat(base: number, level: number): number {
	return Math.floor((Math.floor((2 * base + 31) * level / 100) + 5));
}

/** Standard HP stat formula. 31 IV, 0 EV. Shedinja (base 1 HP) → 1. */
function estimateMaxHpFromBase(baseHp: number, level: number): number {
	if (baseHp === 1) return 1; // Shedinja
	return Math.floor((2 * baseHp + 31) * level / 100) + level + 10;
}

/** Parse "Pikachu, L88, M" → 88. Defaults to 100. */
function parseLevel(details: string): number {
	for (const seg of details.split(',')) {
		const s = seg.trim();
		if (s.startsWith('L')) {
			const n = parseInt(s.slice(1));
			if (!isNaN(n)) return n;
		}
	}
	return 100;
}

const WEATHER_FIRE_UP = new Set(['sunnyday', 'desolateland']);
const WEATHER_WATER_UP = new Set(['raindance', 'primordialsea']);

/** Estimate the foe's current absolute HP from its species/level/HP%. */
export function estimateFoeCurrentHp(foe: FoePokemon, ctx: ActiveContext): number {
	const species = ctx.dex.species.get(foe.speciesId);
	const baseHp = species?.baseStats?.hp ?? 80;
	const maxHp = estimateMaxHpFromBase(baseHp, foe.level || 100);
	return Math.max(1, Math.round(maxHp * foe.hpPercent / 100));
}

export interface DamageEstimate {
	/** Estimated damage as a percent of the foe's max HP (0..∞, can exceed 100). */
	percent: number;
	/** Whether this move is estimated to KO the foe this turn. */
	canKO: boolean;
	/** Type effectiveness multiplier (0, 0.25, 0.5, 1, 2, 4). */
	effectiveness: number;
}

/**
 * Estimate the damage `cand` would deal to `foe`. Status moves and moves
 * the foe is immune to return 0 / canKO=false.
 */
export function estimateDamage(
	cand: MoveCandidate, ctx: ActiveContext, foe: FoePokemon
): DamageEstimate {
	const move = ctx.dex.moves.get(cand.raw.id ?? toID(cand.move));
	if (!move?.exists || move.category === 'Status') {
		return { percent: 0, canKO: false, effectiveness: 1 };
	}

	const foeTypes = effectiveTypes(foe, ctx.dex);
	const eff = foeTypes.length ? typeMultiplier(ctx.dex, move.type, foeTypes) : 1;
	if (eff === 0) {
		return { percent: 0, canKO: false, effectiveness: 0 };
	}

	const foeSpecies = ctx.dex.species.get(foe.speciesId);
	const foeBase = foeSpecies?.baseStats ?? { hp: 80, atk: 80, def: 80, spa: 80, spd: 80, spe: 80 };
	const foeLevel = foe.level || 100;
	const foeMaxHp = estimateMaxHpFromBase(foeBase.hp, foeLevel);

	const ourLevel = parseLevel(ctx.pokemon.details);
	const ourTypes = (() => {
		const s = ctx.dex.species.get(toID(ctx.pokemon.details.split(',')[0]));
		return s?.types ?? [];
	})();

	// Variable / fixed-damage moves have basePower 0. Use sensible fallbacks.
	let basePower = move.basePower;
	if (!basePower) {
		// Fixed-damage moves (Seismic Toss, Night Shade) deal damage = level.
		if (move.damage === 'level') {
			const dmg = ourLevel;
			const pct = (dmg / foeMaxHp) * 100;
			return { percent: pct, canKO: dmg >= estimateFoeCurrentHp(foe, ctx), effectiveness: eff };
		}
		if (typeof move.damage === 'number') {
			const pct = (move.damage / foeMaxHp) * 100;
			return { percent: pct, canKO: move.damage >= estimateFoeCurrentHp(foe, ctx), effectiveness: eff };
		}
		// OHKO moves.
		if (move.ohko) {
			return { percent: 100, canKO: true, effectiveness: eff };
		}
		// Otherwise assume a moderate 60 BP so the move isn't dismissed.
		basePower = 60;
	}

	// Attacker stat (real) vs defender stat (estimated).
	const isPhysical = move.category === 'Physical';
	const atkStat = isPhysical ? ctx.pokemon.stats.atk : ctx.pokemon.stats.spa;
	const defBase = isPhysical ? foeBase.def : foeBase.spd;
	const defStat = estimateStat(defBase, foeLevel);

	// Core damage formula (max roll, no random reduction).
	let damage = Math.floor(Math.floor(Math.floor(2 * ourLevel / 5 + 2) * basePower * atkStat / defStat) / 50) + 2;

	// STAB.
	if (ourTypes.includes(move.type)) damage = Math.floor(damage * 1.5);

	// Type effectiveness.
	damage = Math.floor(damage * eff);

	// Weather.
	const weather = ctx.view.weather as string | undefined;
	if (weather) {
		if (move.type === 'Fire' && WEATHER_FIRE_UP.has(weather)) damage = Math.floor(damage * 1.5);
		else if (move.type === 'Water' && WEATHER_WATER_UP.has(weather)) damage = Math.floor(damage * 1.5);
		else if (move.type === 'Fire' && WEATHER_WATER_UP.has(weather)) damage = Math.floor(damage * 0.5);
		else if (move.type === 'Water' && WEATHER_FIRE_UP.has(weather)) damage = Math.floor(damage * 0.5);
	}

	// Multi-hit moves: use the average number of hits.
	if (move.multihit) {
		const hits = Array.isArray(move.multihit)
			? (move.multihit[0] + move.multihit[1]) / 2 * 0.7 + move.multihit[0] * 0.3 // skew toward min
			: move.multihit;
		damage = Math.floor(damage * (Array.isArray(move.multihit) ? 3 : hits));
	}

	const currentHp = Math.max(1, Math.round(foeMaxHp * foe.hpPercent / 100));
	const percent = (damage / foeMaxHp) * 100;
	return { percent, canKO: damage >= currentHp, effectiveness: eff };
}

/** Estimate the foe's Speed stat (base stats, neutral, 31 IV, 0 EV). */
export function estimateFoeSpeed(foe: FoePokemon, ctx: ActiveContext): number {
	const species = ctx.dex.species.get(foe.speciesId);
	const baseSpe = species?.baseStats?.spe ?? 80;
	return estimateStat(baseSpe, foe.level || 100);
}

/** True if we (probably) move before the foe, ignoring move priority. */
export function weOutspeed(ctx: ActiveContext, foe: FoePokemon): boolean {
	const ourSpe = ctx.pokemon.stats.spe;
	const foeSpe = estimateFoeSpeed(foe, ctx);
	return ourSpe >= foeSpe;
}
