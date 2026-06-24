import type { PolicyChain } from '../types';
import { randomAction, randomForceSwitch, defaultTeamPreview } from '../policies';
import { ingameScoreMove, DEFAULT_CONFIG } from '../policies-ingame';

export function gen5IngameChain(): PolicyChain {
	return {
		action: [ingameScoreMove(DEFAULT_CONFIG), randomAction()],
		forceSwitch: [randomForceSwitch],
		teamPreview: [defaultTeamPreview],
	};
}
