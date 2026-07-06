/**
 * Gen 8 in-game AI — full scoring + Dynamax + last-resort switching.
 *
 * Same scoring as gen 4/5. SwSh is a Dynamax-and-swing AI: it only switches
 * out when the active is super-effectively threatened AND can't hit back
 * hard (a hopeless matchup), matching how rarely story trainers pivot. NPCs
 * dynamax their LAST Pokemon (ace) — the trigger is having no remaining
 * switches, not HP thresholds.
 */

import type { PolicyChain } from '../types';
import { randomAction, randomForceSwitch, defaultTeamPreview } from '../policies';
import { ingameScoreMove, dynamaxOnLastMon, switchOnBadMatchup, GEN4_CONFIG, GEN8_SWITCH } from '../policies-ingame';

export function gen8IngameChain(): PolicyChain {
	return {
		action: [
			switchOnBadMatchup(GEN8_SWITCH),
			dynamaxOnLastMon(GEN4_CONFIG),
			ingameScoreMove(GEN4_CONFIG),
			randomAction(),
		],
		forceSwitch: [randomForceSwitch],
		teamPreview: [defaultTeamPreview],
	};
}
