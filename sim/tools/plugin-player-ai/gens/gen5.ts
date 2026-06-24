/**
 * Gen 5 in-game AI — full scoring (same as gen 4).
 *
 * BW refined the score system but the core algorithm is the same as DPP.
 * Same modifiers apply. No switching.
 */

import type { PolicyChain } from '../types';
import { randomAction, randomForceSwitch, defaultTeamPreview } from '../policies';
import { ingameScoreMove, GEN4_CONFIG } from '../policies-ingame';

export function gen5IngameChain(): PolicyChain {
	return {
		action: [ingameScoreMove(GEN4_CONFIG), randomAction()],
		forceSwitch: [randomForceSwitch],
		teamPreview: [defaultTeamPreview],
	};
}
