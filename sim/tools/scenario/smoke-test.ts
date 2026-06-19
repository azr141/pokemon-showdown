/**
 * Scenario smoke test.
 *
 * Loads the bundled example scenario, plays it AI-vs-AI to completion, and
 * verifies the engine actually honored the scenario:
 *   1. The battle ends with a winner or tie.
 *   2. PokemonSet.hp overrides are applied (Garchomp starts at 150, Skarmory at 80).
 *   3. (TODO M3) Field state is applied before turn 1.
 *   4. (TODO M4) Volatiles are applied before turn 1.
 *
 * Also runs a "no overrides" control: a copy of the scenario with hp fields
 * stripped — those mons should start at full HP.
 *
 * Run with `node build && node dist/sim/tools/scenario/smoke-test.js`.
 */

import * as path from 'path';
import { loadScenario, playScenario, validateScenario, type Scenario } from './index';

// Resolved relative to the repo root (where you run `node dist/...` from).
const EXAMPLE_PATH = path.join(process.cwd(), 'config', 'scenarios', 'example-3v3.json');

interface Check { ok: boolean; label: string; detail?: string }

function check(label: string, ok: boolean, detail?: string): Check {
	return { label, ok, detail };
}

/**
 * Pull the first switch-in HP for a given slot from the raw omniscient log.
 * The omniscient stream emits both halves of each `|split|` block; the FIRST
 * `|switch|` line for a slot is always the privileged (absolute-HP) view,
 * since the spectator view is pushed immediately after.
 */
function firstSwitchHp(log: string, slot: string): { cur: number, max: number } | null {
	const re = new RegExp(`\\|switch\\|${slot}: [^|]+\\|[^|]+\\|(\\d+)/(\\d+)`);
	const m = log.match(re);
	if (!m) return null;
	return { cur: parseInt(m[1]), max: parseInt(m[2]) };
}

