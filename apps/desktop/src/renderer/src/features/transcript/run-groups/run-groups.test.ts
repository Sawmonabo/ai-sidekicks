// The run group fold, held to what `run-groups.ts` must never do. Each rule fails silently (a
// heuristic grouping or a collapsed live run group still renders).

import { describe, expect, it } from "vitest";

import { groupRowsByRun } from "./run-groups.js";
import { findRunGroup, mixedWindow } from "./run-groups.test-support.js";
import { runRow } from "../transcript-event-rows.test-support.js";

describe("run groups — rows join a run group by runId and by nothing else", () => {
  it("groups each run's rows and leaves an unattributed row out of every run group", () => {
    const runGroups = groupRowsByRun(mixedWindow());
    expect(runGroups.map((runGroup) => runGroup.runId)).toStrictEqual(["run-a", "run-b"]);
    expect(findRunGroup(runGroups, "run-a").rowIds).toStrictEqual(["a1", "a2"]);
  });

  it("keeps each run group's rows in the order the log delivered them", () => {
    const runGroups = groupRowsByRun([
      runRow({ id: "a2", sequence: 9, type: "run.running", runId: "run-a", position: 2 }),
      runRow({ id: "a1", sequence: 4, type: "run.queued", runId: "run-a", position: 1 }),
    ]);
    // Delivery order, not sequence order: the fold partitions and leaves the ordering to
    // whatever handed it the window.
    expect(findRunGroup(runGroups, "run-a").rowIds).toStrictEqual(["a2", "a1"]);
  });
});

describe("run groups — what makes a run group terminal", () => {
  it("reads the terminal from the run's own event type, verbatim", () => {
    const runGroups = groupRowsByRun(mixedWindow());
    expect(findRunGroup(runGroups, "run-a").lifecycle).toBe("live");
    expect(findRunGroup(runGroups, "run-b").lifecycle).toBe("terminal");
  });

  it("a rewind is not a terminal", () => {
    // `run.rolled_back` is a forward, non-state event: the run continues from the boundary. A
    // fold treating any run-lifecycle row as an ending would fold this run group.
    const runGroups = groupRowsByRun([
      runRow({ id: "a1", sequence: 1, type: "run.queued", runId: "run-a", position: 1 }),
      runRow({ id: "a2", sequence: 2, type: "run.rolled_back", runId: "run-a", position: 2 }),
    ]);
    expect(findRunGroup(runGroups, "run-a").lifecycle).toBe("live");
  });

  it("reopens a run group the run came back from", () => {
    // A rollback accepted from a finished run appends a pause and a rewind before it resumes.
    // An accumulator that only set the terminal would keep the completion, leaving the run
    // group folded with rows hidden behind a receipt for an ending that had been undone.
    const runGroups = groupRowsByRun([
      runRow({ id: "a1", sequence: 1, type: "run.queued", runId: "run-a", position: 1 }),
      runRow({ id: "a2", sequence: 2, type: "run.completed", runId: "run-a", position: 2 }),
      runRow({ id: "a3", sequence: 3, type: "run.paused", runId: "run-a", position: 3 }),
      runRow({ id: "a4", sequence: 4, type: "run.rolled_back", runId: "run-a", position: 4 }),
      runRow({ id: "a5", sequence: 5, type: "run.running", runId: "run-a", position: 5 }),
    ]);

    const runGroup = findRunGroup(runGroups, "run-a");
    expect(runGroup.lifecycle).toBe("live");
    // The receipt goes with it: that row ends nothing now.
    expect(runGroup.terminalRowId).toBeUndefined();
  });

  it("seals a reopened run group again at its next ending", () => {
    // A run that came back and then failed is finished, and its header names the second ending.
    const runGroups = groupRowsByRun([
      runRow({ id: "a1", sequence: 1, type: "run.completed", runId: "run-a", position: 1 }),
      runRow({ id: "a2", sequence: 2, type: "run.rolled_back", runId: "run-a", position: 2 }),
      runRow({ id: "a3", sequence: 3, type: "run.failed", runId: "run-a", position: 3 }),
    ]);

    const runGroup = findRunGroup(runGroups, "run-a");
    expect(runGroup.lifecycle).toBe("terminal");
    expect(runGroup.terminalRowId).toBe("a3");
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
    ]);
    expect(findRunGroup(runGroups, "run-d").payingAccountId).toBe(undefined);
  });
});
