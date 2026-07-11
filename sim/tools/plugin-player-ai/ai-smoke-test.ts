/**
 * AI faithfulness smoke test.
 *
 * Each case sets up a concrete matchup (gen, our active + stats, the foe's
 * set + HP, field) and asserts the AI's chosen move. This is where every
 * edge case we find gets locked in — run with:
 *   node build && node dist/sim/tools/plugin-player-ai/ai-smoke-test.js
 *
 * Cases are deliberately deterministic (unique top score) so a single
 * assertion is stable; where the real game is random among ties we note it.
 */

import { Dex, PRNG } from '../../';
import { BattleView } from './battle-view';
import type { ActiveContext, MoveCandidate, MoveScoreTrace } from './types';
import { getAIChain } from '../scenario/registry';

interface MoveSpec { id: string; name: string; target?: string; priority?: boolean }

interface Case {
	name: string;
	gen: number;
	/** Our active: species + real stats + condition (cur/max [status]). */
	self: { species: string, condition: string, item?: string, stats: { atk: number, def: number, spa: number, spd: number, spe: number } };
	/** The foe's set (registered for omniscient damage) + current HP%. */
	foe: { set: AnyObject, hpPercent: number, status?: string, ability?: string };
	moves: MoveSpec[];
	switches?: number;
	field?: string[]; // extra protocol lines (e.g. '|-sidestart|p1: Rival|move: Stealth Rock')
	/** AI id to run (registry key). Defaults to the polished 'ingame'. */
	ai?: string;
	expect: string; // expected chosen move name
}

function buildCtx(c: Case): ActiveContext {
	const dex = Dex.forGen(c.gen);
	const view = new BattleView(dex);
	view.setGen(c.gen);
	view.setOurSide('p2');
	view.setFoeKnownSets([c.foe.set as any]);
	const foeSpecies = c.foe.set.species || c.foe.set.name;
	let cond = `${c.foe.hpPercent}/100`;
	if (c.foe.status) cond += ` ${c.foe.status}`;
	view.receiveLine(`|switch|p1a: ${foeSpecies}|${foeSpecies}, L100, M|${cond}`);
	if (c.foe.ability) view.receiveLine(`|-ability|p1a: ${foeSpecies}|${c.foe.ability}`);
	for (const line of c.field ?? []) view.receiveLine(line);

	const moves: MoveCandidate[] = c.moves.map((m, i) => ({
		slot: i + 1, raw: { id: m.id }, move: m.name, target: m.target ?? 'normal',
		zMove: false, maxMove: false,
	}));

	return {
		player: null as any, request: { active: [{}] } as any,
		active: {} as any, activeIndex: 0,
		pokemon: { details: `${c.self.species}, L100`, condition: c.self.condition, stats: c.self.stats, item: c.self.item ?? '' } as any,
		moves,
		switches: Array.from({ length: c.switches ?? 0 }, (_, i) => ({ slot: i + 2, pokemon: {} as any })),
		canMega: false, canUltra: false, canDynamax: false, canTerastallize: false, canZMove: false,
		view, dex, gen: c.gen, prng: new PRNG([1, 2, 3, 4]),
		explain: [],
	};
}

function decide(c: Case): { chosen: string, explain: MoveScoreTrace[] } {
	const ctx = buildCtx(c);
	const chain = getAIChain(c.ai ?? 'ingame', c.gen);
	for (const policy of chain.action) {
		const d = policy(ctx);
		if (d) {
			const chosen = d.kind === 'move' ? d.candidate.move : `switch`;
			return { chosen, explain: (ctx.explain ?? []).slice().sort((a, b) => b.score - a.score) };
		}
	}
	return { chosen: '(none)', explain: [] };
}

// ----------------------------------------------------------------------
// Cases
// ----------------------------------------------------------------------

