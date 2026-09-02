// The chapter fold, held to the three things §5.2 says it must never do.
//
// Each case below pins a rule whose violation is SILENT: a heuristic grouping
// still renders chapters, a re-ordered fold still renders rows, and a collapsed
// live chapter still renders a header. Nothing goes red on its own, which is why
// each clean assertion here is paired with a negative control that fails when the
// rule is removed.

import type { TimelineRow } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import {
  ChapterCollapseState,
  LedgerChapterIndex,
  foldChapters,
  type ChapterAutoCollapseObservation,
  type LedgerChapter,
} from "./chapters.js";
import { generalRow, legacyStubRow, runRow } from "./row-fixtures.js";

/** One live run, one finished run, and a session row belonging to neither. */
function mixedWindow(): readonly TimelineRow[] {
  return [
    runRow({
      id: "a1",
      sequence: 1,
      type: "run.queued",
      runId: "run-a",
      position: 1,
      actor: "agent-one",
    }),
    generalRow({ id: "s1", sequence: 2, type: "session.renamed", category: "session_lifecycle" }),
    runRow({
      id: "b1",
      sequence: 3,
      type: "run.queued",
      runId: "run-b",
      position: 1,
      actor: "agent-two",
    }),
    runRow({ id: "a2", sequence: 4, type: "run.running", runId: "run-a", position: 2 }),
    runRow({ id: "b2", sequence: 5, type: "run.completed", runId: "run-b", position: 2 }),
  ];
}

function chapterFor(chapters: readonly LedgerChapter[], runId: string): LedgerChapter {
  const chapter = chapters.find((candidate) => candidate.runId === runId);
  if (chapter === undefined) {
    throw new Error(`no chapter for ${runId}`);
  }
  return chapter;
}

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
    // Delivery order, not sequence order: §5.2 forbids re-ordering rows, so the
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

describe("chapters — collapse state never folds the live chapter", () => {
  const live = chapterFor(foldChapters(mixedWindow()).chapters, "run-a");
  const terminal = chapterFor(foldChapters(mixedWindow()).chapters, "run-b");

  it("reports the live chapter open and the terminal chapter folded, before anything is clicked", () => {
    const state = new ChapterCollapseState();
    expect(state.isOpen(live)).toBe(true);
    expect(state.isOpen(terminal)).toBe(false);
  });

  it("negative control: closing the live chapter changes nothing", () => {
    // Without the live arm answering first, `close` would remove it from the open
    // set and the next `isOpen` would report a live chapter folded.
    const state = new ChapterCollapseState();
    expect(state.close(live)).toBe(false);
    expect(state.isOpen(live)).toBe(true);
  });

  it("opens a folded chapter and keeps it open until it is closed", () => {
    const state = new ChapterCollapseState();
    state.open(terminal);
    expect(state.isOpen(terminal)).toBe(true);
    expect(state.close(terminal)).toBe(true);
    expect(state.isOpen(terminal)).toBe(false);
  });

  it("collapses every terminal chapter and reports how many it folded", () => {
    const state = new ChapterCollapseState();
    state.open(terminal);
    expect(state.collapseAllTerminal([live, terminal])).toBe(1);
    expect(state.openedTerminalRunIds.size).toBe(0);
  });
});

describe("chapters — auto-collapse is conjunctive on four conditions", () => {
  const terminal = chapterFor(foldChapters(mixedWindow()).chapters, "run-b");
  const live = chapterFor(foldChapters(mixedWindow()).chapters, "run-a");

  function openedState(): ChapterCollapseState {
    const state = new ChapterCollapseState();
    state.open(terminal);
    return state;
  }

  it("folds a terminal chapter that is off screen, freshly measured, and unengaged", () => {
    const state = openedState();
    expect(
      state.autoCollapse(terminal, {
        isOffScreen: true,
        hasFreshGeometrySample: true,
        isEngaged: false,
      }),
    ).toBe(true);
  });

  // Three negative controls, one per conjunct. Each drops exactly one condition
  // from the folding case above, so a rule that had quietly become a disjunction
  // fails here rather than folding a chapter somebody is reading.
  function refuses(observation: ChapterAutoCollapseObservation): void {
    const state = openedState();
    expect(state.autoCollapse(terminal, observation)).toBe(false);
    expect(state.isOpen(terminal)).toBe(true);
  }

  it("negative control: refuses to fold a chapter that is on screen", () => {
    refuses({ isOffScreen: false, hasFreshGeometrySample: true, isEngaged: false });
  });

  it("negative control: refuses to fold on geometry measured before the pane was hidden", () => {
    refuses({ isOffScreen: true, hasFreshGeometrySample: false, isEngaged: false });
  });

  it("negative control: refuses to fold a chapter that is engaged", () => {
    refuses({ isOffScreen: true, hasFreshGeometrySample: true, isEngaged: true });
  });

  it("never auto-collapses the live chapter, whatever the geometry says", () => {
    const state = openedState();
    expect(
      state.autoCollapse(live, {
        isOffScreen: true,
        hasFreshGeometrySample: true,
        isEngaged: false,
      }),
    ).toBe(false);
  });
});
