/**
 * Plugin Player AI — battle view.
 *
 * Maintains a partial reconstruction of battle state from the protocol log
 * stream that `BattlePlayer` already receives. Policies use this view to
 * answer questions like "what types is the opposing pokemon?" or "what
 * moves have they revealed so far?".
 *
 * This is deliberately minimal: parse what's needed by the bundled policies,
 * and provide hooks for callers to extend. Extra protocol lines that aren't
 * recognised are simply ignored.
 */

import { Dex, type ModdedDex } from '../../dex';
import { toID } from '../../dex';

export type SideID = 'p1' | 'p2' | 'p3' | 'p4';

/** What we know about a foe pokemon. Fields fill in as the battle plays out. */
export interface FoePokemon {
	/** Slot identifier without species, e.g. 'p2a'. Stable across switches. */
	slot: string;
	/** Position-bearing side, e.g. 'p2'. */
	side: SideID;
	/** Species name as reported by `|switch|` / `|drag|` / `|detailschange|`. */
	species: string;
	speciesId: ID;
	level: number;
	gender?: string;
	shiny?: boolean;
	/** Current HP percent (0..100). 0 means fainted. */
	hpPercent: number;
	status?: ID;
	/** Move ids the foe has used so far (deduped, insertion-ordered). */
	revealedMoves: ID[];
	/** Item id, once revealed (e.g. via |-item|, |-enditem|, Knock Off, etc.). */
	revealedItem?: ID;
	/** Ability id, once revealed. */
	revealedAbility?: ID;
	teraType?: ID;
	terastallized?: ID;
	/** Volatile statuses currently applied (substitute, confusion, etc.). */
	volatiles: Set<ID>;
}

/** Side-wide state we track (hazards, screens). */
export interface SideState {
	conditions: Set<ID>;
}

/**
 * Incremental view of the battle, derived from protocol log lines.
 *
 * Call `receiveLine` for each `|...`-prefixed line as it arrives. The view
 * makes a best-effort reconstruction — protocol surprises (custom mods,
 * unknown effects) degrade gracefully rather than throwing.
 */
export class BattleView {
	/** Detected from `|gen|N`. Falls back to the dex's gen if not seen. */
	gen: number;
	dex: ModdedDex;
	/** Which side this player is on (from `|player|` lines + our requests). */
	ourSide: SideID | null;
	/**
	 * Foes by slot ident (e.g. 'p2a'). Entries are *replaced* on switch / drag
	 * / detailschange — pre-switch state is forgotten for that slot but a
	 * snapshot is retained in `foeRevealed` keyed by speciesId.
	 */
	readonly foeActive: Map<string, FoePokemon>;
	/** Every foe pokemon we have ever seen on the field, keyed by speciesId. */
	readonly foeRevealed: Map<ID, FoePokemon>;
	readonly sideState: Map<SideID, SideState>;
	weather?: ID;
	terrain?: ID;
	pseudoWeather: Set<ID>;
	turn: number;

	constructor(dex: ModdedDex = Dex) {
		this.dex = dex;
		this.gen = dex.gen;
		this.ourSide = null;
		this.foeActive = new Map();
		this.foeRevealed = new Map();
		this.sideState = new Map();
		this.pseudoWeather = new Set();
		this.turn = 0;
	}

	/** Set the gen explicitly (e.g. when the caller knows the format). */
	setGen(gen: number) {
		if (!gen || gen === this.gen) return;
		this.gen = gen;
		this.dex = Dex.forGen(gen);
	}

	/** Note which side we're playing. Allows `isFoe` to work correctly. */
	setOurSide(side: SideID) {
		this.ourSide = side;
	}

	isFoe(side: SideID): boolean {
		// In doubles/triples allies share our `ourSide`. Anything else is foe.
		// In multi-battles allies have their own side id; callers can override.
		return this.ourSide !== null && side !== this.ourSide;
	}

