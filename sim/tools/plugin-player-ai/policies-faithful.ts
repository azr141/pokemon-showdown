/**
 * Plugin Player AI — FAITHFUL port of the mainline trainer AI.
 *
 * This is the "copy the games exactly" AI, kept separate from the polished
 * heuristic in `policies-ingame.ts`. Where the polished AI is idealised (it
 * avoids obviously-bad plays), this one reproduces the decompiled algorithm
 * verbatim — including its randomness and its willingness to make bad plays,
 * because that is what the real games do.
 *
 * ## Source
 *
 * Gen 3 logic is ported from pret/pokeemerald `data/battle_ai_scripts.s` +
 * `src/battle_ai_script_commands.c`. Every move starts at score 100; the
 * enabled AI scripts adjust it; the highest-scoring move wins with a RANDOM
 * tie-break (`Random() % numOfBestMoves`).
 *
 * ## Trainer flags (AI_FLAG_*)
 *
 * The real AI is per-trainer: each trainer enables a subset of scripts. Most
 * route trainers enable NONE (every move stays at 100 → near-random). Gym
 * leaders and the Elite Four enable more. We model this with `AiFlags` tiers.
 *
 * ## AI_TryToFaint (the KO routine) — exact
 *   - KO move            → +4
 *   - KO via Quick Attack (priority) → +6
 *   - Explosion / Self-Destruct KO   → +0 (explicitly excluded)
 *   - non-KO, not the strongest move → −1
 *   - non-KO, 4× super-effective     → +2, ~69% of the time
 *
 * ## AI_CheckBadMove — the common penalties
 *   - move the foe is immune to (type/ability) → −10
 *   - re-applying a status the foe already has  → −10
 *   - Dream Eater / Nightmare on a non-asleep foe → −8
 *   - Belly Drum at ≤50% HP → −10
 *   - Explosion: 0 with a healthy party, −10 as the last mon
 *
 * Known simplification: the games discourage a stat-boost already at +6, but
 * our own boosts aren't visible through the protocol, so that check is skipped
 * (same limitation as the polished AI). AI_CheckViability's ~150 per-effect
 * cases are ported incrementally.
 */

import { toID } from '../../dex';
import type {
	ActionPolicy, ActiveContext, MoveCandidate, MoveDecision, MoveScoreTrace, ScoreReason,
} from './types';
import { estimateDamage, type DamageEstimate } from './damage-estimate';
import type { FoePokemon } from './battle-view';

/** Which AI scripts a trainer runs. Mirrors the games' AI_FLAG_* bits. */
export interface AiFlags {
	checkBadMove: boolean;
	tryToFaint: boolean;
	checkViability: boolean;
}

/**
 * Trainer skill tiers. `wild`/`grunt` run few scripts (near-random, like a
 * low-level route trainer); `gym`/`ace` run the full smart set.
 */
export const FAITHFUL_TIERS: Record<string, AiFlags> = {
	wild: { checkBadMove: false, tryToFaint: false, checkViability: false },
	grunt: { checkBadMove: false, tryToFaint: true, checkViability: false },
	gym: { checkBadMove: true, tryToFaint: true, checkViability: false },
	ace: { checkBadMove: true, tryToFaint: true, checkViability: true },
};

const SELF_KO_MOVES = new Set([
	'selfdestruct', 'explosion', 'memento', 'finalgambit', 'mistyexplosion',
]);

/** Gen 3 abilities that grant a full type immunity the AI knows about. */
const GEN3_ABILITY_IMMUNITY: Record<string, string> = {
	levitate: 'Ground', flashfire: 'Fire', waterabsorb: 'Water', voltabsorb: 'Electric',
};

interface Scored {
	cand: MoveCandidate;
	est: DamageEstimate;
	move: AnyObject;
}

function foeAbility(foe: FoePokemon, ctx: ActiveContext): ID | undefined {
	return ctx.view.foeKnownSets.get(foe.speciesId)?.ability ?? foe.revealedAbility;
}

/** Whether the foe's ability nullifies this damaging move (the AI knows abilities). */
function abilityNullifies(foe: FoePokemon, ctx: ActiveContext, move: AnyObject, effectiveness: number): boolean {
	const ability = foeAbility(foe, ctx);
	if (!ability) return false;
	if (GEN3_ABILITY_IMMUNITY[ability as string] === move.type) return true;
	if (ability === 'wonderguard' && effectiveness < 2) return true;
	if (ability === 'soundproof' && move.flags?.sound) return true;
	return false;
}

function ownHpPercent(ctx: ActiveContext): number {
	const hp = (ctx.pokemon.condition || '').split(' ')[0];
	const slash = hp.indexOf('/');
	if (slash < 0) return 100;
	const num = parseInt(hp.slice(0, slash)), den = parseInt(hp.slice(slash + 1));
	return den ? Math.max(0, Math.min(100, num / den * 100)) : 100;
}

/**
 * Score one move exactly as the enabled Gen 3 scripts would, recording each
 * non-zero adjustment for the explainer.
 */
