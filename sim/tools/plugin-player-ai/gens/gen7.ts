import type { PolicyChain } from '../types';
import { randomAction, randomForceSwitch, defaultTeamPreview } from '../policies';
import { ingameScoreMove, useZMoveAggressively, DEFAULT_CONFIG } from '../policies-ingame';

export function gen7IngameChain(): PolicyChain {
	return {
		action: [useZMoveAggressively(DEFAULT_CONFIG), ingameScoreMove(DEFAULT_CONFIG), randomAction()],
		forceSwitch: [randomForceSwitch],
		teamPreview: [defaultTeamPreview],
	};
}
