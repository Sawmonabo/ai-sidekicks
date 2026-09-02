// What the ledger scenarios claim, held to the wire and to the design.
//
// Two different kinds of claim, and both are worth a case:
//
//   • WIRE TRUTH — every beat is an event the daemon can emit, carrying the payload
//     the strict layer registers. Checked through `findScenarioWireTruthDefects`,
//     the same predicate every shipped scenario is held to, never a second reading
//     of the census here.
//   • COMPOSITION — the three lanes really do end in three different conditions,
//     the rewind boundary really is followed by rows it supersedes, and the quiet
//     session really is empty. These are what the ledger frame is built against, so
//     a scenario that quietly lost one would leave a surface untested and green.

import { describe, expect, it } from "vitest";

import { LEDGER_FIRST_SIXTY_SCENARIO, LEDGER_FIRST_SIXTY_SPAN_MS } from "./ledger-first-sixty.js";
import { LEDGER_QUIET_SCENARIO } from "./ledger-quiet.js";
import { LEDGER_SCENARIO } from "./ledger.js";
import { findScenarioWireTruthDefects } from "./wire-truth.js";
import type { ConsoleScenario, ScenarioBeat } from "../scenario.js";

const LEDGER_SCENARIOS: readonly ConsoleScenario[] = [
  LEDGER_SCENARIO,
  LEDGER_FIRST_SIXTY_SCENARIO,
  LEDGER_QUIET_SCENARIO,
];

/** The run one beat belongs to, or `undefined` when it names none. */
function runIdOf(beat: ScenarioBeat): string | undefined {
  const runId = beat.event.payload?.["runId"];
  return typeof runId === "string" ? runId : undefined;
}

/** The state a run-lifecycle beat moved into, or `undefined` for any other beat. */
function newStateOf(beat: ScenarioBeat): string | undefined {
  const newState = beat.event.payload?.["newState"];
  return typeof newState === "string" ? newState : undefined;
}

/** The last state each run reached, keyed by run. */
function finalRunStates(scenario: ConsoleScenario): ReadonlyMap<string, string> {
  const states = new Map<string, string>();
  for (const beat of scenario.beats) {
    const runId = runIdOf(beat);
    const newState = newStateOf(beat);
    if (runId !== undefined && newState !== undefined) {
      states.set(runId, newState);
    }
  }
  return states;
}

