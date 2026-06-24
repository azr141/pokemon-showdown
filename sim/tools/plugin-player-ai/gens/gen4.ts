/**
 * Gen 4 in-game AI — full scoring.
 *
 * DPP expanded the score system significantly. Each move starts at 100.
 * Modifiers for: type effectiveness (biggest factor), STAB, base power,
 * accuracy, weather boost (Sun→Fire, Rain→Water only), status reapplication,
 * recovery at low HP, priority moves on low-HP foe, setup penalty at low HP,
 * self-KO move penalty, ability-based immunity (Levitate, etc.).
 * No switching.
 */

import type { PolicyChain } from '../types';
import { randomAction, randomForceSwitch, defaultTeamPreview } from '../policies';
import { ingameScoreMove, GEN4_CONFIG } from '../policies-ingame';

export function gen4IngameChain(): PolicyChain {
	return {
		action: [ingameScoreMove(GEN4_CONFIG), randomAction()],
		forceSwitch: [randomForceSwitch],
		teamPreview: [defaultTeamPreview],
	};
}
