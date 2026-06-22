/**
 * Interactive scenario play (web).
 *
 * Same shape as cli-play.ts but driven by an HTTP / browser caller instead
 * of stdin: the human's "make a choice" prompt is exposed as `currentRequest`
 * on the session, and the caller submits choices via `submitChoice(...)`.
 * The session also accumulates formatted event lines (move / damage / faint /
 * etc.) so the browser can render a turn-by-turn battle log without parsing
 * raw protocol.
 *
 * Lives next to cli-play because they share the same battle-bootstrap shape
 * (in-process BattleStream + PluginPlayerAI for the AI side + scenario state
 * applied at battle start). The only thing that differs is how the human's
 * choice arrives — readline vs HTTP POST.
 *
 * Sessions are created by the Scenario UI server and indexed by id. The
 * server is responsible for GC of stale sessions; this module just gives
 * them a clean lifecycle.
 */

import { BattleStream, getPlayerStreams, BattlePlayer } from '../../battle-stream';
import { Dex } from '../../dex';
import { PluginPlayerAI } from '../plugin-player-ai/plugin-player-ai';
import type { ChoiceRequest, MoveRequest, SwitchRequest } from '../../side';
import { getAIChain, HUMAN_AI } from './registry';
import { validateScenario } from './load';
import { buildOnBattleStart } from './apply';
import type { Scenario } from './types';
import { DefaultText } from '../../../data/text/default';

/**
 * PS default battle text templates. Same source the live PS server uses for
 * message strings — gives us authentic phrasing without rolling our own.
 * The `default` group has the common turn-by-turn templates; per-effect
 * groups (e.g. weather, status conditions, abilities) live as sibling keys
 * keyed by effect id.
 */
const T: any = (DefaultText as any).default;
function tpl(s: string | undefined, slots: Record<string, string>): string {
	if (!s) return '';
	// PS templates indent with leading spaces; we trim them off so they
	// look right in our flat log.
	return s.trimStart().replace(/\[([A-Z]+)\]/g, (_, key) => slots[key] ?? `[${key}]`);
}
/** Look up a per-effect template; falls back to the supplied default key. */
function tplForEffect(effectId: string, key: string, fallbackKey: string, slots: Record<string, string>): string {
	const group = (DefaultText as any)[effectId];
	const found = group?.[key];
	if (found) return tpl(found, slots);
	return tpl(T[fallbackKey], slots);
}

/** A weather / terrain / pseudo-weather entry with its remaining duration. */
export interface FieldEffectState {
	id: string;
	turnsRemaining?: number;
}

/** A side-condition entry: hazards (Spikes-style layers) or screens (turn counters). */
export interface SideEffectState {
	id: string;
	turnsRemaining?: number;
	layers?: number;
}

/** A pretty-printed event line — what the browser shows in the battle log. */
export interface PrettyEvent {
	kind: 'move' | 'damage' | 'heal' | 'status' | 'faint' | 'switch' | 'weather' | 'effect' | 'boost' | 'ability' | 'item' | 'note' | 'formechange';
	text: string;
	/** Best-effort attribution to a side, if known. Useful for styling. */
	side?: 'p1' | 'p2' | null;
	/** For damage/heal: percentage of max HP lost (negative) or gained (positive). */
	hpDelta?: number;
	/** For formechange: the new species/forme name for sprite updates. */
	newSpecies?: string;
	/** Human-readable name of the item/ability/effect that caused this event (e.g. "Rocky Helmet", "Iron Barbs", "Leftovers"). */
	fromEffect?: string;
	/** Category of the triggering effect, for popup styling. */
	fromEffectKind?: 'item' | 'ability' | 'move' | 'status';
	/** For boost events: which stat changed (e.g. "atk", "spe"). */
	stat?: string;
	/** For boost events: signed stage change (e.g. +1, -2). */
	boostDelta?: number;
	/** For move events: the move's type (e.g. "Fire", "Water"). */
	moveType?: string;
	/** For move events: Physical / Special / Status. */
	moveCategory?: 'Physical' | 'Special' | 'Status';
}

/** Move metadata included alongside the request to enrich the action buttons. */
export interface MoveMeta {
	move: string;
	id: string;
	type: string;
	category: 'Physical' | 'Special' | 'Status' | string;
	basePower: number;
	accuracy: number | true;
	pp?: number;
	disabled?: boolean | string;
	target?: string;
	/** Short description of the move effect, for hover tooltips. */
	shortDesc?: string;
	/**
	 * Type-chart multiplier against the foe currently in front (0, 0.25,
	 * 0.5, 1, 2, 4). Undefined when there's no foe or the move is a Status
	 * move. Computed server-side from the dex so the client doesn't need
	 * the type chart.
	 */
	effectivenessVsFoe?: number;
}

/** Foe-side state derived from the protocol log (same visibility as a real PS opponent). */
export interface FoeMonState {
	species: string;
	level?: number;
	gender?: string;
	hpPercent: number;
	condition: string; // raw condition string from the log
	status: string | null;
	revealedItem: string | null;
	revealedAbility: string | null;
	teraType: string | null;
	terastallized: string | null;
	boosts: Record<string, number>;
	fainted: boolean;
	active: boolean;
	/** Which slot this foe occupies when active (e.g. 'p2a', 'p2b'). Null when benched. */
	slot: string | null;
	/** Effective types right now (base species types, overridden by tera if terastallized). */
	types?: string[];
	/** Min/max possible speed stat (across all EV/IV/nature spreads). Useful for outspeeding decisions. */
	speedMin?: number;
	speedMax?: number;
}

interface PendingChoice {
	resolve: (choice: string) => void;
	request: ChoiceRequest;
}

export interface InteractiveSessionSnapshot {
	id: string;
	scenarioName: string | null;
	humanSide: 'p1' | 'p2';
	aiSide: 'p1' | 'p2';
	/** Display names of the two trainers (from scenario.p1.name / p2.name). */
	myName: string | null;
	aiName: string | null;
	/** Trainer-sprite ids (resolved to URLs client-side via /api/scenario/assets). */
	myAvatar: string | null;
	aiAvatar: string | null;
	/** Backdrop id (resolved to image URL client-side). */
	backdrop: string | null;
	/**
	 * Dex id -> display-name maps for everything that appears in OUR side of
	 * the current request. The engine sends item/ability/etc. as ids
	 * (`heavydutyboots`, `static`), but the UI needs the pretty names
	 * (`Heavy-Duty Boots`, `Static`). Computed fresh per snapshot — tiny
	 * payload (≤6 entries each, never more).
	 */
	dexNames: {
		items: Record<string, string>,
		abilities: Record<string, string>,
	};
	events: PrettyEvent[];
	currentRequest: ChoiceRequest | null;
	/** Per-move metadata for each active slot, parallel to request.active[i].moves. */
	currentMoves: MoveMeta[][] | null;
	/** Foe mons currently known, in slot order (1..6). Index 0 is slot 1. */
	foeTeam: FoeMonState[];
	/** True if the scenario has `openTeamsheet`; the UI uses this to know it can show foe item/ability without a reveal. */
	openTeamsheet: boolean;
	/** Boosts on our active mon(s), keyed by slot ('p1a', 'p1b' etc). */
	myBoosts: Record<string, Record<string, number>>;
	/** Weather + turns remaining (null when no weather is active). */
	weather: FieldEffectState | null;
	/** Terrain + turns remaining. */
	terrain: FieldEffectState | null;
	/** Pseudo-weather effects (Trick Room, Gravity, etc.) with their turn counts. */
	pseudoWeather: FieldEffectState[];
	/** Side-specific effects (hazards / screens) keyed by side. */
	sideEffects: { p1: SideEffectState[], p2: SideEffectState[] };
	ended: boolean;
	winner: string | null;
	/** What event index has been emitted; clients pass this back as `since` to GET deltas. */
	cursor: number;
	/** Last error from the engine, if any (e.g. an invalid choice that didn't undo cleanly). */
	lastError: string | null;
}

