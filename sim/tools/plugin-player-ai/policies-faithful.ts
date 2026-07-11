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
	if (flags.checkViability) applyCheckViability(move, ctx, foe, ownHp, est.effectiveness, add);

	return { score, reasons };
}

/** Classify a PS move into the Gen 3 EFFECT_* family the AI dispatches on. */
/**
 * Moves whose AI_CV effect can't be inferred from PS fields alone, keyed by id.
 * Covers moves that would otherwise mis-classify (Rest looks like heal; Belly
 * Drum like an Attack-up) and damaging moves scored by a CheckViability script
 * (Super Fang, Bide, Icy Wind's speed drop).
 */
const ID_EFFECTS: Record<string, string> = {
	rest: 'rest',
	icywind: 'speed-down', rocktomb: 'speed-down', mudshot: 'speed-down',
	lightscreen: 'lightscreen', reflect: 'reflect',
	superfang: 'superfang', bide: 'bide', bellydrum: 'bellydrum', endure: 'endure',
	curse: 'curse', roar: 'roar', whirlwind: 'roar', haze: 'haze',
	foresight: 'foresight', odorsleuth: 'foresight', psychup: 'psychup',
	counter: 'counter', mirrorcoat: 'mirrorcoat',
	substitute: 'substitute', encore: 'encore', disable: 'disable',
	// EFFECT_MEAN_LOOK + EFFECT_TRAP both route to AI_CV_Trap.
	meanlook: 'trap', block: 'trap', spiderweb: 'trap',
	bind: 'trap', wrap: 'trap', firespin: 'trap', clamp: 'trap', whirlpool: 'trap', sandtomb: 'trap',
	// Type-effectiveness-scored damaging moves.
	dreameater: 'dreameater',
	absorb: 'absorb', megadrain: 'absorb', gigadrain: 'absorb', leechlife: 'absorb',
	hyperbeam: 'recharge', blastburn: 'recharge', hydrocannon: 'recharge', frenzyplant: 'recharge',
	solarbeam: 'chargeup', skyattack: 'chargeup', razorwind: 'chargeup', skullbash: 'chargeup',
};

function gen3Effect(move: AnyObject): string {
	if (!move?.exists) return '';
	const id = move.id as string;
	if (ID_EFFECTS[id]) return ID_EFFECTS[id];
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
		const changed = Object.entries(boosts).filter(([, v]) => (v as number) !== 0);
		if (changed.length === 1) {
			const [stat, val] = changed[0] as [string, number];
			if (val > 0) return `up-${stat}`;
			// Foe-targeting single-stat drops (Growl / Leer / Screech / ...).
			if (val < 0 && move.target !== 'self') return `down-${stat}`;
		}
	}
	// EFFECT_HIGH_CRITICAL (Slash / Crabhammer / Aeroblast / Cross Chop / ...).
	if (move.category !== 'Status' && (move.critRatio ?? 1) >= 2) return 'highcrit';
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

/** The foe's current types (from its species; Gen-3 type chart via `ctx.dex`). */
function foeTypes(foe: FoePokemon, ctx: ActiveContext): string[] {
	return ctx.dex.species.get(foe.speciesId).types;
}

/** Our active's types (parsed from its details; Gen-3 chart via `ctx.dex`). */
function ownTypes(ctx: ActiveContext): string[] {
	const species = (ctx.pokemon.details || '').split(',')[0].trim();
	return ctx.dex.species.get(species).types;
}

/** AI_CV_Curse. Ghost users trap at an HP cost; others use it as bulk-up setup. */
function applyCurse(
	ctx: ActiveContext, ownHp: number, rng: () => number,
	add: (k: string, l: string, d: number) => void
): void {
	if (ownTypes(ctx).includes('Ghost')) {
		if (ownHp <= 80) add('curse', 'Ghost Curse while already hurt', -1);
		return;
	}
	// Non-Ghost bulk-up (our Def stage assumed neutral): three independent +1s.
	if (rng() >= 128) add('curse', 'Curse setup', 1);
	if (rng() >= 128) add('curse', 'Curse setup', 1);
	if (rng() >= 128) add('curse', 'Curse setup', 1);
}

/** The foe's last used move (`get_last_used_bank_move AI_TARGET`), or null. */
function foeLastMove(foe: FoePokemon | undefined, ctx: ActiveContext): AnyObject | null {
	if (!foe?.lastMove) return null;
	const mv = ctx.dex.moves.get(foe.lastMove);
	return mv.exists ? mv : null;
}

