// The run group fold, held to what `groups.ts` must never do. Each rule fails silently (a header
// standing over another run's rows, or a live run read as ended, still renders).

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";
import { describe, expect, it } from "vitest";

import { RunGroupIndex, groupRowsByRun } from "./groups.js";
import { findRunGroup, mixedWindow } from "./groups.test-support.js";
import { runGroupHeadingOf } from "./heading.js";
import { generalRow, runRow } from "../event-rows.test-support.js";

/** A call and its result of `runId`, the `call`th pair in the log from `sequence`. */
function callPair(runId: string, sequence: number): readonly TranscriptEventRow[] {
  return [
    runRow({
      id: `${runId}-call-${String(sequence)}`,
      sequence,
      type: "tool.invoked",
      runId,
      position: sequence,
    }),
    runRow({
      id: `${runId}-result-${String(sequence + 1)}`,
      sequence: sequence + 1,
      type: "tool.result",
      runId,
      position: sequence + 1,
    }),
  ];
}

/** The runs a fold of `rows` reads as not ended. */
function liveRunIdsOf(rows: readonly TranscriptEventRow[]): readonly string[] {
  const runGroupIndex = new RunGroupIndex();
  for (const row of rows) {
    runGroupIndex.admit(row, false);
  }
  return [...runGroupIndex.liveRunIds()];
}

describe("run groups — rows join a run group by runId and by nothing else", () => {
  it("groups each run's rows and leaves an unattributed row out of every run group", () => {
    // The session row draws no card and run b replies after run a's last card, so no run is
    // broken.
    const runGroups = groupRowsByRun(mixedWindow());
    expect(runGroups.map((runGroup) => runGroup.runId)).toStrictEqual(["run-a", "run-b"]);
    expect(findRunGroup(runGroups, "run-a").rowIds).toStrictEqual(["a1", "a2", "a3"]);
  });

  it("keeps each run group's rows in the order the log delivered them", () => {
    const runGroups = groupRowsByRun([
      runRow({ id: "a2", sequence: 9, type: "assistant.message", runId: "run-a", position: 2 }),
      runRow({ id: "a1", sequence: 4, type: "run.queued", runId: "run-a", position: 1 }),
    ]);
    // Delivery order, not sequence order: the fold partitions and leaves the ordering to
    // whatever handed it the window.
    expect(findRunGroup(runGroups, "run-a").rowIds).toStrictEqual(["a2", "a1"]);
  });
});

describe("run groups — one unbroken stretch of a run under each header", () => {
  it("goes on under a new header after another agent's reply, each counting its drawn rows", () => {
    const runGroups = groupRowsByRun([
      runRow({ id: "a-running", sequence: 1, type: "run.running", runId: "run-a", position: 1 }),
      ...callPair("run-a", 2),
      runRow({
        id: "b-reply",
        sequence: 4,
        type: "assistant.message",
        runId: "run-b",
        position: 1,
      }),
      ...callPair("run-a", 5),
      ...callPair("run-a", 7),
    ]);

    // The running row draws nothing, so the first header counts only its call and result.
    expect(
      runGroups.map((runGroup) => [runGroup.key, runGroupHeadingOf(runGroup).entryCount]),
    ).toStrictEqual([
      ["run-a:a-running", "2"],
      ["run-b:b-reply", "1"],
      ["run-a:run-a-call-5", "4"],
    ]);
    // Only the newest header says what the run is doing now.
    expect(runGroups.map((runGroup) => runGroup.runStateEventType)).toStrictEqual([
      undefined,
      undefined,
      "run.running",
    ]);
  });

  it("ends the stretch at a person's message, even one stamped with the run it steers", () => {
    const steer = runRow({
      id: "steer",
      sequence: 3,
      type: "user.message",
      runId: "run-a",
      position: 3,
    });
    const rows = [...callPair("run-a", 1), steer, ...callPair("run-a", 4)];
    const runGroupIndex = new RunGroupIndex();
    for (const row of rows) {
      runGroupIndex.admit(row, false);
    }

    expect(runGroupIndex.runGroups().map((runGroup) => runGroup.rowIds)).toStrictEqual([
      ["run-a-call-1", "run-a-result-2"],
      ["run-a-call-4", "run-a-result-5"],
    ]);
    expect(runGroupIndex.runGroupKeyByRowId().has("steer")).toBe(false);
  });

  it("lets a notification join the stretch it lands in, and one with no call before it stand alone", () => {
    const runGroups = groupRowsByRun([
      // Before the run has a call, so it stands on its own.
      generalRow({ id: "early-notice", sequence: 1, type: "usage.context_compacted" }),
      ...callPair("run-a", 2),
      generalRow({ id: "session-notice", sequence: 4, type: "usage.context_compacted" }),
      // Another run's notification is not run a's, so it neither joins nor breaks run a.
      runRow({
        id: "b-notice",
        sequence: 5,
        type: "usage.context_compacted",
        runId: "run-b",
        position: 1,
      }),
      ...callPair("run-a", 6),
    ]);

    expect(runGroups.map((runGroup) => runGroup.rowIds)).toStrictEqual([
      ["run-a-call-2", "run-a-result-3", "session-notice", "run-a-call-6", "run-a-result-7"],
    ]);
  });

  it("draws no header for a run with no card, and stands one at the card that arrives", () => {
    // Two runs start together: a header above run b's first row would stand over run a's call.
    const rows = [
      runRow({ id: "a-queued", sequence: 1, type: "run.queued", runId: "run-a", position: 1 }),
      runRow({ id: "b-queued", sequence: 2, type: "run.queued", runId: "run-b", position: 1 }),
      ...callPair("run-a", 3),
    ];
    expect(groupRowsByRun(rows).map((runGroup) => runGroup.runId)).toStrictEqual(["run-a"]);

    const runGroups = groupRowsByRun([...rows, ...callPair("run-b", 5)]);
    expect(runGroups.map((runGroup) => [runGroup.key, runGroup.headerRowId])).toStrictEqual([
      ["run-a:a-queued", "run-a-call-3"],
      ["run-b:b-queued", "run-b-call-5"],
    ]);
  });
});

