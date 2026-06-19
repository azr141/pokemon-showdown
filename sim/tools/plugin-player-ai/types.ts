/**
 * Plugin Player AI — types.
 *
 * The plugin player composes its behavior from a chain of policy functions.
 * Each policy inspects a context object and returns either a Decision (for
 * action / forced-switch policies) or a team-order string (for team preview).
 * Returning null means "abstain"; the next policy in the chain is consulted.
 *
 * A chain should always terminate in a fallback policy that never abstains
 * (typically the random ones from `./policies`).
 */

import type { PRNG } from '../../prng';
import type { ModdedDex } from '../../dex';
import type {
	MoveRequest, SwitchRequest, TeamPreviewRequest,
	PokemonMoveRequestData, PokemonSwitchRequestData,
} from '../../side';
import type { BattleView } from './battle-view';
import type { PluginPlayerAI } from './plugin-player-ai';

/** One legal move action available to the active pokemon. */
export interface MoveCandidate {
	/** 1-indexed slot in the active pokemon's move list (as the protocol expects). */
	slot: number;
	/** Display name of the move. */
	move: string;
	/** Targeting type from the request (e.g. 'normal', 'self', 'adjacentAlly'). */
	target: string;
	/** Whether this candidate represents the Z-move variant of the slot. */
	zMove: boolean;
	/** Whether this candidate represents the Max-move variant (gen 8 only). */
	maxMove: boolean;
	/** Raw move entry from the request (regular move, z-move, or max-move). */
	raw: AnyObject;
}

/** One legal switch action available. */
export interface SwitchCandidate {
	/** 1-indexed team slot (as the protocol expects). */
	slot: number;
	pokemon: PokemonSwitchRequestData;
}

/** Mid-action form change that can be appended to a move command in gen 6+. */
export type FormChange = 'mega' | 'megax' | 'megay' | 'ultra' | 'dynamax' | 'terastallize';

export interface MoveDecision {
	kind: 'move';
	candidate: MoveCandidate;
	/** Targeting position for doubles/triples (1-indexed, negative for ally). */
	targetLoc?: number;
	/** Optional form change to append (e.g. terastallize). */
	formChange?: FormChange;
}

export interface SwitchDecision {
	kind: 'switch';
	candidate: SwitchCandidate;
}

export type Decision = MoveDecision | SwitchDecision;

/** Context passed to every action policy on an active-pokemon (move) request. */
export interface ActiveContext {
	player: PluginPlayerAI;
	request: MoveRequest;
	/** Active-pokemon data for the slot we're choosing for. */
	active: PokemonMoveRequestData;
	/** Index of the active slot in `request.active` (0 = first active, etc.). */
	activeIndex: number;
	/** Switch-request data for our active pokemon at this slot. */
	pokemon: PokemonSwitchRequestData;
	/** Legal moves (post-filter for unavailable/disabled and target validity). */
	moves: MoveCandidate[];
	/** Legal switches (excludes fainted, active, trapped, already-chosen). */
	switches: SwitchCandidate[];
	canMega: boolean;
	canUltra: boolean;
	canDynamax: boolean;
	canTerastallize: boolean;
	canZMove: boolean;
	view: BattleView;
	dex: ModdedDex;
	gen: number;
	prng: PRNG;
}

/** Context passed to forced-switch policies (after faint / Volt Switch / etc.). */
export interface ForceSwitchContext {
	player: PluginPlayerAI;
	request: SwitchRequest;
	/** The pokemon being switched out (may be fainted). */
	pokemon: PokemonSwitchRequestData;
	/** Active slot index this switch is for. */
	index: number;
	switches: SwitchCandidate[];
	view: BattleView;
	dex: ModdedDex;
	gen: number;
	prng: PRNG;
}

/** Context passed to team-preview policies. */
export interface TeamPreviewContext {
	player: PluginPlayerAI;
	request: TeamPreviewRequest;
	team: PokemonSwitchRequestData[];
	maxChosenTeamSize?: number;
	view: BattleView;
	dex: ModdedDex;
	gen: number;
	prng: PRNG;
}

export type ActionPolicy = (ctx: ActiveContext) => Decision | null;
export type ForceSwitchPolicy = (ctx: ForceSwitchContext) => SwitchDecision | null;
/** Returns a team-order string like `"team 123456"` or `"default"`. */
export type TeamPreviewPolicy = (ctx: TeamPreviewContext) => string | null;

/**
 * Bundle of policy chains for a player. Each chain is tried in order; the
 * first non-null result wins. A chain must end in a fallback that never
 * abstains, or the player will throw.
 */
export interface PolicyChain {
	action: ActionPolicy[];
	forceSwitch: ForceSwitchPolicy[];
	teamPreview: TeamPreviewPolicy[];
}
