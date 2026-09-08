// The frozen-tick registry: which frame of each scenario the capture tiers pin.
//
// `Spec-023 §Console Design (Meridian)` §The fixture bridge: "the manifest names every
// scenario, its frozen ticks (`flagship@t=<tick>`), and, per bridge method, its live
// status at HEAD". The manifest already carried the scenarios and the live statuses and
// named no tick, which left the middle claim unmade — and it is the claim that decides
// whether a reference image means anything.
//
// WHY A TICK HAS TO BE NAMED AT ALL. The fixture clock is frozen and a driver advances
// it, so what a capture photographs is decided entirely by how far the caller advanced.
// Two suites that advance differently photograph two different frames of one scenario
// and both are green; a suite that advances by a number written inline drifts from the
// baseline the day someone re-times a beat, and the reference is regenerated rather than
// questioned. A NAMED tick is the fixed point that makes "the money frame is
// byte-identical" a checkable sentence instead of a hope.
//
// WHY THE TABLE IS HERE AND NOT ON THE SCENARIO. A frozen tick is a claim the CAPTURE
// tiers make — this is the frame we pin — and not a fact about the session. A scenario
// can exist perfectly well before anyone has decided which of its frames is worth
// freezing, which is exactly why an unregistered scenario has to be a registry FAILURE
// rather than a compiler error: the decision is owed, and the registry is what collects
// the debt. Putting the member on `ConsoleScenario` would make forgetting impossible and
// deciding thoughtlessly easy, which is the wrong trade for a table this small.
//
// WHAT A NAME MEANS. `settled` is the tick at which every beat the script carries has
// been delivered — the longest the session gets, and the frame most surfaces are worth
// photographing at. `money-shot` is the flagship's own composed frame per §14.7. A
// scenario that wants a second frame adds a second row with its own name; the rules
// below hold the pair to an ascending, uniquely-named sequence.

import type { ConsoleScenario } from "./scenario.js";

/** One pinned frame of one scenario: what it is called, and the tick it is taken at. */
export interface ScenarioFrozenTick {
  /** Unique within its scenario. Names the FRAME, never the surface it is captured for. */
  readonly name: string;
  /** Milliseconds from scenario start — what a driver advances the frozen clock to. */
  readonly atMs: number;
}

/** The registry's own shape: scenario id to the frames pinned for it. */
export type FrozenTickTable = Readonly<Record<string, readonly ScenarioFrozenTick[]>>;

/**
 * Every scenario's pinned frames, keyed by scenario id.
 *
 * The values are written down rather than derived, and that is the whole point: a tick
 * computed from the script it pins would move whenever the script did, which is the
 * silent baseline drift this registry exists to stop.
 */
export const SCENARIO_FROZEN_TICKS: FrozenTickTable = {
  "first-run": [{ name: "settled", atMs: 0 }],
  flagship: [{ name: "money-shot", atMs: 2_450 }],
  ledger: [{ name: "settled", atMs: 3_140 }],
  "ledger-first-sixty": [{ name: "settled", atMs: 60_000 }],
  "ledger-quiet": [{ name: "settled", atMs: 0 }],
  composer: [{ name: "settled", atMs: 540 }],
  runs: [{ name: "settled", atMs: 980 }],
  approvals: [{ name: "settled", atMs: 1_100 }],
  collaboration: [{ name: "settled", atMs: 640 }],
  agents: [{ name: "settled", atMs: 420 }],
  settings: [{ name: "settled", atMs: 380 }],
  repos: [{ name: "settled", atMs: 1_900 }],
  workflows: [{ name: "settled", atMs: 420 }],
  browser: [{ name: "settled", atMs: 3_900 }],
  terminal: [{ name: "settled", atMs: 4_900 }],
  shell: [{ name: "settled", atMs: 800 }],
  "bring-your-history": [{ name: "settled", atMs: 0 }],
  onboarding: [{ name: "settled", atMs: 0 }],
  "incident-ledger-window-growth": [{ name: "settled", atMs: 20_000 }],
};

/**
 * The label a pinned frame is referred to by, in the corpus's own spelling.
 *
 * One function rather than a template every caller writes, because the spelling is the
 * handle: a reference file, a failure message, and a design document all have to name
 * one frame the same way or they are naming three.
 */
export function frozenTickLabel(scenarioId: string, tick: ScenarioFrozenTick): string {
  return `${scenarioId}@t=${String(tick.atMs)}`;
}