	/** Return the first foe currently on the field, or undefined. */
	primaryFoe(): FoePokemon | undefined {
		for (const foe of this.foeActive.values()) {
			if (foe.hpPercent > 0) return foe;
		}
		return undefined;
	}

	/** All foes currently on the field with non-zero HP. */
	activeFoes(): FoePokemon[] {
		const out: FoePokemon[] = [];
		for (const foe of this.foeActive.values()) {
			if (foe.hpPercent > 0) out.push(foe);
		}
		return out;
	}

	/** Type chart lookup for the current gen's dex. */
	getTypes(speciesId: ID): readonly string[] {
		const species = this.dex.species.get(speciesId);
		return species?.types ?? [];
	}

	/**
	 * Feed one protocol line (with leading `|`) into the view. Unknown lines
	 * are ignored. Safe to call from inside `BattlePlayer.receiveLine`.
	 */
	receiveLine(line: string) {
		if (!line.startsWith('|')) return;
		const parts = line.slice(1).split('|');
		const cmd = parts[0];
		switch (cmd) {
		case 'gen': {
			const gen = parseInt(parts[1]);
			if (gen) this.setGen(gen);
			break;
		}
		case 'turn': {
			const turn = parseInt(parts[1]);
			if (!isNaN(turn)) this.turn = turn;
			break;
		}
		case 'player': {
			// |player|p1|Name|avatar|rating — we can't tell from here which
			// side is ours; that's set externally via setOurSide().
			break;
		}
		case 'switch':
		case 'drag':
			this.handleSwitch(parts[1], parts[2], parts[3]);
			break;
		case 'detailschange':
		case 'replace':
			this.handleDetailsChange(parts[1], parts[2], parts[3]);
			break;
		case 'faint':
			this.handleFaint(parts[1]);
			break;
		case 'move':
			this.handleMove(parts[1], parts[2]);
			break;
		case '-damage':
		case '-heal':
		case '-sethp':
			this.handleHpUpdate(parts[1], parts[2]);
			break;
		case '-status':
			this.handleStatus(parts[1], parts[2]);
			break;
		case '-curestatus':
		case '-cureteam':
			this.handleCureStatus(parts[1]);
			break;
		case '-item':
			this.handleItem(parts[1], parts[2]);
			break;
		case '-enditem':
			this.handleEndItem(parts[1], parts[2]);
			break;
		case '-ability':
			this.handleAbility(parts[1], parts[2]);
			break;
		case '-terastallize':
			this.handleTerastallize(parts[1], parts[2]);
			break;
		case '-start':
			this.handleVolatile(parts[1], parts[2], true);
			break;
		case '-end':
			this.handleVolatile(parts[1], parts[2], false);
			break;
		case '-sidestart':
			this.handleSideCondition(parts[1], parts[2], true);
			break;
		case '-sideend':
			this.handleSideCondition(parts[1], parts[2], false);
			break;
		case '-weather':
			this.weather = parts[1] === 'none' ? undefined : toID(parts[1]);
			break;
		case '-fieldstart':
			this.handleFieldStart(parts[1]);
			break;
		case '-fieldend':
			this.handleFieldEnd(parts[1]);
			break;
		}
	}

	private parseIdent(ident: string): { slot: string, side: SideID } | null {
		// 'p2a: Pikachu' -> { slot: 'p2a', side: 'p2' }. Some lines (e.g.
		// |-fieldstart|) don't have a pokemon ident; guard against those.
		const colon = ident.indexOf(':');
		const slot = colon >= 0 ? ident.slice(0, colon) : ident;
		if (slot.length < 2 || (slot[0] !== 'p')) return null;
		const side = slot.slice(0, 2) as SideID;
		return { slot, side };
	}

