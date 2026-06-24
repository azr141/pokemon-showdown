/**
 * Gen 8 in-game AI — full scoring + Dynamax.
 *
 * Same scoring as gen 4/5. NPCs dynamax their LAST Pokemon (ace).
 * The trigger is having no remaining switches — not HP thresholds or
 * tactical evaluation. No switching.
 */

import type { PolicyChain } from '../types';
import { randomAction, randomForceSwitch, defaultTeamPreview } from '../policies';
import { ingameScoreMove, dynamaxOnLastMon, GEN4_CONFIG } from '../policies-ingame';

export function gen8IngameChain(): PolicyChain {
	return {
		action: [dynamaxOnLastMon(GEN4_CONFIG), ingameScoreMove(GEN4_CONFIG), randomAction()],
		forceSwitch: [randomForceSwitch],
		teamPreview: [defaultTeamPreview],
	};
}
