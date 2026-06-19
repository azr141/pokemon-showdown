/**
 * Plugin Player AI — gen registry.
 *
 * Maps a gen number to its default chain factory. Falls back to the
 * generation-agnostic default for gens that don't have a custom file yet.
 */

import type { PolicyChain } from '../types';
import type { RandomActionOptions } from '../policies';
import { defaultChain } from './default';
import { gen9Chain } from './gen9';

export { defaultChain, gen9Chain };

const registry: { [gen: number]: (opts?: RandomActionOptions) => PolicyChain } = {
	9: gen9Chain,
};

/** Return the chain factory for `gen`, or `defaultChain` if none is registered. */
export function getChainFactory(gen: number): (opts?: RandomActionOptions) => PolicyChain {
	return registry[gen] ?? defaultChain;
}

/** Convenience: build a chain for `gen` with `opts`. */
export function getChain(gen: number, opts?: RandomActionOptions): PolicyChain {
	return getChainFactory(gen)(opts);
}
