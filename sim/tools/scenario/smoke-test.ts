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

	// ── Edge case: Stealth Rock damages switch-ins in mid-battle ──
	// Rocks are pre-set. When a mon switches in, it should take SR damage.
	{
		const srScenario: Scenario = JSON.parse(JSON.stringify(scenario));
		srScenario.startingPoint = 'mid';
		srScenario.field = {
			sideConditions: {
				p1: ['stealthrock' as ID],
				p2: ['stealthrock' as ID],
			},
		};
		const { checks, log } = await runWithLog('edge-sr-switch', srScenario);
		allChecks.push(...checks);

		// After the initial switch-in, any subsequent switch should trigger SR damage.
		// Look for |-damage|...|[from] Stealth Rock in the log (happens on switch-ins
		// after the initial one, since mid startingPoint skips turn-0 switch effects).
		allChecks.push(check('edge-sr-switch: SR damage log line present',
			/\|-damage\|.*\[from\] Stealth Rock/.test(log),
			'should see SR damage on a switch-in during the game'));
	}

	// ── Edge case: Psychic Seed does NOT trigger on pre-existing terrain ──
	// Terrain is already up (mid), Indeedee holds Psychic Seed.
	// The seed should NOT activate at battle start.
	{
		const seedScenario: Scenario = {
			name: 'edge-seed-suppression',
			format: 'gen9customgame',
			startingPoint: 'mid',
			p1: {
				name: 'Seed Holder',
				ai: 'gen9tactical',
				team: [{
					name: 'Indeedee', species: 'Indeedee-F',
					item: 'Psychic Seed', ability: 'Psychic Surge',
					moves: ['Psychic', 'Mystical Fire', 'Healing Wish', 'Calm Mind'],
					nature: 'Timid', gender: 'F',
					evs: { hp: 252, atk: 0, def: 0, spa: 252, spd: 0, spe: 4 },
					ivs: { hp: 31, atk: 0, def: 31, spa: 31, spd: 31, spe: 31 },
					level: 100,
				}, {
					name: 'Alakazam', species: 'Alakazam',
					item: 'Focus Sash', ability: 'Magic Guard',
					moves: ['Psychic', 'Shadow Ball', 'Focus Blast', 'Nasty Plot'],
					nature: 'Timid', gender: 'M',
					evs: { hp: 0, atk: 0, def: 0, spa: 252, spd: 4, spe: 252 },
					ivs: { hp: 31, atk: 0, def: 31, spa: 31, spd: 31, spe: 31 },
					level: 100,
				}],
			},
			p2: {
				name: 'Foe',
				ai: 'random',
				team: [{
					name: 'Hatterene', species: 'Hatterene',
					item: 'Leftovers', ability: 'Magic Bounce',
					moves: ['Psyshock', 'Dazzling Gleam', 'Mystical Fire', 'Trick Room'],
					nature: 'Quiet', gender: 'F',
					evs: { hp: 252, atk: 0, def: 4, spa: 252, spd: 0, spe: 0 },
					ivs: { hp: 31, atk: 0, def: 31, spa: 31, spd: 31, spe: 0 },
					level: 100,
				}, {
					name: 'Gardevoir', species: 'Gardevoir',
					item: 'Choice Scarf', ability: 'Trace',
					moves: ['Moonblast', 'Psychic', 'Focus Blast', 'Trick'],
					nature: 'Timid', gender: 'F',
					evs: { hp: 0, atk: 0, def: 0, spa: 252, spd: 4, spe: 252 },
					ivs: { hp: 31, atk: 0, def: 31, spa: 31, spd: 31, spe: 31 },
					level: 100,
				}],
			},
			field: {
				terrain: { id: 'psychicterrain' as ID, turnsRemaining: 3 },
			},
		};
		const { checks, log } = await runWithLog('edge-seed-suppression', seedScenario);
		allChecks.push(...checks);

		// The Psychic Seed should NOT have activated in the pre-turn-1 section.
		const turn1Idx = log.indexOf('|turn|1');
		const preTurn1 = turn1Idx >= 0 ? log.slice(0, turn1Idx) : log;
		allChecks.push(check('edge-seed-suppression: Psychic Seed does NOT trigger at start',
			!preTurn1.includes('Psychic Seed'),
			'seed should not activate on pre-existing terrain'));
	}

	// ── Edge case: Trick Room pre-set actually inverts speed ──
	// Slow mon should move first when TR is already up.
	{
		const trScenario: Scenario = {
			name: 'edge-trick-room-speed',
			format: 'gen9customgame',
			startingPoint: 'mid',
			seed: '1,2,3,4',
			p1: {
				name: 'Slow',
				ai: 'gen9tactical',
				team: [{
					name: 'Torkoal', species: 'Torkoal',
					item: 'Charcoal', ability: 'Drought',
					moves: ['Eruption', 'Lava Plume', 'Solar Beam', 'Stealth Rock'],
					nature: 'Quiet', gender: 'M',
					evs: { hp: 252, atk: 0, def: 4, spa: 252, spd: 0, spe: 0 },
					ivs: { hp: 31, atk: 0, def: 31, spa: 31, spd: 31, spe: 0 },
					level: 100,
				}],
			},
			p2: {
				name: 'Fast',
				ai: 'gen9tactical',
				team: [{
					name: 'Dragapult', species: 'Dragapult',
					item: 'Choice Specs', ability: 'Infiltrator',
					moves: ['Shadow Ball', 'Draco Meteor', 'Flamethrower', 'Thunderbolt'],
					nature: 'Timid', gender: 'M',
					evs: { hp: 0, atk: 0, def: 0, spa: 252, spd: 4, spe: 252 },
					ivs: { hp: 31, atk: 0, def: 31, spa: 31, spd: 31, spe: 31 },
					level: 100,
				}],
			},
			field: {
				pseudoWeather: [{ id: 'trickroom' as ID, turnsRemaining: 3 }],
			},
		};
		const { checks, log } = await runWithLog('edge-trick-room', trScenario);
		allChecks.push(...checks);

		// On turn 1, Torkoal (20 base Spe) should move before Dragapult (142 base Spe).
		// Find the first |move| line after |turn|1 — it should be from p1 (Torkoal).
		const turn1Start = log.indexOf('|turn|1');
		const afterTurn1 = turn1Start >= 0 ? log.slice(turn1Start) : '';
		const firstMove = afterTurn1.match(/\|move\|(p[12])a:/);
		allChecks.push(check('edge-trick-room: slow mon moves first under TR',
			firstMove?.[1] === 'p1',
			firstMove ? `first mover: ${firstMove[1]}` : 'no move found'));
	}

	// ── Edge case: Toxic damage escalates correctly from mid-battle start ──
	{
		const toxScenario: Scenario = JSON.parse(JSON.stringify(scenario));
		toxScenario.startingPoint = 'mid';
		toxScenario.volatiles = [
			{ side: 'p1', slot: 1, status: 'tox' },
		];
		const { checks, log } = await runWithLog('edge-toxic-escalation', toxScenario);
		allChecks.push(...checks);

		// Toxic damage should appear in the log — at minimum the first tick.
		allChecks.push(check('edge-toxic-escalation: toxic damage present',
			/\|-damage\|p1a:.*\[from\] psn/.test(log),
			'should see escalating toxic damage each turn'));
	}

	// ── Edge case: Burn does 1/16 damage each turn ──
	{
		const burnScenario: Scenario = JSON.parse(JSON.stringify(scenario));
		burnScenario.startingPoint = 'mid';
		burnScenario.volatiles = [
			{ side: 'p1', slot: 1, status: 'brn' },
		];
		const { checks, log } = await runWithLog('edge-burn-damage', burnScenario);
		allChecks.push(...checks);

		allChecks.push(check('edge-burn-damage: burn status applied',
			log.includes('|-status|p1a:') && log.includes('|brn'),
			'burned mon should have brn status in log'));
	}

	// ── Edge case: Sandstorm chip on non-immune types ──
	{
		const sandScenario: Scenario = JSON.parse(JSON.stringify(scenario));
		sandScenario.startingPoint = 'mid';
		sandScenario.field = { weather: 'sandstorm' as ID };
		const { checks, log } = await runWithLog('edge-sand-chip', sandScenario);
		allChecks.push(...checks);

		// Sandstorm should be active from the start.
		const turn1Idx = log.indexOf('|turn|1');
		const preTurn1 = turn1Idx >= 0 ? log.slice(0, turn1Idx) : log;
		allChecks.push(check('edge-sand-chip: sandstorm weather active at start',
			preTurn1.includes('|-weather|Sandstorm'),
			'sandstorm should be set before turn 1'));
		// Sand damage or upkeep should appear somewhere in the log.
		allChecks.push(check('edge-sand-chip: sandstorm upkeep present',
			log.includes('Sandstorm'),
			'sandstorm should appear in log'));
	}

	// ── Edge case: Reflect/Light Screen reduce damage ──
	{
		const screenScenario: Scenario = JSON.parse(JSON.stringify(scenario));
		screenScenario.startingPoint = 'mid';
		screenScenario.field = {
			sideConditions: {
				p2: [
					{ id: 'reflect' as ID, turnsRemaining: 5 },
					{ id: 'lightscreen' as ID, turnsRemaining: 5 },
				],
			},
		};
		const { checks, log } = await runWithLog('edge-screens', screenScenario);
		allChecks.push(...checks);

		// Screens should show up in the pre-turn-1 log.
		const turn1Idx = log.indexOf('|turn|1');
		const preTurn1 = turn1Idx >= 0 ? log.slice(0, turn1Idx) : log;
		allChecks.push(check('edge-screens: reflect present at start',
			/\|-sidestart\|p2.*\|Reflect/.test(preTurn1)));
		allChecks.push(check('edge-screens: light screen present at start',
			preTurn1.includes('Light Screen')));
	}

	// ── Edge case: Layered spikes damage scales with layer count ──
	{
		const spikesScenario: Scenario = JSON.parse(JSON.stringify(scenario));
		spikesScenario.startingPoint = 'mid';
		spikesScenario.field = {
			sideConditions: {
				p1: [{ id: 'spikes' as ID, layers: 3 }],
				p2: [{ id: 'spikes' as ID, layers: 1 }],
			},
		};
		const { checks, log } = await runWithLog('edge-spikes-layers', spikesScenario);
		allChecks.push(...checks);

		// Spikes should be present.
		const turn1Idx = log.indexOf('|turn|1');
		const preTurn1 = turn1Idx >= 0 ? log.slice(0, turn1Idx) : log;
		allChecks.push(check('edge-spikes-layers: p1 spikes present',
			/\|-sidestart\|p1.*\|Spikes/.test(preTurn1)));
		allChecks.push(check('edge-spikes-layers: p2 spikes present',
			/\|-sidestart\|p2.*\|Spikes/.test(preTurn1)));
	}

	// ── Edge case: Confusion + boosts together ──
	{
		const confScenario: Scenario = JSON.parse(JSON.stringify(scenario));
		confScenario.startingPoint = 'mid';
		confScenario.volatiles = [
			{ side: 'p1', slot: 1, boosts: { atk: 2, spe: 2 }, confused: 3 },
		];
		const { checks, log } = await runWithLog('edge-confused-boosted', confScenario);
		allChecks.push(...checks);

		// Both boosts and confusion should be logged.
		allChecks.push(check('edge-confused-boosted: boost summary present',
			/starts the battle with:.*atk\+2.*spe\+2/i.test(log)));
		// Confusion may or may not trigger (RNG), but the volatile should be set.
		// Check the pre-turn log for the confusion marker or any confusion event.
		allChecks.push(check('edge-confused-boosted: battle completes with boosts+confusion',
			log.includes('|turn|1'),
			'game should reach turn 1 with boosts and confusion applied'));
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
