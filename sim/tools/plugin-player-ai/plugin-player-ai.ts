/**
 * Plugin Player AI.
 *
 * A BattlePlayer whose decision logic is composed from a chain of policy
 * functions. The player handles all the protocol bookkeeping that the
 * existing `RandomPlayerAI` handles — enumerating legal moves and switches,
 * filtering trapped/fainted/already-chosen options, formatting target
 * locations for doubles, applying form changes (mega/dynamax/tera/etc.) —
 * and hands the resulting candidate lists to the policy chain to choose.
 *
 * The chain is generation-agnostic; per-generation behavior is expressed by
 * picking different policy compositions (see ./gens/).
 */

import type { ObjectReadWriteStream } from '../../../lib/streams';
import { BattlePlayer } from '../../battle-stream';
import { Dex, type ModdedDex } from '../../dex';
import { PRNG, type PRNGSeed } from '../../prng';
import type {
	ChoiceRequest, MoveRequest, SwitchRequest, TeamPreviewRequest,
	PokemonMoveRequestData,
} from '../../side';
import { BattleView } from './battle-view';
import type {
	ActiveContext, ForceSwitchContext, TeamPreviewContext,
	Decision, MoveDecision, SwitchDecision, MoveCandidate, SwitchCandidate,
	PolicyChain, FormChange,
} from './types';

export interface PluginPlayerOptions {
	/** Policy chain to run. If omitted, uses `defaultChain` from ./gens. */
	chain?: PolicyChain;
	/** Optional explicit gen (1-9). If omitted, inferred from `|gen|` log. */
	gen?: number;
	/** Dex to use for type/species lookups. Defaults to Dex.forGen(gen). */
	dex?: ModdedDex;
	/** Seed for the player's PRNG (used by random fallback policies). */
	seed?: PRNG | PRNGSeed | null;
}

export class PluginPlayerAI extends BattlePlayer {
	readonly chain: PolicyChain;
	readonly prng: PRNG;
	readonly view: BattleView;
	/** Resolved by the chooseChain hook on first request if `chain` is null. */
	private resolvedChain: PolicyChain | null;
	private explicitGen: number | undefined;

	constructor(
		playerStream: ObjectReadWriteStream<string>,
		options: PluginPlayerOptions = {},
		debug = false,
	) {
		super(playerStream, debug);
		this.prng = PRNG.get(options.seed);
		this.explicitGen = options.gen;
		const dex = options.dex ?? (options.gen ? Dex.forGen(options.gen) : Dex);
		this.view = new BattleView(dex);
		if (options.gen) this.view.setGen(options.gen);
		// `chain` may be filled in lazily by chooseChain() once we know the gen.
		this.chain = options.chain!;
		this.resolvedChain = options.chain ?? null;
	}

	/**
	 * Override to swap policy chains based on the detected gen / format.
	 * Called once on the first request. By default returns the chain passed
	 * via constructor options, or throws if none was provided.
	 */
	protected chooseChain(_gen: number): PolicyChain {
		if (this.resolvedChain) return this.resolvedChain;
		throw new Error(`${this.constructor.name}: no policy chain provided and chooseChain() not overridden`);
	}

	override receiveLine(line: string) {
		// Keep BattlePlayer's behavior (push non-request lines into this.log),
		// then feed the same line into the battle view.
		super.receiveLine(line);
		this.view.receiveLine(line);
	}

	override receiveError(error: Error) {
		// Same swallow-on-unavailable-choice behavior as RandomPlayerAI: the
		// engine will send us a follow-up request with the corrected info.
		if (error.message.startsWith('[Unavailable choice]')) return;
		throw error;
	}

	override receiveRequest(request: ChoiceRequest) {
		// First request: we now know our side id; tell the view.
		if (request.side && !this.view.ourSide) {
			this.view.setOurSide(request.side.id);
		}
		if (!this.resolvedChain) {
			this.resolvedChain = this.chooseChain(this.view.gen);
		}

		if (request.wait) {
			// Engine doesn't expect a choice from us this turn.
			return;
		}
		if (request.forceSwitch) {
			this.handleForceSwitch(request);
			return;
		}
		if (request.teamPreview) {
			this.handleTeamPreview(request);
			return;
		}
		if (request.active) {
			this.handleMoveRequest(request as MoveRequest);
			return;
		}
	}

	// --------------------------------------------------------------------
	// Request handlers
	// --------------------------------------------------------------------

	private handleTeamPreview(request: TeamPreviewRequest) {
		const ctx: TeamPreviewContext = {
			player: this,
			request,
			team: request.side.pokemon,
			maxChosenTeamSize: request.maxChosenTeamSize,
			view: this.view,
			dex: this.view.dex,
			gen: this.view.gen,
			prng: this.prng,
		};
		for (const policy of this.resolvedChain!.teamPreview) {
			const result = policy(ctx);
			if (result !== null) {
				this.choose(result);
				return;
			}
		}
		throw new Error(`${this.constructor.name}: team preview policy chain exhausted with no decision`);
	}