/** Whether our active carries a move with this id (`if_has_move AI_USER`). */
function weHaveMove(ctx: ActiveContext, id: string): boolean {
	return ctx.moves.some(m => (m.raw.id ?? toID(m.move)) === id);
}

/** Which incoming effect (if any) a Substitute would block, from the foe's last move. */
function substituteBlockKind(move: AnyObject): 'status' | 'confuse' | 'leechseed' | null {
	if (move.category !== 'Status') return null;
	if (['slp', 'tox', 'psn', 'par', 'brn'].includes(move.status as string)) return 'status';
	if (move.volatileStatus === 'confusion') return 'confuse';
	if (move.volatileStatus === 'leechseed') return 'leechseed';
	return null;
}

/** AI_CV_Substitute: HP-tier discouragement, plus a small bonus when Sub blocks a status. */
function applySubstitute(
	ctx: ActiveContext, foe: FoePokemon | undefined, ownHp: number, foeFaster: boolean,
	rng: () => number, add: (k: string, l: string, d: number) => void
): void {
	// One ~61% -1 roll per HP tier we've dropped below (Sub / Sub2 / Sub3).
	let rolls = 0;
	if (ownHp <= 90) rolls++;
	if (ownHp <= 70) rolls++;
	if (ownHp <= 50) rolls++;
	for (let i = 0; i < rolls; i++) {
		if (rng() >= 100) add('substitute', 'Substitute below full HP', -1);
	}
	// Substitute4-8: +1 if we're not slower and the foe's last move was a status
	// this Substitute would block, not already applied (checks the foe, as shipped).
	if (foeFaster) return;
	const last = foeLastMove(foe, ctx);
	if (!last) return;
	const kind = substituteBlockKind(last);
	let blockable = false;
	if (kind === 'status') blockable = !foe?.status;
	else if (kind === 'confuse') blockable = !foe?.volatiles.has('confusion' as ID);
	else if (kind === 'leechseed') blockable = !foe?.volatiles.has('leechseed' as ID);
	if (blockable && rng() >= 100) add('substitute', 'Substitute blocks the incoming status', 1);
}

/**
 * AI_CV_Counter / AI_CV_MirrorCoat (shipped, non-BUGFIX behaviour). Both read
 * the foe's last used move: +1 if it was a hit of the side we can bounce
 * (physical for Counter, special for Mirror Coat), -1 if it was the wrong side.
 * Carrying the opposite move triggers the random +4 "which one will they use?"
 * mind-game, and a status/none last move falls back to guessing from types.
 */
function applyCounterLike(
	ctx: ActiveContext, foe: FoePokemon | undefined, ownHp: number, sideTypes: Set<string>,
	pairedMoveId: string, rng: () => number, add: (k: string, l: string, d: number) => void,
	key: string, label: string
): void {
	if (foe && (foe.status === 'slp' || foe.volatiles.has('attract') || foe.volatiles.has('confusion'))) {
		add(key, `${label} is unreliable vs an inactive foe`, -1);
		return;
	}
	if (ownHp <= 30 && rng() >= 10) add(key, `${label} while low on HP`, -1);
	if (ownHp <= 50 && rng() >= 100) add(key, `${label} while somewhat hurt`, -1);
	if (weHaveMove(ctx, pairedMoveId)) {
		if (rng() >= 100) add(key, `${label}/counter mix-up`, 4);
		return;
	}
	const last = foeLastMove(foe, ctx);
	if (last && last.basePower > 0) {
		if (!sideTypes.has(last.type as string)) { add(key, `Foe's last hit was the wrong kind`, -1); return; }
		if (rng() >= 100) add(key, `Foe just used a bounceable move`, 1);
		return;
	}
	// power == 0: the foe's last move was status / none — guess from its types.
	if (foe && foeTypes(foe, ctx).some(t => sideTypes.has(t))) return;
	if (rng() < 50) return;
	if (rng() >= 100) add(key, `Anticipating a bounceable hit`, 4);
}

/**
 * AI_CV_DefenseUp / AI_CV_SpDefUp. Both boost a defensive stat and read the
 * foe's last move to judge whether that side is worth reinforcing. With our own
 * stage assumed neutral we take the *Up2 branch; a +2 is possible at full HP,
 * and the move is discouraged when it defends the wrong side or we're low.
 */