const CASES: Case[] = [
	{
		name: 'Gen 4: Bronzong leads with strongest move vs healthy Garchomp (not Explosion)',
		gen: 4,
		self: { species: 'Bronzong', condition: '360/360', item: 'leftovers', stats: { atk: 214, def: 271, spa: 194, spd: 258, spe: 63 } },
		foe: { set: { species: 'Garchomp', ability: 'Sand Veil', nature: 'Jolly', evs: { atk: 252, spe: 252 }, moves: ['Earthquake'], level: 100 }, hpPercent: 100 },
		moves: [
			{ id: 'stealthrock', name: 'Stealth Rock', target: 'foeSide' },
			{ id: 'gyroball', name: 'Gyro Ball' },
			{ id: 'earthquake', name: 'Earthquake' },
			{ id: 'explosion', name: 'Explosion' },
		],
		switches: 1,
		expect: 'Gyro Ball',
	},
	{
		name: 'Gen 6: Aegislash revenge-kills faster low-HP Charizard with priority (Shadow Sneak)',
		gen: 6,
		self: { species: 'Aegislash-Blade', condition: '180/347', item: 'leftovers', stats: { atk: 317, def: 114, spa: 317, spd: 114, spe: 154 } },
		foe: { set: { species: 'Charizard-Mega-X', ability: 'Tough Claws', nature: 'Jolly', evs: { atk: 252, spe: 252 }, moves: ['Earthquake'], level: 100 }, hpPercent: 7 },
		moves: [
			{ id: 'kingsshield', name: "King's Shield", target: 'self' },
			{ id: 'shadowball', name: 'Shadow Ball' },
			{ id: 'flashcannon', name: 'Flash Cannon' },
			{ id: 'shadowsneak', name: 'Shadow Sneak' },
		],
		expect: 'Shadow Sneak',
	},
	{
		name: 'Gen 4: avoids Ground move into (unrevealed) Levitate Bronzong',
		gen: 4,
		self: { species: 'Garchomp', condition: '357/357', item: 'choiceband', stats: { atk: 359, def: 226, spa: 176, spd: 206, spe: 333 } },
		foe: { set: { species: 'Bronzong', ability: 'Levitate', nature: 'Sassy', evs: { hp: 252, def: 128, spd: 128 }, moves: ['Gyro Ball'], level: 100 }, hpPercent: 100 },
		moves: [
			{ id: 'earthquake', name: 'Earthquake' },
			{ id: 'firefang', name: 'Fire Fang' },
			{ id: 'outrage', name: 'Outrage' },
			{ id: 'stoneedge', name: 'Stone Edge' },
		],
		expect: 'Fire Fang',
	},
	{
		name: 'Gen 4: does not re-set Stealth Rock already down (uses Recover)',
		gen: 4,
		self: { species: 'Bronzong', condition: '360/360', item: 'leftovers', stats: { atk: 214, def: 271, spa: 194, spd: 258, spe: 63 } },
		foe: { set: { species: 'Skarmory', ability: 'Sturdy', nature: 'Impish', evs: { hp: 252, def: 232 }, moves: ['Brave Bird'], level: 100 }, hpPercent: 100 },
		moves: [
			{ id: 'stealthrock', name: 'Stealth Rock', target: 'foeSide' },
			{ id: 'recover', name: 'Recover', target: 'self' },
		],
		field: ['|-sidestart|p1: Rival|move: Stealth Rock'],
		expect: 'Recover',
	},

	// --- Faithful AI (exact Emerald port) ---
	{
		name: 'Faithful (ace): priority KO (+6) beats non-priority KO (+4) — Aegislash Shadow Sneak',
		gen: 6, ai: 'faithfulace',
		self: { species: 'Aegislash-Blade', condition: '180/347', stats: { atk: 317, def: 114, spa: 317, spd: 114, spe: 154 } },
		foe: { set: { species: 'Charizard-Mega-X', ability: 'Tough Claws', nature: 'Jolly', evs: { atk: 252, spe: 252 }, moves: ['Earthquake'], level: 100 }, hpPercent: 7 },
		moves: [
			{ id: 'shadowball', name: 'Shadow Ball' },
			{ id: 'flashcannon', name: 'Flash Cannon' },
			{ id: 'shadowsneak', name: 'Shadow Sneak' },
		],
		expect: 'Shadow Sneak',
	},
	{
		// Authentic Emerald: Explosion is the highest-damage move → it alone
		// escapes the -1 "not strongest" penalty, and with a backup on the
		// bench AI_CheckBadMove doesn't penalise it. So it explodes. The
		// polished AI deliberately avoids this; the faithful AI copies the game.
		name: 'Faithful (gym): explodes when Explosion is the strongest move + has backup (real Emerald)',
		gen: 4, ai: 'faithfulgym',
		self: { species: 'Bronzong', condition: '360/360', item: 'leftovers', stats: { atk: 214, def: 271, spa: 194, spd: 258, spe: 63 } },
		foe: { set: { species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', evs: { atk: 252, spe: 252 }, moves: ['Earthquake'], level: 100 }, hpPercent: 100 },
		moves: [
			{ id: 'stealthrock', name: 'Stealth Rock', target: 'foeSide' },
			{ id: 'gyroball', name: 'Gyro Ball' },
			{ id: 'earthquake', name: 'Earthquake' },
			{ id: 'explosion', name: 'Explosion' },
		],
		switches: 1,
		expect: 'Explosion',
	},
	{
		name: 'Faithful (gym): avoids ability-immune Earthquake into Levitate; uses strongest legal move',
		gen: 4, ai: 'faithfulgym',
		self: { species: 'Garchomp', condition: '357/357', stats: { atk: 359, def: 226, spa: 176, spd: 206, spe: 333 } },
		foe: { set: { species: 'Bronzong', ability: 'Levitate', nature: 'Sassy', evs: { hp: 252, def: 128, spd: 128 }, moves: ['Gyro Ball'], level: 100 }, hpPercent: 100 },
		moves: [
			{ id: 'earthquake', name: 'Earthquake' },
			{ id: 'firefang', name: 'Fire Fang' },
			{ id: 'outrage', name: 'Outrage' },
			{ id: 'stoneedge', name: 'Stone Edge' },
		],
		expect: 'Fire Fang',
	},
	{
		name: 'Faithful (ace, CheckViability): discourages Recover at full HP (attacks instead)',
		gen: 6, ai: 'faithfulace',
		self: { species: 'Jellicent', condition: '380/380', stats: { atk: 150, def: 200, spa: 220, spd: 220, spe: 120 } },
		foe: { set: { species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', evs: { atk: 252, spe: 252 }, moves: ['Earthquake'], level: 100 }, hpPercent: 100 },
		moves: [{ id: 'scald', name: 'Scald' }, { id: 'recover', name: 'Recover', target: 'self' }],
		switches: 1,
		expect: 'Scald',
	},
	{
		name: 'Faithful (ace, CheckViability): heals when low HP and outsped',
		gen: 6, ai: 'faithfulace',
		self: { species: 'Jellicent', condition: '90/380', stats: { atk: 150, def: 200, spa: 220, spd: 220, spe: 120 } },
		foe: { set: { species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', evs: { atk: 252, spe: 252 }, moves: ['Earthquake'], level: 100 }, hpPercent: 100 },
		moves: [{ id: 'scald', name: 'Scald' }, { id: 'recover', name: 'Recover', target: 'self' }],
		switches: 1,
		expect: 'Recover',
	},
	{
		name: 'Faithful (ace, CheckViability): paralyzes a faster foe (Thunder Wave over attack)',
		gen: 3, ai: 'faithfulace',
		self: { species: 'Slowbro', condition: '300/300', stats: { atk: 100, def: 300, spa: 240, spd: 200, spe: 50 } },
		foe: { set: { species: 'Aerodactyl', ability: 'Rock Head', nature: 'Jolly', evs: { atk: 252, spe: 252 }, moves: ['Rock Slide'], level: 100 }, hpPercent: 100 },
		moves: [{ id: 'thunderwave', name: 'Thunder Wave', target: 'normal' }, { id: 'psychic', name: 'Psychic' }],
		expect: 'Thunder Wave',
	},
	{
		name: 'Faithful (ace, CheckViability): skips paralysis when already faster and hurt (attacks)',
		gen: 3, ai: 'faithfulace',
		self: { species: 'Jolteon', condition: '180/300', stats: { atk: 150, def: 180, spa: 300, spd: 200, spe: 350 } },
		foe: { set: { species: 'Snorlax', ability: 'Immunity', nature: 'Careful', evs: { hp: 252, spd: 252 }, moves: ['Body Slam'], level: 100 }, hpPercent: 100 },
		moves: [{ id: 'thunderwave', name: 'Thunder Wave', target: 'normal' }, { id: 'thunderbolt', name: 'Thunderbolt' }],
		expect: 'Thunderbolt',
	},
	{
		name: 'Faithful (ace, CheckViability): will not Swords Dance while badly hurt (attacks)',
		gen: 3, ai: 'faithfulace',
		self: { species: 'Garchomp', condition: '90/357', stats: { atk: 359, def: 226, spa: 176, spd: 206, spe: 333 } },
		foe: { set: { species: 'Snorlax', ability: 'Thick Fat', nature: 'Careful', evs: { hp: 252, spd: 252 }, moves: ['Body Slam'], level: 100 }, hpPercent: 100 },
		moves: [{ id: 'swordsdance', name: 'Swords Dance', target: 'self' }, { id: 'earthquake', name: 'Earthquake' }],
		expect: 'Earthquake',
	},
	{
		// We outspeed the (slow) foe and are at full HP → Rest is a wasted turn (-8).
		name: 'Faithful (ace, CheckViability): will not Rest at full HP (attacks)',
		gen: 3, ai: 'faithfulace',
		self: { species: 'Snorlax', condition: '525/525', stats: { atk: 318, def: 228, spa: 178, spd: 258, spe: 60 } },
		foe: { set: { species: 'Shuckle', ability: 'Sturdy', nature: 'Bold', evs: { hp: 252, def: 252 }, moves: ['Toxic'], level: 100 }, hpPercent: 100 },
		moves: [{ id: 'rest', name: 'Rest', target: 'self' }, { id: 'bodyslam', name: 'Body Slam' }],
		expect: 'Body Slam',
	},
	{
		// Low HP and outsped by the foe → Rest to recover is the game's play (+3).
		name: 'Faithful (ace, CheckViability): Rests to recover when low and outsped',
		gen: 3, ai: 'faithfulace',
		self: { species: 'Snorlax', condition: '150/525', stats: { atk: 318, def: 228, spa: 178, spd: 258, spe: 60 } },
		foe: { set: { species: 'Aerodactyl', ability: 'Rock Head', nature: 'Jolly', evs: { atk: 252, spe: 252 }, moves: ['Rock Slide'], level: 100 }, hpPercent: 100 },
		moves: [{ id: 'rest', name: 'Rest', target: 'self' }, { id: 'bodyslam', name: 'Body Slam' }],
		expect: 'Rest',
	},
	{
		// Vs a pure special attacker, Reflect is the wrong screen (-2 for the foe
		// not being a physical type) so the AI puts up Light Screen instead.
		name: 'Faithful (ace, CheckViability): picks Light Screen over Reflect vs a special attacker',
		gen: 3, ai: 'faithfulace',
		self: { species: 'Claydol', condition: '300/300', stats: { atk: 200, def: 250, spa: 200, spd: 250, spe: 150 } },
		foe: { set: { species: 'Alakazam', ability: 'Synchronize', nature: 'Timid', evs: { spa: 252, spe: 252 }, moves: ['Psychic'], level: 100 }, hpPercent: 100 },
		moves: [{ id: 'reflect', name: 'Reflect', target: 'self' }, { id: 'lightscreen', name: 'Light Screen', target: 'self' }],
		expect: 'Light Screen',
	},
	{
		// Iron Defense (a Defense-up move) is abandoned when we're badly hurt —
		// the AI attacks instead. Exercises the AI_CV_DefenseUp handler.
		name: 'Faithful (ace, CheckViability): will not Iron Defense while badly hurt (attacks)',
		gen: 3, ai: 'faithfulace',
		self: { species: 'Regirock', condition: '80/300', stats: { atk: 320, def: 300, spa: 100, spd: 200, spe: 100 } },
		foe: { set: { species: 'Gardevoir', ability: 'Trace', nature: 'Modest', evs: { spa: 252, spe: 252 }, moves: ['Psychic'], level: 100 }, hpPercent: 100 },
		moves: [{ id: 'irondefense', name: 'Iron Defense', target: 'self' }, { id: 'rockslide', name: 'Rock Slide' }],
		field: ['|move|p1a: Gardevoir|Psychic'],
		expect: 'Rock Slide',
	},
	{
		// With nothing boosted, both are "reset" moves, but Roar is penalised
		// harder (-3) than Haze (at most -1), so the AI prefers Haze.
		name: 'Faithful (ace, CheckViability): prefers Haze over Roar when nothing is boosted',
		gen: 3, ai: 'faithfulace',
		self: { species: 'Weezing', condition: '300/300', stats: { atk: 200, def: 280, spa: 220, spd: 200, spe: 160 } },
		foe: { set: { species: 'Tyranitar', ability: 'Sand Stream', nature: 'Adamant', evs: { atk: 252, hp: 252 }, moves: ['Crunch'], level: 100 }, hpPercent: 100 },
		moves: [{ id: 'haze', name: 'Haze', target: 'self' }, { id: 'roar', name: 'Roar', target: 'normal' }],
		expect: 'Haze',
	},
	{
		// The foe just used a physical move (Body Slam), so Counter is on-side and
		// encouraged; the AI takes it over phazing.
		name: 'Faithful (ace, CheckViability): Counter is favoured after the foe uses a physical move',
		gen: 3, ai: 'faithfulace',
		self: { species: 'Wobbuffet', condition: '600/600', stats: { atk: 100, def: 200, spa: 100, spd: 200, spe: 80 } },
		foe: { set: { species: 'Snorlax', ability: 'Immunity', nature: 'Adamant', evs: { atk: 252, hp: 252 }, moves: ['Body Slam'], level: 100 }, hpPercent: 100 },
		moves: [{ id: 'counter', name: 'Counter' }, { id: 'roar', name: 'Roar', target: 'normal' }],
		field: ['|move|p1a: Snorlax|Body Slam'],
		expect: 'Counter',
	},
	{
		// The (slower) foe just used a status move (Toxic), so Encore to lock it
		// into that wasted turn is strongly encouraged.
		name: 'Faithful (ace, CheckViability): Encores a slower foe that just used status',
		gen: 3, ai: 'faithfulace',
		self: { species: 'Alakazam', condition: '250/250', stats: { atk: 100, def: 120, spa: 350, spd: 180, spe: 350 } },
		foe: { set: { species: 'Blissey', ability: 'Natural Cure', nature: 'Calm', evs: { hp: 252, spd: 252 }, moves: ['Toxic'], level: 100 }, hpPercent: 100 },
		moves: [{ id: 'encore', name: 'Encore', target: 'normal' }, { id: 'roar', name: 'Roar', target: 'normal' }],
		field: ['|move|p1a: Blissey|Toxic'],
		expect: 'Encore',
	},
];

// ----------------------------------------------------------------------
// Runner
// ----------------------------------------------------------------------

let failures = 0;
for (const c of CASES) {
	const { chosen, explain } = decide(c);
	const ok = chosen === c.expect;
	if (!ok) failures++;
	const tag = ok ? '[OK  ]' : '[FAIL]';
	console.log(`${tag} ${c.name}`);
	if (!ok) {
		console.log(`        expected ${c.expect}, got ${chosen}`);
		for (const t of explain) {
			console.log(`          ${t.move} = ${t.score}${t.canKO ? ' [KO]' : ''}  ${t.reasons.map(r => `${r.delta >= 0 ? '+' : ''}${r.delta} ${r.label}`).join(' · ')}`);
		}
	}
}

console.log(`\n${failures ? `${failures} failure(s)` : `All ${CASES.length} AI smoke tests passed.`}`);
process.exit(failures ? 1 : 0);