	private parseHp(hpStatus: string | undefined): { hpPercent: number, status?: ID } {
		if (!hpStatus) return { hpPercent: 100 };
		// Format: "100/100", "42/100 par", "0 fnt", or a fraction like "42/100".
		if (hpStatus.endsWith(' fnt') || hpStatus.trim() === '0 fnt' || hpStatus.trim() === '0') {
			return { hpPercent: 0 };
		}
		const spaceIdx = hpStatus.indexOf(' ');
		const ratio = spaceIdx >= 0 ? hpStatus.slice(0, spaceIdx) : hpStatus;
		const statusPart = spaceIdx >= 0 ? hpStatus.slice(spaceIdx + 1).trim() : '';
		const status = statusPart ? toID(statusPart) || undefined : undefined;
		const slashIdx = ratio.indexOf('/');
		if (slashIdx < 0) return { hpPercent: 100, status };
		const num = parseInt(ratio.slice(0, slashIdx));
		const den = parseInt(ratio.slice(slashIdx + 1));
		if (!den || isNaN(num)) return { hpPercent: 100, status };
		return { hpPercent: Math.max(0, Math.min(100, (num / den) * 100)), status };
	}

	private parseDetails(details: string): { species: string, level: number, gender?: string, shiny?: boolean } {
		// 'Pikachu, L100, M, shiny' or 'Pikachu' or 'Pikachu, F'.
		const segs = details.split(',').map(s => s.trim());
		const species = segs[0];
		let level = 100;
		let gender: string | undefined;
		let shiny: boolean | undefined;
		for (let i = 1; i < segs.length; i++) {
			const seg = segs[i];
			if (seg.startsWith('L')) {
				const n = parseInt(seg.slice(1));
				if (!isNaN(n)) level = n;
			} else if (seg === 'shiny') {
				shiny = true;
			} else if (seg === 'M' || seg === 'F' || seg === 'N') {
				gender = seg;
			}
		}
		return { species, level, gender, shiny };
	}

	private handleSwitch(ident: string, details: string, hpStatus: string) {
		const parsed = this.parseIdent(ident);
		if (!parsed) return;
		if (!this.isFoe(parsed.side)) return;
		const det = this.parseDetails(details);
		const speciesId = toID(det.species);
		const hp = this.parseHp(hpStatus);
		const existing = this.foeRevealed.get(speciesId);
		const foe: FoePokemon = existing ?? {
			slot: parsed.slot,
			side: parsed.side,
			species: det.species,
			speciesId,
			level: det.level,
			gender: det.gender,
			shiny: det.shiny,
			hpPercent: hp.hpPercent,
			status: hp.status,
			revealedMoves: [],
			volatiles: new Set(),
		};
		foe.slot = parsed.slot;
		foe.hpPercent = hp.hpPercent;
		foe.status = hp.status;
		// Switching clears volatile statuses (with a few edge cases we don't track).
		foe.volatiles = new Set();
		this.foeActive.set(parsed.slot, foe);
		this.foeRevealed.set(speciesId, foe);
	}

	private handleDetailsChange(ident: string, details: string, hpStatus: string) {
		const parsed = this.parseIdent(ident);
		if (!parsed) return;
		if (!this.isFoe(parsed.side)) return;
		const foe = this.foeActive.get(parsed.slot);
		if (!foe) return;
		const det = this.parseDetails(details);
		foe.species = det.species;
		foe.speciesId = toID(det.species);
		if (hpStatus) {
			const hp = this.parseHp(hpStatus);
			foe.hpPercent = hp.hpPercent;
			foe.status = hp.status;
		}
		this.foeRevealed.set(foe.speciesId, foe);
	}

	private handleFaint(ident: string) {
		const parsed = this.parseIdent(ident);
		if (!parsed) return;
		if (!this.isFoe(parsed.side)) return;
		const foe = this.foeActive.get(parsed.slot);
		if (foe) foe.hpPercent = 0;
	}

	private handleMove(ident: string, move: string) {
		const parsed = this.parseIdent(ident);
		if (!parsed) return;
		if (!this.isFoe(parsed.side)) return;
		const foe = this.foeActive.get(parsed.slot);
		if (!foe) return;
		const id = toID(move);
		if (id && !foe.revealedMoves.includes(id)) foe.revealedMoves.push(id);
	}

