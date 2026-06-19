/**
 * Apply scenario state to a running battle.
 *
 * Starting HP is handled directly by the engine (see PokemonSet.hp in
 * sim/teams.ts and the init code in sim/pokemon.ts), so this module
 * doesn't need to touch it.
 *
 * Field conditions (M3) and volatiles (M4) are applied here via direct
 * mutation of the Battle object after both players are set, immediately
 * before the first turn begins. The hooks live in ScenarioBattleStream
 * (./play.ts) which calls into these helpers at the right moment.
 */

import type { Battle } from '../../battle';
import type { Scenario, ScenarioField, ScenarioFieldEffect, ScenarioVolatile, ScenarioGimmickState } from './types';

/**
 * Normalize a `ScenarioFieldEffect` (string OR {id, turnsRemaining}) to a
 * canonical object. Lets the rest of apply.ts treat both shapes uniformly.
 */
function normalizeEffect(e: ScenarioFieldEffect): { id: ID, turnsRemaining?: number, layers?: number } {
	if (typeof e === 'string') return { id: e };
	return { id: e.id, turnsRemaining: e.turnsRemaining, layers: (e as any).layers };
}

/**
 * Apply scenario field state (weather / terrain / pseudo-weather / side
 * conditions). For mid-battle snapshots, we mutate engine state directly
 * rather than going through `setWeather` / `setTerrain` / `addSideCondition`
 * — those fire `WeatherChange` / `TerrainStart` / `SideStart` events, and
 * those events trigger reactive items (Psychic Seed activating when
 * terrain comes up), abilities, and so on. A scenario where "Psychic
 * Terrain has been up for 2 turns" should NOT mean "Psychic Seed activates
 * right now"; we present the state as fait accompli.
 *
 * We still emit the `|-weather|` / `|-fieldstart|` / `|-sidestart|` log
 * lines so the UI can render the chips. We just skip the event chain.
 */
export function applyField(battle: Battle, field: ScenarioField | undefined): void {
	if (!field) return;

	if (field.weather) {
		const { id, turnsRemaining } = normalizeEffect(field.weather);
		if (!ALLOWED_WEATHERS.includes(id)) {
			throw new Error(`Scenario weather '${id}' is not in the allow-list.`);
		}
		silentSetWeather(battle, id, turnsRemaining);
	}

	if (field.terrain) {
		const { id, turnsRemaining } = normalizeEffect(field.terrain);
		if (!ALLOWED_TERRAINS.includes(id)) {
			throw new Error(`Scenario terrain '${id}' is not in the allow-list.`);
		}
		silentSetTerrain(battle, id, turnsRemaining);
	}

	if (field.pseudoWeather) {
		for (const entry of field.pseudoWeather) {
			const { id, turnsRemaining } = normalizeEffect(entry);
			if (!ALLOWED_PSEUDO_WEATHERS.includes(id)) {
				throw new Error(`Scenario pseudoWeather '${id}' is not in the allow-list.`);
			}
			silentAddPseudoWeather(battle, id, turnsRemaining);
		}
	}

	if (field.sideConditions) {
		for (const sideKey of ['p1', 'p2'] as const) {
			const conditions = field.sideConditions[sideKey];
			if (!conditions) continue;
			for (const entry of conditions) {
				const { id, turnsRemaining, layers } = normalizeEffect(entry);
				if (!ALLOWED_SIDE_CONDITIONS.includes(id)) {
					throw new Error(`Scenario sideCondition '${id}' on ${sideKey} is not in the allow-list.`);
				}
				silentAddSideCondition(battle, sideKey, id, turnsRemaining, layers);
			}
		}
	}
}

// ---- Silent setters: mutate engine state without firing reactive events ----

function silentSetWeather(battle: Battle, id: ID, turnsRemaining?: number): void {
	const status = battle.dex.conditions.get(id);
	if (!status.exists) return;
	(battle.field as any).weather = status.id;
	(battle.field as any).weatherState = battle.initEffectState({ id: status.id });
	const dur = turnsRemaining ?? (status as any).duration;
	if (dur) (battle.field as any).weatherState.duration = Math.max(1, dur);
	battle.add('-weather', status.name);
}