class WebHumanPlayer extends BattlePlayer {
	private session: InteractiveSession;
	constructor(playerStream: any, session: InteractiveSession) {
		super(playerStream);
		this.session = session;
	}

	override receiveError(error: Error) {
		// Same posture as RandomPlayerAI / PluginPlayerAI: swallow unavailable
		// (engine will resend), surface anything else for the UI to display.
		if (error.message.startsWith('[Unavailable choice]')) return;
		this.session.recordError(error.message);
	}

	override receiveRequest(request: ChoiceRequest) {
		if (request.wait) return;
		if (request.teamPreview) {
			// Scenarios strip team preview, but if anything synthesizes one,
			// just send default.
			this.choose('default');
			return;
		}
		// Stash the request for the browser to render; await the next
		// submitChoice() call from the HTTP layer.
		this.session.queuePromptedChoice(request, choice => {
			this.choose(choice);
		});
	}
}

export class InteractiveSession {
	readonly id: string;
	readonly scenario: Scenario;
	readonly scenarioName: string | null;
	readonly humanSide: 'p1' | 'p2';
	readonly aiSide: 'p1' | 'p2';

	private events: PrettyEvent[] = [];
	private currentRequest: ChoiceRequest | null = null;
	private pendingChoice: PendingChoice | null = null;
	ended = false;
	winner: string | null = null;
	private lastError: string | null = null;
	private runPromise: Promise<void> | null = null;
	createdAt = Date.now();
	lastTouchedAt = Date.now();

	// Derived battle state for the snapshot.
	private foeTeam: FoeMonState[] = [];
	/** Per-slot boosts for our active mons (keyed by slot like 'p1a', 'p1b'). */
	private myBoostsPerSlot: Record<string, Record<string, number>> = {};
	private weather: string | null = null;
	private terrain: string | null = null;
	/**
	 * Live reference to the BattleStream we own. Kept so snapshot() can read
	 * the engine's current field / side state directly (durations, hazard
	 * layers) — far cleaner than tracking them in parallel from the log.
	 */
	private battleStream: BattleStream | null = null;
	/** Dex for the scenario's gen, set in runBattle(). Used for move metadata. */
	private dex: any = null;
	/** Last seen HP percent per slot. Used to compute `lost X%` for the damage line. */
	private lastHp: Map<string, number> = new Map();

	/**
	 * Tracks `|split|pX` blocks. The omniscient stream emits both halves of
	 * every split message — privileged view (absolute HP for the named side)
	 * then the spectator view. Without filtering, every switch / damage line
	 * would render twice. We pick the half that matches our human-side
	 * perspective and ignore the other.
	 *
	 *   null   – not inside a split
	 *   'mine' – the next line is for our side; the line after is spectator
	 *   'foe'  – the next line is for the foe; the line after is our view
	 */
	private splitMode: 'mine' | 'foe' | null = null;
	private splitIndex = 0;

	constructor(id: string, scenario: Scenario, scenarioName: string | null) {
		const problems = validateScenario(scenario);
		if (problems.length) throw new Error(`Invalid scenario:\n  ${problems.join('\n  ')}`);

		const humanSides: Array<'p1' | 'p2'> = [];
		for (const side of ['p1', 'p2'] as const) {
			if (scenario[side].ai === HUMAN_AI || !scenario[side].ai) humanSides.push(side);
		}
		if (humanSides.length !== 1) {
			throw new Error(
				`Interactive play needs exactly one side marked 'human'; found ${humanSides.length}. ` +
				`Edit the scenario to set p1.ai or p2.ai to "human".`,
			);
		}
		this.id = id;
		this.scenario = scenario;
		this.scenarioName = scenarioName;
		this.humanSide = humanSides[0];
		this.aiSide = this.humanSide === 'p1' ? 'p2' : 'p1';
	}

	start(): void {
		if (this.runPromise) return;
		this.runPromise = this.runBattle().catch(err => {
			this.recordError(err.message ?? String(err));
		});
	}

	private async runBattle(): Promise<void> {
		const format = Dex.formats.get(this.scenario.format);
		const gen = format.exists ? (format.mod === 'base' ? Dex.gen : Dex.forFormat(format).gen) : Dex.gen;
		this.dex = Dex.forGen(gen);
		const aiChain = getAIChain(this.scenario[this.aiSide].ai ?? 'default', gen);

		const formatId = this.scenario.format.includes('@@@') ?
			`${this.scenario.format},!Team Preview` :
			`${this.scenario.format}@@@!Team Preview`;

		this.battleStream = new BattleStream({
			noCatch: true,
			onBattleStart: buildOnBattleStart(this.scenario),
		});
		const streams = getPlayerStreams(this.battleStream);
		const spec: AnyObject = { formatid: formatId, scenarioState: this.scenario };
		if (this.scenario.seed) spec.seed = this.scenario.seed;
		const humanSpec = { name: this.scenario[this.humanSide].name ?? 'You', team: this.scenario[this.humanSide].team };
		const aiSpec = { name: this.scenario[this.aiSide].name ?? 'AI', team: this.scenario[this.aiSide].team };

		const humanPlayer = new WebHumanPlayer(streams[this.humanSide], this);
		const aiPlayer = new PluginPlayerAI(streams[this.aiSide], { chain: aiChain, gen });

		void humanPlayer.start();
		void aiPlayer.start();

		const startMsg =
			`>start ${JSON.stringify(spec)}\n` +
			`>player p1 ${JSON.stringify(this.humanSide === 'p1' ? humanSpec : aiSpec)}\n` +
			`>player p2 ${JSON.stringify(this.humanSide === 'p2' ? humanSpec : aiSpec)}`;
		void streams.omniscient.write(startMsg);

		for await (const chunk of streams.omniscient) {
			for (const line of chunk.split('\n')) {
				this.ingestProtocolLine(line);
			}
			if (this.ended) break;
		}
	}

	// --- choice plumbing --------------------------------------------------

	queuePromptedChoice(request: ChoiceRequest, resolve: (choice: string) => void): void {
		this.currentRequest = request;
		this.pendingChoice = { request, resolve };
		this.lastTouchedAt = Date.now();
	}

