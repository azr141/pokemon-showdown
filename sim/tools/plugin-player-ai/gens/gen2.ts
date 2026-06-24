/**
 * Gen 2 in-game AI — weighted random.
 *
 * Same as Gen 1: weighted random based on type effectiveness.
 * Gen 2 added held items and new types (Dark, Steel) but the trainer
 * AI logic remained fundamentally the same weighted-random system.
 * No scoring, no STAB, no switching.
 */

import type { PolicyChain } from '../types';
import { randomAction, randomForceSwitch, defaultTeamPreview } from '../policies';
import { gen1WeightedRandom } from '../policies-ingame';

export function gen2IngameChain(): PolicyChain {
	return {
		action: [gen1WeightedRandom(), randomAction()],
		forceSwitch: [randomForceSwitch],
		teamPreview: [defaultTeamPreview],
	};
}
