import type { PolicyChain } from '../types';
import { randomAction, randomForceSwitch, defaultTeamPreview } from '../policies';
import { ingameScoreMove, type IngameConfig } from '../policies-ingame';

const GEN1_CONFIG: IngameConfig = {
	immunePenalty: -100,
	nvePenalty: -5,
	seBonus: 5,
	stabBonus: 0,
	basePowerWeight: 0,
	statusPenalty: 0,
	reapplyStatusPenalty: 0,
	lowHpRecoveryBonus: 0,
	lowHpFoeKillBonus: 0,
	weatherBonus: 0,
};

export function gen1IngameChain(): PolicyChain {
	return {
		action: [ingameScoreMove(GEN1_CONFIG), randomAction()],
		forceSwitch: [randomForceSwitch],
		teamPreview: [defaultTeamPreview],
	};
}
