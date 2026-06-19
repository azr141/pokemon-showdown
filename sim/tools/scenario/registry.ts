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
import { defaultChain, getChain, gen9Chain } from '../plugin-player-ai/gens';

export type ChainBuilder = (gen: number) => PolicyChain;

const registry: Record<string, ChainBuilder> = {
	random: () => defaultChain(),
	default: gen => getChain(gen),
	gen9tactical: () => gen9Chain(),
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