	submitChoice(choice: string): { ok: boolean, error?: string } {
		this.lastTouchedAt = Date.now();
		if (!this.pendingChoice) {
			return { ok: false, error: 'No current request — wait for the AI to move or for the battle to await your input.' };
		}
		// Clear before invoking the engine — the engine MAY synchronously emit
		// the next request (in which case queuePromptedChoice will re-fill us).
		const { resolve } = this.pendingChoice;
		this.pendingChoice = null;
		this.currentRequest = null;
		this.lastError = null;
		resolve(choice);
		return { ok: true };
	}

	recordError(message: string): void {
		this.lastError = message;
	}

	// --- protocol line formatting ----------------------------------------

	private ingestProtocolLine(line: string): void {
		if (!line.startsWith('|')) return;
		const parts = line.split('|');
		const cmd = parts[1];

		// Handle PS protocol's `|split|<side>` markers. The two lines that
		// follow a split are the privileged + spectator views of the same
		// event. Keep only the one that matches our human-side perspective.
		if (cmd === 'split') {
			const splitSide = parts[2];
			this.splitMode = (splitSide === this.humanSide) ? 'mine' : 'foe';
			this.splitIndex = 0;
			return;
		}
		if (this.splitMode !== null) {
			const useThisLine = (this.splitMode === 'mine' && this.splitIndex === 0) ||
				(this.splitMode === 'foe' && this.splitIndex === 1);
			this.splitIndex++;
			if (this.splitIndex >= 2) this.splitMode = null;
			if (!useThisLine) return;
		}

		switch (cmd) {
		case 'move': this.handleMove(parts); break;
		case '-damage': this.handleDamageOrHeal(parts, false); break;
		case '-heal': this.handleDamageOrHeal(parts, true); break;
		case '-sethp': this.handleSetHp(parts); break;
		case '-status': this.handleStatus(parts, false); break;
		case '-curestatus': this.handleStatus(parts, true); break;
		case 'faint': this.handleFaint(parts); break;
		case 'switch': case 'drag': this.handleSwitch(parts, cmd === 'drag'); break;
		case 'detailschange': case 'replace': this.handleDetailsChange(parts); break;
		case '-weather':
			this.weather = parts[2] === 'none' ? null : parts[2];
			if (parts[2] && parts[2] !== 'none') {
				const wid = this.idof(parts[2]);
				const wg = (DefaultText as any)[wid];
				const isUpkeep = parts.slice(3).some(p => p.includes('[upkeep]'));
				const tplStr = isUpkeep ? wg?.upkeep : wg?.start;
				this.pushEvent({ kind: 'weather', text: tplStr ? tpl(tplStr, {}) : `Weather: ${parts[2]}` });
			}
			break;
		case '-fieldstart':
			this.terrain = this.terrainNameFromEffect(parts[2]) || this.terrain;
			this.pushEvent({ kind: 'effect', text: this.fieldEffectText(parts.slice(2).join('|'), true) });
			break;
		case '-fieldend':
			this.pushEvent({ kind: 'effect', text: this.fieldEffectText(parts.slice(2).join('|'), false) });
			break;
		case '-sidestart':
			this.pushEvent({ kind: 'effect', side: this.parseSideRef(parts[2]),
				text: this.sideEffectText(parts[2], parts[3], true) });
			break;
		case '-sideend':
			this.pushEvent({ kind: 'effect', side: this.parseSideRef(parts[2]),
				text: this.sideEffectText(parts[2], parts[3], false) });
			break;
		case '-supereffective': this.pushEvent({ kind: 'effect', text: tpl(T.superEffective, {}) }); break;
		case '-resisted': this.pushEvent({ kind: 'effect', text: tpl(T.resisted, {}) }); break;
		case '-immune':
			this.pushEvent({ kind: 'effect', side: this.sideOf(this.slotOf(parts[2])),
				text: tpl(T.immune, { POKEMON: this.nameForSide(parts[2]) }) });
			break;
		case '-crit': this.pushEvent({ kind: 'effect', text: tpl(T.crit, {}) }); break;
		case '-miss': {
			// PS protocol: |-miss|SOURCE|TARGET. The modern template
			//   default.miss: "  [POKEMON] avoided the attack!"
			// refers to the TARGET, not the source. When the target is
			// missing (e.g. moves with no resolvable target slot) fall back
			// to the legacy template `[SOURCE]'s attack missed!`.
			const sourceIdent = parts[2];
			const targetIdent = parts[3];
			if (targetIdent && targetIdent.includes(':')) {
				this.pushEvent({ kind: 'effect', side: this.sideOf(this.slotOf(targetIdent)),
					text: tpl(T.miss, { POKEMON: this.nameForSide(targetIdent) }) });
			} else {
				this.pushEvent({ kind: 'effect', side: this.sideOf(this.slotOf(sourceIdent)),
					text: tpl(T.missNoPokemon ?? T.miss, { SOURCE: this.nameForSide(sourceIdent), POKEMON: this.nameForSide(sourceIdent) }) });
			}
			break;
		}
		case '-fail':
			// PS protocol: `|-fail|POKEMON[|REASON][|[from] ...]`. Reason is
			// optional and often a stat id ("unboost") or move-specific text;
			// the bare "But it failed!" is the default.
			this.pushEvent({ kind: 'effect', side: this.sideOf(this.slotOf(parts[2])),
				text: tpl(T.fail, { POKEMON: this.nameForSide(parts[2]) }) });
			break;
		case 'cant':
			// `|cant|POKEMON|REASON|MOVE` — e.g. paralyzed/frozen/etc. PS has
			// per-effect templates; fall back to the generic `cant` text.
			{
				const reason = parts[3] ?? '';
				const MOVE = parts[4] ?? '';
				const POKEMON = this.nameForSide(parts[2]);
				const group = (DefaultText as any)[this.idof(reason)];
				const t = group?.cant ?? (MOVE ? T.cant : T.cantNoMove);
				this.pushEvent({ kind: 'effect', side: this.sideOf(this.slotOf(parts[2])),
					text: tpl(t, { POKEMON, MOVE }) });
			}
			break;
		case '-block':
			// `|-block|POKEMON|EFFECT|MOVE|ATTACKER` — Substitute, Protect, etc.
			this.pushEvent({ kind: 'effect', side: this.sideOf(this.slotOf(parts[2])),
				text: tpl(T.block ?? '  [POKEMON] protected itself!', { POKEMON: this.nameForSide(parts[2]) }) });
			break;
		case '-activate': {
			const POKEMON = this.nameForSide(parts[2]);
			const effectRaw = (parts[3] ?? '').replace(/^(move|ability|item):/, '').trim();
			const effectId = this.idof(effectRaw);
			const group = (DefaultText as any)[effectId];
			const text = group?.activate
				? tpl(group.activate, { POKEMON, TARGET: POKEMON })
				: `  ${effectRaw} activated!`;
			this.pushEvent({ kind: 'effect', side: this.sideOf(this.slotOf(parts[2])), text });
			break;
		}
		case '-boost': case '-unboost': this.handleBoost(parts, cmd === '-boost'); break;
		case '-setboost': this.handleSetBoost(parts); break;
		case '-ability': this.handleAbilityReveal(parts); break;
		case '-item': case '-enditem': this.handleItemReveal(parts, cmd === '-enditem'); break;
		case '-terastallize': this.handleTerastallize(parts); break;
		case '-mega': this.handleMega(parts); break;
		case '-burst': this.handleUltraBurst(parts); break;
		case '-primal': this.handlePrimal(parts); break;
		case '-zpower': this.pushEvent({ kind: 'effect', side: this.sideOf(this.slotOf(parts[2])),
			text: tpl(T.zPower, { POKEMON: this.nameForSide(parts[2]) }) }); break;
		case '-zbroken': this.pushEvent({ kind: 'effect', side: this.sideOf(this.slotOf(parts[2])),
			text: tpl(T.zBroken, { POKEMON: this.nameForSide(parts[2]) }) }); break;
		case '-start': this.handleStart(parts); break;
		case '-end': this.handleEnd(parts); break;
		case 'turn': this.pushEvent({ kind: 'note', text: tpl(T.turn, { NUMBER: parts[2] ?? '?' }) }); break;
		case 'win': this.winner = line.slice(5); this.ended = true; break;
		}
		if (line === '|tie' || line.startsWith('|tie|')) { this.winner = '(tie)'; this.ended = true; }
	}

