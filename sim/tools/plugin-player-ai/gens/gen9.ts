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
import { superEffectiveMove, switchToResist, randomAction, randomForceSwitch, defaultTeamPreview, type RandomActionOptions } from '../policies';

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