	private handleHpUpdate(ident: string, hpStatus: string) {
		const parsed = this.parseIdent(ident);
		if (!parsed) return;
		if (!this.isFoe(parsed.side)) return;
		const foe = this.foeActive.get(parsed.slot);
		if (!foe) return;
		const hp = this.parseHp(hpStatus);
		foe.hpPercent = hp.hpPercent;
		if (hp.status !== undefined) foe.status = hp.status;
	}

	private handleStatus(ident: string, status: string) {
		const parsed = this.parseIdent(ident);
		if (!parsed) return;
		if (!this.isFoe(parsed.side)) return;
		const foe = this.foeActive.get(parsed.slot);
		if (foe) foe.status = toID(status);
	}

	private handleCureStatus(ident: string) {
		const parsed = this.parseIdent(ident);
		if (!parsed) return;
		if (!this.isFoe(parsed.side)) return;
		const foe = this.foeActive.get(parsed.slot);
		if (foe) foe.status = undefined;
	}

	private handleItem(ident: string, item: string) {
		const parsed = this.parseIdent(ident);
		if (!parsed) return;
		if (!this.isFoe(parsed.side)) return;
		const foe = this.foeActive.get(parsed.slot);
		if (foe) foe.revealedItem = toID(item);
	}

	private handleEndItem(ident: string, item: string) {
		const parsed = this.parseIdent(ident);
		if (!parsed) return;
		if (!this.isFoe(parsed.side)) return;
		const foe = this.foeActive.get(parsed.slot);
		if (foe) foe.revealedItem = toID(item);
	}

	private handleAbility(ident: string, ability: string) {
		const parsed = this.parseIdent(ident);
		if (!parsed) return;
		if (!this.isFoe(parsed.side)) return;
		const foe = this.foeActive.get(parsed.slot);
		if (foe) foe.revealedAbility = toID(ability);
	}

	private handleTerastallize(ident: string, type: string) {
		const parsed = this.parseIdent(ident);
		if (!parsed) return;
		if (!this.isFoe(parsed.side)) return;
		const foe = this.foeActive.get(parsed.slot);
		if (foe) foe.terastallized = toID(type);
	}

	private handleVolatile(ident: string, effect: string, start: boolean) {
		const parsed = this.parseIdent(ident);
		if (!parsed) return;
		if (!this.isFoe(parsed.side)) return;
		const foe = this.foeActive.get(parsed.slot);
		if (!foe) return;
		const id = toID(effect.replace(/^move: |^ability: |^item: /, ''));
		if (!id) return;
		if (start) foe.volatiles.add(id);
		else foe.volatiles.delete(id);
	}

	private handleSideCondition(sideRef: string, effect: string, start: boolean) {
		// sideRef looks like 'p2: BotName' or 'p2'.
		const colon = sideRef.indexOf(':');
		const side = (colon >= 0 ? sideRef.slice(0, colon) : sideRef) as SideID;
		if (side.length !== 2 || side[0] !== 'p') return;
		let state = this.sideState.get(side);
		if (!state) {
			state = { conditions: new Set() };
			this.sideState.set(side, state);
		}
		const id = toID(effect.replace(/^move: /, ''));
		if (!id) return;
		if (start) state.conditions.add(id);
		else state.conditions.delete(id);
	}

	private handleFieldStart(effect: string) {
		const id = toID(effect.replace(/^move: /, ''));
		if (!id) return;
		// Terrains report through fieldstart/fieldend in modern gens.
		if (id.endsWith('terrain')) this.terrain = id;
		else this.pseudoWeather.add(id);
	}

	private handleFieldEnd(effect: string) {
		const id = toID(effect.replace(/^move: /, ''));
		if (!id) return;
		if (id === this.terrain) this.terrain = undefined;
		else this.pseudoWeather.delete(id);
	}
}