	// --- per-line handlers ------------------------------------------------

	private handleMove(parts: string[]): void {
		const slot = this.slotOf(parts[2]);
		const side = this.sideOf(slot);
		const POKEMON = this.nameForSide(parts[2]);
		const MOVE = parts[3] ?? '?';
		const move = Dex.moves.get(MOVE);
		this.pushEvent({
			kind: 'move', side, text: tpl(T.move, { POKEMON, MOVE }),
			moveType: move.exists ? move.type : undefined,
			moveCategory: move.exists ? (move.category as 'Physical' | 'Special' | 'Status') : undefined,
		});
	}

	private handleDamageOrHeal(parts: string[], isHeal: boolean): void {
		const slot = this.slotOf(parts[2]);
		const side = this.sideOf(slot);
		const POKEMON = this.nameForSide(parts[2]);
		const hp = parts[3] ?? '?';
		this.updateMonHpFromCondition(slot, hp);

		const fromTag = parts.slice(4).find(p => p.startsWith('[from]'));
		const fromRaw = fromTag?.replace('[from]', '').trim() ?? null;
		const fromId = fromRaw ? this.idof(fromRaw.replace(/^(item|ability|move):/, '').trim()) : null;
		const { fromEffect, fromEffectKind } = this.resolveFromEffect(fromRaw, fromId);

		if (isHeal) {
			const newHp = this.parseHp(hp).hpPercent;
			const beforeHp = this.lastHp.get(slot ?? '') ?? 100;
			const rawGain = newHp - beforeHp;
			const gainedPct = rawGain > 0 ? Math.max(1, Math.round(rawGain)) : 0;
			this.lastHp.set(slot ?? '', newHp);
			if (gainedPct === 0) return;
			const pctSuffix = ` (+${gainedPct}%)`;
			const ofTag = parts.slice(4).find(p => p.startsWith('[of]'));
			const SOURCE = ofTag ? this.nameForSide(ofTag.replace('[of]', '').trim()) : POKEMON;
			if (fromId) {
				const healTpl = this.resolveEffectTemplate(fromId, 'heal');
				if (healTpl) {
					this.pushEvent({ kind: 'heal', side, hpDelta: gainedPct,
						text: tpl(healTpl, { POKEMON, SOURCE }) + pctSuffix,
						fromEffect, fromEffectKind });
					return;
				}
			}
			this.pushEvent({ kind: 'heal', side, hpDelta: gainedPct,
				text: tpl(T.heal, { POKEMON, SOURCE }) + pctSuffix,
				fromEffect, fromEffectKind });
			return;
		}

		// Compute HP delta before choosing text template.
		const newHp = this.parseHp(hp).hpPercent;
		const beforeHp = this.lastHp.get(slot ?? '') ?? 100;
		const rawLoss = beforeHp - newHp;
		const lostPct = rawLoss > 0 ? Math.max(1, Math.round(rawLoss)) : 0;
		this.lastHp.set(slot ?? '', newHp);
		if (lostPct === 0) return;

		const pctSuffix = ` (${lostPct}%)`;
		if (fromId) {
			const dmgTpl = this.resolveEffectTemplate(fromId, 'damage');
			if (dmgTpl) {
				let dmgText = tpl(dmgTpl, { POKEMON }) + pctSuffix;
				if (fromEffect && !dmgText.toLowerCase().includes(fromEffect.toLowerCase())) {
					dmgText = `${POKEMON} was hurt by ${fromEffect}!${pctSuffix}`;
				}
				this.pushEvent({ kind: 'damage', side, hpDelta: -lostPct,
					text: dmgText, fromEffect, fromEffectKind });
				return;
			}
		}
		this.pushEvent({ kind: 'damage', side, hpDelta: -lostPct,
			text: fromEffect
				? `${POKEMON} was hurt by ${fromEffect}!${pctSuffix}`
				: tpl(T.damagePercentage, { POKEMON, PERCENTAGE: `${lostPct}%` }),
			fromEffect, fromEffectKind });
	}

	private handleSetHp(parts: string[]): void {
		if (parts.slice(4).some(p => p.includes('[silent]'))) return;
		const slot = this.slotOf(parts[2]);
		const hp = parts[3] ?? '?';
		const newHp = this.parseHp(hp).hpPercent;
		const beforeHp = this.lastHp.get(slot ?? '') ?? 100;
		const isHeal = newHp > beforeHp;
		this.handleDamageOrHeal(parts, isHeal);
	}

	private handleStatus(parts: string[], isCure: boolean): void {
		const slot = this.slotOf(parts[2]);
		const side = this.sideOf(slot);
		const POKEMON = this.nameForSide(parts[2]);
		const status = parts[3] ?? '';
		const foe = this.foeAtSlot(slot);
		if (foe) foe.status = isCure ? null : status;
		// PS has per-status start templates: brn.startFromItem etc. Bare start
		// is plain (e.g. `brn.start`).
		const group = (DefaultText as any)[status];
		const key = isCure ? 'end' : 'start';
		const text = group?.[key] ? tpl(group[key], { POKEMON }) : `${POKEMON} ${isCure ? 'was cured' : 'was ' + status}`;
		this.pushEvent({ kind: 'status', side, text });
	}

	private handleFaint(parts: string[]): void {
		const slot = this.slotOf(parts[2]);
		const side = this.sideOf(slot);
		const POKEMON = this.nameForSide(parts[2]);
		const foe = this.foeAtSlot(slot);
		if (foe) { foe.fainted = true; foe.hpPercent = 0; foe.active = false; }
		this.pushEvent({ kind: 'faint', side, text: tpl(T.faint, { POKEMON }) });
	}

