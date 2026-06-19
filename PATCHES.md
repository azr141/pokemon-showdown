# BattleLab Engine Patches

This fork of [smogon/pokemon-showdown](https://github.com/smogon/pokemon-showdown)
contains patches for [BattleLab](https://battlelab.gg), a web app for creating
and playing Pokemon battle scenarios.

## How to rebase on upstream

```bash
git remote add upstream https://github.com/smogon/pokemon-showdown.git  # once
git fetch upstream
git rebase upstream/master
git push origin master
```

The patches below are small and touch distinct areas of the codebase, so
conflicts should be rare. If they occur, the descriptions below explain the
intent so you can resolve them correctly.

---

## Core engine patches (3 files, ~25 lines total)

### 1. `sim/battle.ts` — onBattleStart callback

**What:** Adds two optional fields to `BattleOptions`:
- `scenarioState?: AnyObject` — opaque scenario data, passed through to the callback
- `onBattleStart?: (battle: Battle) => void` — called once after all Pokemon
  switch in during the `'start'` action, immediately before turn 1 begins

Both are stored as readonly fields on the `Battle` class. The callback is
invoked with `if (this.onBattleStart) this.onBattleStart(this)` in the
`'start'` case of `runAction`.

**Why:** Lets scenario code apply field conditions (weather, terrain, hazards),
stat boosts, and status effects to the live Battle object at the right moment
— after switch-in but before the first turn. The callback pattern keeps
`battle.ts` completely decoupled from `sim/tools/scenario/`.

### 2. `sim/battle-stream.ts` — forward onBattleStart to Battle

**What:** Adds `onBattleStart` to `BattleStream`'s constructor options. When
present, it's injected into the `Battle` options at construction time (after
`JSON.parse` of the `>start` message, since functions can't be serialized).

**Why:** The `>start` protocol message is JSON-serialized, so callbacks can't
ride along in the message payload. This bridges the gap: callers pass the
callback to `BattleStream`, which forwards it to `Battle`.

### 3. `sim/pokemon.ts` — HP override from PokemonSet

**What:** After `this.hp = this.maxhp` in the Pokemon constructor, checks for
`this.set.hp` (a number). If present and finite, clamps it to `[1, maxhp]`
and sets `this.hp` to that value.

**Why:** Allows scenarios to specify starting HP for individual Pokemon
(e.g., "Skarmory starts at 80 HP"). The value comes from the `hp` field
added to `PokemonSet` (see below).

### 4. `sim/teams.ts` — hp field on PokemonSet

**What:** Adds `hp?: number` to the `PokemonSet` interface.

**Why:** Carries the starting HP override for patch 3. Not round-tripped
through the packed team format (scenarios use JSON).

---

## BattleLab additions (new files, no upstream conflicts)

### `sim/tools/scenario/` (9 files)

Scenario framework for declaring battle starting states:
- `types.ts` — Scenario, ScenarioField, ScenarioPlayer, ScenarioVolatile types
- `apply.ts` — Applies field conditions and volatiles to a live Battle
  (silent setters that bypass reactive events) + `buildOnBattleStart` callback builder
  + gen-aware allow-list helpers (`allowedWeathersForGen(gen)`, etc.)
- `load.ts` — Loads/saves scenario JSON, structural + gen-aware field validation,
  deep team validation via PS's TeamValidator
- `play.ts` — Headless AI-vs-AI scenario runner
- `interactive.ts` — Web-driven interactive play session (used by BattleLab);
  handles all gimmick protocol events (Mega, Z-Move, Dynamax, Primal, Ultra Burst, Tera)
- `registry.ts` — AI chain registry (maps AI ids to PolicyChain builders)
- `cli-play.ts` — Interactive CLI play via readline
- `smoke-test.ts` — Regression tests
- `index.ts` — Barrel exports

### `sim/tools/plugin-player-ai/` (9 files)

Policy-chain AI system for scenario play:
- `types.ts` — Decision, PolicyChain, ActionPolicy types
- `plugin-player-ai.ts` — Main player class (extends BattlePlayer)
- `battle-view.ts` — Reconstructed opponent state from protocol log
- `policies.ts` — Built-in policies (random, super-effective, switch-to-resist)
- `gens/` — Per-generation chain configurations (default, gen9)
- `smoke-test.ts` — Regression tests
- `index.ts` — Barrel exports

These directories are entirely new files under `sim/tools/`. They never
conflict with upstream changes because upstream has no `sim/tools/` directory.

### `config/scenarios/example-3v3.json`

Test fixture used by `sim/tools/scenario/smoke-test.ts`. Run via:
```bash
node build && node dist/sim/tools/scenario/smoke-test.js
```
