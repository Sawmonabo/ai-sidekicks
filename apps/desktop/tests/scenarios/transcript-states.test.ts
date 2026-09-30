// What the transcript-states scenario claims, played through the transcript's own readers: the
// three lanes end in three different conditions and the rewind boundary is followed by rows it
// supersedes. A scenario that lost either would leave a view untested and green. Whether each
// beat is one a daemon can emit is the catalog-wide contract check's question.

import { describe, expect, it } from "vitest";
import {
  TRANSCRIPT_STATES_SCENARIO,
  RUN_ARCHITECT_CHILD,
  RUN_IMPLEMENTER,
  SUBAGENT_REVIEWER,
} from "../../fixtures/scenarios/transcript-states.js";
import type { Scenario, ScenarioBeat } from "../../fixtures/scenario.js";
// The transcript's own readers, reached deeply rather than through the feature's entry, since
// this claim is about what the scenario reaches.
import { projectTranscriptRows } from "@renderer/features/transcript/projection/transcript-row-projection.js";
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
function finalRunStates(scenario: Scenario): ReadonlyMap<string, string> {
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
    // `session.list` reads like a real method, but the registry carries `session.read` and no
    // list verb; a scripted answer would put a call in front of a view with nowhere to send it.
    const calls = TRANSCRIPT_STATES_SCENARIO.replies.map((reply) => reply.call);
    expect(calls).not.toContain("session.list");
    expect(calls).toContain("session.read");
  });
});

/** Every row this scenario's whole script projects to, in log order. */
function transcriptStatesRows(): ReturnType<typeof projectTranscriptRows>["rows"] {
  return projectTranscriptRows(TRANSCRIPT_STATES_SCENARIO.beats.map((beat) => beat.event)).rows;
}

describe("the three lanes", () => {
  it("ends its three LANES in three different conditions at once", () => {
    // The child run under the architect is a fourth run, not a fourth lane: the transcript folds
    // it into its parent's run group, so it is subtracted here.
    const laneStates = [...finalRunStates(TRANSCRIPT_STATES_SCENARIO)]
      .filter(([runId]) => runId !== RUN_ARCHITECT_CHILD)
      .map(([, state]) => state)
      .sort();
    expect(laneStates).toStrictEqual(["completed", "paused", "running"]);
  });

  it("waits for approval and returns through `run.running`", () => {
    const kinds = TRANSCRIPT_STATES_SCENARIO.beats.map((beat) => beat.event.kind);
    expect(kinds).toContain("run.waiting_for_approval");
    expect(kinds.lastIndexOf("run.running")).toBeGreaterThan(
      kinds.indexOf("run.waiting_for_approval"),
    );
  });

  it("plays the compaction and rollback seams and a paused run", () => {
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
    // The band is measured against the target position the boundary carries.
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
  it("summarizes the architect's child run as whole across its compaction", () => {
    const entries = new ChildRunIndex(transcriptStatesRows()).childRunEntries();

    expect(entries).toHaveLength(1);
    expect(entries[0]?.summary.runId).toBe(RUN_ARCHITECT_CHILD);
    // The compaction inside the child folds the provider's context, not the log, so all its rows
    // are still there to count.
    expect(entries[0]?.summary.completeness.state).toBe("complete");
    // Anchored at the birth row and re-summarized nowhere: the child's later rows say nothing
    // about a parent.
    expect(entries[0]?.resummarizedRowIds).toStrictEqual([]);
  });

  it("draws the subagent's start as a handoff and suppresses its completion", () => {
    const rows = transcriptStatesRows();
    const handoffs = new ChildRunIndex(rows).handoffEntries();
    const subagentRowIds = rows
      .filter((row) => row.type.startsWith("subagent."))
      .map((row) => row.id);

    // Both halves are in the log and exactly one draws a card: the anchor is first-wins, so a
    // completion, resume or compaction leaves the handoff where the start put it.
    expect(subagentRowIds).toHaveLength(2);
    const subagentHandoffs = handoffs.filter((handoff) => subagentRowIds.includes(handoff.rowId));
    expect(subagentHandoffs).toHaveLength(1);
    expect(subagentHandoffs[0]?.wireType).toBe("subagent.started");
    expect(subagentHandoffs[0]?.rowId).toBe(subagentRowIds[0]);
    // One in all: the anchor above, and nothing else in the log is a handoff.
    expect(handoffs).toHaveLength(1);
  });

  it("names the subagent's identity, without which the pair could not be keyed", () => {
    // The completion is suppressed rather than drawn beside the start because both rows carry the
    // same `(runId, provider, subagentId)` triple; a pair missing the provider or the id is two
    // unrelated handoffs.
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
    // The band is the rewound run's first epoch (the boundary belongs to the epoch it ended) and
    // holds the rows past the cutoff the wire named.
    expect(bands[0]?.epoch).toBe(0);
    expect(bands[0]?.rowIds.length).toBeGreaterThan(0);
  });
});