function scoreFaithful(
	sc: Scored, ctx: ActiveContext, flags: AiFlags,
	foe: FoePokemon | undefined, isMostPowerful: boolean
): { score: number, reasons: ScoreReason[] } {
	const { est, move } = sc;
	const reasons: ScoreReason[] = [{ key: 'base', label: 'Base score', delta: 100 }];
	let score = 100;
	const add = (key: string, label: string, delta: number) => {
		if (delta === 0) return;
		score += delta;
		reasons.push({ key, label, delta });
	};
	const isDamaging = move.category !== 'Status';
	const isSelfKO = SELF_KO_MOVES.has(move.id as string);

	// --- AI_CheckBadMove ---
	if (flags.checkBadMove) {
		// Immunity (type or ability) — the est is pre-zeroed for ability
		// immunity in faithfulScoreMove, so effectiveness 0 covers both.
		if (isDamaging && est.effectiveness === 0) {
			add('immune', 'Foe is immune — no effect', -10);
		}
		if (!isDamaging && (move.status || move.volatileStatus) && foe?.status) {
			add('reapply-status', 'Foe already has a status', -10);
		}
		if ((move.id === 'dreameater' || move.id === 'nightmare') && foe && foe.status !== 'slp') {
			add('cant-work', 'Foe is not asleep', -8);
		}
		if (move.id === 'bellydrum' && ownHpPercent(ctx) <= 50) {
			add('cant-work', 'Not enough HP for Belly Drum', -10);
		}
		if (isSelfKO) {
			if (est.effectiveness === 0 || (foe && foeAbility(foe, ctx) === 'damp')) {
				add('self-ko', 'Self-KO wasted (immune / Damp)', -10);
			} else if (ctx.switches.length === 0) {
				add('self-ko', 'Self-KO as the last Pokémon', -10);
			}
			// else: has backup — no penalty (the games are fine exploding here)
		}
	}

	// --- AI_TryToFaint ---
	if (flags.tryToFaint) {
		if (est.canKO && foe) {
			if (isSelfKO) {
				// Explicitly excluded from the faint bonus (+0).
			} else if (move.priority > 0 && isDamaging) {
				add('ko-priority', 'Can KO with priority (Quick Attack)', 6);
			} else {
				add('ko', 'Can KO the foe', 4);
			}
		} else {
			if (!isMostPowerful) add('not-strongest', 'Not the strongest move', -1);
			// 4× super-effective, ~69% of the time (if_random_less_than 80).
			if (isDamaging && est.effectiveness >= 4 && ctx.prng.random(256) >= 80) {
				add('quad-se', '4× super-effective', 2);
			}
		}
	}

	// --- AI_CheckViability: incremental; core cases only for now ---
	// (Left minimal — the long tail of per-effect deltas is ported over time.)

	return { score, reasons };
}

/**
 * Faithful move-selection policy for the given trainer flags. Highest score
 * wins; ties are broken uniformly at random (as the games do).
 */
export function faithfulScoreMove(flags: AiFlags): ActionPolicy {
	return (ctx: ActiveContext): MoveDecision | null => {
		const foe = ctx.view.primaryFoe();
		const regular = ctx.moves.filter(m => !m.maxMove && !m.zMove);
		const pool = regular.length ? regular : ctx.moves;
		if (!pool.length) return null;

		const scored: Scored[] = pool.map(cand => {
			const move = ctx.dex.moves.get(cand.raw.id ?? toID(cand.move));
			let est = foe ? estimateDamage(cand, ctx, foe) : { percent: 0, canKO: false, effectiveness: 1 };
			// The game's damage calc knows the foe's ability, so an ability-immune
			// move does 0 — otherwise it wrongly counts as the "strongest move".
			if (foe && move && move.category !== 'Status' && est.percent > 0 &&
				abilityNullifies(foe, ctx, move, est.effectiveness)) {
				est = { percent: 0, canKO: false, effectiveness: 0 };
			}
			return { cand, est, move: move ?? {} };
		});
		// "most powerful" = the single highest-damage move (get_how_powerful_move_is).
		const maxDamage = scored.reduce((m, s) => Math.max(m, s.est.percent), 0);

		const traces: MoveScoreTrace[] = [];
		let best = -Infinity;
		let bestCands: MoveCandidate[] = [];
		for (const sc of scored) {
			const isMostPowerful = maxDamage > 0 && sc.est.percent === maxDamage;
			const { score, reasons } = scoreFaithful(sc, ctx, flags, foe, isMostPowerful);
			traces.push({
				move: sc.cand.move, slot: sc.cand.slot, score, chosen: false,
				tiedTop: false, damagePercent: sc.est.percent, canKO: sc.est.canKO, reasons,
			});
			if (score > best) {
				best = score;
				bestCands = [sc.cand];
			} else if (score === best) {
				bestCands.push(sc.cand);
			}
		}

		const candidate = bestCands.length === 1 ? bestCands[0] : ctx.prng.sample(bestCands);
		for (const t of traces) {
			t.chosen = t.move === candidate.move;
			t.tiedTop = t.score === best && bestCands.length > 1;
		}
		if (ctx.explain) ctx.explain.push(...traces);
		return { kind: 'move', candidate };
	};
}