async function main() {
	const allChecks: Check[] = [];

	const scenario = loadScenario(EXAMPLE_PATH);
	// The example doubles as a sandbox for interactive play, so p1.ai might
	// be 'human' on disk. The headless smoke suite always coerces both sides
	// to deterministic AIs so it doesn't care what AI a developer has set.
	if (scenario.p1.ai === 'human' || !scenario.p1.ai) scenario.p1.ai = 'gen9tactical';
	if (scenario.p2.ai === 'human' || !scenario.p2.ai) scenario.p2.ai = 'random';

	// Case 1: scenario as written — HP overrides on Garchomp (150) and Skarmory (80).
	{
		const { checks, log } = await runWithLog('example-3v3', scenario);
		allChecks.push(...checks);

		const garchomp = firstSwitchHp(log, 'p1a');
		allChecks.push(check(
			'example-3v3: Garchomp starts at hp=150',
			!!garchomp && garchomp.cur === 150,
			garchomp ? `observed ${garchomp.cur}/${garchomp.max}` : 'no switch line for p1a',
		));

		const skarmory = firstSwitchHp(log, 'p2a');
		allChecks.push(check(
			'example-3v3: Skarmory starts at hp=80',
			!!skarmory && skarmory.cur === 80,
			skarmory ? `observed ${skarmory.cur}/${skarmory.max}` : 'no switch line for p2a',
		));
	}

	// Case 2: control — strip hp overrides; those mons should start at full HP.
	{
		const stripped: Scenario = JSON.parse(JSON.stringify(scenario));
		for (const set of stripped.p1.team) delete (set as any).hp;
		for (const set of stripped.p2.team) delete (set as any).hp;
		const { checks, log } = await runWithLog('no-hp-overrides', stripped);
		allChecks.push(...checks);

		const garchomp = firstSwitchHp(log, 'p1a');
		allChecks.push(check(
			'no-hp-overrides: Garchomp at full HP',
			!!garchomp && garchomp.cur === garchomp.max,
			garchomp ? `observed ${garchomp.cur}/${garchomp.max}` : 'no switch line for p1a',
		));
	}

	// Case 3: field conditions — weather, terrain, pseudo-weather, hazards
	// should all be in place at turn 1 (verified from the protocol log lines
	// emitted during the start chunk, before turn 1's actions resolve).
	{
		const withField: Scenario = JSON.parse(JSON.stringify(scenario));
		withField.field = {
			weather: 'sunnyday' as ID,
			terrain: 'electricterrain' as ID,
			pseudoWeather: ['trickroom' as ID],
			sideConditions: {
				p1: ['stealthrock' as ID, 'reflect' as ID],
				p2: ['spikes' as ID],
			},
		};
		const { checks, log } = await runWithLog('field-state', withField);
		allChecks.push(...checks);

		// Take only the pre-turn-1 portion of the log so we know these effects
		// were applied at start (not added by a move mid-battle).
		const turn1Idx = log.indexOf('|turn|1');
		const preTurn1 = turn1Idx >= 0 ? log.slice(0, turn1Idx) : log;

		allChecks.push(check('field-state: weather sunnyday at start',
			/\|-weather\|SunnyDay/i.test(preTurn1)));
		allChecks.push(check('field-state: terrain electricterrain at start',
			/\|-fieldstart\|move: Electric Terrain/i.test(preTurn1)));
		allChecks.push(check('field-state: trickroom at start',
			/\|-fieldstart\|move: Trick Room/i.test(preTurn1)));
		allChecks.push(check('field-state: p1 stealth rock at start',
			/\|-sidestart\|p1[^|]*\|move: Stealth Rock/i.test(preTurn1)));
		allChecks.push(check('field-state: p1 reflect at start',
			/\|-sidestart\|p1[^|]*\|Reflect/i.test(preTurn1)));
		allChecks.push(check('field-state: p2 spikes at start',
			/\|-sidestart\|p2[^|]*\|Spikes/i.test(preTurn1)));
	}

	// Case 4: bad field id should throw, not silently no-op.
	{
		const bad: Scenario = JSON.parse(JSON.stringify(scenario));
		bad.field = { weather: 'notarealthing' as ID };
		let threw = false;
		try {
			await playScenario(bad);
		} catch (err: any) {
			threw = /not in the allow-list|not available in Gen/.test(err.message ?? '');
		}
		allChecks.push(check('field-state: invalid weather id rejected', threw));
	}

	// Volatiles: stat boosts on actives + major status on active and bench.
	{
		const withVol: Scenario = JSON.parse(JSON.stringify(scenario));
		withVol.volatiles = [
			{ side: 'p1', slot: 1, boosts: { atk: 2, def: -1 }, status: 'brn' },
			{ side: 'p2', slot: 1, status: 'par' },
			// Benched mon with status — should land without error.
			{ side: 'p1', slot: 2, status: 'tox' },
		];
		const { checks, log } = await runWithLog('volatiles', withVol);
		allChecks.push(...checks);

		// Boost log markers (setboost is silent but we add a visible -message).
		allChecks.push(check('volatiles: p1 active boost summary present',
			/starts the battle with:.*atk\+2/i.test(log)));
		// Major statuses
		// Match any nickname (user may have renamed the mons in the JSON).
		allChecks.push(check('volatiles: p1 active burned',
			/\|-status\|p1a: [^|]+\|brn/i.test(log)));
		allChecks.push(check('volatiles: p2 active paralyzed',
			/\|-status\|p2a: [^|]+\|par/i.test(log)));
		// Benched mon's status should show when it switches in (or via a
		// |-status| line emitted at apply time — either way, the status was set).
		// Easiest verification: scan log for "Heatran|tox" pattern or "Heatran" + "tox".
		// Benched mons emit |-status|p1: Heatran|tox (no position letter, since
		// they're not on the field at apply time). Once Heatran switches in, the
		// status persists into subsequent |switch| / |-damage| lines as `... tox`.
		allChecks.push(check('volatiles: benched p1 slot 2 toxic applied',
			/\|-status\|p1: Heatran\|tox/.test(log)));
	}

	// Bench-boost rejection — should error rather than silently no-op.
	{
		const bad: Scenario = JSON.parse(JSON.stringify(scenario));
		bad.volatiles = [{ side: 'p1', slot: 2, boosts: { atk: 2 } }];
		let threw = false;
		try {
			await playScenario(bad);
		} catch (err: any) {
			threw = /boosts on benched pokemon/.test(err.message ?? '');
		}
		allChecks.push(check('volatiles: bench boost rejected', threw));
	}

	// Bad slot id — should error rather than silently no-op.
	{
		const bad: Scenario = JSON.parse(JSON.stringify(scenario));
		bad.volatiles = [{ side: 'p1', slot: 7, status: 'brn' }];
		let threw = false;
		try {
			await playScenario(bad);
		} catch (err: any) {
			threw = /slot must be an integer in \[1, 6\]/.test(err.message ?? '');
		}
		allChecks.push(check('volatiles: bad slot rejected at validation time', threw));
	}

	// Gimmick validation — gen-mismatched gimmicks should produce validation errors.
	{
		const gen9: Scenario = JSON.parse(JSON.stringify(scenario));
		gen9.gimmicks = { p1: { dynamaxTurnsLeft: 2 } };
		const dynProbs = validateScenario(gen9);
		allChecks.push(check('gimmicks: dynamax rejected in Gen 9',
			dynProbs.some(p => /dynamaxTurnsLeft.*Gen 8/.test(p))));

		gen9.gimmicks = { p2: { megaUsed: true } };
		const megaProbs = validateScenario(gen9);
		allChecks.push(check('gimmicks: mega allowed in Gen 9',
			!megaProbs.some(p => /megaUsed/.test(p))));

		gen9.gimmicks = { p1: { dynamaxTurnsLeft: 5 } };
		const rangeProbs = validateScenario(gen9);
		allChecks.push(check('gimmicks: dynamaxTurnsLeft out of range rejected',
			rangeProbs.some(p => /dynamaxTurnsLeft must be an integer in \[1, 3\]/.test(p))));

		const fresh: Scenario = JSON.parse(JSON.stringify(scenario));
		fresh.startingPoint = 'start';
		fresh.gimmicks = { p1: { megaUsed: true } };
		const startProbs = validateScenario(fresh);
		allChecks.push(check('gimmicks: rejected with startingPoint=start',
			startProbs.some(p => /gimmicks requires startingPoint='mid'/.test(p))));
	}

	// clamp behavior — hp absurdly high should clamp to maxhp.
	{
		const clamped: Scenario = JSON.parse(JSON.stringify(scenario));
		(clamped.p1.team[0] as any).hp = 99999;
		(clamped.p2.team[0] as any).hp = 1; // minimum
		const { checks, log } = await runWithLog('hp-clamp', clamped);
		allChecks.push(...checks);

		const garchomp = firstSwitchHp(log, 'p1a');
		allChecks.push(check(
			'hp-clamp: hp=99999 clamps to maxhp',
			!!garchomp && garchomp.cur === garchomp.max,
			garchomp ? `observed ${garchomp.cur}/${garchomp.max}` : 'no switch line for p1a',
		));
		const skarmory = firstSwitchHp(log, 'p2a');
		allChecks.push(check(
			'hp-clamp: hp=1 starts at 1',
			!!skarmory && skarmory.cur === 1,
			skarmory ? `observed ${skarmory.cur}/${skarmory.max}` : 'no switch line for p2a',
		));
	}

	let failures = 0;
	for (const c of allChecks) {
		const status = c.ok ? 'OK  ' : 'FAIL';
		console.log(`[${status}] ${c.label}${c.detail ? `  (${c.detail})` : ''}`);
		if (!c.ok) failures++;
	}
	if (failures) {
		console.log(`\n${failures} failure(s)`);
		process.exit(1);
	} else {
		console.log('\nAll scenario smoke tests passed.');
	}
}

async function runWithLog(label: string, scenario: Scenario): Promise<{ checks: Check[], log: string }> {
	try {
		const result = await playScenario(scenario);
		return {
			checks: [check(`${label}: completes`, result.ended, `winner=${result.winner ?? '(tie)'}, turns=${result.turns}`)],
			log: result.log.join('\n'),
		};
	} catch (err: any) {
		return {
			checks: [check(`${label}: completes`, false, err.message ?? String(err))],
			log: '',
		};
	}
}

void main();
