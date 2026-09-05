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
import { generalRow, legacyStubRow, runRow } from "./timeline-rows.test-support.js";

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
