/**
 * Scenario loading, saving, and validation.
 *
 * Validation here is structural + light semantic: format exists, both sides
 * have teams, HP values are sane, AI ids are known. Deep team validity
 * (legality, EV totals, ability legality) is left to the existing
 * TeamValidator — call validateScenarioTeams() to run that pass too.
 */

import * as fs from 'fs';
import * as path from 'path';

import { Dex } from '../../dex';
import { TeamValidator } from '../../team-validator';
import { getAIChain, HUMAN_AI } from './registry';
import {
	allowedWeathersForGen, allowedTerrainsForGen,
	allowedPseudoWeathersForGen, allowedSideConditionsForGen,
} from './apply';
import type { Scenario, ScenarioPlayer, ScenarioFieldEffect } from './types';

export function loadScenario(filePath: string): Scenario {
	const raw = fs.readFileSync(filePath, 'utf-8');
	const scenario = JSON.parse(raw) as Scenario;
	return scenario;
}

export function saveScenario(filePath: string, scenario: Scenario) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(scenario, null, 2) + '\n');
}

/**
 * Structural / light semantic validation. Returns a list of human-readable
 * problems; empty array means the scenario is well-formed.
 */
export function validateScenario(scenario: Scenario): string[] {
	const problems: string[] = [];
	if (!scenario || typeof scenario !== 'object') {
		return ['Scenario must be a JSON object.'];
	}
	if (typeof scenario.format !== 'string' || !scenario.format) {
		problems.push('Scenario.format is required.');
	} else {
		const format = Dex.formats.get(scenario.format);
		if (!format.exists) problems.push(`Unknown format: '${scenario.format}'.`);
	}
	problems.push(...validatePlayer(scenario.p1, 'p1'));
	problems.push(...validatePlayer(scenario.p2, 'p2'));

	// startingPoint validation. 'start' is the "fresh battle with optional
	// pre-set HP/status" mode and forbids anything that implies the battle
	// has been going on for turns (field state, confusion, boosts).
	const startingPoint = scenario.startingPoint ?? 'mid';
	if (startingPoint !== 'mid' && startingPoint !== 'start') {
		problems.push(`startingPoint must be 'start' or 'mid' (got '${startingPoint}').`);
	}
	if (startingPoint === 'start') {
		const f = scenario.field;
		const hasField = !!(f && (f.weather || f.terrain || f.pseudoWeather?.length ||
			(f.sideConditions && Object.values(f.sideConditions).some(arr => arr?.length))));
		if (hasField) {
			problems.push(`startingPoint='start' is incompatible with field state — weather/terrain/hazards/screens imply turns have already passed. Use startingPoint='mid' instead.`);
		}
		for (let i = 0; i < (scenario.volatiles?.length ?? 0); i++) {
			const v = scenario.volatiles![i];
			if (v.confused !== undefined) {
				problems.push(`volatiles[${i}].confused requires startingPoint='mid' (confusion only applies once the battle is underway).`);
			}
			if (v.boosts && Object.keys(v.boosts).length > 0) {
				problems.push(`volatiles[${i}].boosts requires startingPoint='mid' (stat changes only apply once the battle is underway).`);
			}
		}
	}

	if (scenario.volatiles) {
		for (let i = 0; i < scenario.volatiles.length; i++) {
			const v = scenario.volatiles[i];
			if (v.side !== 'p1' && v.side !== 'p2') {
				problems.push(`volatiles[${i}].side must be 'p1' or 'p2'.`);
			}
			if (!Number.isInteger(v.slot) || v.slot < 1 || v.slot > 6) {
				problems.push(`volatiles[${i}].slot must be an integer in [1, 6].`);
			}
			if (v.boosts) {
				for (const [stat, value] of Object.entries(v.boosts)) {
					if (!Number.isInteger(value) || value! < -6 || value! > 6) {
						problems.push(`volatiles[${i}].boosts.${stat} must be an integer in [-6, 6].`);
					}
				}
			}
			if (v.confused !== undefined) {
				if (!Number.isInteger(v.confused) || v.confused < 1 || v.confused > 5) {
					problems.push(`volatiles[${i}].confused must be an integer in [1, 5].`);
				}
			}
		}
	}

	// Gen-aware field effect validation.
	const format = Dex.formats.get(scenario.format);
	if (format.exists && scenario.field) {
		const gen = format.mod === 'base' ? Dex.gen : Dex.forFormat(format).gen;
		const f = scenario.field;
		if (f.weather) {
			const wid = typeof f.weather === 'string' ? f.weather : f.weather.id;
			if (!allowedWeathersForGen(gen).includes(wid as ID)) {
				problems.push(`Weather '${wid}' is not available in Gen ${gen}.`);
			}
		}
		if (f.terrain) {
			const tid = typeof f.terrain === 'string' ? f.terrain : f.terrain.id;
			if (!allowedTerrainsForGen(gen).includes(tid as ID)) {
				problems.push(`Terrain '${tid}' is not available in Gen ${gen}.`);
			}
		}
		if (f.pseudoWeather) {
			for (const entry of f.pseudoWeather) {
				const pid = typeof entry === 'string' ? entry : entry.id;
				if (!allowedPseudoWeathersForGen(gen).includes(pid as ID)) {
					problems.push(`Pseudo-weather '${pid}' is not available in Gen ${gen}.`);
				}
			}
		}
		if (f.sideConditions) {
			for (const sideKey of ['p1', 'p2'] as const) {
				const conditions = f.sideConditions[sideKey];
				if (!conditions) continue;
				for (const entry of conditions) {
					const sid = typeof entry === 'string' ? entry : entry.id;
					if (!allowedSideConditionsForGen(gen).includes(sid as ID)) {
						problems.push(`Side condition '${sid}' on ${sideKey} is not available in Gen ${gen}.`);
					}
				}
			}
		}
	}

	// Gimmick state validation.
	if (scenario.gimmicks) {
		if (startingPoint === 'start') {
			problems.push(`gimmicks requires startingPoint='mid' (gimmick usage only applies once the battle is underway).`);
		}
		for (const sideKey of ['p1', 'p2'] as const) {
			const g = scenario.gimmicks[sideKey];
			if (!g) continue;
			const prefix = `gimmicks.${sideKey}`;
			if (g.dynamaxTurnsLeft !== undefined) {
				if (!Number.isInteger(g.dynamaxTurnsLeft) || g.dynamaxTurnsLeft < 1 || g.dynamaxTurnsLeft > 3) {
					problems.push(`${prefix}.dynamaxTurnsLeft must be an integer in [1, 3].`);
				}
			}
			if (format.exists) {
				const gen = format.mod === 'base' ? Dex.gen : Dex.forFormat(format).gen;
				if (g.megaUsed && gen < 6) {
					problems.push(`${prefix}.megaUsed is not available before Gen 6.`);
				}
				if (g.zMoveUsed && gen !== 7) {
					problems.push(`${prefix}.zMoveUsed is only available in Gen 7.`);
				}
				if ((g.dynamaxTurnsLeft !== undefined) && gen !== 8) {
					problems.push(`${prefix}.dynamaxTurnsLeft is only available in Gen 8.`);
				}
				if (g.teraUsed && gen < 9) {
					problems.push(`${prefix}.teraUsed is not available before Gen 9.`);
				}
			}
		}
	}

	return problems;
}

