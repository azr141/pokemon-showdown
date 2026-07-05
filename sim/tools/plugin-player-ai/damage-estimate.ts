/**
 * Plugin Player AI — damage estimation.
 *
 * The mainline in-game AI's core routine (`AI_TryToFaint` and the
 * damage-ranking selection in Gen 4+) runs a real damage calculation and
 * prefers the move that deals the most damage / can KO.
 *
 * The mainline AI is omniscient about the current foe: the game engine
 * calculates damage with the foe's REAL stats. When the opposing team has
 * been registered on the BattleView (`view.foeKnownSets`), we use those exact
 * stats. Otherwise we fall back to estimating the foe's defenses from its
 * species' base stats (31 IV / 0 EV / neutral nature) — the best we can do
 * from protocol-revealed info alone.
 *
 * What we always know exactly (from our own move request):
 *   - our own real stats (atk/def/spa/spd/spe) via `ctx.pokemon.stats`
 *   - our level, types, and each move's base power/type/category (via dex)
 *
 * We deliberately use a FIXED damage roll (the maximum, random factor = 1.0)
 * rather than a range: the mainline AI's KO check is computed on a single
 * optimistic roll, so it will commit to a move it believes can KO even when
 * the low roll would fall short. This matches observed in-game behavior.
 */

import { toID } from '../../dex';
import type { ActiveContext, MoveCandidate } from './types';
import type { FoePokemon, SideID } from './battle-view';
import { typeMultiplier, effectiveTypes } from './policies';

/** Standard stat formula for a non-HP stat. Neutral nature, 31 IV, 0 EV. */
function estimateStat(base: number, level: number): number {
	return Math.floor((2 * base + 31) * level / 100) + 5;
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

/** The foe's max HP — exact from the known set, else estimated from base. */
function getFoeMaxHp(foe: FoePokemon, ctx: ActiveContext): number {
	const known = ctx.view.foeKnownSets.get(foe.speciesId);
	if (known) return known.stats.hp;
	const species = ctx.dex.species.get(foe.speciesId);
	const baseHp = species?.baseStats?.hp ?? 80;
	return estimateMaxHpFromBase(baseHp, foe.level || 100);
}

/** The foe's relevant defense stat — exact from the known set, else estimated. */
function getFoeDefStat(foe: FoePokemon, ctx: ActiveContext, physical: boolean): number {
	const known = ctx.view.foeKnownSets.get(foe.speciesId);
	if (known) return physical ? known.stats.def : known.stats.spd;
	const species = ctx.dex.species.get(foe.speciesId);
	const base = species?.baseStats ?? { hp: 80, atk: 80, def: 80, spa: 80, spd: 80, spe: 80 };
	return estimateStat(physical ? base.def : base.spd, foe.level || 100);
}

const WEATHER_FIRE_UP = new Set(['sunnyday', 'desolateland']);
const WEATHER_WATER_UP = new Set(['raindance', 'primordialsea']);

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
 * the foe is immune to (by type) return 0 / canKO=false.
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

	const maxHp = getFoeMaxHp(foe, ctx);
	const curHp = Math.max(1, Math.round(maxHp * foe.hpPercent / 100));
	const ourLevel = parseLevel(ctx.pokemon.details);
	const ourTypes = ctx.dex.species.get(toID(ctx.pokemon.details.split(',')[0]))?.types ?? [];

	// Variable / fixed-damage moves have basePower 0. Use sensible fallbacks.
	let basePower = move.basePower;
	if (!basePower) {
		if (move.damage === 'level') {
			return { percent: (ourLevel / maxHp) * 100, canKO: ourLevel >= curHp, effectiveness: eff };
		}
		if (typeof move.damage === 'number') {
			return { percent: (move.damage / maxHp) * 100, canKO: move.damage >= curHp, effectiveness: eff };
		}
		if (move.ohko) {
			return { percent: 100, canKO: true, effectiveness: eff };
		}
		basePower = 60; // moderate fallback for variable-power moves
	}

	// Attacker stat (real) vs defender stat (exact if known, else estimated).
	const isPhysical = move.category === 'Physical';
	const atkStat = isPhysical ? ctx.pokemon.stats.atk : ctx.pokemon.stats.spa;
	const defStat = getFoeDefStat(foe, ctx, isPhysical);

	// Core damage formula (max roll, no random reduction).
	let damage = Math.floor(Math.floor(Math.floor(2 * ourLevel / 5 + 2) * basePower * atkStat / defStat) / 50) + 2;

	if (ourTypes.includes(move.type)) damage = Math.floor(damage * 1.5); // STAB
	damage = Math.floor(damage * eff); // type effectiveness

	// Weather (only Sun/Rain change Fire/Water damage).
	const weather = ctx.view.weather as string | undefined;
	if (weather) {
		if (move.type === 'Fire') {
			const mod = WEATHER_FIRE_UP.has(weather) ? 1.5 : WEATHER_WATER_UP.has(weather) ? 0.5 : 1;
			damage = Math.floor(damage * mod);
		} else if (move.type === 'Water') {
			const mod = WEATHER_WATER_UP.has(weather) ? 1.5 : WEATHER_FIRE_UP.has(weather) ? 0.5 : 1;
			damage = Math.floor(damage * mod);
		}
	}

	// Multi-hit moves: approximate with the number of hits.
	if (move.multihit) {
		const hits = Array.isArray(move.multihit) ? 3 : move.multihit;
		damage = Math.floor(damage * hits);
	}

	return { percent: (damage / maxHp) * 100, canKO: damage >= curHp, effectiveness: eff };
}