describe("the ledger scenarios", () => {
  it("script only events the daemon can emit, in the payloads it registers", () => {
    expect(findScenarioWireTruthDefects(LEDGER_SCENARIOS)).toStrictEqual([]);
  });

  it("would report a defect if one of them played an unregistered kind", () => {
    // The negative control for the case above. `run.started` reads exactly like a
    // real event and is not one, which is the defect class the predicate exists for
    // — so a clean sweep is only worth something if this fails.
    const defects = findScenarioWireTruthDefects([
      {
        ...LEDGER_SCENARIO,
        beats: [{ atMs: 0, event: { ...LEDGER_SCENARIO.beats[0]!.event, kind: "run.started" } }],
      },
    ]);
    expect(defects).toHaveLength(1);
    expect(defects[0]?.reason).toContain("not a registered event type");
  });

  it("carries unique ids, so the picker and the manifest lookup cannot collide", () => {
    const ids = LEDGER_SCENARIOS.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("states a viewer who is actually in the roster", () => {
    for (const scenario of LEDGER_SCENARIOS) {
      expect(scenario.participantIdsInJoinOrder).toContain(scenario.viewingParticipantId);
    }
  });

  it("scripts no reply for a call the method registry does not carry", () => {
    // `session.list` is the specific one this family shipped by mistake once: the
    // registry carries `session.read` and no list verb, so a scripted answer to it
    // puts a call in front of a surface that has nowhere to send it.
    const calls = LEDGER_SCENARIOS.flatMap((scenario) =>
      scenario.replies.map((reply) => reply.call),
    );
    expect(calls).not.toContain("session.list");
    expect(calls).toContain("session.read");
  });
});

describe("the three-lane ledger scenario", () => {
  it("ends its three runs in three different conditions at once", () => {
    expect([...finalRunStates(LEDGER_SCENARIO).values()].sort()).toStrictEqual([
      "completed",
      "paused",
      "running",
    ]);
  });

  it("reaches the block state a seam renders, and returns through `run.running`", () => {
    const kinds = LEDGER_SCENARIO.beats.map((beat) => beat.event.kind);
    expect(kinds).toContain("run.waiting_for_approval");
    expect(kinds.lastIndexOf("run.running")).toBeGreaterThan(
      kinds.indexOf("run.waiting_for_approval"),
    );
  });

  it("draws the compaction and rollback seams the log can actually carry", () => {
    const kinds = LEDGER_SCENARIO.beats.map((beat) => beat.event.kind);
    expect(kinds).toContain("usage.context_compacted");
    expect(kinds).toContain("run.rolled_back");
    expect(kinds).toContain("run.paused");
  });

  it("puts rows of the rewound run after its boundary, which is what a band folds", () => {
    const boundaryIndex = LEDGER_SCENARIO.beats.findIndex(
      (beat) => beat.event.kind === "run.rolled_back",
    );
    expect(boundaryIndex).toBeGreaterThan(-1);
    const boundary = LEDGER_SCENARIO.beats[boundaryIndex]!;
    const rewoundRunId = runIdOf(boundary);
    const laterRowsOfThatRun = LEDGER_SCENARIO.beats
      .slice(boundaryIndex + 1)
      .filter((beat) => runIdOf(beat) === rewoundRunId);
    expect(laterRowsOfThatRun.length).toBeGreaterThan(0);
    // The boundary states where the run landed, and the band is measured against
    // that number — so a boundary carrying no target would leave nothing to compare.
    expect(typeof boundary.event.payload?.["targetPosition"]).toBe("number");
  });

  it("streams two agents' turns before either run reaches a terminal state", () => {
    const firstTerminalIndex = LEDGER_SCENARIO.beats.findIndex(
      (beat) => newStateOf(beat) === "completed",
    );
    const streamingRunsBefore = new Set(
      LEDGER_SCENARIO.beats
        .slice(0, firstTerminalIndex)
        .filter((beat) => beat.event.kind.startsWith("assistant."))
        .map((beat) => runIdOf(beat)),
    );
    expect(streamingRunsBefore.size).toBeGreaterThanOrEqual(2);
  });
});

describe("the first-sixty-seconds scenario", () => {
  it("is paced across a full minute rather than fired at tick zero", () => {
    // The span is read off the scenario rather than restated here: the number the
    // claim is about lives beside the script it paces, so a script edit that moved the
    // last beat fails this rather than quietly disagreeing with a copy.
    const lastBeat = LEDGER_FIRST_SIXTY_SCENARIO.beats.at(-1);
    expect(lastBeat?.atMs).toBe(LEDGER_FIRST_SIXTY_SPAN_MS);
    expect(LEDGER_FIRST_SIXTY_SCENARIO.beats[0]?.atMs).toBe(0);
  });

  it("has a run landing past tense and another still going when it ends", () => {
    expect([...finalRunStates(LEDGER_FIRST_SIXTY_SCENARIO).values()].sort()).toStrictEqual([
      "completed",
      "running",
    ]);
  });

  it("opens a child thread under a run and settles it", () => {
    const kinds = LEDGER_FIRST_SIXTY_SCENARIO.beats.map((beat) => beat.event.kind);
    expect(kinds.indexOf("subagent.started")).toBeGreaterThan(-1);
    expect(kinds.indexOf("subagent.completed")).toBeGreaterThan(kinds.indexOf("subagent.started"));
  });
});

describe("the quiet ledger scenario", () => {
  it("plays no beats at all, which is the one state a script cannot reach", () => {
    expect(LEDGER_QUIET_SCENARIO.beats).toStrictEqual([]);
  });

  it("still carries a roster, because an empty log is not an empty room", () => {
    expect(LEDGER_QUIET_SCENARIO.participantIdsInJoinOrder.length).toBeGreaterThanOrEqual(3);
  });
});