function statUpDefensive(
	kind: 'def' | 'spd', ownHp: number, foe: FoePokemon | undefined, ctx: ActiveContext,
	rng: () => number, add: (k: string, l: string, d: number) => void
): void {
	const key = `up-${kind}`;
	const label = kind === 'def' ? 'Defense' : 'Sp. Def';
	if (ownHp >= 100 && rng() >= 128) add(key, `Boosting ${label} at full HP`, 2);
	// *Up3: at high HP the AI usually leaves it there.
	if (ownHp >= 70 && rng() < 200) return;
	// *Up4:
	if (ownHp < 40) { add(key, `Boosting ${label} while badly hurt`, -2); return; }
	const last = foeLastMove(foe, ctx);
	if (last && last.basePower > 0) {
		const lastPhysical = AI_REFLECT_PHYS_TYPES.has(last.type as string);
		// Defense wants a physical attacker; Sp.Def wants a special one.
		const wrongSide = kind === 'def' ? !lastPhysical : lastPhysical;
		if (wrongSide) { add(key, `Foe attacks the other side — ${label} misplaced`, -2); return; }
		if (rng() < 60) return;
	}
	// *Up5 (shared by the power-0 path): the residual ~77% -2.
	if (rng() >= 60) add(key, `Boosting ${label} is low-value now`, -2);
}

// AI_CV_AttackDown / AI_CV_SpAtkDown consult these type lists to guess whether
// the foe is a physical / special attacker worth debuffing. The Attack list is
// bugged in-game (it omits Flying, Poison and Ghost); we replicate that.
const AI_ATTACK_DOWN_TYPES = new Set(['Normal', 'Fighting', 'Ground', 'Rock', 'Bug', 'Steel']);
const AI_SPATK_DOWN_TYPES = new Set(['Fire', 'Water', 'Grass', 'Electric', 'Psychic', 'Ice', 'Dragon', 'Dark']);
// AI_CV_Reflect's physical-type list is the *complete* one (unlike the bugged
// AttackDown list above); Light Screen reuses the special list (AI_SPATK_DOWN_TYPES).
const AI_REFLECT_PHYS_TYPES = new Set(['Normal', 'Fighting', 'Flying', 'Poison', 'Ground', 'Rock', 'Bug', 'Ghost', 'Steel']);

/**
 * AI_CV_LightScreen / AI_CV_Reflect. Discouraged when we're low, or when the
 * foe's types suggest it won't attack on the screened side (special vs
 * physical). Keys off the foe's types, not its last move.
 */
function applyScreen(
	ownHp: number, foe: FoePokemon | undefined, ctx: ActiveContext, relevant: Set<string>,
	rng: () => number, add: (k: string, l: string, d: number) => void, label: string
): void {
	if (ownHp < 50) { add('screen', `${label} while too low on HP`, -2); return; }
	const isRelevant = foe ? foeTypes(foe, ctx).some(t => relevant.has(t)) : false;
	if (!isRelevant && rng() >= 50) add('screen', `Foe unlikely to attack into ${label}`, -2);
}

/**
 * AI_CV_DefenseDown / SpDefDown / EvasionDown share one shape. With the foe's
 * stage assumed neutral, the flow always reaches the ~80% -2, then adds a
 * further -2 against an already-weak foe (just attack it).
 */
function statDownDefensive(
	foeHp: number, rng: () => number,
	add: (k: string, l: string, d: number) => void, label: string
): void {
	if (rng() >= 50) add('stat-down', `Lowering the foe's ${label} is low-value`, -2);
	if (foeHp <= 70) add('stat-down', `Lowering ${label} on a weak foe (attack instead)`, -2);
}

/**
 * AI_CV_AttackDown / AI_CV_SpAtkDown. With the foe's stage assumed neutral the
 * flow skips straight to *Down3: -2 vs a weak foe, then -2 more unless the foe
 * is one of the "relevant attacker" types.
 */
function statDownOffensive(
	foe: FoePokemon | undefined, ctx: ActiveContext, foeHp: number, relevant: Set<string>,
	rng: () => number, add: (k: string, l: string, d: number) => void, label: string
): void {
	if (foeHp <= 70) add('stat-down', `Lowering ${label} on a weak foe (attack instead)`, -2);
	const isRelevant = foe ? foeTypes(foe, ctx).some(t => relevant.has(t)) : false;
	if (!isRelevant && rng() >= 50) add('stat-down', `Foe is not a ${label} attacker`, -2);
}

