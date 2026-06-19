/**
 * CLI scenario play.
 *
 * Runs a scenario in-process (no PS server, no WebSocket) with the
 * `human` side controlled by stdin. The AI side(s) use the same
 * PluginPlayerAI chain you'd get via the scenario `ai` field.
 *
 * This bypasses the PS client / auth / SockJS layer entirely — you get
 * an interactive battle straight from the engine, exactly the same
 * choice protocol the engine speaks.
 *
 * Each turn the script prints:
 *   - your active pokemon's HP/status
 *   - foe(s) on the field, with HP %
 *   - legal moves (numbered, with target type if doubles)
 *   - legal switches (numbered)
 * Then prompts for input.
 *
 * Input syntax (lowercase):
 *   move 1                    use slot-1 move on the default foe
 *   move 2 1                  use slot-2 move on foe at position 1 (doubles)
 *   switch 3                  switch to team slot 3
 *   move 1 mega / dynamax / terastallize / ultra
 *   pass                      pass (rare)
 *   help                      print this list
 *
 * Run via `node pokemon-showdown cli-play SCENARIO_NAME`.
 */

import * as readline from 'readline';

import { BattleStream, getPlayerStreams } from '../../battle-stream';
import { BattlePlayer } from '../../battle-stream';
import { Dex } from '../../dex';
import { PluginPlayerAI } from '../plugin-player-ai/plugin-player-ai';
import type { ChoiceRequest, MoveRequest, SwitchRequest } from '../../side';
import { getAIChain, HUMAN_AI } from './registry';
import { validateScenario, loadScenario } from './load';
import { buildOnBattleStart } from './apply';
import type { Scenario } from './types';

const HELP = `
Choices:
  move N [TARGET] [mega|dynamax|terastallize|ultra]
  switch N
  pass
  help
Examples: "move 1", "move 3 mega", "switch 2"
`.trim();

class CliHumanPlayer extends BattlePlayer {
	private rl: readline.Interface;
	private prompting = false;

	constructor(playerStream: any, rl: readline.Interface) {
		super(playerStream);
		this.rl = rl;
	}

	override receiveError(error: Error) {
		if (error.message.startsWith('[Unavailable choice]')) return;
		if (error.message.startsWith('[Invalid choice]')) {
			console.log(`\n  ✗ ${error.message}`);
			console.log(`  Try again. Type 'help' for syntax.\n`);
			// The engine will resend the request automatically; just wait.
			return;
		}
		throw error;
	}

	override receiveRequest(request: ChoiceRequest) {
		if (request.wait) return;
		if (request.teamPreview) {
			// Scenarios run with team preview stripped, so this shouldn't fire.
			// If it does, just send default.
			this.choose('default');
			return;
		}
		if (request.forceSwitch) {
			this.promptForceSwitch(request as SwitchRequest);
			return;
		}
		if (request.active) {
			this.promptMove(request as MoveRequest);
			return;
		}
	}

	private prompt(question: string, handler: (input: string) => void) {
		if (this.prompting) {
			// Shouldn't happen in singles, but guard against re-entrant prompts.
			return;
		}
		this.prompting = true;
		this.rl.question(question, (line) => {
			this.prompting = false;
			handler(line.trim());
		});
	}

	private formatHpStatus(condition: string): string {
		// condition is like "150/357" or "42/100 par" or "0 fnt"
		return condition || '?';
	}

	private describeOwnTeam(req: MoveRequest | SwitchRequest): string {
		const lines: string[] = [];
		for (let i = 0; i < req.side.pokemon.length; i++) {
			const p = req.side.pokemon[i];
			const marker = p.active ? '*' : ' ';
			lines.push(`  ${marker}${i + 1}. ${p.details.split(',')[0]}  ${this.formatHpStatus(p.condition)}`);
		}
		return lines.join('\n');
	}

