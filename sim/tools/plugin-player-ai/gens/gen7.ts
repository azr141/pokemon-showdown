/**
 * Gen 7 in-game AI — full scoring + Z-Moves.
 *
 * Same scoring as gen 4/5. NPCs use Z-moves aggressively — on the first
 * opportunity, applied to their strongest/most effective attacking move.
 * They do not conserve Z-moves for later. No switching.
 */

import type { PolicyChain } from '../types';
import { randomAction, randomForceSwitch, defaultTeamPreview } from '../policies';
import { ingameScoreMove, useZMoveAggressively, GEN4_CONFIG } from '../policies-ingame';

export function gen7IngameChain(): PolicyChain {
	return {
		action: [useZMoveAggressively(GEN4_CONFIG), ingameScoreMove(GEN4_CONFIG), randomAction()],
		forceSwitch: [randomForceSwitch],
		teamPreview: [defaultTeamPreview],
	};
}
