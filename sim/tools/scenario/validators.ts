/**
 * Per-generation scenario validators.
 *
 * Two distinct validation layers exist for scenario teams, and which one a
 * format gets is decided by `validationPlanFor()`:
 *
 *  1. MECHANICAL (this module, always runs): "could this set physically
 *     exist in Gen N?" — species/moves/items/abilities present in the gen,
 *     no items in Gen 1, no abilities/natures before Gen 3, Z-Crystals only
 *     in Gen 7, Mega Stones only in Gens 6-7, Gigantamax/Dynamax Level only
 *     in Gen 8, Tera Types only in Gen 9, EV/IV/level sanity.
 *
 *  2. TIER (TeamValidator, opt-in): competitive legality — bans, clauses,
 *     learnsets. Only meaningful for ladder formats (gen4ou, gen9ou...).
 *     Custom-game formats skip it: in-game AI battles have no competitive
 *     clauses (there is no Sleep Clause in the real games), so
 *     `genNcustomgame` + mechanical validation is the recommended pairing
 *     for in-game-AI scenarios.
 */

import { Dex, toID } from '../../dex';
import type { PokemonSet } from '../../teams';

/** The recommended scenario format for a gen (see module docs for why). */
export function scenarioFormatForGen(gen: number): string {
	return `gen${gen}customgame`;
}

/**
 * The format id to hand the battle engine for scenario play. Team order is
 * already fixed by the scenario JSON, so Team Preview is a useless round-trip
 * that delays field / volatile application past turn 1 — we strip it.
 *
 * Open Team Sheets (bundled by VGC formats) *requires* Team Preview, so we
 * strip it too; the scenario handles open-sheet display itself via its
 * `openTeamsheet` field. Both are only removed when actually present —
 * appending `!Team Preview` to a format without it throws
 * `Rule "!teampreview" did nothing` during Battle construction.
 */
export function scenarioBattleFormatId(formatid: string): string {
	try {
		const ruleTable = Dex.formats.getRuleTable(Dex.formats.get(formatid));
		const strips: string[] = [];
		// Remove Open Team Sheets first (it depends on Team Preview).
		if (ruleTable.has('openteamsheets')) strips.push('!Open Team Sheets');
		if (ruleTable.has('teampreview')) strips.push('!Team Preview');
		if (strips.length) {
			const joined = strips.join(',');
			return formatid.includes('@@@') ? `${formatid},${joined}` : `${formatid}@@@${joined}`;
		}
	} catch {
		// Unresolvable rule table (exotic custom rules) — use the format as-is.
	}
	return formatid;
}

export interface ValidationPlan {
	gen: number;
	/** Mechanical per-gen validation — always on. */
	mechanical: true;
	/** Whether TeamValidator (tier legality) should also run for this format. */
	tier: boolean;
}

/**
 * Which validators apply to a format. Custom games get mechanical-only;
 * everything else gets mechanical + tier.
 */
export function validationPlanFor(formatid: string): ValidationPlan | null {
	const format = Dex.formats.get(formatid);
	if (!format.exists) return null;
	const gen = format.mod === 'base' ? Dex.gen : Dex.forFormat(format).gen;
	const isCustom = format.id.includes('customgame') || format.id.includes('metronomebattle');
	return { gen, mechanical: true, tier: !isCustom };
}

/** Result of mechanical validation: blocking `errors` + non-blocking `warnings`. */
export interface SetValidation {
	errors: string[];
	warnings: string[];
}