	private promptMove(req: MoveRequest) {
		const active = req.active[0];
		const myActive = req.side.pokemon.find(p => p.active);
		console.log(`\n────────── Turn (your move) ──────────`);
		console.log(`Your team:`);
		console.log(this.describeOwnTeam(req));

		console.log(`\nMoves for ${myActive?.details.split(',')[0]}:`);
		for (let i = 0; i < active.moves.length; i++) {
			const m = active.moves[i];
			const disabled = m.disabled ? ' [DISABLED]' : '';
			console.log(`  ${i + 1}. ${m.move}${disabled}`);
		}

		if (active.canTerastallize) console.log(`  (can terastallize: ${active.canTerastallize})`);
		if (active.canMegaEvo) console.log(`  (can mega evolve)`);
		if (active.canDynamax) console.log(`  (can dynamax)`);

		if (!active.trapped) {
			console.log(`\nAvailable switches:`);
			const benched = req.side.pokemon.filter((p, i) => !p.active && !p.condition.endsWith(' fnt'));
			if (benched.length === 0) {
				console.log(`  (none)`);
			} else {
				for (let i = 0; i < req.side.pokemon.length; i++) {
					const p = req.side.pokemon[i];
					if (p.active || p.condition.endsWith(' fnt')) continue;
					console.log(`  switch ${i + 1}: ${p.details.split(',')[0]} (${this.formatHpStatus(p.condition)})`);
				}
			}
		} else {
			console.log(`\n(trapped — cannot switch)`);
		}

		this.prompt('> ', (line) => {
			if (line === 'help' || !line) {
				console.log(HELP);
				this.promptMove(req);
				return;
			}
			this.choose(line);
		});
	}

	private promptForceSwitch(req: SwitchRequest) {
		console.log(`\n────────── Forced switch ──────────`);
		console.log(this.describeOwnTeam(req));
		console.log(`\nPick a replacement:`);
		this.prompt('> switch ', (line) => {
			const choice = /^\d+$/.test(line) ? `switch ${line}` : line;
			this.choose(choice);
		});
	}
}

