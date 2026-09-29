// What the transcript-states scenario claims, played through the transcript's own readers.
//
// COMPOSITION — the three lanes really do end in three different conditions, and the
// rewind boundary really is followed by rows it supersedes. These are what the transcript
// frame is built against, so a scenario that quietly lost one would leave a surface
// untested and green. Whether each beat is one a daemon can emit is the catalog-wide
// contract check's question.

import { describe, expect, it } from "vitest";
import {
  TRANSCRIPT_STATES_SCENARIO,
  RUN_ARCHITECT_CHILD,
  RUN_IMPLEMENTER,
  SUBAGENT_REVIEWER,
} from "../../fixtures/scenarios/transcript-states.js";
import type { ConsoleScenario, ScenarioBeat } from "../../fixtures/scenario.js";
// The transcript's own readers, reached deeply rather than through a door: this is a
// claim about what THIS SCENARIO reaches, so the three treatments it has to reach are
// named by the modules that derive them.
import { projectFixtureShellRows } from "@renderer/features/transcript/projection/transcript-row-projection.js";
import { ChildRunIndex } from "@renderer/features/transcript/dispatches/child-run-entries.js";
import { deriveSupersededBands } from "@renderer/features/transcript/superseded/superseded-bands.js";

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

describe("the transcript-states scenario", () => {
  it("names a caller who is actually in the roster", () => {
    expect(TRANSCRIPT_STATES_SCENARIO.userIdsInJoinOrder).toContain(
      TRANSCRIPT_STATES_SCENARIO.callerUserId,
    );
  });

  it("scripts no reply for a call the method registry does not carry", () => {
    // `session.list` reads exactly like a real method: the registry carries
    // `session.read` and no list verb, so a scripted answer to it puts a call in front
    // of a surface that has nowhere to send it.
    const calls = TRANSCRIPT_STATES_SCENARIO.replies.map((reply) => reply.call);
    expect(calls).not.toContain("session.list");
    expect(calls).toContain("session.read");
  });
});

/** Every row this scenario's whole script projects to, in log order. */
function transcriptStatesRows(): ReturnType<typeof projectFixtureShellRows>["rows"] {
  return projectFixtureShellRows(TRANSCRIPT_STATES_SCENARIO.beats.map((beat) => beat.event)).rows;
}

describe("the three lanes", () => {
  it("ends its three LANES in three different conditions at once", () => {
    // The child run under the architect is a fourth run and not a fourth lane: the
    // transcript folds it into its parent's chapter as a summary rather than drawing it
    // beside the three, so it is subtracted here rather than counted as one of them.
    const laneStates = [...finalRunStates(TRANSCRIPT_STATES_SCENARIO)]
      .filter(([runId]) => runId !== RUN_ARCHITECT_CHILD)
      .map(([, state]) => state)
      .sort();
    expect(laneStates).toStrictEqual(["completed", "paused", "running"]);
  });

  it("reaches the block state a seam renders, and returns through `run.running`", () => {
    const kinds = TRANSCRIPT_STATES_SCENARIO.beats.map((beat) => beat.event.kind);
    expect(kinds).toContain("run.waiting_for_approval");
    expect(kinds.lastIndexOf("run.running")).toBeGreaterThan(
      kinds.indexOf("run.waiting_for_approval"),
    );
  });

  it("draws the compaction and rollback seams the log can actually carry", () => {
    const kinds = TRANSCRIPT_STATES_SCENARIO.beats.map((beat) => beat.event.kind);
    expect(kinds).toContain("usage.context_compacted");
    expect(kinds).toContain("run.rolled_back");
    expect(kinds).toContain("run.paused");
  });

  it("puts rows of the rewound run after its boundary, which is what a band folds", () => {
    const boundaryIndex = TRANSCRIPT_STATES_SCENARIO.beats.findIndex(
      (beat) => beat.event.kind === "run.rolled_back",
    );
    expect(boundaryIndex).toBeGreaterThan(-1);
    const boundary = TRANSCRIPT_STATES_SCENARIO.beats[boundaryIndex]!;
    const rewoundRunId = runIdOf(boundary);
    const laterRowsOfThatRun = TRANSCRIPT_STATES_SCENARIO.beats
      .slice(boundaryIndex + 1)
      .filter((beat) => runIdOf(beat) === rewoundRunId);
    expect(laterRowsOfThatRun.length).toBeGreaterThan(0);
    // The boundary states where the run landed, and the band is measured against
    // that number — so a boundary carrying no target would leave nothing to compare.
    expect(typeof boundary.event.payload?.["targetPosition"]).toBe("number");
  });

  it("streams two agents' turns before either run reaches a terminal state", () => {
    const firstTerminalIndex = TRANSCRIPT_STATES_SCENARIO.beats.findIndex(
      (beat) => newStateOf(beat) === "completed",
    );
    const streamingRunsBefore = new Set(
      TRANSCRIPT_STATES_SCENARIO.beats
        .slice(0, firstTerminalIndex)
        .filter((beat) => beat.event.kind.startsWith("assistant."))
        .map((beat) => runIdOf(beat)),
    );
    expect(streamingRunsBefore.size).toBeGreaterThanOrEqual(2);
  });
});