function silentSetTerrain(battle: Battle, id: ID, turnsRemaining?: number): void {
	const status = battle.dex.conditions.get(id);
	if (!status.exists) return;
	(battle.field as any).terrain = status.id;
	(battle.field as any).terrainState = battle.initEffectState({ id: status.id });
	const dur = turnsRemaining ?? (status as any).duration;
	if (dur) (battle.field as any).terrainState.duration = Math.max(1, dur);
	battle.add('-fieldstart', `move: ${status.name}`);
}

function silentAddPseudoWeather(battle: Battle, id: ID, turnsRemaining?: number): void {
	const status = battle.dex.conditions.get(id);
	if (!status.exists) return;
	const state = battle.initEffectState({ id: status.id });
	const dur = turnsRemaining ?? (status as any).duration;
	if (dur) state.duration = Math.max(1, dur);
	(battle.field as any).pseudoWeather[status.id] = state;
	battle.add('-fieldstart', `move: ${status.name}`);
}

/**
 * Mirror of PS's actual `-sidestart` log format. The engine is inconsistent
 * about whether the effect name carries a `move:` prefix — `move: Stealth
 * Rock`, `move: Sticky Web`, `move: Tailwind`, `move: Light Screen`,
 * `move: Aurora Veil`, `move: Lucky Chant`, `move: Toxic Spikes` get the
 * prefix; `Spikes`, `Reflect`, `Mist`, `Safeguard` don't. Replicate that so
 * our silent emit matches the protocol the UI / smoke tests expect.
 */
const SIDESTART_MOVE_PREFIX: ReadonlySet<string> = new Set([
	'stealthrock', 'stickyweb', 'toxicspikes',
	'tailwind', 'lightscreen', 'auroraveil', 'luckychant',
]);

function silentAddSideCondition(
	battle: Battle, sideKey: 'p1' | 'p2', id: ID, turnsRemaining?: number, layers?: number,
): void {
	const status = battle.dex.conditions.get(id);
	if (!status.exists) return;
	const side = (battle as any)[sideKey];
	if (!side) return;
	const state = battle.initEffectState({ id: status.id });
	const dur = turnsRemaining ?? (status as any).duration;
	if (dur) state.duration = Math.max(1, dur);
	if (typeof layers === 'number') {
		const max = id === 'toxicspikes' ? 2 : (id === 'spikes' ? 3 : 1);
		state.layers = Math.max(1, Math.min(max, layers));
	}
	side.sideConditions[status.id] = state;
	const label = SIDESTART_MOVE_PREFIX.has(id) ? `move: ${status.name}` : status.name;
	battle.add('-sidestart', side, label);
}

const VALID_BOOST_IDS = new Set(['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion']);
const VALID_MAJOR_STATUSES = new Set(['psn', 'tox', 'brn', 'par', 'slp', 'frz']);

/**
 * Apply scenario volatiles (boosts, major status) to the indicated pokemon.
 *
 * - Boosts are written directly via Pokemon.setBoost (no TryBoost / Defiant
 *   event chain), then logged via `|-setboost|`. This matches scenario
 *   semantics: the mon is "already" boosted — reactive abilities shouldn't
 *   trigger.
 * - Status uses Pokemon.setStatus with `ignoreImmunities=true` so a scenario
 *   can put burn on a Fire-type, etc. — this is intentional for stress tests.
 *   The condition's onStart runs (so Toxic correctly starts its counter at 1).
 *
 * Boosts on benched (inactive) pokemon are skipped with a thrown error — they
 * would be silently wiped on switch-in. Status on benched mons is valid.
 */
