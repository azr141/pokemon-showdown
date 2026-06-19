/**
 * Plugin Player AI — generation-agnostic default chain.
 *
 * This is the baseline behavior every gen-specific chain extends. It
 * reproduces RandomPlayerAI's behavior verbatim (random move, random
 * forced switch, default team preview) and is also the chain returned by
 * `getChain(gen)` for any gen that doesn't have a custom override.
 *
 * A gen-specific chain typically prepends tactical policies, leaving the
 * random fallbacks in place at the end so the chain always terminates.
 */

import type { PolicyChain } from '../types';
import { randomAction, randomForceSwitch, defaultTeamPreview, type RandomActionOptions } from '../policies';

export function defaultChain(opts: RandomActionOptions = {}): PolicyChain {
	return {
		action: [randomAction(opts)],
		forceSwitch: [randomForceSwitch],
		teamPreview: [defaultTeamPreview],
	};
}