describe("the folded bodies", () => {
  it("summarizes the architect's child run, and marks it incomplete", () => {
    const entries = new ChildRunIndex(transcriptStatesRows()).childRunEntries();

    expect(entries).toHaveLength(1);
    expect(entries[0]?.summary.runId).toBe(RUN_ARCHITECT_CHILD);
    // The compaction inside the child is what makes the count a floor, and it is the
    // one incompleteness cause a log can state on its own.
    expect(entries[0]?.summary.completeness.state).toBe("incomplete");
    // Anchored at the birth row and re-summarized nowhere: the child's later rows say
    // nothing about a parent, so filing them as re-summarizations would be a claim the
    // wire did not make.
    expect(entries[0]?.resummarizedRowIds).toStrictEqual([]);
  });

  it("draws the subagent's start as a handoff and suppresses its completion", () => {
    const rows = transcriptStatesRows();
    const handoffs = new ChildRunIndex(rows).handoffEntries();
    const subagentRowIds = rows
      .filter((row) => row.type.startsWith("subagent."))
      .map((row) => row.id);

    // Both halves are in the log, and exactly one of them draws a card: the anchor is
    // first-wins, so a completion, a resume, or a compaction inside the child all
    // leave the handoff where the start put it.
    expect(subagentRowIds).toHaveLength(2);
    const subagentHandoffs = handoffs.filter((handoff) => subagentRowIds.includes(handoff.rowId));
    expect(subagentHandoffs).toHaveLength(1);
    expect(subagentHandoffs[0]?.wireType).toBe("subagent.started");
    expect(subagentHandoffs[0]?.rowId).toBe(subagentRowIds[0]);
    // Four in all: the three agent attachments this session always carried, each
    // naming no subagent identity and so anchored by nothing, plus the one anchor the
    // pair above draws. The attachments are why a handoff row was reachable from this
    // scenario before it carried a subagent — what was not reachable was suppression.
    expect(handoffs).toHaveLength(4);
  });

  it("names the subagent's identity, without which the pair could not be keyed", () => {
    // The whole reason the completion is suppressed rather than drawn beside the
    // start: both rows carry the same `(runId, provider, subagentId)` triple. A pair
    // missing the provider or the id is two unrelated handoffs, which is what this
    // scenario used to script.
    const subagentPayloads = TRANSCRIPT_STATES_SCENARIO.beats
      .filter((beat) => beat.event.kind.startsWith("subagent."))
      .map((beat) => beat.event.payload);

    expect(subagentPayloads).toHaveLength(2);
    for (const payload of subagentPayloads) {
      expect(payload?.["subagentId"]).toBe(SUBAGENT_REVIEWER);
      expect(typeof payload?.["provider"]).toBe("string");
    }
  });

  it("folds a superseded band over the rows the rewind left behind", () => {
    const bands = deriveSupersededBands(transcriptStatesRows());

    expect(bands).toHaveLength(1);
    expect(bands[0]?.runId).toBe(RUN_IMPLEMENTER);
    // The band is the rewound run's FIRST epoch — the boundary belongs to the epoch it
    // ended — and it holds the rows whose position exceeds the cutoff the wire named.
    expect(bands[0]?.epoch).toBe(0);
    expect(bands[0]?.rowIds.length).toBeGreaterThan(0);
  });
});
