/**
 * Faithful AI chains — the exact-port AI (see ../policies-faithful.ts),
 * parameterised by trainer skill tier (which AI_FLAG_* scripts run).
 *
 * Currently ports the Gen 3 (Emerald) algorithm; per-gen/per-game variants
 * are added over time. Kept separate from the polished `ingame` chains so
 * both are selectable.
 */

import type { PolicyChain } from '../types';
import { randomAction, randomForceSwitch, defaultTeamPreview } from '../policies';
import { faithfulScoreMove, FAITHFUL_TIERS, type AiFlags } from '../policies-faithful';

export function faithfulChain(flags: AiFlags): PolicyChain {
	return {
		action: [faithfulScoreMove(flags), randomAction()],
		forceSwitch: [randomForceSwitch],
		teamPreview: [defaultTeamPreview],
	};
}

export const faithfulWildChain = () => faithfulChain(FAITHFUL_TIERS.wild);
export const faithfulGruntChain = () => faithfulChain(FAITHFUL_TIERS.grunt);
export const faithfulGymChain = () => faithfulChain(FAITHFUL_TIERS.gym);
export const faithfulAceChain = () => faithfulChain(FAITHFUL_TIERS.ace);