/** Estimate the foe's Speed stat — exact from the known set, else estimated. */
export function estimateFoeSpeed(foe: FoePokemon, ctx: ActiveContext): number {
	const known = ctx.view.foeKnownSets.get(foe.speciesId);
	if (known) return known.stats.spe;
	const species = ctx.dex.species.get(foe.speciesId);
	const baseSpe = species?.baseStats?.spe ?? 80;
	return estimateStat(baseSpe, foe.level || 100);
}

/** Our own major status token from the request condition ("152/300 par" → 'par'). */
function ownStatus(ctx: ActiveContext): string | undefined {
	const parts = (ctx.pokemon.condition || '').split(' ');
	return parts.length > 1 && parts[1] !== 'fnt' ? parts[1] : undefined;
}

/**
 * Apply the speed modifiers the battle engine itself applies — the mainline
 * AI's "who moves first" check runs on real engine speed, so replicating the
 * common modifiers here IS the faithful behavior (not an enhancement):
 * Choice Scarf ×1.5 / Iron Ball ×0.5, Tailwind ×2, paralysis (÷4 before
 * Gen 7, ÷2 from Gen 7).
 */
function effectiveSpeed(
	rawSpe: number, item: string | undefined, status: string | undefined,
	tailwind: boolean, gen: number
): number {
	let spe = rawSpe;
	if (item === 'choicescarf') spe = Math.floor(spe * 1.5);
	else if (item === 'ironball') spe = Math.floor(spe * 0.5);
	if (tailwind) spe *= 2;
	if (status === 'par') spe = Math.floor(spe * (gen >= 7 ? 0.5 : 0.25));
	return spe;
}

/** True if `side` currently has Tailwind up. */
function hasTailwind(ctx: ActiveContext, side: SideID | null): boolean {
	if (!side) return false;
	return !!ctx.view.sideState.get(side)?.conditions.has('tailwind' as ID);
}

/**
 * True if we move before the foe, ignoring move priority. Uses effective
 * speed (items / paralysis / Tailwind) and inverts under Trick Room —
 * matching the engine turn order the mainline AI consults.
 */
export function weOutspeed(ctx: ActiveContext, foe: FoePokemon): boolean {
	const known = ctx.view.foeKnownSets.get(foe.speciesId);
	const foeItem = (known?.item as string | undefined) ?? (foe.revealedItem as string | undefined);

	const ours = effectiveSpeed(
		ctx.pokemon.stats.spe, ctx.pokemon.item as string, ownStatus(ctx),
		hasTailwind(ctx, ctx.view.ourSide), ctx.gen,
	);
	const theirs = effectiveSpeed(
		estimateFoeSpeed(foe, ctx), foeItem, foe.status as string | undefined,
		hasTailwind(ctx, foe.side), ctx.gen,
	);

	// Trick Room: slower acts first.
	if (ctx.view.pseudoWeather.has('trickroom' as ID)) return ours <= theirs;
	return ours >= theirs;
}
