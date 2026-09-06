// The chapter fold, held to the three things `chapters.ts` says it must never do.
//
// Each case below pins a rule whose violation is SILENT: a heuristic grouping
// still renders chapters, a re-ordered fold still renders rows, and a collapsed
// live chapter still renders a header. Nothing goes red on its own, which is why
// each clean assertion here is paired with a negative control that fails when the
// rule is removed.

import { describe, expect, it } from "vitest";

import { LedgerChapterIndex, foldChapters } from "./chapters.js";
import { chapterFor, mixedWindow } from "./chapters.test-support.js";
import { generalRow, legacyStubRow, runRow } from "../timeline-rows.test-support.js";

describe("chapters — rows join a chapter by runId and by nothing else", () => {
  it("groups each run's rows and leaves an unattributed row out of every chapter", () => {
    const fold = foldChapters(mixedWindow());
    expect(fold.chapters.map((chapter) => chapter.runId)).toStrictEqual(["run-a", "run-b"]);
    expect(chapterFor(fold.chapters, "run-a").rowIds).toStrictEqual(["a1", "a2"]);
    expect(fold.unchapteredRowIds).toStrictEqual(["s1"]);
  });

  it("negative control: a window of only unattributed rows produces no chapter at all", () => {
    // The case above would pass over a fold that swept every row into one chapter
    // by proximity — this one would not, because there is no run to sweep them
    // into and a heuristic fold would have to invent one.
    const fold = foldChapters([
      generalRow({ id: "s1", sequence: 1, type: "session.renamed", category: "session_lifecycle" }),
      generalRow({ id: "s2", sequence: 2, type: "session.notice", category: "session_lifecycle" }),
    ]);
    expect(fold.chapters).toStrictEqual([]);
    expect(fold.unchapteredRowIds).toStrictEqual(["s1", "s2"]);
  });

  it("keeps each chapter's rows in the order the log delivered them", () => {
    const fold = foldChapters([
      runRow({ id: "a2", sequence: 9, type: "run.running", runId: "run-a", position: 2 }),
      runRow({ id: "a1", sequence: 4, type: "run.queued", runId: "run-a", position: 1 }),
    ]);
    // Delivery order, not sequence order: the fold never re-orders rows, so the
    // fold partitions and leaves the ordering to whatever handed it the window.
    expect(chapterFor(fold.chapters, "run-a").rowIds).toStrictEqual(["a2", "a1"]);
    expect(chapterFor(fold.chapters, "run-a").firstSequence).toBe(4);
    expect(chapterFor(fold.chapters, "run-a").lastSequence).toBe(9);
  });
});