export function applyVolatiles(battle: Battle, volatiles: ScenarioVolatile[] | undefined): void {
	if (!volatiles?.length) return;
	for (const vol of volatiles) {
		if (vol.side !== 'p1' && vol.side !== 'p2') {
			throw new Error(`Scenario volatile: unknown side '${vol.side}'.`);
		}
		const side = battle[vol.side];
		if (!side) throw new Error(`Scenario volatile: side '${vol.side}' not found in battle.`);
		const pokemon = side.pokemon[vol.slot - 1];
		if (!pokemon) {
			throw new Error(`Scenario volatile: ${vol.side} has no pokemon at slot ${vol.slot}.`);
		}

		if (vol.boosts) {
			if (!pokemon.isActive) {
				throw new Error(
					`Scenario volatile: boosts on benched pokemon (${vol.side} slot ${vol.slot}) would be wiped on switch-in.`,
				);
			}
			for (const [stat, value] of Object.entries(vol.boosts)) {
				if (!VALID_BOOST_IDS.has(stat)) {
					throw new Error(`Scenario volatile: unknown boost stat '${stat}'.`);
				}
				if (!Number.isInteger(value) || value! < -6 || value! > 6) {
					throw new Error(`Scenario volatile: boost ${stat} must be an integer in [-6, 6].`);
				}
			}
			pokemon.setBoost(vol.boosts as AnyObject);
			for (const stat of Object.keys(vol.boosts)) {
				battle.add('-setboost', pokemon, stat, (pokemon.boosts as any)[stat], '[silent]');
			}
			// Emit a single visible marker so a UI replay can show "starts boosted".
			const summary = Object.entries(vol.boosts).map(([s, v]) => `${s}${v! >= 0 ? '+' : ''}${v}`).join(' ');
			battle.add('-message', `${pokemon.name} starts the battle with: ${summary}`);
		}

		if (vol.status) {
			if (!VALID_MAJOR_STATUSES.has(vol.status)) {
				throw new Error(`Scenario volatile: unknown major status '${vol.status}'.`);
			}
			pokemon.setStatus(vol.status, pokemon, null, true);
		}

		if (vol.confused !== undefined) {
			if (!pokemon.isActive) {
				throw new Error(
					`Scenario volatile: confused on benched pokemon (${vol.side} slot ${vol.slot}) would be wiped on switch-in.`,
				);
			}
			const turns = Math.max(1, Math.min(5, Math.floor(vol.confused)));
			pokemon.addVolatile('confusion', pokemon);
			// addVolatile's onStart rolls a random duration; override it so the
			// scenario can express "confused for 3 more turns".
			const st = pokemon.volatiles['confusion'];
			if (st) (st as any).time = turns;
		}
	}
}

/**
 * Apply everything (called once after both sides are seated).
 *
 * Note on log ordering: Battle.start() emits `|switch|` and `|turn|1` into
 * battle.log before our hook runs, so newly-emitted field/volatile lines
 * land at the end (after `|turn|1`). We splice them to immediately before
 * `|turn|1` so the protocol log reads coherently for UI replay. The
 * underlying battle state mutation is already correct in-place — this is
 * purely a cosmetic reordering of log lines.
 */
export function applyScenarioState(battle: Battle, scenario: Scenario): void {
	const log = (battle as any).log as string[];
	const before = log.length;
	applyField(battle, scenario.field);
	applyVolatiles(battle, scenario.volatiles);
	applyGimmicks(battle, scenario.gimmicks);
	const after = log.length;
	if (after > before) {
		const newEntries = log.splice(before, after - before);
		const turnIdx = log.findIndex(l => l.startsWith('|turn|'));
		const insertAt = turnIdx >= 0 ? turnIdx : log.length;
		log.splice(insertAt, 0, ...newEntries);
	}
}

