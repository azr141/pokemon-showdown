/**
 * Gen 1 in-game AI — weighted random.
 *
 * Real Gen 1 "Good AI" (gym leaders, E4) uses weighted random selection
 * based on type effectiveness. Moves are NOT scored — they're sampled
 * with weights proportional to how effective they are:
 *   - Immune:          excluded (weight 0)
 *   - Not very effective: weight 1
 *   - Neutral:           weight 2
 *   - Super effective:   weight 6
 *
 * No STAB, no base power, no status logic, no switching.
 */

import type { PolicyChain } from '../types';
import { randomAction, randomForceSwitch, defaultTeamPreview } from '../policies';
import { gen1WeightedRandom } from '../policies-ingame';

export function gen1IngameChain(): PolicyChain {
	return {
		action: [gen1WeightedRandom(), randomAction()],
		forceSwitch: [randomForceSwitch],
		teamPreview: [defaultTeamPreview],
	};
}
