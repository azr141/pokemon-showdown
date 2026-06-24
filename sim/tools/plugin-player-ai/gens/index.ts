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
import { gen1IngameChain } from './gen1';
import { gen2IngameChain } from './gen2';
import { gen3IngameChain } from './gen3';
import { gen4IngameChain } from './gen4';
import { gen5IngameChain } from './gen5';
import { gen6IngameChain } from './gen6';
import { gen7IngameChain } from './gen7';
import { gen8IngameChain } from './gen8';
import { gen9IngameChain } from './gen9';

export { defaultChain, gen9Chain };
export {
	gen1IngameChain, gen2IngameChain, gen3IngameChain,
	gen4IngameChain, gen5IngameChain, gen6IngameChain,
	gen7IngameChain, gen8IngameChain, gen9IngameChain,
};

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

const ingameRegistry: { [gen: number]: () => PolicyChain } = {
	1: gen1IngameChain,
	2: gen2IngameChain,
	3: gen3IngameChain,
	4: gen4IngameChain,
	5: gen5IngameChain,
	6: gen6IngameChain,
	7: gen7IngameChain,
	8: gen8IngameChain,
	9: gen9IngameChain,
};

/** Build the in-game AI chain for the given gen. Falls back to gen 4/5 scoring for unknown gens. */
export function getIngameChain(gen: number): PolicyChain {
	const factory = ingameRegistry[gen] ?? gen4IngameChain;
	return factory();
}
