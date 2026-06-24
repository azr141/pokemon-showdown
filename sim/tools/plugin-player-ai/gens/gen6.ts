/**
 * Gen 6 in-game AI — full scoring + Mega Evolution.
 *
 * Same scoring as gen 4/5. NPCs with mega stones ALWAYS mega evolve on
 * their first available turn — this is hardcoded in the game, not a
 * decision. No switching.
 */

import type { PolicyChain } from '../types';
import { randomAction, randomForceSwitch, defaultTeamPreview } from '../policies';
import { ingameScoreMove, megaImmediately, GEN4_CONFIG } from '../policies-ingame';

export function gen6IngameChain(): PolicyChain {
	return {
		action: [megaImmediately(GEN4_CONFIG), ingameScoreMove(GEN4_CONFIG), randomAction()],
		forceSwitch: [randomForceSwitch],
		teamPreview: [defaultTeamPreview],
	};
}
