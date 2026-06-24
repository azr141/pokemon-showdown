import type { PolicyChain } from '../types';
import { randomAction, randomForceSwitch, defaultTeamPreview } from '../policies';
import { ingameScoreMove, megaImmediately, DEFAULT_CONFIG } from '../policies-ingame';

export function gen6IngameChain(): PolicyChain {
	return {
		action: [megaImmediately(DEFAULT_CONFIG), ingameScoreMove(DEFAULT_CONFIG), randomAction()],
		forceSwitch: [randomForceSwitch],
		teamPreview: [defaultTeamPreview],
	};
}