describe("run groups — when a run has ended", () => {
  it("reads the terminal from the run's own event type, verbatim", () => {
    expect(liveRunIdsOf(mixedWindow())).toStrictEqual(["run-a"]);
  });

  it("a rewind is not a terminal", () => {
    // `run.rolled_back` is a forward, non-state event: the run continues from the boundary. A
    // fold treating any run-lifecycle row as an ending would let the window drop its rows.
    expect(
      liveRunIdsOf([
        runRow({ id: "a1", sequence: 1, type: "run.queued", runId: "run-a", position: 1 }),
        runRow({ id: "a2", sequence: 2, type: "run.rolled_back", runId: "run-a", position: 2 }),
      ]),
    ).toStrictEqual(["run-a"]);
  });

  it("reopens a run the run came back from, and ends it again at its next ending", () => {
    // A rollback accepted from a finished run appends a pause and a rewind before it resumes.
    // An accumulator that only set the terminal would keep the completion, reading the run as
    // ended after that ending had been undone.
    const reopened = [
      runRow({ id: "a1", sequence: 1, type: "run.queued", runId: "run-a", position: 1 }),
      runRow({ id: "a2", sequence: 2, type: "run.completed", runId: "run-a", position: 2 }),
      runRow({ id: "a3", sequence: 3, type: "run.paused", runId: "run-a", position: 3 }),
      runRow({ id: "a4", sequence: 4, type: "run.rolled_back", runId: "run-a", position: 4 }),
      runRow({ id: "a5", sequence: 5, type: "run.running", runId: "run-a", position: 5 }),
    ];
    expect(liveRunIdsOf(reopened)).toStrictEqual(["run-a"]);
    // A run that came back and then failed is finished.
    expect(
      liveRunIdsOf([
        ...reopened,
        runRow({ id: "a6", sequence: 6, type: "run.failed", runId: "run-a", position: 6 }),
      ]),
    ).toStrictEqual([]);
  });
});

describe("the paying account — read off the admission row and never composed", () => {
  it("holds the FIRST naming, so a run never changes who pays for it mid-flight", () => {
    const runGroups = groupRowsByRun([
      runRow({
        id: "d1",
        sequence: 1,
        type: "run.queued",
        runId: "run-d",
        position: 1,
        payload: { admittedProviderAccountId: "acct-7" },
      }),
      runRow({
        id: "d2",
        sequence: 2,
        type: "run.running",
        runId: "run-d",
        position: 2,
        payload: { admittedProviderAccountId: "acct-9" },
      }),
      runRow({ id: "d3", sequence: 3, type: "assistant.message", runId: "run-d", position: 3 }),
    ]);
    expect(findRunGroup(runGroups, "run-d").payingAccountId).toBe("acct-7");
  });

  it("reads a wrongly-typed member as an absence rather than coercing it", () => {
    const runGroups = groupRowsByRun([
      runRow({
        id: "d1",
        sequence: 1,
        type: "run.queued",
        runId: "run-d",
        position: 1,
        payload: { admittedProviderAccountId: 7 },
      }),
      runRow({ id: "d2", sequence: 2, type: "assistant.message", runId: "run-d", position: 2 }),
    ]);
    expect(findRunGroup(runGroups, "run-d").payingAccountId).toBe(undefined);
  });
});
