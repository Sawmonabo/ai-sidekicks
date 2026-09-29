// The run group fold, held to the three things `run-groups.ts` says it must never do.
//
// Each case below pins a rule whose violation is SILENT: a heuristic grouping
// still renders run groups, a re-ordered fold still renders rows, and a collapsed
// live run group still renders a header. Nothing goes red on its own, which is why
// each clean assertion here is paired with a negative control that fails when the
// rule is removed.

import { describe, expect, it } from "vitest";

import { RunGroupIndex, groupRowsByRun } from "./run-groups.js";
import { findRunGroup, mixedWindow } from "./run-groups.test-support.js";
import { generalRow, runRow } from "../timeline-rows.test-support.js";

describe("run groups — rows join a run group by runId and by nothing else", () => {
  it("groups each run's rows and leaves an unattributed row out of every run group", () => {
    const fold = groupRowsByRun(mixedWindow());
    expect(fold.runGroups.map((runGroup) => runGroup.runId)).toStrictEqual(["run-a", "run-b"]);
    expect(findRunGroup(fold.runGroups, "run-a").rowIds).toStrictEqual(["a1", "a2"]);
    expect(fold.ungroupedRowIds).toStrictEqual(["s1"]);
  });

  it("negative control: a window of only unattributed rows produces no run group at all", () => {
    // The case above would pass over a fold that swept every row into one run group
    // by proximity — this one would not, because there is no run to sweep them
    // into and a heuristic fold would have to invent one.
    const fold = groupRowsByRun([
      generalRow({ id: "s1", sequence: 1, type: "session.renamed", category: "session_lifecycle" }),
      generalRow({ id: "s2", sequence: 2, type: "session.notice", category: "session_lifecycle" }),
    ]);
    expect(fold.runGroups).toStrictEqual([]);
    expect(fold.ungroupedRowIds).toStrictEqual(["s1", "s2"]);
  });

  it("keeps each run group's rows in the order the log delivered them", () => {
    const fold = groupRowsByRun([
      runRow({ id: "a2", sequence: 9, type: "run.running", runId: "run-a", position: 2 }),
      runRow({ id: "a1", sequence: 4, type: "run.queued", runId: "run-a", position: 1 }),
    ]);
    // Delivery order, not sequence order: the fold never re-orders rows, so the
    // fold partitions and leaves the ordering to whatever handed it the window.
    expect(findRunGroup(fold.runGroups, "run-a").rowIds).toStrictEqual(["a2", "a1"]);
    expect(findRunGroup(fold.runGroups, "run-a").firstSequence).toBe(4);
    expect(findRunGroup(fold.runGroups, "run-a").lastSequence).toBe(9);
  });
});

