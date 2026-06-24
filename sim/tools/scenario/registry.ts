/**
 * AI registry for scenarios.
 *
 * Maps scenario `ai` strings to PolicyChain builders. The builder takes the
 * gen detected from the format so the same key (e.g. 'default') can return
 * gen-appropriate behavior.
 *
 * Add new entries here when you ship a new chain. Keep the surface small —
 * scenario JSONs are versioned by the keys this registry exposes.
 */

import type { PolicyChain } from '../plugin-player-ai/types';
import {
	defaultChain, getChain, gen9Chain, getIngameChain,
	gen1IngameChain, gen2IngameChain, gen3IngameChain,
	gen4IngameChain, gen5IngameChain, gen6IngameChain,
	gen7IngameChain, gen8IngameChain, gen9IngameChain,
} from '../plugin-player-ai/gens';

export type ChainBuilder = (gen: number) => PolicyChain;

const registry: Record<string, ChainBuilder> = {
	random: () => defaultChain(),
	default: gen => getChain(gen),
	gen9tactical: () => gen9Chain(),
	ingame: gen => getIngameChain(gen),
	gen1ingame: () => gen1IngameChain(),
	gen2ingame: () => gen2IngameChain(),
	gen3ingame: () => gen3IngameChain(),
	gen4ingame: () => gen4IngameChain(),
	gen5ingame: () => gen5IngameChain(),
	gen6ingame: () => gen6IngameChain(),
	gen7ingame: () => gen7IngameChain(),
	gen8ingame: () => gen8IngameChain(),
	gen9ingame: () => gen9IngameChain(),
};

/** The id used when a scenario marks a slot as human-controlled. */
export const HUMAN_AI = 'human';

export function registerAI(id: string, builder: ChainBuilder) {
	if (id === HUMAN_AI) throw new Error(`'${HUMAN_AI}' is reserved`);
	registry[id] = builder;
}

export function getAIChain(id: string, gen: number): PolicyChain {
	const builder = registry[id];
	if (!builder) throw new Error(`Unknown AI id: '${id}'`);
	return builder(gen);
}

export function listAIs(): string[] {
	return [HUMAN_AI, ...Object.keys(registry)].sort();
}