	private handleSwitch(parts: string[], isDrag: boolean): void {
		const slot = this.slotOf(parts[2]);
		const side = this.sideOf(slot);
		const details = parts[3] ?? '';
		const hpStatus = parts[4] ?? '';
		const det = this.parseDetails(details);
		const hpData = this.parseHp(hpStatus);
		// Reset the last-hp tracker for the slot so the next damage line
		// computes its percentage from the new mon's full HP.
		this.lastHp.set(slot ?? '', hpData.hpPercent);
		// Replace foe-side state for that slot.
		if (side === this.aiSide) {
			// Mark only the mon in THIS slot as inactive (not all foes — doubles has 2 active).
			for (const f of this.foeTeam) {
				if (f.active && f.slot === slot) { f.active = false; f.slot = null; }
			}
			// Find or create an entry by species id.
			const existing = this.foeTeam.find(f => this.idof(f.species) === this.idof(det.species));
			const foe: FoeMonState = existing ?? {
				species: det.species, level: det.level, gender: det.gender,
				hpPercent: hpData.hpPercent, condition: hpStatus,
				status: hpData.status, revealedItem: null, revealedAbility: null,
				teraType: null, terastallized: null, boosts: {}, fainted: hpData.hpPercent === 0, active: true,
				slot: slot ?? null,
			};
			foe.active = true;
			foe.slot = slot ?? null;
			foe.hpPercent = hpData.hpPercent;
			foe.condition = hpStatus;
			foe.status = hpData.status;
			foe.boosts = {}; // boosts reset on switch
			if (!existing) this.foeTeam.push(foe);
		} else {
			// Switch on our side resets boosts for this slot only.
			if (slot) this.myBoostsPerSlot[slot] = {};
		}
		const FULLNAME = det.species;
		const NICKNAME = parts[2]?.split(': ')[1] ?? det.species;
		const TRAINER = (this.scenario as any)[side ?? 'p1']?.name ?? '?';
		let text: string;
		if (isDrag) {
			text = tpl(T.drag, { FULLNAME });
		} else if (side === this.humanSide) {
			text = tpl(T.switchInOwn, { FULLNAME, NICKNAME });
		} else {
			text = tpl(T.switchIn, { TRAINER, FULLNAME, NICKNAME });
		}
		this.pushEvent({ kind: 'switch', side, text });
	}

	private handleDetailsChange(parts: string[]): void {
		const slot = this.slotOf(parts[2]);
		const side = this.sideOf(slot);
		const details = parts[3] ?? '';
		const det = this.parseDetails(details);
		if (side === this.aiSide) {
			const foe = this.foeAtSlot(slot);
			if (foe) foe.species = det.species;
		}
		this.pushEvent({ kind: 'formechange', side, newSpecies: det.species,
			text: `${this.sidePrefix(side)}${det.species} transformed!` });
	}

	private handleBoost(parts: string[], up: boolean): void {
		const slot = this.slotOf(parts[2]);
		const side = this.sideOf(slot);
		const stat = parts[3] ?? '?';
		const amt = parseInt(parts[4] ?? '1') || 1;
		const delta = up ? amt : -amt;
		this.applyBoostDelta(slot, stat, delta);
		const POKEMON = this.nameForSide(parts[2]);
		const STAT = this.statName(stat);
		const key = (up ? 'boost' : 'unboost') + (amt === 1 ? '' : String(amt));
		const fallback = up ? T.boost : T.unboost;
		const template = (T[key] ?? fallback) as string;
		const fromTag = parts.slice(5).find(p => p.startsWith('[from]'));
		const fromRaw = fromTag?.replace('[from]', '').trim() ?? null;
		const fromId = fromRaw ? this.idof(fromRaw.replace(/^(item|ability|move):/, '').trim()) : null;
		const { fromEffect, fromEffectKind } = this.resolveFromEffect(fromRaw, fromId);
		this.pushEvent({ kind: 'boost', side, text: tpl(template, { POKEMON, STAT }),
			stat, boostDelta: delta, fromEffect, fromEffectKind });
	}
	private handleSetBoost(parts: string[]): void {
		const slot = this.slotOf(parts[2]);
		const side = this.sideOf(slot);
		const stat = parts[3] ?? '?';
		const value = parseInt(parts[4] ?? '0') || 0;
		this.setBoostAbsolute(slot, stat, value);
		// `[silent]` flag is set when scenario apply emits these; we don't surface those.
		if (parts.slice(5).some(p => p.includes('[silent]'))) return;
		this.pushEvent({ kind: 'boost', side,
			text: `${this.nameForSide(parts[2])}'s ${this.statName(stat)} was set to ${value > 0 ? '+' : ''}${value}` });
	}

	private handleAbilityReveal(parts: string[]): void {
		const slot = this.slotOf(parts[2]);
		const side = this.sideOf(slot);
		const ability = parts[3] ?? '';
		if (side === this.aiSide) {
			const foe = this.foeAtSlot(slot);
			if (foe) foe.revealedAbility = ability;
		}
		this.pushEvent({ kind: 'ability', side,
			text: `[${this.nameForSide(parts[2])}'s ${ability}]` });
	}

	private handleItemReveal(parts: string[], ended: boolean): void {
		const slot = this.slotOf(parts[2]);
		const side = this.sideOf(slot);
		const item = parts[3] ?? '';
		if (side === this.aiSide) {
			const foe = this.foeAtSlot(slot);
			if (foe) foe.revealedItem = ended ? null : item;
		}
		this.pushEvent({ kind: 'item', side,
			text: ended ? `${this.nameForSide(parts[2])}'s ${item} was used up` :
				`[${this.nameForSide(parts[2])}'s ${item}]` });
	}

	private handleTerastallize(parts: string[]): void {
		const slot = this.slotOf(parts[2]);
		const side = this.sideOf(slot);
		const type = parts[3] ?? '?';
		if (side === this.aiSide) {
			const foe = this.foeAtSlot(slot);
			if (foe) { foe.teraType = type; foe.terastallized = type; }
		}
		this.pushEvent({ kind: 'effect', side,
			text: `${this.nameForSide(parts[2])} terastallized to ${type}!` });
	}

	private handleMega(parts: string[]): void {
		const slot = this.slotOf(parts[2]);
		const side = this.sideOf(slot);
		const species = parts[3] ?? '?';
		const item = parts[4] ?? '';
		if (side === this.aiSide) {
			const foe = this.foeAtSlot(slot);
			if (foe) { foe.species = species; foe.revealedItem = item || foe.revealedItem; }
		}
		this.pushEvent({ kind: 'effect', side,
			text: tpl(T.mega, { POKEMON: this.nameForSide(parts[2]), ITEM: item }) });
		this.pushEvent({ kind: 'formechange', side, newSpecies: species,
			text: `${this.nameForSide(parts[2])} has Mega Evolved into Mega ${species}!` });
	}

