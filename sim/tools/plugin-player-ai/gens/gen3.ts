/**
 * Gen 3 in-game AI — flag-based scoring (RSE).
 *
 * Base score 100. Runs the documented routines: AI_CheckBadMove (avoid
 * type-immune moves, don't re-apply an existing status), AI_TryToFaint
 * (compute damage; strongly favor a move that KOs, weighted by speed/
 * priority), and a light AI_CheckViability pass (don't heal at high HP,
 * don't set up at low HP, don't re-set weather).
 *
 * Gen 3 is deliberately LOOSE: the strongest non-KO move gets only a +1
 * preference (`bestDamageBonus`), so when nothing KOs, Gen 3 trainers
 * frequently pick sub-optimal moves — matching the games' reputation.
 * No ability-immunity awareness, no Explosion caution. No switching.
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