	private handleForceSwitch(request: SwitchRequest) {
		const pokemon = request.side.pokemon;
		const chosen: number[] = [];
		const chunks = request.forceSwitch.map((mustSwitch, i) => {
			if (!mustSwitch) return 'pass';
			const switches = this.collectSwitchesForForceSwitch(request, i, chosen);
			if (!switches.length) return 'pass';
			const ctx: ForceSwitchContext = {
				player: this,
				request,
				pokemon: pokemon[i],
				index: i,
				switches,
				view: this.view,
				dex: this.view.dex,
				gen: this.view.gen,
				prng: this.prng,
			};
			const decision = this.runChain(this.resolvedChain!.forceSwitch, ctx, 'forced switch');
			chosen.push(decision.candidate.slot);
			return `switch ${decision.candidate.slot}`;
		});
		this.choose(chunks.join(', '));
	}

	private handleMoveRequest(request: MoveRequest) {
		const pokemon = request.side.pokemon;
		const chosen: number[] = [];
		// Form-change flags are consumed lazily: only one form change per turn
		// across all active slots, and z-move likewise (z-move is per-slot in
		// theory but the engine enforces only one in a turn).
		const formAvail = {
			mega: true, ultra: true, dynamax: true, terastallize: true, zmove: true,
		};
		const chunks = request.active.map((active: AnyObject, i: number) => {
			const myPokemon = pokemon[i];
			if (myPokemon.condition.endsWith(' fnt') || myPokemon.commanding) return 'pass';

			const ctx = this.buildActiveContext(request, active, i, chosen, formAvail);
			// If the pokemon literally cannot move and cannot switch, the engine
			// will normally send a wait request — but in degenerate cases we
			// fall back to passing rather than throwing.
			if (!ctx.moves.length && !ctx.switches.length) return 'pass';
			const decision = this.runChain(this.resolvedChain!.action, ctx, `slot ${i}`);
			if (decision.kind === 'switch') {
				chosen.push(decision.candidate.slot);
				return `switch ${decision.candidate.slot}`;
			}
			return this.formatMoveDecision(decision, ctx, formAvail);
		});
		this.choose(chunks.join(', '));
	}

	// --------------------------------------------------------------------
	// Chain execution
	// --------------------------------------------------------------------

	private runChain(policies: ((c: any) => any)[], ctx: any, label: string): any {
		for (const policy of policies) {
			const result = policy(ctx);
			if (result !== null && result !== undefined) return result;
		}
		throw new Error(`${this.constructor.name}: policy chain exhausted with no decision for ${label}`);
	}

	// --------------------------------------------------------------------
	// Candidate enumeration
	// --------------------------------------------------------------------

	private buildActiveContext(
		request: MoveRequest,
		active: AnyObject,
		activeIndex: number,
		chosenSwitchSlots: number[],
		formAvail: { mega: boolean, ultra: boolean, dynamax: boolean, terastallize: boolean, zmove: boolean },
	): ActiveContext {
		const pokemon = request.side.pokemon;
		const myPokemon = pokemon[activeIndex];

		const canMega = !!active.canMegaEvo && formAvail.mega;
		const canUltra = !!active.canUltraBurst && formAvail.ultra;
		const canDynamax = !!active.canDynamax && formAvail.dynamax;
		const canTerastallize = !!active.canTerastallize && formAvail.terastallize;
		const canZMove = !!active.canZMove && formAvail.zmove;

		// If already dynamaxed (gen 8), `maxMoves` is present but `canDynamax`
		// is false. In that case the protocol expects the regular `move N`
		// slot, but the *name* of the move is the max move — that matters for
		// type-aware policies. We expose max moves and tag them.
		const alreadyDynamaxed = !active.canDynamax && active.maxMoves;
		const baseMoves: AnyObject[] = alreadyDynamaxed ? active.maxMoves.maxMoves : (active.moves || []);
		const moves: MoveCandidate[] = [];
		for (let j = 0; j < baseMoves.length; j++) {
			const entry = baseMoves[j];
			if (!entry || entry.disabled) continue;
			moves.push({
				slot: j + 1,
				move: entry.move,
				target: entry.target,
				zMove: false,
				maxMove: !!alreadyDynamaxed,
				raw: entry,
			});
		}
		// Optional dynamax variants the policy can choose by setting formChange=dynamax.
		if (canDynamax && active.maxMoves?.maxMoves) {
			const maxMoves: AnyObject[] = active.maxMoves.maxMoves;
			for (let j = 0; j < maxMoves.length; j++) {
				const entry = maxMoves[j];
				if (!entry || entry.disabled) continue;
				moves.push({
					slot: j + 1,
					move: entry.move,
					target: entry.target,
					zMove: false,
					maxMove: true,
					raw: entry,
				});
			}
		}
		// Z-move variants.
		if (canZMove && Array.isArray(active.canZMove)) {
			for (let j = 0; j < active.canZMove.length; j++) {
				const entry = active.canZMove[j];
				if (!entry) continue;
				moves.push({
					slot: j + 1,
					move: entry.move,
					target: entry.target,
					zMove: true,
					maxMove: false,
					raw: entry,
				});
			}
		}

		// Filter adjacentAlly targets when we have no ally.
		const hasAlly = pokemon.length > 1 && !pokemon[activeIndex ^ 1]?.condition.endsWith(' fnt');
		const filteredMoves = moves.filter(m => m.target !== 'adjacentAlly' || hasAlly);
		const finalMoves = filteredMoves.length ? filteredMoves : moves;

		// Switches: not active, not chosen elsewhere this turn, not fainted, and
		// only if we're not trapped.
		const switches: SwitchCandidate[] = [];
		if (!active.trapped) {
			for (let j = 1; j <= 6; j++) {
				const candidate = pokemon[j - 1];
				if (!candidate) continue;
				if (candidate.active) continue;
				if (chosenSwitchSlots.includes(j)) continue;
				if (candidate.condition.endsWith(' fnt')) continue;
				switches.push({ slot: j, pokemon: candidate });
			}
		}

		return {
			player: this,
			request,
			active: active as PokemonMoveRequestData,
			activeIndex,
			pokemon: myPokemon,
			moves: finalMoves,
			switches,
			canMega, canUltra, canDynamax, canTerastallize, canZMove,
			view: this.view,
			dex: this.view.dex,
			gen: this.view.gen,
			prng: this.prng,
		};
	}