	private handleUltraBurst(parts: string[]): void {
		const slot = this.slotOf(parts[2]);
		const side = this.sideOf(slot);
		const species = parts[3] ?? '?';
		if (side === this.aiSide) {
			const foe = this.foeAtSlot(slot);
			if (foe) foe.species = species;
		}
		this.pushEvent({ kind: 'formechange', side, newSpecies: species,
			text: `${this.nameForSide(parts[2])} underwent Ultra Burst into ${species}!` });
	}

	private handlePrimal(parts: string[]): void {
		const slot = this.slotOf(parts[2]);
		const side = this.sideOf(slot);
		this.pushEvent({ kind: 'effect', side,
			text: tpl(T.primal, { POKEMON: this.nameForSide(parts[2]) }) });
	}

	private handleStart(parts: string[]): void {
		const slot = this.slotOf(parts[2]);
		const side = this.sideOf(slot);
		const effect = parts[3] ?? '';
		if (effect === 'Dynamax' || effect === 'Dynamax Gmax') {
			const isGmax = parts[4] === 'Gmax' || effect.includes('Gmax');
			const label = isGmax ? 'Gigantamaxed' : 'Dynamaxed';
			const POKEMON = this.nameForSide(parts[2]);
			const gmaxSpecies = isGmax ? `${POKEMON}-Gmax` : POKEMON;
			this.pushEvent({ kind: 'formechange', side, newSpecies: gmaxSpecies,
				text: `${POKEMON} ${label}!` });
			return;
		}
		const effectId = this.idof(effect);
		const group = (DefaultText as any)[effectId];
		if (group?.start) {
			this.pushEvent({ kind: 'effect', side,
				text: tpl(group.start, { POKEMON: this.nameForSide(parts[2]) }) });
		}
	}

	private handleEnd(parts: string[]): void {
		const slot = this.slotOf(parts[2]);
		const side = this.sideOf(slot);
		const effect = parts[3] ?? '';
		if (effect === 'Dynamax') {
			const POKEMON = this.nameForSide(parts[2]);
			this.pushEvent({ kind: 'formechange', side, newSpecies: POKEMON,
				text: `${POKEMON}'s Dynamax ended!` });
			return;
		}
		const effectId = this.idof(effect);
		const group = (DefaultText as any)[effectId];
		if (group?.end) {
			this.pushEvent({ kind: 'effect', side,
				text: tpl(group.end, { POKEMON: this.nameForSide(parts[2]) }) });
		}
	}

	// --- helpers / formatting --------------------------------------------

	private pushEvent(ev: PrettyEvent): void { this.events.push(ev); }

	private slotOf(ident: string | undefined): string | undefined {
		if (!ident) return undefined;
		return ident.split(': ')[0];
	}
	private sideOf(slot: string | undefined): 'p1' | 'p2' | null {
		if (!slot) return null;
		if (slot.startsWith('p1')) return 'p1';
		if (slot.startsWith('p2')) return 'p2';
		return null;
	}
	private sidePrefix(side: 'p1' | 'p2' | null): string {
		if (side === this.aiSide) return 'The opposing ';
		return '';
	}
	private nameForSide(ident: string | undefined): string {
		if (!ident) return '?';
		const nick = ident.split(': ')[1] ?? '?';
		const side = this.sideOf(this.slotOf(ident));
		return side === this.aiSide ? `the opposing ${nick}` : nick;
	}
	private parseSideRef(ref: string): 'p1' | 'p2' | null {
		if (!ref) return null;
		const colon = ref.indexOf(':');
		const id = (colon >= 0 ? ref.slice(0, colon) : ref).trim();
		if (id === 'p1' || id === 'p2') return id;
		return null;
	}
	private foeAtSlot(slot: string | undefined): FoeMonState | undefined {
		if (!slot) return undefined;
		if (this.sideOf(slot) !== this.aiSide) return undefined;
		// Match by exact slot first (doubles-correct), fall back to any active (singles compat).
		return this.foeTeam.find(f => f.active && f.slot === slot) ??
			this.foeTeam.find(f => f.active);
	}

	private parseDetails(details: string): { species: string, level?: number, gender?: string } {
		const segs = details.split(',').map(s => s.trim());
		const out: { species: string, level?: number, gender?: string } = { species: segs[0] };
		for (let i = 1; i < segs.length; i++) {
			const seg = segs[i];
			if (seg.startsWith('L')) {
				const n = parseInt(seg.slice(1));
				if (!isNaN(n)) out.level = n;
			} else if (seg === 'M' || seg === 'F' || seg === 'N') {
				out.gender = seg;
			}
		}
		return out;
	}
	private resolveFromEffect(fromRaw: string | null, fromId: string | null): { fromEffect?: string, fromEffectKind?: 'item' | 'ability' | 'move' | 'status' } {
		if (!fromRaw || !fromId) return {};
		const group = (DefaultText as any)[fromId];
		const name: string | undefined = group?.name;
		let kind: 'item' | 'ability' | 'move' | 'status' | undefined;
		if (fromRaw.startsWith('item:')) kind = 'item';
		else if (fromRaw.startsWith('ability:')) kind = 'ability';
		else if (fromRaw.startsWith('move:')) kind = 'move';
		else if (['brn', 'psn', 'tox', 'par', 'slp', 'frz'].includes(fromId)) kind = 'status';
		if (!name && !kind) return {};
		return { fromEffect: name ?? fromRaw.replace(/^(item|ability|move):/, '').trim(), fromEffectKind: kind };
	}

	private resolveEffectTemplate(effectId: string, key: string): string | undefined {
		const group = (DefaultText as any)[effectId];
		let val = group?.[key];
		if (typeof val !== 'string') return undefined;
		// PS uses "#otherId" references to share templates (e.g. tox.damage = "#psn")
		if (val.startsWith('#')) {
			const refGroup = (DefaultText as any)[val.slice(1)];
			val = refGroup?.[key];
		}
		return typeof val === 'string' ? val : undefined;
	}

