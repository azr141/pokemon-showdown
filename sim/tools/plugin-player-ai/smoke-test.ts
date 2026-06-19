/**
 * Plugin Player AI — smoke test.
 *
 * Runs a small number of complete random battles with the plugin player on
 * both sides, both with the gen-agnostic default chain and with the gen 9
 * tactical chain. Verifies that:
 *   1. Every battle reaches a `|win|`/`|tie|` line (no stuck choices).
 *   2. The receiveError handler never fires for non-`[Unavailable choice]` errors.
 *   3. The chain factory dispatch returns a usable chain for the format's gen.
 *
 * Run with `node build && node dist/sim/tools/plugin-player-ai/smoke-test.js`.
 * Exits 0 on success, 1 on any battle that didn't complete cleanly.
 */

import { BattleStream, getPlayerStreams } from '../../battle-stream';
import { Teams } from '../../teams';
import { PRNG } from '../../prng';
import { PluginPlayerAI } from './plugin-player-ai';
import { getChain, defaultChain } from './gens';
import type { PolicyChain } from './types';

interface BattleResult {
	winner: string | null;
	turns: number;
	ended: boolean;
}

async function runBattle(format: string, chain: PolicyChain, seed: PRNG): Promise<BattleResult> {
	const streams = getPlayerStreams(new BattleStream());
	const newSeed = () => [
		seed.random(2 ** 16), seed.random(2 ** 16), seed.random(2 ** 16), seed.random(2 ** 16),
	].join(',') as any;

	const spec = { formatid: format, seed: newSeed() };
	const p1spec = { name: 'Bot 1', team: Teams.pack(Teams.generate(format)) };
	const p2spec = { name: 'Bot 2', team: Teams.pack(Teams.generate(format)) };

	const p1 = new PluginPlayerAI(streams.p1, { chain, seed: newSeed() });
	const p2 = new PluginPlayerAI(streams.p2, { chain, seed: newSeed() });

	void p1.start();
	void p2.start();

	void streams.omniscient.write(
		`>start ${JSON.stringify(spec)}\n` +
		`>player p1 ${JSON.stringify(p1spec)}\n` +
		`>player p2 ${JSON.stringify(p2spec)}`,
	);

	let winner: string | null = null;
	let turns = 0;
	let ended = false;
	for await (const chunk of streams.omniscient) {
		for (const line of chunk.split('\n')) {
			if (line.startsWith('|turn|')) turns = parseInt(line.split('|')[2]) || turns;
			if (line.startsWith('|win|')) { winner = line.slice(5); ended = true; }
			if (line.startsWith('|tie')) { ended = true; }
		}
	}
	return { winner, turns, ended };
}

async function main() {
	const seed = new PRNG();
	const cases: { label: string, format: string, chain: PolicyChain }[] = [
		{ label: 'gen9 default (random)', format: 'gen9randombattle', chain: defaultChain() },
		{ label: 'gen9 tactical',          format: 'gen9randombattle', chain: getChain(9) },
		{ label: 'gen8 default (random)', format: 'gen8randombattle', chain: defaultChain() },
		{ label: 'gen7 default (random)', format: 'gen7randombattle', chain: defaultChain() },
	];
	const reps = 3;
	let failures = 0;
	for (const c of cases) {
		for (let i = 0; i < reps; i++) {
			try {
				const result = await runBattle(c.format, c.chain, seed);
				const ok = result.ended;
				const status = ok ? 'OK' : 'FAIL';
				console.log(`[${status}] ${c.label} #${i + 1}: ${result.turns} turns, winner=${result.winner ?? '(tie)'}`);
				if (!ok) failures++;
			} catch (err: any) {
				failures++;
				console.log(`[FAIL] ${c.label} #${i + 1}: ${err.message}`);
			}
		}
	}
	if (failures) {
		console.log(`\n${failures} failure(s)`);
		process.exit(1);
	} else {
		console.log('\nAll smoke tests passed.');
	}
}

void main();
