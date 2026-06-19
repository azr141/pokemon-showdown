/**
 * Scenario module — public exports.
 *
 *   import { loadScenario, playScenario } from './sim/tools/scenario';
 */

export * from './types';
export { loadScenario, saveScenario, validateScenario, validateScenarioTeams } from './load';
export { getAIChain, registerAI, listAIs, HUMAN_AI } from './registry';
export type { ChainBuilder } from './registry';
export { playScenario, ScenarioBattleStream } from './play';
export type { PlayScenarioOptions, PlayScenarioResult } from './play';
export { playScenarioCli, playScenarioCliByName } from './cli-play';
export { InteractiveSession } from './interactive';
export type { InteractiveSessionSnapshot, PrettyEvent } from './interactive';
export {
	applyScenarioState, applyField, applyVolatiles, applyGimmicks, buildOnBattleStart,
	ALLOWED_WEATHERS, ALLOWED_TERRAINS, ALLOWED_PSEUDO_WEATHERS, ALLOWED_SIDE_CONDITIONS,
	allowedWeathersForGen, allowedTerrainsForGen, allowedPseudoWeathersForGen, allowedSideConditionsForGen,
} from './apply';
export type { ScenarioSide } from './apply';