	private parseHp(hpStatus: string | undefined): { hpPercent: number, status: string | null } {
		if (!hpStatus) return { hpPercent: 100, status: null };
		if (hpStatus.endsWith(' fnt') || hpStatus.trim() === '0 fnt' || hpStatus.trim() === '0') {
			return { hpPercent: 0, status: null };
		}
		const spaceIdx = hpStatus.indexOf(' ');
		const ratio = spaceIdx >= 0 ? hpStatus.slice(0, spaceIdx) : hpStatus;
		const statusPart = spaceIdx >= 0 ? hpStatus.slice(spaceIdx + 1).trim() : '';
		const slashIdx = ratio.indexOf('/');
		if (slashIdx < 0) return { hpPercent: 100, status: statusPart || null };
		const num = parseInt(ratio.slice(0, slashIdx));
		const den = parseInt(ratio.slice(slashIdx + 1));
		if (!den || isNaN(num)) return { hpPercent: 100, status: statusPart || null };
		return { hpPercent: Math.max(0, Math.min(100, (num / den) * 100)), status: statusPart || null };
	}
	private updateMonHpFromCondition(slot: string | undefined, condition: string): void {
		const side = this.sideOf(slot);
		if (side !== this.aiSide) return;
		const foe = this.foeAtSlot(slot);
		if (!foe) return;
		const hpData = this.parseHp(condition);
		foe.hpPercent = hpData.hpPercent;
		foe.condition = condition;
		foe.status = hpData.status;
		if (hpData.hpPercent === 0) foe.fainted = true;
	}
	private hpPercentString(condition: string): string {
		const hp = this.parseHp(condition);
		return `${Math.round(hp.hpPercent)}%`;
	}
	private statusName(s: string): string {
		return ({ brn: 'burned', par: 'paralyzed', psn: 'poisoned', tox: 'badly poisoned', slp: 'asleep', frz: 'frozen' } as any)[s] || s;
	}
	private statName(s: string): string {
		return ({ atk: 'Attack', def: 'Defense', spa: 'Sp. Atk', spd: 'Sp. Def', spe: 'Speed', accuracy: 'accuracy', evasion: 'evasiveness' } as any)[s] || s;
	}
	private weatherText(weather: string, upkeep?: string): string {
		const isUpkeep = upkeep && upkeep.includes('[upkeep]');
		if (isUpkeep) return `${this.weatherName(weather)} continues`;
		return this.weatherStart(weather);
	}
	private weatherName(w: string): string {
		return ({ sunnyday: 'The sunshine', raindance: 'The rain', sandstorm: 'The sandstorm',
			hail: 'The hail', snow: 'The snow', snowscape: 'The snow' } as any)[w] || w;
	}
	private weatherStart(w: string): string {
		return ({ sunnyday: 'The sunlight turned harsh!', raindance: 'It started to rain!',
			sandstorm: 'A sandstorm kicked up!', hail: 'It started to hail!',
			snow: 'It started to snow!', snowscape: 'It started to snow!',
			desolateland: 'The sunlight turned extremely harsh!', primordialsea: 'A heavy rain began to fall!',
			deltastream: 'Mysterious strong winds appeared!' } as any)[w] || `Weather: ${w}`;
	}
	private terrainNameFromEffect(effect: string): string | null {
		const cleaned = effect.replace(/^move:\s*/i, '').toLowerCase().replace(/\s+/g, '');
		if (cleaned.endsWith('terrain')) return cleaned;
		return null;
	}
	private fieldEffectText(rest: string, start: boolean): string {
		const name = rest.replace(/^move:\s*/i, '').replace(/\|.*$/, '').trim();
		return start ? `${name} took effect.` : `${name} ended.`;
	}
	private sideEffectText(sideRef: string, effect: string, start: boolean): string {
		const side = this.parseSideRef(sideRef);
		const who = side === this.humanSide ? 'Your side' : (side === this.aiSide ? 'The opposing side' : '?');
		const name = effect.replace(/^move:\s*/i, '').trim();
		return start ? `${who}: ${name} took effect.` : `${who}: ${name} ended.`;
	}
	private idof(s: string): string {
		return s.toLowerCase().replace(/[^a-z0-9]/g, '');
	}
	private applyBoostDelta(slot: string | undefined, stat: string, delta: number): void {
		const side = this.sideOf(slot);
		if (side === this.humanSide && slot) {
			if (!this.myBoostsPerSlot[slot]) this.myBoostsPerSlot[slot] = {};
			const target = this.myBoostsPerSlot[slot];
			target[stat] = Math.max(-6, Math.min(6, (target[stat] ?? 0) + delta));
		} else {
			const foe = this.foeAtSlot(slot);
			if (!foe) return;
			foe.boosts[stat] = Math.max(-6, Math.min(6, (foe.boosts[stat] ?? 0) + delta));
		}
	}
	private setBoostAbsolute(slot: string | undefined, stat: string, value: number): void {
		const side = this.sideOf(slot);
		if (side === this.humanSide && slot) {
			if (!this.myBoostsPerSlot[slot]) this.myBoostsPerSlot[slot] = {};
			this.myBoostsPerSlot[slot][stat] = Math.max(-6, Math.min(6, value));
		} else {
			const foe = this.foeAtSlot(slot);
			if (!foe) return;
			foe.boosts[stat] = Math.max(-6, Math.min(6, value));
		}
	}

	// --- move metadata enrichment ---------------------------------------

	/**
	 * Build id -> display-name lookups for the items and abilities on every
	 * mon in our current request. The browser uses these to render
	 * "Heavy-Duty Boots" instead of "heavydutyboots" wherever an own-side
	 * mon's item / ability is shown.
	 */
	private buildDexNamesForMyTeam(): { items: Record<string, string>, abilities: Record<string, string> } {
		const items: Record<string, string> = {};
		const abilities: Record<string, string> = {};
		const dex = this.dex ?? Dex;
		const req = this.currentRequest as MoveRequest | undefined;
		const pokemonList = req?.side?.pokemon ?? [];
		for (const pkmn of pokemonList) {
			const itemId = (pkmn as any).item;
			if (itemId) {
				const it = dex.items.get(itemId);
				if (it?.exists) items[itemId] = it.name;
			}
			const abilityId = (pkmn as any).ability ?? (pkmn as any).baseAbility;
			if (abilityId) {
				const ab = dex.abilities.get(abilityId);
				if (ab?.exists) abilities[abilityId] = ab.name;
			}
		}
		return { items, abilities };
	}

	private buildCurrentMoves(): MoveMeta[][] | null {
		if (!this.currentRequest || this.currentRequest.wait || this.currentRequest.forceSwitch || this.currentRequest.teamPreview) {
			return null;
		}
		const moveReq = this.currentRequest as MoveRequest;
		if (!moveReq.active || !moveReq.active.length) return null;
		const dex = this.dex ?? Dex;
		const activeFoes = this.foeTeam.filter(f => f.active && !f.fainted);
		return moveReq.active.map(activeSlot => {
			if (!activeSlot?.moves) return [];
			return activeSlot.moves.map(m => {
				const move = dex.moves.get(m.id ?? m.move);
				let shortDesc = move?.shortDesc || move?.desc || '';
				if (!shortDesc && move?.exists) {
					const textData = dex.getDescs('Moves', move.id, dex.data.Moves[move.id] || {});
					if (textData) shortDesc = textData.shortDesc || textData.desc || '';
				}
				const meta: MoveMeta = {
					move: m.move,
					id: String(m.id ?? ''),
					type: move?.type ?? '?',
					category: move?.category ?? '?',
					basePower: move?.basePower ?? 0,
					accuracy: move?.accuracy ?? 100,
					disabled: m.disabled,
					target: m.target,
					shortDesc,
				};
				if (activeFoes.length && move?.exists && move.category !== 'Status' && move.type && move.type !== '???') {
					const foeTypes = this.effectiveTypesOf(activeFoes[0]);
					meta.effectivenessVsFoe = this.computeEffectiveness(move.type, foeTypes);
				}
				return meta;
			});
		});
	}

