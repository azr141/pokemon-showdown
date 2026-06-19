/**
 * Headless scenario runner.
 *
 * Wires a Scenario through PluginPlayerAI on each side, applies scenario
 * state (HP via PokemonSet, field/volatiles via apply.ts) once the battle
 * is seated, and streams the protocol log. Used by:
 *   - the `play-scenario` CLI command
 *   - the smoke / regression tests
 *   - eventually the PS server's `/scenario` command (it'll wrap this).
 *
 * Human players are not supported here — the CLI is AI-vs-AI. If a
 * scenario specifies `ai: 'human'` for either side, `playScenario` throws.
 */

import { BattleStream, getPlayerStreams } from '../../battle-stream';
import type { Battle } from '../../battle';
import { Dex } from '../../dex';
import { PluginPlayerAI } from '../plugin-player-ai/plugin-player-ai';
import { getAIChain, HUMAN_AI } from './registry';
import { validateScenario } from './load';
import { buildOnBattleStart } from './apply';
import type { Scenario } from './types';

/**
 * Backward-compat re-export. As of M8 we pass scenario state via the
 * `>start` options (BattleOptions.scenarioState), and the engine applies
 * it inside the 'start' choice handler — no stream subclass needed.
 * Kept exported so existing imports don't break.
 */
export const ScenarioBattleStream = BattleStream;

export interface PlayScenarioOptions {
	/** If true, print each protocol chunk to stdout as it arrives. */
	output?: boolean;
	/**
	 * Called with each protocol chunk (multi-line string ending in '\n').
	 * Use to capture logs for replay storage or piping to a UI.
	 */
	onChunk?: (chunk: string) => void;
}

export interface PlayScenarioResult {
	winner: string | null;
	turns: number;
	ended: boolean;
	log: string[];
}

/** Run a scenario headlessly to completion (AI vs AI). */
export async function playScenario(
	scenario: Scenario,
	options: PlayScenarioOptions = {},
): Promise<PlayScenarioResult> {
	const problems = validateScenario(scenario);
	if (problems.length) throw new Error(`Invalid scenario:\n  ${problems.join('\n  ')}`);

	if (scenario.p1.ai === HUMAN_AI || scenario.p2.ai === HUMAN_AI) {
		throw new Error(`Headless play does not support 'human' players. Use the PS server's /scenario command instead.`);
	}

	const format = Dex.formats.get(scenario.format);
	const gen = format.exists ? format.mod === 'base' ? Dex.gen : Dex.forFormat(format).gen : Dex.gen;

	// Strip Team Preview for scenario play: the team order is already fixed
	// by the JSON, so team preview would just be a no-op `default` round-trip
	// that delays our field/volatile application past turn 1.
	const formatId = scenario.format.includes('@@@') ?
		`${scenario.format},!Team Preview` :
		`${scenario.format}@@@!Team Preview`;

	const streams = getPlayerStreams(new BattleStream({
		noCatch: true,
		onBattleStart: buildOnBattleStart(scenario),
	}));
	const baseSpec: AnyObject = { formatid: formatId, scenarioState: scenario };
	if (scenario.seed) baseSpec.seed = scenario.seed;
	const spec = baseSpec;
	// Pass the team as a raw PokemonSet[] (not Teams.pack(...)). The packed
	// team format doesn't carry scenario-only fields like `hp`; the engine
	// accepts either a string or an array, so we hand it the array verbatim.
	const p1spec = { name: scenario.p1.name ?? 'Bot 1', team: scenario.p1.team };
	const p2spec = { name: scenario.p2.name ?? 'Bot 2', team: scenario.p2.team };

	const chainP1 = getAIChain(scenario.p1.ai ?? 'default', gen);
	const chainP2 = getAIChain(scenario.p2.ai ?? 'default', gen);
	const p1 = new PluginPlayerAI(streams.p1, { chain: chainP1, gen });
	const p2 = new PluginPlayerAI(streams.p2, { chain: chainP2, gen });

	void p1.start();
	void p2.start();

	void streams.omniscient.write(
		`>start ${JSON.stringify(spec)}\n` +
		`>player p1 ${JSON.stringify(p1spec)}\n` +
		`>player p2 ${JSON.stringify(p2spec)}`,
	);

	const log: string[] = [];
	let winner: string | null = null;
	let turns = 0;
	let ended = false;
	for await (const chunk of streams.omniscient) {
		log.push(chunk);
		if (options.output) process.stdout.write(chunk);
		options.onChunk?.(chunk);
		for (const line of chunk.split('\n')) {
			if (line.startsWith('|turn|')) turns = parseInt(line.split('|')[2]) || turns;
			if (line.startsWith('|win|')) { winner = line.slice(5); ended = true; }
			if (line.startsWith('|tie')) { ended = true; }
		}
	}
	return { winner, turns, ended, log };
}