describe("run groups — what makes a run group terminal", () => {
  it("reads the terminal from the run's own event type, verbatim", () => {
    const fold = groupRowsByRun(mixedWindow());
    expect(findRunGroup(fold.runGroups, "run-a").lifecycle).toBe("live");
    expect(findRunGroup(fold.runGroups, "run-b").lifecycle).toBe("terminal");
    expect(findRunGroup(fold.runGroups, "run-b").terminalEventType).toBe("run.completed");
  });

  it("negative control: a rewind is not a terminal", () => {
    // `run.rolled_back` is a forward, non-state event — the run continues from the
    // boundary. A fold that treated any run-lifecycle row as an ending would fold
    // this run group and stop showing what happened after the rewind.
    const fold = groupRowsByRun([
      runRow({ id: "a1", sequence: 1, type: "run.queued", runId: "run-a", position: 1 }),
      runRow({ id: "a2", sequence: 2, type: "run.rolled_back", runId: "run-a", position: 2 }),
    ]);
    expect(findRunGroup(fold.runGroups, "run-a").lifecycle).toBe("live");
  });

  it("reopens a run group the run came back from", () => {
    // A rollback accepted from a finished run appends a pause and a rewind for that
    // same run before it can resume. An accumulator that only ever SET the terminal
    // kept the completion forever: the run group stayed folded by default, its header
    // went on reading "Completed", and every row appended after the rewind was
    // hidden behind a receipt for an ending that had been undone.
    const fold = groupRowsByRun([
      runRow({ id: "a1", sequence: 1, type: "run.queued", runId: "run-a", position: 1 }),
      runRow({ id: "a2", sequence: 2, type: "run.completed", runId: "run-a", position: 2 }),
      runRow({ id: "a3", sequence: 3, type: "run.paused", runId: "run-a", position: 3 }),
      runRow({ id: "a4", sequence: 4, type: "run.rolled_back", runId: "run-a", position: 4 }),
      runRow({ id: "a5", sequence: 5, type: "run.running", runId: "run-a", position: 5 }),
    ]);

    const runGroup = findRunGroup(fold.runGroups, "run-a");
    expect(runGroup.lifecycle).toBe("live");
    expect(runGroup.terminalEventType).toBeUndefined();
    // And the receipt goes with it: a folded run group renders its header and the row
    // that ended it, and that row no longer ends anything.
    expect(runGroup.terminalRowId).toBeUndefined();
  });

  it("seals a reopened run group again at its next ending", () => {
    // The clearing is not final either. A run that came back and then
    // failed is a finished run, and its header says which ending it reached — the
    // second one.
    const fold = groupRowsByRun([
      runRow({ id: "a1", sequence: 1, type: "run.completed", runId: "run-a", position: 1 }),
      runRow({ id: "a2", sequence: 2, type: "run.rolled_back", runId: "run-a", position: 2 }),
      runRow({ id: "a3", sequence: 3, type: "run.failed", runId: "run-a", position: 3 }),
    ]);

    const runGroup = findRunGroup(fold.runGroups, "run-a");
    expect(runGroup.lifecycle).toBe("terminal");
    expect(runGroup.terminalEventType).toBe("run.failed");
    expect(runGroup.terminalRowId).toBe("a3");
  });

  it("negative control: an ordinary teardown after an ending reopens nothing", () => {
    // Without this the two cases above would pass over a fold that cleared the
    // terminal on any later run row at all — and a worker shutting down after a
    // completion says nothing about the run's state, so a run group that went live
    // again there would unfold every finished run in the session.
    const fold = groupRowsByRun([
      runRow({ id: "a1", sequence: 1, type: "run.completed", runId: "run-a", position: 1 }),
      runRow({ id: "a2", sequence: 2, type: "run.worker_shutdown", runId: "run-a", position: 2 }),
    ]);

    const runGroup = findRunGroup(fold.runGroups, "run-a");
    expect(runGroup.lifecycle).toBe("terminal");
    expect(runGroup.terminalEventType).toBe("run.completed");
  });

  it("marks a run group whose child expand is incomplete", () => {
    const fold = groupRowsByRun([
      runRow({
        id: "a1",
        sequence: 1,
        type: "run.queued",
        runId: "run-a",
        position: 1,
        childRun: { completeness: "incomplete" },
      }),
    ]);
    expect(findRunGroup(fold.runGroups, "run-a").hasIncompleteChildExpand).toBe(true);
  });

  it("clears the marker when a later row summarizes that same child as complete", () => {
    // The card beside this header already replaces its summary with the latest reading,
    // so an accumulated marker left the header claiming a child was not fully expanded
    // beside a card saying its summary was complete — permanently, because no later row
    // could ever clear a monotonic flag.
    const fold = groupRowsByRun([
      runRow({
        id: "a1",
        sequence: 1,
        type: "run.queued",
        runId: "run-a",
        position: 1,
        childRun: { completeness: "incomplete" },
      }),
      runRow({
        id: "a2",
        sequence: 2,
        type: "subagent.completed",
        runId: "run-a",
        position: 2,
        childRun: { completeness: "complete" },
      }),
    ]);
    expect(findRunGroup(fold.runGroups, "run-a").hasIncompleteChildExpand).toBe(false);
  });

  it("marks it again when the latest reading of that child is the incomplete one", () => {
    // Row ORDER decides, not the set of readings: the same two observations the other
    // way round leave the child partly expanded, and a fold that took the last row it
    // liked rather than the last row would answer both cases the same way.
    const fold = groupRowsByRun([
      runRow({
        id: "a1",
        sequence: 1,
        type: "subagent.completed",
        runId: "run-a",
        position: 1,
        childRun: { completeness: "complete" },
      }),
      runRow({
        id: "a2",
        sequence: 2,
        type: "run.queued",
        runId: "run-a",
        position: 2,
        childRun: { completeness: "incomplete" },
      }),
    ]);
    expect(findRunGroup(fold.runGroups, "run-a").hasIncompleteChildExpand).toBe(true);
  });

  it("marks a run group while ANY of its children is still incomplete", () => {
    // Per child rather than per run group: one child completing says nothing about
    // another, so a fold holding one reading for the whole run group would clear the
    // marker the moment either child finished.
    const fold = groupRowsByRun([
      runRow({
        id: "a1",
        sequence: 1,
        type: "run.queued",
        runId: "run-a",
        position: 1,
        childRun: { childRunId: "run-child-1", completeness: "complete" },
      }),
      runRow({
        id: "a2",
        sequence: 2,
        type: "run.queued",
        runId: "run-a",
        position: 2,
        childRun: { childRunId: "run-child-2", completeness: "incomplete" },
      }),
    ]);
    expect(findRunGroup(fold.runGroups, "run-a").hasIncompleteChildExpand).toBe(true);
  });

  it("negative control: a run group with no child summary is not marked", () => {
    const fold = groupRowsByRun(mixedWindow());
    expect(findRunGroup(fold.runGroups, "run-a").hasIncompleteChildExpand).toBe(false);
  });
});