export function applyGimmicks(
	battle: Battle,
	gimmicks: { p1?: ScenarioGimmickState; p2?: ScenarioGimmickState } | undefined,
): void {
	if (!gimmicks) return;
	for (const sideKey of ['p1', 'p2'] as const) {
		const g = gimmicks[sideKey];
		if (!g) continue;
		const side = battle[sideKey];
		if (!side) continue;

		if (g.megaUsed) {
			(side as any).megaEvolved = true;
		}
		if (g.zMoveUsed) {
			(side as any).zMoveUsed = true;
		}
		if (g.teraUsed) {
			(side as any).terastallized = true;
		}
		if (g.dynamaxTurnsLeft && g.dynamaxTurnsLeft > 0) {
			(side as any).dynamaxUsed = true;
			const active = side.active[0];
			if (active && !active.fainted) {
				active.addVolatile('dynamax', active);
				const vol = active.volatiles['dynamax'];
				if (vol) (vol as any).turns = 3 - Math.min(3, g.dynamaxTurnsLeft);
			}
		}
	}
}

// Helpers used by M3/M4 (kept here so the registry of valid ids lives next to
// the apply code). Both lists are deliberately small; broaden them only when
// you have a use case.

export const ALLOWED_WEATHERS: readonly ID[] = ([
	'sunnyday', 'desolateland',
	'raindance', 'primordialsea',
	'sandstorm',
	'snow', 'snowscape', 'hail',
	'deltastream',
] as string[]) as readonly ID[];

export const ALLOWED_TERRAINS: readonly ID[] = ([
	'electricterrain',
	'grassyterrain',
	'mistyterrain',
	'psychicterrain',
] as string[]) as readonly ID[];

export const ALLOWED_PSEUDO_WEATHERS: readonly ID[] = ([
	'trickroom', 'magicroom', 'wonderroom',
	'gravity',
	'fairylock',
] as string[]) as readonly ID[];

export const ALLOWED_SIDE_CONDITIONS: readonly ID[] = ([
	'stealthrock', 'spikes', 'toxicspikes', 'stickyweb',
	'reflect', 'lightscreen', 'auroraveil',
	'tailwind', 'mist', 'safeguard',
	'luckychant',
] as string[]) as readonly ID[];

const GEN_MIN: Record<string, number> = {
	desolateland: 6, primordialsea: 6, deltastream: 6,
	snow: 9, snowscape: 9,
	electricterrain: 6, grassyterrain: 6, mistyterrain: 6, psychicterrain: 7,
	fairylock: 6,
	stickyweb: 6, auroraveil: 7,
};

export function allowedWeathersForGen(gen: number): readonly ID[] {
	return ALLOWED_WEATHERS.filter(id => (GEN_MIN[id] ?? 1) <= gen);
}
export function allowedTerrainsForGen(gen: number): readonly ID[] {
	return ALLOWED_TERRAINS.filter(id => (GEN_MIN[id] ?? 1) <= gen);
}
export function allowedPseudoWeathersForGen(gen: number): readonly ID[] {
	return ALLOWED_PSEUDO_WEATHERS.filter(id => (GEN_MIN[id] ?? 1) <= gen);
}
export function allowedSideConditionsForGen(gen: number): readonly ID[] {
	return ALLOWED_SIDE_CONDITIONS.filter(id => (GEN_MIN[id] ?? 1) <= gen);
}

export type ScenarioSide = 'p1' | 'p2';

/**
 * Build the `onBattleStart` callback for a given scenario. Handles
 * startingPoint semantics (mid vs start) and then applies field/volatiles.
 * Pass the returned function to BattleStream's `onBattleStart` option.
 */
export function buildOnBattleStart(scenario: Scenario): (battle: Battle) => void {
	return (battle: Battle) => {
		const startingPoint = (scenario as any).startingPoint ?? 'mid';
		if (startingPoint === 'mid') {
			while ((battle as any).queue.peek()?.choice === 'runSwitch') {
				const action = (battle as any).queue.shift()!;
				if (action.pokemon) action.pokemon.isStarted = true;
			}
		} else if (startingPoint === 'early') {
			while ((battle as any).queue.peek()?.choice === 'runSwitch') {
				const action = (battle as any).queue.shift()!;
				(battle as any).actions.runSwitch(action.pokemon!);
			}
		}
		applyScenarioState(battle, scenario);
	};
}
