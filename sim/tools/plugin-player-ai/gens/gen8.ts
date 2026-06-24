import type { PolicyChain } from '../types';
import { randomAction, randomForceSwitch, defaultTeamPreview } from '../policies';
import { ingameScoreMove, dynamaxOnLastMon, DEFAULT_CONFIG } from '../policies-ingame';

export function gen8IngameChain(): PolicyChain {
	return {
		action: [dynamaxOnLastMon(DEFAULT_CONFIG), ingameScoreMove(DEFAULT_CONFIG), randomAction()],
		forceSwitch: [randomForceSwitch],
		teamPreview: [defaultTeamPreview],
	};
}