describe("run groups — the index folds once and answers from the fold", () => {
  it("returns the same run group objects on repeated reads", () => {
    const index = new RunGroupIndex(mixedWindow());
    expect(index.runGroups()).toBe(index.runGroups());
    expect(index.runGroupFor("run-b")).toBe(findRunGroup(index.runGroups(), "run-b"));
  });

  it("negative control: a fresh fold builds fresh objects", () => {
    // The case above would pass over a class that re-folded and happened to return
    // deep-equal values; `toBe` is identity, and this shows the identity claim is
    // about the CACHE rather than about the fold being pure.
    const rows = mixedWindow();
    expect(groupRowsByRun(rows).runGroups).not.toBe(groupRowsByRun(rows).runGroups);
  });

  it("names only the finished run groups as collapsible", () => {
    const index = new RunGroupIndex(mixedWindow());
    expect(index.terminalRunGroups().map((runGroup) => runGroup.runId)).toStrictEqual(["run-b"]);
  });
});

describe("the run state — the daemon's newest word, and nothing after a rewind", () => {
  it("carries the newest state a run reported, not only the one that ended it", () => {
    const fold = groupRowsByRun(mixedWindow());
    expect(findRunGroup(fold.runGroups, "run-a").runStateEventType).toBe("run.running");
    expect(findRunGroup(fold.runGroups, "run-b").runStateEventType).toBe("run.completed");
  });

  it("negative control: a live run group used to have no state to say at all", () => {
    // The header drew `terminalEventType`, which is undefined for every run that has
    // not ended — so this is the member that makes a live run group's line non-empty.
    expect(findRunGroup(groupRowsByRun(mixedWindow()).runGroups, "run-a").terminalEventType).toBe(
      undefined,
    );
  });

  it("clears the state on a rewind, because a rewind does not say what it came back into", () => {
    const fold = groupRowsByRun([
      runRow({ id: "c1", sequence: 1, type: "run.completed", runId: "run-c", position: 1 }),
      runRow({ id: "c2", sequence: 2, type: "run.rolled_back", runId: "run-c", position: 2 }),
    ]);
    const runGroup = findRunGroup(fold.runGroups, "run-c");
    expect(runGroup.lifecycle).toBe("live");
    expect(runGroup.runStateEventType).toBe(undefined);
  });

  it("takes the run's next state after the rewind, verbatim", () => {
    const fold = groupRowsByRun([
      runRow({ id: "c1", sequence: 1, type: "run.completed", runId: "run-c", position: 1 }),
      runRow({ id: "c2", sequence: 2, type: "run.rolled_back", runId: "run-c", position: 2 }),
      runRow({ id: "c3", sequence: 3, type: "run.running", runId: "run-c", position: 3 }),
    ]);
    expect(findRunGroup(fold.runGroups, "run-c").runStateEventType).toBe("run.running");
  });
});

describe("the paying account — read off the admission row and never composed", () => {
  it("carries the account the run was admitted under", () => {
    const fold = groupRowsByRun([
      runRow({
        id: "d1",
        sequence: 1,
        type: "run.queued",
        runId: "run-d",
        position: 1,
        payload: { admittedProviderAccountId: "acct-7" },
      }),
      runRow({ id: "d2", sequence: 2, type: "run.running", runId: "run-d", position: 2 }),
    ]);
    expect(findRunGroup(fold.runGroups, "run-d").payingAccountId).toBe("acct-7");
  });

  it("holds the FIRST naming, so a run never changes who pays for it mid-flight", () => {
    const fold = groupRowsByRun([
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
    expect(findRunGroup(fold.runGroups, "run-d").payingAccountId).toBe("acct-7");
  });

  it("reads a wrongly-typed member as an absence rather than coercing it", () => {
    const fold = groupRowsByRun([
      runRow({
        id: "d1",
        sequence: 1,
        type: "run.queued",
        runId: "run-d",
        position: 1,
        payload: { admittedProviderAccountId: 7 },
      }),
    ]);
    expect(findRunGroup(fold.runGroups, "run-d").payingAccountId).toBe(undefined);
  });
});