	private collectSwitchesForForceSwitch(
		request: SwitchRequest, i: number, alreadyChosen: number[],
	): SwitchCandidate[] {
		// Mirror RandomPlayerAI's filter: a pokemon must exist, be on the bench
		// (or be the reviving slot for Revival Blessing), not already chosen,
		// and have fainted-ness matching whether we're reviving.
		const pokemon = request.side.pokemon;
		const switches: SwitchCandidate[] = [];
		for (let j = 1; j <= 6; j++) {
			const candidate = pokemon[j - 1];
			if (!candidate) continue;
			const isBenched = j > request.forceSwitch.length || pokemon[i].reviving;
			if (!isBenched) continue;
			if (alreadyChosen.includes(j)) continue;
			const isFainted = candidate.condition.endsWith(' fnt');
			const reviving = !!pokemon[i].reviving;
			// Revival Blessing wants a fainted target; normal switches want a
			// non-fainted one.
			if (isFainted !== reviving) continue;
			switches.push({ slot: j, pokemon: candidate });
		}
		return switches;
	}

	// --------------------------------------------------------------------
	// Decision formatting
	// --------------------------------------------------------------------

	private formatMoveDecision(
		decision: MoveDecision,
		ctx: ActiveContext,
		formAvail: { mega: boolean, ultra: boolean, dynamax: boolean, terastallize: boolean, zmove: boolean },
	): string {
		const { candidate } = decision;
		let out = `move ${candidate.slot}`;

		// Default targetLoc for normal/any/adjacentFoe in doubles+ if unspecified.
		const isMulti = ctx.request.active.length > 1;
		const needsTarget = ['normal', 'any', 'adjacentFoe', 'adjacentAlly', 'adjacentAllyOrSelf'].includes(candidate.target);
		if (isMulti && needsTarget) {
			let targetLoc = decision.targetLoc;
			if (targetLoc === undefined) {
				// Sensible default: first foe slot (+1). For ally-only targets, ally slot.
				if (candidate.target === 'adjacentAlly') {
					targetLoc = -((ctx.activeIndex ^ 1) + 1);
				} else if (candidate.target === 'adjacentAllyOrSelf') {
					targetLoc = -(ctx.activeIndex + 1);
				} else {
					targetLoc = 1;
				}
			}
			out += ` ${targetLoc}`;
		}

		if (candidate.zMove) {
			out += ' zmove';
			formAvail.zmove = false;
			return out;
		}

		// Apply form change. The policy explicitly opts in by setting
		// `formChange`. We also auto-apply dynamax if the policy picked a
		// maxMove candidate but didn't tag it (convenience).
		let form = decision.formChange;
		if (!form && candidate.maxMove && ctx.canDynamax) form = 'dynamax';
		if (form && this.consumeFormChange(form, formAvail)) {
			out += ` ${form}`;
		}
		return out;
	}

	private consumeFormChange(
		form: FormChange,
		formAvail: { mega: boolean, ultra: boolean, dynamax: boolean, terastallize: boolean, zmove: boolean },
	): boolean {
		switch (form) {
		case 'mega': case 'megax': case 'megay':
			if (!formAvail.mega) return false;
			formAvail.mega = false;
			return true;
		case 'ultra':
			if (!formAvail.ultra) return false;
			formAvail.ultra = false;
			return true;
		case 'dynamax':
			if (!formAvail.dynamax) return false;
			formAvail.dynamax = false;
			return true;
		case 'terastallize':
			if (!formAvail.terastallize) return false;
			formAvail.terastallize = false;
			return true;
		}
	}
}

// Re-export the type aliases the user is most likely to consume directly.
export type { Decision, MoveDecision, SwitchDecision, MoveCandidate, SwitchCandidate, PolicyChain };
export type { ActiveContext, ForceSwitchContext, TeamPreviewContext };