export async function playScenarioCli(scenario: Scenario): Promise<void> {
	const problems = validateScenario(scenario);
	if (problems.length) throw new Error(`Invalid scenario:\n  ${problems.join('\n  ')}`);

	const humanSides: Array<'p1' | 'p2'> = [];
	for (const side of ['p1', 'p2'] as const) {
		if (scenario[side].ai === HUMAN_AI || !scenario[side].ai) humanSides.push(side);
	}
	if (humanSides.length === 0) {
		throw new Error(`Scenario has no human side — use /scenario play for AI-vs-AI.`);
	}
	if (humanSides.length === 2) {
		throw new Error(`Both sides marked human. CLI play supports human vs AI only.`);
	}
	const humanSide = humanSides[0];
	const aiSide = humanSide === 'p1' ? 'p2' : 'p1';

	const format = Dex.formats.get(scenario.format);
	const gen = format.exists ? (format.mod === 'base' ? Dex.gen : Dex.forFormat(format).gen) : Dex.gen;
	const aiChain = getAIChain(scenario[aiSide].ai ?? 'default', gen);

	const formatId = scenario.format.includes('@@@') ?
		`${scenario.format},!Team Preview` :
		`${scenario.format}@@@!Team Preview`;

	const streams = getPlayerStreams(new BattleStream({
		noCatch: true,
		onBattleStart: buildOnBattleStart(scenario),
	}));
	const spec: AnyObject = { formatid: formatId, scenarioState: scenario };
	if (scenario.seed) spec.seed = scenario.seed;
	const humanSpec = { name: scenario[humanSide].name ?? 'You', team: scenario[humanSide].team };
	const aiSpec = { name: scenario[aiSide].name ?? 'AI', team: scenario[aiSide].team };

	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

	const humanPlayer = new CliHumanPlayer(streams[humanSide], rl);
	const aiPlayer = new PluginPlayerAI(streams[aiSide], { chain: aiChain, gen });

	void humanPlayer.start();
	void aiPlayer.start();

	const startMsg =
		`>start ${JSON.stringify(spec)}\n` +
		`>player p1 ${JSON.stringify(humanSide === 'p1' ? humanSpec : aiSpec)}\n` +
		`>player p2 ${JSON.stringify(humanSide === 'p2' ? humanSpec : aiSpec)}`;
	void streams.omniscient.write(startMsg);

	console.log(`\n=== Scenario: ${scenario.name ?? '(unnamed)'} ===`);
	console.log(`You are ${scenario[humanSide].name ?? 'player'} (${humanSide}).`);
	console.log(`Opponent: ${scenario[aiSide].name ?? 'AI'} (${aiSide}, ai=${scenario[aiSide].ai ?? 'default'}).`);
	console.log(`Type 'help' at any prompt for syntax.\n`);

	let winner: string | null = null;
	for await (const chunk of streams.omniscient) {
		// Pull out the "your active vs foe active" updates so the human can
		// see what just happened. We deliberately don't dump the raw protocol
		// log — that would be noisy. Just the move/damage lines that humans
		// care about between requests.
		for (const line of chunk.split('\n')) {
			if (line.startsWith('|move|')) console.log(`  ${formatMoveLine(line)}`);
			else if (line.startsWith('|-damage|')) console.log(`  ${formatDamageLine(line)}`);
			else if (line.startsWith('|-heal|')) console.log(`  ${formatHealLine(line)}`);
			else if (line.startsWith('|-status|')) console.log(`  ${formatStatusLine(line)}`);
			else if (line.startsWith('|faint|')) console.log(`  ${formatFaintLine(line)}`);
			else if (line.startsWith('|switch|') || line.startsWith('|drag|')) console.log(`  ${formatSwitchLine(line)}`);
			else if (line.startsWith('|-weather|')) console.log(`  Weather: ${line.split('|')[2]}`);
			else if (line.startsWith('|-supereffective|')) console.log(`  → super-effective!`);
			else if (line.startsWith('|-resisted|')) console.log(`  → resisted`);
			else if (line.startsWith('|-immune|')) console.log(`  → immune!`);
			else if (line.startsWith('|-crit|')) console.log(`  → critical hit!`);
			else if (line.startsWith('|-miss|')) console.log(`  → missed`);
			else if (line.startsWith('|win|')) { winner = line.slice(5); }
			// Exact match: the engine's tie marker is bare `|tie` (no payload).
			// startsWith('|tie') would false-match `|tier|...` and end the
			// battle on the very first chunk.
			else if (line === '|tie' || line.startsWith('|tie|')) { winner = '(tie)'; }
		}
		if (winner !== null) break;
	}

	console.log(`\n=== Battle over — winner: ${winner} ===`);
	rl.close();
}

function formatMoveLine(line: string): string {
	// |move|p1a: Garchomp|Earthquake|p2a: Skarmory
	const parts = line.split('|');
	const actor = parts[2]?.split(': ')[1] ?? '?';
	const move = parts[3] ?? '?';
	const target = parts[4]?.split(': ')[1] ?? '';
	return `${actor} used ${move}${target ? ` on ${target}` : ''}`;
}
function formatDamageLine(line: string): string {
	const parts = line.split('|');
	const target = parts[2]?.split(': ')[1] ?? '?';
	const hp = parts[3] ?? '?';
	return `${target}: ${hp}`;
}
function formatHealLine(line: string): string {
	const parts = line.split('|');
	const target = parts[2]?.split(': ')[1] ?? '?';
	const hp = parts[3] ?? '?';
	return `${target} healed: ${hp}`;
}
function formatStatusLine(line: string): string {
	const parts = line.split('|');
	const target = parts[2]?.split(': ')[1] ?? '?';
	const status = parts[3] ?? '?';
	return `${target} was ${status}`;
}
function formatFaintLine(line: string): string {
	const parts = line.split('|');
	return `${parts[2]?.split(': ')[1] ?? '?'} fainted`;
}
function formatSwitchLine(line: string): string {
	const parts = line.split('|');
	const slot = parts[2]?.split(': ')[0] ?? '?';
	const species = parts[3]?.split(',')[0] ?? '?';
	return `${slot} sent out ${species}`;
}

export function playScenarioCliByName(name: string): Promise<void> {
	const path = `config/scenarios/${name}.json`;
	const scenario = loadScenario(path);
	return playScenarioCli(scenario);
}
