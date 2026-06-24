/**
 * Gen 4 in-game AI — damage-driven scoring (DPP).
 *
 * Base score 100, same routines as Gen 3 but tighter. The key difference:
 * the single highest-damage move gets a +3 preference (`bestDamageBonus`),
 * so Gen 4 trainers reliably use their strongest move when they can't KO.
 * Also respects the foe's revealed ability immunities (Levitate blocks
 * Ground, Flash Fire blocks Fire, the absorb abilities, etc.) and avoids
 * Explosion/Self-Destruct unless it secures a KO. No switching.
 *
 * Damage is computed by damage-estimate.ts: our real attack stats vs the
 * foe's defenses estimated from base stats (31 IV / 0 EV / neutral nature).
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