/** Validate one set against what physically exists in `gen`. */
export function validateSetForGen(set: PokemonSet, gen: number, label: string): SetValidation {
	const errors: string[] = [];
	const warnings: string[] = [];
	const dex = Dex.forGen(gen);

	// --- Species ---
	const species = dex.species.get(set.species || set.name);
	if (!species.exists) {
		errors.push(`${label}: unknown species '${set.species}'.`);
		return { errors, warnings }; // everything else needs a species
	}
	if (species.gen > gen) {
		errors.push(`${label}: ${species.name} does not exist until Gen ${species.gen} (format is Gen ${gen}).`);
	}

	// --- Level ---
	if (set.level !== undefined && (!Number.isInteger(set.level) || set.level < 1 || set.level > 100)) {
		errors.push(`${label}: level must be an integer in [1, 100].`);
	}

	// --- Moves (empty slots are fine — a set may carry fewer than 4) ---
	for (const moveName of set.moves || []) {
		if (!moveName || (typeof moveName === 'string' && !moveName.trim())) continue;
		const move = dex.moves.get(moveName);
		if (!move.exists) {
			errors.push(`${label}: unknown move '${moveName}'.`);
		} else if (move.gen > gen) {
			errors.push(`${label}: ${move.name} does not exist until Gen ${move.gen}.`);
		}
	}

	// --- Item ---
	if (set.item) {
		if (gen === 1) {
			errors.push(`${label}: held items do not exist in Gen 1.`);
		} else {
			const item = dex.items.get(set.item);
			if (!item.exists) {
				errors.push(`${label}: unknown item '${set.item}'.`);
			} else {
				if (item.gen > gen) {
					errors.push(`${label}: ${item.name} does not exist until Gen ${item.gen}.`);
				}
				if (item.zMove && gen !== 7) {
					errors.push(`${label}: Z-Crystals (${item.name}) only exist in Gen 7.`);
				}
				if (item.megaStone && (gen < 6 || gen > 7)) {
					errors.push(`${label}: Mega Stones (${item.name}) only exist in Gens 6-7.`);
				}
			}
		}
	}

	// --- Battle-only forms need their required item ---
	// Mega forms (Altaria-Mega → Altarianite), Primal, Arceus plates, Silvally
	// memories, etc. only exist while holding a specific item. A Mega form
	// pasted without its stone (or with the wrong item) is a real mistake.
	const reqItems: string[] | null = species.requiredItems ??
		(species.requiredItem ? [species.requiredItem] : null);
	if (reqItems && !reqItems.some(it => toID(it) === toID(set.item))) {
		errors.push(
			`${label}: ${species.name} needs the ${reqItems.join(' or ')} item` +
			`${set.item ? ` (found '${set.item}')` : ' (no item set)'}.`
		);
	}

	// --- Ability ---
	if (gen < 3) {
		if (set.ability && toID(set.ability) !== 'noability' && toID(set.ability) !== 'none') {
			errors.push(`${label}: abilities do not exist before Gen 3 (got '${set.ability}').`);
		}
	} else if (set.ability) {
		const ability = dex.abilities.get(set.ability);
		if (!ability.exists) {
			errors.push(`${label}: unknown ability '${set.ability}'.`);
		} else if (ability.gen > gen) {
			errors.push(`${label}: ${ability.name} does not exist until Gen ${ability.gen}.`);
		}
	}

	// --- Nature ---
	if (set.nature) {
		if (gen < 3) {
			errors.push(`${label}: natures do not exist before Gen 3 (got '${set.nature}').`);
		} else if (!dex.natures.get(set.nature).exists) {
			errors.push(`${label}: unknown nature '${set.nature}'.`);
		}
	}

	// --- EVs / IVs ---
	if (set.evs) {
		let total = 0;
		for (const [stat, val] of Object.entries(set.evs)) {
			if (typeof val !== 'number') continue;
			total += val;
			const max = gen >= 3 ? 252 : 255; // gen 1-2 "EVs" are stat experience, 0-255
			if (val < 0 || val > max) {
				errors.push(`${label}: EV ${stat}=${val} out of range [0, ${max}] for Gen ${gen}.`);
			}
		}
		if (gen >= 3 && total > 510) {
			errors.push(`${label}: EV total ${total} exceeds 510 (Gen 3+).`);
		}
	}
	if (set.ivs) {
		for (const [stat, val] of Object.entries(set.ivs)) {
			if (typeof val === 'number' && (val < 0 || val > 31)) {
				errors.push(`${label}: IV ${stat}=${val} out of range [0, 31].`);
			}
		}
	}

	// --- Gen-gimmick fields ---
	// Harmless outside their generation (the engine just won't use them), so
	// warn and ignore rather than blocking the whole scenario.
	if (set.teraType && gen !== 9) {
		warnings.push(`${label}: teraType is only used in Gen 9 — ignored here.`);
	}
	if (set.gigantamax && gen !== 8) {
		warnings.push(`${label}: gigantamax is only used in Gen 8 — ignored here.`);
	}
	if (set.dynamaxLevel !== undefined && set.dynamaxLevel !== 10 && gen !== 8) {
		warnings.push(`${label}: dynamaxLevel is only used in Gen 8 — ignored here.`);
	}

	return { errors, warnings };
}

/** Validate a whole team mechanically for `gen`. `label` prefixes messages (e.g. 'p1'). */
export function validateTeamForGen(team: PokemonSet[], gen: number, label: string): SetValidation {
	const errors: string[] = [];
	const warnings: string[] = [];
	for (let i = 0; i < team.length; i++) {
		const r = validateSetForGen(team[i], gen, `${label}.team[${i}] (${team[i].species || '?'})`);
		errors.push(...r.errors);
		warnings.push(...r.warnings);
	}
	return { errors, warnings };
}

/**
 * Validate an AI id against the format's gen. The per-gen in-game AIs
 * (gen4ingame etc.) hard-code their generation's behavior; running one
 * against a different gen's format silently misbehaves. The auto-selecting
 * 'ingame' id is always safe.
 */
export function validateAIForGen(aiId: string, gen: number, label: string): string[] {
	const m = /^gen(\d)ingame$/.exec(aiId);
	if (m && parseInt(m[1]) !== gen) {
		return [
			`${label}: AI '${aiId}' replicates Gen ${m[1]} behavior but the format is Gen ${gen}. ` +
			`Use 'ingame' to auto-select the matching generation, or 'gen${gen}ingame'.`,
		];
	}
	return [];
}
