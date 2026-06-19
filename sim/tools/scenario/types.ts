/**
 * Scenario types.
 *
 * A scenario is a saveable starting state for a battle: who's on each side
 * (including custom starting HP), what field conditions are already in
 * place, and what volatiles (boosts / major status) the active pokemon
 * start with. Designed to be JSON-serializable so it round-trips through
 * disk and the eventual UI scenario builder.
 *
 * Field conditions and volatiles are declarative; the simulator applies
 * them before turn 1 (see ./apply.ts, implemented in milestones M3 and M4).
 */

import type { PokemonSet } from '../../teams';

/**
 * A field effect entry. Either a bare id (uses the engine's default duration)
 * or an object with the id plus how many turns should remain when the battle
 * starts. Turns-remaining lets you express scenarios like "rain has 2 turns
 * left" without having to wait it out.
 */
export type ScenarioFieldEffect = ID | {
	id: ID,
	/** Turns the effect should have remaining when the battle starts. */
	turnsRemaining?: number,
	/**
	 * Hazard layer count (Spikes 1-3, Toxic Spikes 1-2). Ignored for
	 * non-layered side conditions. Defaults to 1 when omitted on a
	 * layered hazard.
	 */
	layers?: number,
};

/** Field-wide state applied before the first turn. */
export interface ScenarioField {
	/** Weather (sunnyday / raindance / sandstorm / snow / snowscape / etc.). */
	weather?: ScenarioFieldEffect;
	/** Terrain (electricterrain / grassyterrain / mistyterrain / psychicterrain). */
	terrain?: ScenarioFieldEffect;
	/** Pseudo-weather (trickroom / gravity / magicroom / etc.). */
	pseudoWeather?: ScenarioFieldEffect[];
	/** Side conditions per side (hazards, screens, tailwind, mist, etc.). */
	sideConditions?: {
		p1?: ScenarioFieldEffect[];
		p2?: ScenarioFieldEffect[];
	};
	/**
	 * Optional backdrop id (e.g. "forest", "beach", "stadium"). Purely cosmetic;
	 * the Scenario UI resolves it to an image via /api/scenario/assets and
	 * paints it behind the battle stage. Omit for the default weather-reactive
	 * gradient.
	 */
	backdrop?: string;
}

/**
 * A single-pokemon volatile setup. Applied at battle start, before turn 1.
 *
 * Scope (deliberately strict to avoid invalid mid-battle interactions):
 * - `boosts`: stat-stage changes from -6..+6 per stat. Only meaningful on
 *   active pokemon (boosts reset on switch out anyway).
 * - `status`: a major status condition.
 *
 * Things like substitute, leech seed, taunt, encore, and move-locks are
 * intentionally NOT supported here — they have cascading interactions that
 * aren't safe to fake at turn 0.
 */
export interface ScenarioVolatile {
	side: 'p1' | 'p2';
	/** 1-indexed team slot. Slot 1 is the active pokemon in singles. */
	slot: number;
	boosts?: Partial<BoostsTable>;
	status?: 'psn' | 'tox' | 'brn' | 'par' | 'slp' | 'frz';
	/**
	 * Confusion volatile, with the number of turns it should remain. Range
	 * 1-5 (the engine normally rolls 2-5). Active pokemon only — confusion
	 * wipes on switch like other volatiles.
	 */
	confused?: number;
}

/**
 * Per-side gimmick usage flags. Applied at battle start to mark that a
 * gimmick has already been used (or is mid-use) in a mid-battle snapshot.
 */
export interface ScenarioGimmickState {
	/** True if this side has already Mega Evolved this battle. */
	megaUsed?: boolean;
	/** True if this side has already used its Z-Move this battle. */
	zMoveUsed?: boolean;
	/**
	 * If set, the active Pokemon is currently Dynamaxed with this many
	 * turns remaining (1-3). Omit if Dynamax hasn't been used or already
	 * ended. Setting this also marks Dynamax as used for the side.
	 */
	dynamaxTurnsLeft?: number;
	/** True if this side has already Terastallized this battle. */
	teraUsed?: boolean;
}

/** Per-side configuration: name, who plays it (AI id or 'human'), team. */
export interface ScenarioPlayer {
	name?: string;
	/**
	 * AI key from the registry, or `'human'` for the player to be controlled
	 * interactively (only valid in UI / chat-command paths, not headless CLI).
	 */
	ai?: string;
	team: PokemonSet[];
	/**
	 * Optional trainer sprite id (e.g. "lance", "red", "ace-trainer-gen6").
	 * Resolved to an image URL via /api/scenario/assets. Cosmetic only —
	 * the Scenario UI uses it for trainer cards / vs-screens.
	 */
	avatar?: string;
}

/** Full scenario. Saved as JSON to disk. */
export interface Scenario {
	/** Display name, e.g. 'Down to two'. Optional; the filename is the canonical id. */
	name?: string;
	/** Free-text description. */
	description?: string;
	/** Format id, e.g. 'gen9customgame'. */
	format: string;
	p1: ScenarioPlayer;
	p2: ScenarioPlayer;
	field?: ScenarioField;
	volatiles?: ScenarioVolatile[];
	/** Optional PRNG seed for reproducibility. */
	seed?: string;
	/**
	 * If true, players see the opponent's full team (items, abilities, moves)
	 * even before they're revealed by play. Useful for scenarios where the
	 * matchup is meant to be known up front. Default false.
	 */
	openTeamsheet?: boolean;
	/**
	 * How to interpret the scenario:
	 *
	 *   'start' — fresh battle, leads enter normally. HP overrides and major
	 *             status are allowed (e.g. "Pikachu enters at half HP, burned");
	 *             field must be empty, confusion + boosts not allowed
	 *             (those imply a turn has already passed). Abilities like
	 *             Drizzle and Intimidate fire on entry as in any normal battle.
	 *
	 *   'mid'   — mid-battle snapshot. Anything goes — weather, hazards, boosts,
	 *             confusion, screens, terrains. NOTHING triggers on battle
	 *             start: ability-on-switchin (Drizzle, Psychic Surge),
	 *             item-on-switchin (seeds, focus sash setup), hazard damage
	 *             on the leads — all suppressed. Subsequent switch-ins behave
	 *             as normal.
	 *
	 * Default: 'mid' (most scenarios are mid-battle snapshots).
	 */
	startingPoint?: 'start' | 'mid';
	/**
	 * Per-side gimmick usage state. Marks Mega/Z-Move/Dynamax/Tera as
	 * already used so the player can't use them again. Only meaningful
	 * with startingPoint='mid'.
	 */
	gimmicks?: {
		p1?: ScenarioGimmickState;
		p2?: ScenarioGimmickState;
	};
}
