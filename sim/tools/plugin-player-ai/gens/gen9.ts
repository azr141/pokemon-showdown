/**
 * Plugin Player AI — gen 9 chain.
 *
 * Example of how a per-generation file composes tactical policies on top
 * of the default chain. The shape any other gen-N file should follow:
 *   1. Build a chain that prepends gen-specific tactical policies.
 *   2. Append the gen-agnostic fallbacks from defaultChain at the end.
 * Anything truly gen-specific (e.g. tera type selection in gen 9, dynamax
 * preference in gen 8, z-move targeting in gen 7) lives here.
 */

import type { PolicyChain } from '../types';
import {
	superEffectiveMove, switchToResist, randomAction, randomForceSwitch,
	defaultTeamPreview, type RandomActionOptions,
} from '../policies';
import { ingameScoreMove, teraOnLastMon, switchOnBadMatchup, GEN4_CONFIG, GEN9_SWITCH } from '../policies-ingame';

export function gen9Chain(opts: RandomActionOptions = {}): PolicyChain {
	return {
		action: [
			superEffectiveMove,
			switchToResist,
			randomAction(opts),
		],
		forceSwitch: [randomForceSwitch],
		teamPreview: [defaultTeamPreview],
	};
}

/**
 * Gen 9 in-game AI — full scoring + Terastallization + proactive switching.
 *
 * Same scoring as gen 4/5. SV is the first mainline AI that pivots: it reads
 * the opposing Pokemon's type and switches to a defensive answer when the
 * active is at a super-effective disadvantage and can't KO first. NPCs
 * terastallize their LAST Pokemon (ace) — trigger is no remaining switches.
 */
export function gen9IngameChain(): PolicyChain {
	return {
		action: [
			switchOnBadMatchup(GEN9_SWITCH),
			teraOnLastMon(GEN4_CONFIG),
			ingameScoreMove(GEN4_CONFIG),
			randomAction(),
		],
		forceSwitch: [randomForceSwitch],
		teamPreview: [defaultTeamPreview],
	};
}
