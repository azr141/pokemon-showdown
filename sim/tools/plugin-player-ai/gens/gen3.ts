import type { PolicyChain } from '../types';
import { randomAction, randomForceSwitch, defaultTeamPreview } from '../policies';
import { ingameScoreMove, type IngameConfig } from '../policies-ingame';

const GEN3_CONFIG: IngameConfig = {
	immunePenalty: -1000,
	nvePenalty: -10,
	seBonus: 15,
	stabBonus: 5,
	basePowerWeight: 0.3,
	statusPenalty: -10,
	reapplyStatusPenalty: -50,
	lowHpRecoveryBonus: 0,
	lowHpFoeKillBonus: 5,
	weatherBonus: 0,
};

export function gen3IngameChain(): PolicyChain {
	return {
		action: [ingameScoreMove(GEN3_CONFIG), randomAction()],
		forceSwitch: [randomForceSwitch],
		teamPreview: [defaultTeamPreview],
	};
}
