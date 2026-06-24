/**
 * Gen 3 in-game AI — flag-based scoring.
 *
 * RSE introduced trainer AI flags (bitmask). The "check viability" flag
 * enables a basic score system: penalize immune/NVE moves, bonus for SE,
 * penalize reapplying status the foe already has, small kill bonus.
 * No STAB weighting, no base power consideration, no accuracy check,
 * no ability immunity awareness. No switching.
 */

import type { PolicyChain } from '../types';
import { randomAction, randomForceSwitch, defaultTeamPreview } from '../policies';
import { ingameScoreMove, GEN3_CONFIG } from '../policies-ingame';

export function gen3IngameChain(): PolicyChain {
	return {
		action: [ingameScoreMove(GEN3_CONFIG), randomAction()],
		forceSwitch: [randomForceSwitch],
		teamPreview: [defaultTeamPreview],
	};
}