describe("chapters — what makes a chapter terminal", () => {
  it("reads the terminal from the run's own event type, verbatim", () => {
    const fold = foldChapters(mixedWindow());
    expect(chapterFor(fold.chapters, "run-a").lifecycle).toBe("live");
    expect(chapterFor(fold.chapters, "run-b").lifecycle).toBe("terminal");
    expect(chapterFor(fold.chapters, "run-b").terminalEventType).toBe("run.completed");
  });

  it("negative control: a rewind is not a terminal", () => {
    // `run.rolled_back` is a forward, non-state event — the run continues from the
    // boundary. A fold that treated any run-lifecycle row as an ending would fold
    // this chapter and stop showing what happened after the rewind.
    const fold = foldChapters([
      runRow({ id: "a1", sequence: 1, type: "run.queued", runId: "run-a", position: 1 }),
      runRow({ id: "a2", sequence: 2, type: "run.rolled_back", runId: "run-a", position: 2 }),
    ]);
    expect(chapterFor(fold.chapters, "run-a").lifecycle).toBe("live");
  });

  it("reopens a chapter the run came back from", () => {
    // A rollback accepted from a finished run appends a pause and a rewind for that
    // same run before it can resume. An accumulator that only ever SET the terminal
    // kept the completion forever: the chapter stayed folded by default, its header
    // went on reading "Completed", and every row appended after the rewind was
    // hidden behind a receipt for an ending that had been undone.
    const fold = foldChapters([
      runRow({ id: "a1", sequence: 1, type: "run.queued", runId: "run-a", position: 1 }),
      runRow({ id: "a2", sequence: 2, type: "run.completed", runId: "run-a", position: 2 }),
      runRow({ id: "a3", sequence: 3, type: "run.paused", runId: "run-a", position: 3 }),
      runRow({ id: "a4", sequence: 4, type: "run.rolled_back", runId: "run-a", position: 4 }),
      runRow({ id: "a5", sequence: 5, type: "run.running", runId: "run-a", position: 5 }),
    ]);

    const chapter = chapterFor(fold.chapters, "run-a");
    expect(chapter.lifecycle).toBe("live");
    expect(chapter.terminalEventType).toBeUndefined();
    // And the receipt goes with it: a folded chapter renders its header and the row
    // that ended it, and that row no longer ends anything.
    expect(chapter.terminalRowId).toBeUndefined();
  });

  it("seals a reopened chapter again at its next ending", () => {
    // The clearing is not a one-way door either. A run that came back and then
    // failed is a finished run, and its header says which ending it reached — the
    // second one.
    const fold = foldChapters([
      runRow({ id: "a1", sequence: 1, type: "run.completed", runId: "run-a", position: 1 }),
      runRow({ id: "a2", sequence: 2, type: "run.rolled_back", runId: "run-a", position: 2 }),
      runRow({ id: "a3", sequence: 3, type: "run.failed", runId: "run-a", position: 3 }),
    ]);

    const chapter = chapterFor(fold.chapters, "run-a");
    expect(chapter.lifecycle).toBe("terminal");
    expect(chapter.terminalEventType).toBe("run.failed");
    expect(chapter.terminalRowId).toBe("a3");
  });

  it("negative control: an ordinary teardown after an ending reopens nothing", () => {
    // Without this the two cases above would pass over a fold that cleared the
    // terminal on any later run row at all — and a worker shutting down after a
    // completion says nothing about the run's state, so a chapter that went live
    // again there would unfold every finished run in the session.
    const fold = foldChapters([
      runRow({ id: "a1", sequence: 1, type: "run.completed", runId: "run-a", position: 1 }),
      runRow({ id: "a2", sequence: 2, type: "run.worker_shutdown", runId: "run-a", position: 2 }),
    ]);

    const chapter = chapterFor(fold.chapters, "run-a");
    expect(chapter.lifecycle).toBe("terminal");
    expect(chapter.terminalEventType).toBe("run.completed");
  });

  it("marks a chapter whose child expand is incomplete", () => {
    const fold = foldChapters([
      runRow({
        id: "a1",
        sequence: 1,
        type: "run.queued",
        runId: "run-a",
        position: 1,
        childRunIncomplete: true,
      }),
    ]);
    expect(chapterFor(fold.chapters, "run-a").hasIncompleteChildExpand).toBe(true);
  });

  it("negative control: a chapter with no child summary is not marked", () => {
    const fold = foldChapters(mixedWindow());
    expect(chapterFor(fold.chapters, "run-a").hasIncompleteChildExpand).toBe(false);
  });
});

describe("chapters — the index folds once and answers from the fold", () => {
  it("returns the same chapter objects on repeated reads", () => {
    const index = new LedgerChapterIndex(mixedWindow());
    expect(index.chapters()).toBe(index.chapters());
    expect(index.chapterFor("run-b")).toBe(chapterFor(index.chapters(), "run-b"));
  });

  it("negative control: a fresh fold builds fresh objects", () => {
    // The case above would pass over a class that re-folded and happened to return
    // deep-equal values; `toBe` is identity, and this shows the identity claim is
    // about the CACHE rather than about the fold being pure.
    const rows = mixedWindow();
    expect(foldChapters(rows).chapters).not.toBe(foldChapters(rows).chapters);
  });

  it("names only the finished chapters as collapsible", () => {
    const index = new LedgerChapterIndex(mixedWindow());
    expect(index.terminalChapters().map((chapter) => chapter.runId)).toStrictEqual(["run-b"]);
  });

  it("chapters a legacy stub by its preserved runId", () => {
    // The stub arm carries no position and no epoch but does carry `runId`, so it
    // belongs in its run's chapter and is never swept into the unattributed list.
    const fold = foldChapters([
      legacyStubRow({ id: "stub", sequence: 1, type: "event.compacted", runId: "run-c" }),
    ]);
    expect(chapterFor(fold.chapters, "run-c").rowIds).toStrictEqual(["stub"]);
  });
});
