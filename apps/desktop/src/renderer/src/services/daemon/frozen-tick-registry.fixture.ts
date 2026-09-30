// The frozen-tick registry: which frame of each scenario the capture tiers pin.
//
// The fixture clock is frozen and a driver advances it, so a capture's frame is decided by how far
// the caller advanced; a named tick per scenario makes "the frame is byte-identical" checkable
// and stops a suite drifting from the baseline when someone re-times a beat. The table lives here
// and not on `Scenario`, because a frozen tick is a claim the capture tiers make, and an
// unregistered scenario is a registry failure so the owed decision is collected. `settled` is the
// tick at which every beat has been delivered; `money-shot` is the concurrent-streaming scenario's
// composed frame. A second frame is a second, uniquely named, ascending row. No label is minted
// here, since no capture tier reads a reference file by one.

import type { Scenario } from "../../../../../fixtures/scenario.js";

/** One pinned frame of one scenario: what it is called, and the tick it is taken at. */
export interface ScenarioFrozenTick {
  /** Unique within its scenario. Names the frame, never the view it is captured for. */
  readonly name: string;
  /** Milliseconds from scenario start: what a driver advances the frozen clock to. */
  readonly atMs: number;
}

/** Scenario id to the frames pinned for it. */
export type FrozenTickTable = Readonly<Record<string, readonly ScenarioFrozenTick[]>>;

/**
 * Every scenario's pinned frames, keyed by scenario id. The values are written down, not derived:
 * a tick computed from the script it pins would move with the script, drifting the baseline
 * silently.
 */
export const SCENARIO_FROZEN_TICKS: FrozenTickTable = {
  "first-run": [{ name: "settled", atMs: 0 }],
  "concurrent-streaming": [{ name: "money-shot", atMs: 2_450 }],
  "transcript-states": [{ name: "settled", atMs: 3_140 }],
  "empty-session": [{ name: "settled", atMs: 0 }],
  "waiting-for-input": [{ name: "settled", atMs: 540 }],
  "approval-request": [{ name: "settled", atMs: 1_100 }],
  "terminal-lease": [{ name: "settled", atMs: 4_100 }],
};

/** One way the registry and the scenario board disagree. */
export interface FrozenTickRegistryDefect {
  readonly scenarioId: string;
  readonly reason: string;
}

/**
 * The frames pinned for one scenario, or an empty list where none are; the defect walk reports
 * the absence. The table parameter defaults to the shipped one so rules can be tested with a
 * planted table. `Object.hasOwn`, since a free-form id would otherwise hit `constructor`.
 */
export function frozenTicksFor(
  scenarioId: string,
  frozenTicks: FrozenTickTable = SCENARIO_FROZEN_TICKS,
): readonly ScenarioFrozenTick[] {
  return Object.hasOwn(frozenTicks, scenarioId) ? (frozenTicks[scenarioId] ?? []) : [];
}

/** Scenarios on the board that the registry names no frame for: what a new scenario meets. */
export function findScenariosWithoutFrozenTick(
  scenarios: readonly Scenario[],
  frozenTicks: FrozenTickTable = SCENARIO_FROZEN_TICKS,
): readonly string[] {
  return scenarios
    .filter((scenario) => frozenTicksFor(scenario.id, frozenTicks).length === 0)
    .map((scenario) => scenario.id);
}

/**
 * Every disagreement between the registry and the scenario board. Empty is passing. Both
 * directions: an unregistered scenario is a frame nobody chose, and a row for a scenario that has
 * left the board pins a session that no longer exists.
 */
export function findFrozenTickRegistryDefects(
  scenarios: readonly Scenario[],
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
        reason: `the frame "${tick.name}" is pinned at ${String(tick.atMs)}ms, at or before the frame in front of it at ${String(previousTickAtMs)}ms. A scenario's pinned frames ascend in time; order them.`,
      });
    }
    previousTickAtMs = tick.atMs;
  }
  return defects;
}