/**
 * The frames pinned for one scenario, or an empty list where none are.
 *
 * Empty rather than `undefined`, because every caller's next act is to iterate: a
 * scenario with no registered frame has no frame to capture, which is the same answer
 * either way, and the registry's own defect walk is what reports it as a failure.
 *
 * The table is a parameter defaulting to the shipped one, the shape
 * `scenario-manifest.ts` takes beside this file: the rules below are then reachable with
 * a planted table, so each one has a negative control that does not require editing the
 * registry the console actually ships.
 *
 * `Object.hasOwn` rather than a bare index, because a scenario id is a free-form string
 * and a plain object answers `constructor` and `toString` with values that are not
 * frozen ticks.
 */
export function frozenTicksFor(
  scenarioId: string,
  frozenTicks: FrozenTickTable = SCENARIO_FROZEN_TICKS,
): readonly ScenarioFrozenTick[] {
  return Object.hasOwn(frozenTicks, scenarioId) ? (frozenTicks[scenarioId] ?? []) : [];
}

/** One way the registry and the scenario board disagree. */
export interface FrozenTickRegistryDefect {
  readonly scenarioId: string;
  readonly reason: string;
}

/**
 * Scenarios on the board that the registry names no frame for.
 *
 * The failure the register row asks for, published on its own because it is the one a
 * person adding a scenario meets: the board grew, nobody said which frame to pin, and
 * the build says so.
 */
export function findScenariosWithoutFrozenTick(
  scenarios: readonly ConsoleScenario[],
  frozenTicks: FrozenTickTable = SCENARIO_FROZEN_TICKS,
): readonly string[] {
  return scenarios
    .filter((scenario) => frozenTicksFor(scenario.id, frozenTicks).length === 0)
    .map((scenario) => scenario.id);
}

/**
 * Every disagreement between the registry and the scenario board. Empty is passing.
 *
 * BOTH DIRECTIONS, on `scenario-manifest.ts`'s own reasoning for the growth slate: an
 * unregistered scenario is a frame nobody chose, and a registry row for a scenario that
 * has left the board is a pin on a session that no longer exists — which reads exactly
 * like a correct row until someone tries to capture it.
 */
export function findFrozenTickRegistryDefects(
  scenarios: readonly ConsoleScenario[],
  frozenTicks: FrozenTickTable = SCENARIO_FROZEN_TICKS,
): readonly FrozenTickRegistryDefect[] {
  const defects: FrozenTickRegistryDefect[] = [];
  for (const scenarioId of findScenariosWithoutFrozenTick(scenarios, frozenTicks)) {
    defects.push({
      scenarioId,
      reason:
        "the scenario board carries it and this registry names no frozen tick for it, so a " +
        "capture of it would be taken at whatever tick its caller happened to advance to. " +
        "Register the frame worth pinning.",
    });
  }
  const boardScenarioIds = new Set(scenarios.map((scenario) => scenario.id));
  for (const [scenarioId, ticks] of Object.entries(frozenTicks)) {
    if (!boardScenarioIds.has(scenarioId)) {
      defects.push({
        scenarioId,
        reason:
          "this registry pins a frame of a scenario the board no longer carries, so the pin " +
          "names a session that cannot be played. Remove the row with the scenario.",
      });
      continue;
    }
    defects.push(...describeTickSequenceDefects(scenarioId, ticks));
  }
  return defects;
}

/** The rules one scenario's own tick list is held to, in the order a reader meets them. */
function describeTickSequenceDefects(
  scenarioId: string,
  ticks: readonly ScenarioFrozenTick[],
): readonly FrozenTickRegistryDefect[] {
  const defects: FrozenTickRegistryDefect[] = [];
  const seenNames = new Set<string>();
  let previousTickAtMs = Number.NEGATIVE_INFINITY;
  for (const tick of ticks) {
    if (seenNames.has(tick.name)) {
      defects.push({
        scenarioId,
        reason: `two frames are named "${tick.name}", so the label they are captured under names both of them.`,
      });
    }
    seenNames.add(tick.name);
    if (!Number.isSafeInteger(tick.atMs) || tick.atMs < 0) {
      defects.push({
        scenarioId,
        reason: `the frame "${tick.name}" is pinned at ${String(tick.atMs)}ms, which is not a tick a frozen clock can be advanced to.`,
      });
      continue;
    }
    if (tick.atMs <= previousTickAtMs) {
      defects.push({
        scenarioId,
        reason: `the frame "${tick.name}" is pinned at ${String(tick.atMs)}ms, at or before the frame in front of it at ${String(previousTickAtMs)}ms. A scenario's pinned frames read as a timeline; order them.`,
      });
    }
    previousTickAtMs = tick.atMs;
  }
  return defects;
}