function validatePlayer(player: ScenarioPlayer | undefined, label: string): string[] {
	const problems: string[] = [];
	if (!player) return [`${label} is missing.`];
	if (!Array.isArray(player.team) || !player.team.length) {
		problems.push(`${label}.team must be a non-empty array.`);
	} else {
		for (let i = 0; i < player.team.length; i++) {
			const set = player.team[i];
			if (!set.species) problems.push(`${label}.team[${i}].species is required.`);
			if (set.hp !== undefined) {
				if (!Number.isFinite(set.hp) || set.hp < 1) {
					problems.push(`${label}.team[${i}].hp must be a positive integer.`);
				}
			}
		}
	}
	if (player.ai && player.ai !== HUMAN_AI) {
		// Throws if unknown — capture and report.
		try { getAIChain(player.ai, 9); } catch (err: any) { problems.push(`${label}: ${err.message}`); }
	}
	return problems;
}

/**
 * Optional deep validation pass: feeds each team through the format's
 * TeamValidator. Slower; useful before persisting a scenario.
 */
export function validateScenarioTeams(scenario: Scenario): string[] {
	const problems: string[] = [];
	const format = Dex.formats.get(scenario.format);
	if (!format.exists) return [`Unknown format: '${scenario.format}'.`];
	const validator = TeamValidator.get(format.id);
	for (const side of ['p1', 'p2'] as const) {
		const result = validator.validateTeam(scenario[side].team);
		if (result) for (const err of result) problems.push(`${side}: ${err}`);
	}
	return problems;
}