/** AI_CV_Rest. Assumes the foe has no Snatch (which we don't track). */
function applyRest(
	ownHp: number, foeFaster: boolean, rng: () => number,
	add: (k: string, l: string, d: number) => void
): void {
	if (!foeFaster && ownHp >= 100) { add('rest-full', 'Resting at full HP', -8); return; }
	let encourage: boolean;
	if (!foeFaster) {
		// AI_CV_Rest2 (HP < 100, we are at least as fast).
		if (ownHp < 40) encourage = true;
		else if (ownHp > 50) encourage = false;
		else encourage = rng() < 70;
	} else {
		// AI_CV_Rest4 (the foe is faster).
		if (ownHp < 60) encourage = true;
		else if (ownHp > 70) encourage = false;
		else encourage = rng() < 50;
	}
	if (encourage) {
		if (rng() >= 10) add('rest', 'Resting to recover safely', 3);
	} else {
		add('rest', 'Resting is not worth the turn', -3);
	}
}

/**
 * AI_CheckViability per-effect deltas. Ported from pokeemerald AI_CV_* scripts.
 * Covered so far: healing (AI_CV_Heal), Rest, the stat-boosts (Atk/SpA/Spe/
 * Acc/Evasion) and stat-drops (Atk/SpA/Def/SpD/Spe/Evasion), and the status
 * families (Sleep/Toxic+Leech Seed/Poison/Paralyze/Confuse). Note: our own and
 * the foe's stat stages aren't visible through the protocol, so we assume they
 * are neutral (the un-boosted path the game takes at the start of a turn).
 * Screens (Reflect/Light Screen) and Defense/Sp.Def *up* read the foe's types /
 * last used move (now tracked). Also covered: Super Fang, Bide, Belly Drum,
 * Endure, Curse, Roar/Whirlwind, Haze, Foresight, Psych Up, Counter/Mirror Coat,
 * Substitute, Trap/Mean Look, Encore, Disable, and the type-effectiveness-scored
 * damaging moves (Absorb/drain, Dream Eater, High Crit, Recharge, Charge-up).
 * Still deferred: Accuracy-down, weather setters (need weather state + our
 * ability) and Baton Pass/Protect (need extra tracking).
 */
