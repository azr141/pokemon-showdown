/**
 * Plugin Player AI — public exports.
 *
 * Typical usage:
 *
 *   import { PluginPlayerAI, getChain } from './sim/tools/plugin-player-ai';
 *   const player = new PluginPlayerAI(stream, { chain: getChain(9) });
 *
 * Or, to build a custom chain inline:
 *
 *   import { PluginPlayerAI, superEffectiveMove, randomAction, ... } from '...';
 *   const chain = {
 *     action: [superEffectiveMove, randomAction()],
 *     forceSwitch: [randomForceSwitch],
 *     teamPreview: [defaultTeamPreview],
 *   };
 *   const player = new PluginPlayerAI(stream, { chain });
 */

export { PluginPlayerAI } from './plugin-player-ai';
export type { PluginPlayerOptions } from './plugin-player-ai';
export { BattleView } from './battle-view';
export type { FoePokemon, SideState, SideID } from './battle-view';
export * from './types';
export * from './policies';
export { getChain, getChainFactory, defaultChain, gen9Chain } from './gens';