	/**
	 * Compute the type-chart multiplier of an attacking type against a
	 * defender's types: 0 (immune) / 0.25 / 0.5 / 1 / 2 / 4.
	 */
	private computeEffectiveness(moveType: string, defTypes: string[]): number {
		const dex = this.dex ?? Dex;
		if (!dex.getImmunity(moveType, defTypes as any)) return 0;
		const eff = dex.getEffectiveness(moveType, defTypes as any);
		// getEffectiveness returns -2..+2 in log2 space.
		return Math.pow(2, eff);
	}

	/** Effective types for a foe mon, accounting for terastallization. */
	private effectiveTypesOf(foe: FoeMonState): string[] {
		if (foe.terastallized) {
			const t = String(foe.terastallized);
			return [t.charAt(0).toUpperCase() + t.slice(1).toLowerCase()];
		}
		const dex = this.dex ?? Dex;
		const species = dex.species.get(this.idof(foe.species));
		return species?.types ?? [];
	}

	/**
	 * Min/max possible speed across all EV/IV/nature spreads (gen 3+ formula).
	 * Useful for the "is the foe faster than me?" hover. For the bottom end:
	 * 0 IVs, 0 EVs, hindering nature (×0.9). For the top: 31 IVs, 252 EVs,
	 * helpful nature (×1.1). For gens 1-2 we still report the same range —
	 * the user just won't see Choice Scarf etc. factored in.
	 */
	private speedRangeFor(speciesName: string, level: number): { min: number, max: number } | null {
		const dex = this.dex ?? Dex;
		const species = dex.species.get(this.idof(speciesName));
		if (!species?.exists) return null;
		const base = species.baseStats?.spe;
		if (!base) return null;
		const lvl = Math.max(1, Math.min(100, level || 100));
		const calc = (iv: number, ev: number, nature: number) =>
			Math.floor((Math.floor((2 * base + iv + Math.floor(ev / 4)) * lvl / 100) + 5) * nature);
		return { min: calc(0, 0, 0.9), max: calc(31, 252, 1.1) };
	}

	/**
	 * Decorate a foe mon entry with derived fields (types, speed range) so
	 * the client can render hover summaries without its own type chart.
	 */
	private decorateFoe(foe: FoeMonState): FoeMonState {
		const types = this.effectiveTypesOf(foe);
		const range = this.speedRangeFor(foe.species, foe.level ?? 100);
		return {
			...foe,
			types: types.length ? types : undefined,
			speedMin: range?.min,
			speedMax: range?.max,
		};
	}

	// --- snapshot for the UI ---------------------------------------------

	snapshot(): InteractiveSessionSnapshot {
		const { weather, terrain, pseudoWeather, sideEffects } = this.readLiveFieldState();
		const rawFoe = this.scenario.openTeamsheet ? this.foeTeamWithSheet() : this.foeTeam;
		const foeTeam = rawFoe.map(f => this.decorateFoe(f));
		return {
			id: this.id,
			scenarioName: this.scenarioName,
			humanSide: this.humanSide,
			aiSide: this.aiSide,
			myName: this.scenario[this.humanSide].name ?? null,
			aiName: this.scenario[this.aiSide].name ?? null,
			myAvatar: this.scenario[this.humanSide].avatar ?? null,
			aiAvatar: this.scenario[this.aiSide].avatar ?? null,
			backdrop: this.scenario.field?.backdrop ?? null,
			dexNames: this.buildDexNamesForMyTeam(),
			events: this.events,
			currentRequest: this.currentRequest,
			currentMoves: this.buildCurrentMoves(),
			foeTeam,
			openTeamsheet: !!this.scenario.openTeamsheet,
			myBoosts: this.myBoostsPerSlot,
			weather, terrain, pseudoWeather, sideEffects,
			ended: this.ended,
			winner: this.winner,
			cursor: this.events.length,
			lastError: this.lastError,
		};
	}

	/**
	 * Read field + side state from the live Battle object. Done at snapshot
	 * time (rather than maintained in parallel from the log) so durations and
	 * hazard layers are always the engine's source of truth.
	 *
	 * Returns empty defaults if the battle hasn't started yet.
	 */
	private readLiveFieldState(): {
		weather: FieldEffectState | null,
		terrain: FieldEffectState | null,
		pseudoWeather: FieldEffectState[],
		sideEffects: { p1: SideEffectState[], p2: SideEffectState[] },
	} {
		const battle = this.battleStream?.battle;
		const sideEffects: { p1: SideEffectState[], p2: SideEffectState[] } = { p1: [], p2: [] };
		if (!battle) {
			return { weather: null, terrain: null, pseudoWeather: [], sideEffects };
		}
		const field = battle.field;
		const weatherId = field.weather as string | undefined;
		const weather = weatherId ? {
			id: weatherId,
			turnsRemaining: (field as any).weatherState?.duration,
		} : null;
		const terrainId = field.terrain as string | undefined;
		const terrain = terrainId ? {
			id: terrainId,
			turnsRemaining: (field as any).terrainState?.duration,
		} : null;
		const pseudoWeather: FieldEffectState[] = [];
		for (const [id, state] of Object.entries((field as any).pseudoWeather ?? {})) {
			pseudoWeather.push({ id, turnsRemaining: (state as any).duration });
		}
		for (const side of battle.sides) {
			const sideKey = side.id as string;
			if (sideKey !== 'p1' && sideKey !== 'p2') continue;
			const list: SideEffectState[] = [];
			for (const [id, state] of Object.entries(side.sideConditions ?? {})) {
				const entry: SideEffectState = { id };
				const dur = (state as any).duration;
				const layers = (state as any).layers;
				if (typeof dur === 'number') entry.turnsRemaining = dur;
				if (typeof layers === 'number') entry.layers = layers;
				list.push(entry);
			}
			sideEffects[sideKey as 'p1' | 'p2'] = list;
		}
		return { weather, terrain, pseudoWeather, sideEffects };
	}

	/**
	 * Build a foe team list using the full scenario team data for items /
	 * abilities (open-teamsheet semantics). Per-mon HP / status / fainted /
	 * active state still come from the log-derived `this.foeTeam` when
	 * available — what's open is just the static identity info.
	 */
	private foeTeamWithSheet(): FoeMonState[] {
		const team = this.scenario[this.aiSide].team || [];
		return team.map((set, idx) => {
			const observed = this.foeTeam.find(f => this.idof(f.species) === this.idof(set.species));
			const base: FoeMonState = observed ?? {
				species: set.species, level: set.level ?? 100, gender: set.gender,
				hpPercent: 100, condition: '',
				status: null, revealedItem: null, revealedAbility: null,
				teraType: null, terastallized: null, boosts: {}, fainted: false,
				active: idx === 0,
			};
			// Overlay open-sheet info — never overwrite what the log revealed.
			return {
				...base,
				revealedItem: base.revealedItem ?? (set.item || null),
				revealedAbility: base.revealedAbility ?? (set.ability || null),
				teraType: base.teraType ?? (set.teraType || null),
			};
		});
	}

	/** Delta snapshot: only events past the given cursor. */
	delta(cursor: number): InteractiveSessionSnapshot {
		const full = this.snapshot();
		return { ...full, events: this.events.slice(cursor) };
	}
}