function applyCheckViability(
	move: AnyObject, ctx: ActiveContext, foe: FoePokemon | undefined,
	ownHp: number, eff: number, add: (k: string, l: string, d: number) => void
): void {
	const rng = () => ctx.prng.random(256);
	const foeHp = foe ? foe.hpPercent : 100;
	const foeFaster = foe ? !weOutspeed(ctx, foe) : false;
	const resisted = eff > 0 && eff < 1;
	const superEff = eff >= 2;
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
	case 'rest': applyRest(ownHp, foeFaster, rng, add); break;
	case 'lightscreen': applyScreen(ownHp, foe, ctx, AI_SPATK_DOWN_TYPES, rng, add, 'Light Screen'); break;
	case 'reflect': applyScreen(ownHp, foe, ctx, AI_REFLECT_PHYS_TYPES, rng, add, 'Reflect'); break;
	case 'down-spe':
	case 'speed-down': {
		// AI_CV_SpeedDown (also Icy Wind / Rock Tomb / Mud Shot).
		if (foeFaster) {
			if (rng() >= 70) add('speed-down', 'Slowing down a faster foe', 2);
		} else {
			add('speed-down', 'Foe is already slower — Speed drop wasted', -3);
		}
		break;
	}
	case 'down-atk': statDownOffensive(foe, ctx, foeHp, AI_ATTACK_DOWN_TYPES, rng, add, 'Attack'); break;
	case 'down-spa': statDownOffensive(foe, ctx, foeHp, AI_SPATK_DOWN_TYPES, rng, add, 'Sp. Atk'); break;
	case 'down-def': statDownDefensive(foeHp, rng, add, 'Defense'); break;
	case 'down-spd': statDownDefensive(foeHp, rng, add, 'Sp. Def'); break;
	case 'down-evasion': statDownDefensive(foeHp, rng, add, 'evasion'); break;
	case 'superfang': if (foeHp <= 50) add('superfang', 'Foe is already at half HP', -1); break;
	case 'bide': if (ownHp <= 90) add('bide', 'Biding below full HP', -2); break;
	case 'bellydrum': if (ownHp < 90) add('bellydrum', 'Belly Drum below 90% HP', -2); break;
	case 'endure': {
		// AI_CV_Endure.
		if (ownHp < 4) add('endure', 'Endure at critical HP', -1);
		else if (ownHp < 35) { if (rng() >= 70) add('endure', 'Endure to survive a hit', 1); } else add('endure', 'Endure at healthy HP (wasteful)', -1);
		break;
	}
	case 'curse': applyCurse(ctx, ownHp, rng, add); break;
	case 'roar': add('roar', 'Phazing an un-boosted foe', -3); break;
	case 'haze': if (rng() >= 50) add('haze', 'Hazing with nothing to reset', -1); break;
	case 'psychup': add('psychup', 'Nothing worth copying from the foe', -2); break;
	case 'counter': applyCounterLike(ctx, foe, ownHp, AI_REFLECT_PHYS_TYPES, 'mirrorcoat', rng, add, 'counter', 'Counter'); break;
	case 'mirrorcoat': applyCounterLike(ctx, foe, ownHp, AI_SPATK_DOWN_TYPES, 'counter', rng, add, 'mirrorcoat', 'Mirror Coat'); break;
	case 'substitute': applySubstitute(ctx, foe, ownHp, foeFaster, rng, add); break;
	case 'trap': {
		// AI_CV_Trap: encourage trapping a foe that's taking residual damage.
		const stuck = foe && (foe.status === 'tox' || foe.volatiles.has('curse' as ID) ||
			foe.volatiles.has('perishsong' as ID) || foe.volatiles.has('attract' as ID));
		if (stuck && rng() >= 128) add('trap', 'Trapping a foe taking residual damage', 1);
		break;
	}
	case 'encore': {
		// AI_CV_Encore (foe-disabled-move check omitted; last-move effect
		// approximated by category — the encouraged list is essentially status moves).
		if (foeFaster) { add('encore', 'Foe is faster — Encore is risky', -2); break; }
		const last = foeLastMove(foe, ctx);
		if (!last || last.category !== 'Status') { add('encore', 'Nothing bad to lock the foe into', -2); break; }
		if (rng() >= 30) add('encore', 'Locking the foe into a bad move', 3);
		break;
	}
	case 'disable': {
		// AI_CV_Disable: +1 to disable the foe's attack; -1 if it just used status.
		if (foeFaster) break;
		const last = foeLastMove(foe, ctx);
		if (last && last.basePower > 0) add('disable', 'Disabling the foe\'s attack', 1);
		else if (rng() >= 100) add('disable', 'Little worth disabling', -1);
		break;
	}
	case 'absorb': {
		// AI_CV_Absorb: draining moves are discouraged when resisted.
		if (resisted && rng() >= 50) add('absorb', 'Drain move is resisted', -3);
		break;
	}
	case 'dreameater': {
		// AI_CV_DreamEater (viability): -1 when resisted (the "foe asleep" gate is
		// the separate AI_CheckBadMove -8).
		if (resisted) add('dreameater', 'Dream Eater is resisted', -1);
		break;
	}
	case 'highcrit': {
		// AI_CV_HighCrit: a small bonus for high-crit moves that aren't resisted.
		if (resisted) break;
		if (superEff || rng() >= 128) { if (rng() >= 128) add('highcrit', 'High-crit move', 1); }
		break;
	}
	case 'recharge': {
		// AI_CV_Recharge (Hyper Beam etc.): discouraged unless it's a finishing blow.
		if (resisted) { add('recharge', 'Recharge move is resisted', -1); break; }
		if (foeFaster) { if (ownHp >= 60) add('recharge', 'Recharge move while healthy', -1); }
		else if (ownHp > 40) add('recharge', 'Recharge move while healthy', -1);
		break;
	}
	case 'chargeup': {
		// AI_CV_ChargeUpMove (Solar Beam / Sky Attack / ...).
		if (resisted) { add('chargeup', 'Charge move is resisted', -2); break; }
		if (foe?.revealedMoves.some(m => m === 'protect' || m === 'detect')) {
			add('chargeup', 'Foe can Protect through the charge', -2);
		} else if (ownHp <= 38) {
			add('chargeup', 'Charging while low is risky', -1);
		}
		break;
	}
	case 'foresight': {
		// AI_CV_Foresight (shipped bug: keys off the USER's Ghost/evasion).
		if (ownTypes(ctx).includes('Ghost')) {
			if (rng() >= 80 && rng() >= 80) add('foresight', 'Foresight (Ghost user)', 2);
		} else {
			add('foresight', 'Foresight is not useful here', -2);
		}
		break;
	}
	case 'up-atk': statUpOffensive(ownHp, 40, rng, add, 'atk'); break;
	case 'up-spa': statUpOffensive(ownHp, 70, rng, add, 'spa'); break;
	case 'up-def': statUpDefensive('def', ownHp, foe, ctx, rng, add); break;
	case 'up-spd': statUpDefensive('spd', ownHp, foe, ctx, rng, add); break;
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
