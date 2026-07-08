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
import { estimateDamage, weOutspeed, type DamageEstimate } from './damage-estimate';
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

/** Does our active have at least one damaging move? (`if_user_has_no_attacking_moves`) */
function userHasAttackingMove(ctx: ActiveContext): boolean {
	return ctx.moves.some(m => {
		const mv = ctx.dex.moves.get(m.raw.id ?? toID(m.move));
		return mv.exists && mv.category !== 'Status';
	});
}

/**
 * Whether we carry a stall enabler — a Protect/Detect or a Special-Defense-up
 * move — which the Toxic script uses to encourage poison (`EFFECT_PROTECT` /
 * `EFFECT_SPECIAL_DEFENSE_UP`).
 */
function userHasStallSynergy(ctx: ActiveContext): boolean {
	return ctx.moves.some(m => {
		const mv = ctx.dex.moves.get(m.raw.id ?? toID(m.move));
		if (!mv.exists) return false;
		if (mv.volatileStatus === 'protect' || mv.id === 'protect' || mv.id === 'detect') return true;
		const boosts = mv.boosts || mv.self?.boosts;
		return !!(boosts && (boosts as AnyObject).spd > 0);
	});
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
	const ownHp = ownHpPercent(ctx);

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
		if (move.id === 'bellydrum' && ownHp <= 50) {
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

	// --- AI_CheckViability (ported incrementally, effect by effect) ---
	if (flags.checkViability) applyCheckViability(move, ctx, foe, ownHp, add);

	return { score, reasons };
}

/** Classify a PS move into the Gen 3 EFFECT_* family the AI dispatches on. */
function gen3Effect(move: AnyObject): string {
	if (!move?.exists) return '';
	if (move.category === 'Status') {
		// Status-infliction families (all Status-category primary effects).
		// EFFECT_TOXIC and EFFECT_LEECH_SEED share AI_CV_Toxic in the real game.
		if (move.status === 'tox' || move.volatileStatus === 'leechseed') return 'toxic';
		if (move.status === 'psn') return 'poison';
		if (move.status === 'par') return 'paralyze';
		if (move.status === 'slp') return 'sleep';
		if (move.volatileStatus === 'confusion' && !move.boosts && !move.status) return 'confuse';
	}
	// EFFECT_RESTORE_HP / SOFTBOILED / SWALLOW — pure recovery (not Rest, not weather-heal).
	const WEATHER_HEAL = new Set(['morningsun', 'synthesis', 'moonlight']);
	if (move.category === 'Status' && move.flags?.heal && !move.status && !WEATHER_HEAL.has(move.id as string)) {
		return 'heal';
	}
	// EFFECT_*_UP — a self-targeting move that only raises stats. The real AI
	// has a distinct script per stat, so single-stat boosts dispatch by stat
	// (`up-atk`/`up-spa`/`up-spe`/`up-accuracy`/`up-evasion`). Multi-stat setup
	// (Dragon Dance / Bulk Up / Calm Mind) has its own effect, ported later.
	const boosts = move.boosts || move.self?.boosts;
	if (move.category === 'Status' && boosts) {
		const raised = Object.entries(boosts).filter(([, v]) => (v as number) !== 0);
		if (raised.length === 1 && (raised[0][1] as number) > 0) return `up-${raised[0][0]}`;
	}
	return '';
}

/**
 * AI_CV_AttackUp / AI_CV_SpAtkUp: the two offensive stat-boost scripts share a
 * shape — a possible +2 at full HP, discouragement when hurt — differing only
 * in the mid-HP random threshold (Atk 40, SpAtk 70). Our own stat stage isn't
 * visible, so we assume it is below +3 (the encourage branch), as the game
 * would on an un-boosted setup sweeper.
 */
function statUpOffensive(
	ownHp: number, midThresh: number, rng: () => number,
	add: (k: string, l: string, d: number) => void, stat: 'atk' | 'spa'
): void {
	const key = `up-${stat}`;
	const label = stat === 'atk' ? 'Attack' : 'Sp. Atk';
	if (ownHp >= 100 && rng() >= 128) add(key, `Boosting ${label} at full HP`, 2);
	if (ownHp <= 70) {
		if (ownHp < 40) add(key, `Boosting ${label} while badly hurt`, -2);
		else if (rng() >= midThresh) add(key, `Boosting ${label} while hurt`, -2);
	}
}

/**
 * AI_CheckViability per-effect deltas. Ported from pokeemerald AI_CV_* scripts.
 * Covered so far: healing (AI_CV_Heal), the offensive/Speed/accuracy/evasion
 * stat-boosts, and the status families (Sleep/Toxic+Leech Seed/Poison/Paralyze/
 * Confuse). Note: our own stat stages aren't visible through the protocol, so
 * the "already at +3" discouragement is skipped (we assume the encourage path);
 * Defense/Sp.Def up and Substitute are deferred (they read the foe's last move).
 */
function applyCheckViability(
	move: AnyObject, ctx: ActiveContext, foe: FoePokemon | undefined,
	ownHp: number, add: (k: string, l: string, d: number) => void
): void {
	const rng = () => ctx.prng.random(256);
	const foeHp = foe ? foe.hpPercent : 100;
	const foeFaster = foe ? !weOutspeed(ctx, foe) : false;
	switch (gen3Effect(move)) {
	case 'sleep': {
		// AI_CV_Sleep: +1 (50%) only if we can exploit sleep (Dream Eater / Nightmare).
		const hasSleepExploit = ctx.moves.some(m => {
			const id = m.raw.id ?? toID(m.move);
			return id === 'dreameater' || id === 'nightmare';
		});
		if (hasSleepExploit && rng() >= 128) add('sleep-combo', 'Sleep enables Dream Eater/Nightmare', 1);
		break;
	}
	case 'toxic': {
		// AI_CV_Toxic (also EFFECT_LEECH_SEED). HP penalties only if we can attack.
		if (userHasAttackingMove(ctx)) {
			if (ownHp <= 50 && rng() >= 50) add('status-self-low', 'Statusing while low on HP', -3);
			if (foeHp <= 50 && rng() >= 50) add('status-foe-low', 'Statusing an already-weak foe', -3);
		}
		// Stall synergy (Protect / Sp.Def boost) → encourage the residual damage.
		if (userHasStallSynergy(ctx) && rng() >= 60) add('status-stall', 'Poison pairs with stall', 2);
		break;
	}
	case 'poison': {
		// AI_CV_Poison: -1 when we're low or the foe is already weakened.
		if (ownHp < 50 || foeHp <= 50) add('poison-weak', 'Poison is weak here', -1);
		break;
	}
	case 'paralyze': {
		// AI_CV_Paralyze.
		if (foeFaster) {
			if (rng() >= 20) add('para-slow-foe', 'Paralysis cripples a faster foe', 3);
		} else if (ownHp <= 70) {
			add('para-fast', 'Already outspeeding — attack instead', -1);
		}
		break;
	}
	case 'confuse': {
		// AI_CV_Confuse: increasingly discouraged as the foe weakens (just KO it).
		if (foeHp <= 70) {
			if (rng() >= 128) add('confuse-weak', 'Confusing a weakened foe', -1);
			if (foeHp <= 50) {
				add('confuse-weaker', 'Confusing a low-HP foe', -1);
				if (foeHp <= 30) add('confuse-weakest', 'Confusing a nearly-fainted foe', -1);
			}
		}
		break;
	}
	case 'up-atk': statUpOffensive(ownHp, 40, rng, add, 'atk'); break;
	case 'up-spa': statUpOffensive(ownHp, 70, rng, add, 'spa'); break;
	case 'up-spe': {
		// AI_CV_SpeedUp: only worth it against a faster foe.
		if (foeFaster) {
			if (rng() >= 70) add('speed-up', 'Boosting Speed to outrun the foe', 3);
		} else {
			add('speed-up', 'Already outspeeding — Speed boost wasted', -3);
		}
		break;
	}
	case 'up-accuracy': {
		// AI_CV_AccuracyUp (own accuracy assumed neutral): discouraged when hurt.
		if (ownHp <= 70) add('accuracy-up', 'Boosting accuracy while hurt (attack instead)', -2);
		break;
	}
	case 'up-evasion': {
		// AI_CV_EvasionUp (own evasion assumed neutral: no stage penalty).
		if (ownHp >= 90 && rng() >= 100) add('evasion-high', 'Boosting evasion at high HP', 3);
		if (foe?.status === 'tox') {
			// Evasion stalls out a badly-poisoned foe (AI_CV_EvasionUp3/4).
			const toEncourage = ownHp > 50 || rng() >= 80;
			if (toEncourage && rng() >= 50) add('evasion-stall', 'Evasion stalls the poisoned foe', 3);
		}
		// (Leech Seed / Curse / Ingrain add further +; omitted — not tracked here.)
		break;
	}
	case 'heal': {
		// AI_CV_Heal.
		if (ownHp >= 100) { add('heal-full', 'Healing at full HP', -3); break; }
		if (!foeFaster) { add('heal-fast', 'Healing while outspeeding (attack instead)', -8); break; }
		// AI_CV_Heal4: the foe is faster.
		if (ownHp < 70 || rng() < 30) {
			if (rng() >= 20) add('heal-low', 'Healing while slow and hurt', 2);
		} else {
			add('heal', 'Healing (not urgent)', -3);
		}
		break;
	}
	}
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
