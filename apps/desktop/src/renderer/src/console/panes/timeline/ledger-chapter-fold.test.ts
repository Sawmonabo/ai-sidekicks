// The chapter fold, driven with no store and no React — what it admits per row.
//
// `LedgerFeedRows.test.tsx` proves the fold reaches the screen; this file proves what
// it selects, which the mounted feed cannot show at this size: the cases below need a
// run longer than the chapter cap, and a virtualized feed mounts a range rather than
// a window whatever the fold admitted.

import type { TimelineRow } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { CHAPTER_VISIBLE_ROW_CAP } from "../../ledger/structure/index.js";
import { type ConsoleSessionEvent } from "../../store/index.js";
import {
  chapterRowIdsWithinCap,
  foldChapterHeaders,
  narrowChapterToAdmittedRows,
} from "./ledger-chapter-fold.js";
import { deriveLedgerWindow, type LedgerWindowModel } from "./ledger-window.js";

const SESSION_ID = "session-chapter-cap";
const RUN_ID = "019b793b-7b60-740e-8110-d1a4c1150111";
const ROWS_PAST_THE_CAP = 5;

/**
 * One finished run of `memberCount` rows, the last of which is its terminal.
 *
 * A single chapter and nothing else, so every figure below is that chapter's: a
 * session-scoped row beside it would be counted by the fold's top-level arm and the
 * cap's arithmetic would stop being readable from the totals.
 */
function oneRunLog(memberCount: number): readonly ConsoleSessionEvent[] {
  const at = (index: number): string => new Date(Date.UTC(2026, 0, 1, 11, 0, index)).toISOString();
  const payload = { sessionId: SESSION_ID, runId: RUN_ID };
  return Array.from({ length: memberCount }, (_unused, index) => ({
    id: `event-${String(index)}`,
    sessionId: SESSION_ID,
    sequence: index,
    kind: index === memberCount - 1 ? "run.completed" : "assistant.message",
    occurredAt: at(index),
    payload,
  }));
}

/** That log, folded, with the chapter open or shut. */
function foldedOverOneRun(memberCount: number, isOpen: boolean): LedgerWindowModel {
  return foldChapterHeaders(
    deriveLedgerWindow(oneRunLog(memberCount), false),
    new Set(isOpen ? [RUN_ID] : []),
  );
}

/** The chapter's rows in the viewport, which is every row hanging off its header. */
function renderedMemberKeys(model: LedgerWindowModel): readonly string[] {
  return model.viewportRows.filter((row) => row.parentKey === RUN_ID).map((row) => row.key);
}

describe("an opened chapter admits the cap's own window and no more", () => {
  const OVER_CAP_MEMBER_COUNT = CHAPTER_VISIBLE_ROW_CAP + ROWS_PAST_THE_CAP;

  it("renders exactly the cap when a run longer than it is opened", () => {
    const model = foldedOverOneRun(OVER_CAP_MEMBER_COUNT, true);
    expect(renderedMemberKeys(model)).toHaveLength(CHAPTER_VISIBLE_ROW_CAP);
    // And the body lookup agrees, so nothing can draw a row the cap kept out.
    expect(model.rows).toHaveLength(CHAPTER_VISIBLE_ROW_CAP);
  });

  it("keeps the newest rows and clips the run's older head", () => {
    // Newest and not oldest because the chapter body clips behind a TOP-edge fade.
    // Reading it the other way round would fade a long run's newest work out of view
    // and leave its opening on screen.
    const model = foldedOverOneRun(OVER_CAP_MEMBER_COUNT, true);
    const everyMemberId = deriveLedgerWindow(oneRunLog(OVER_CAP_MEMBER_COUNT), false).rows.map(
      (row: TimelineRow) => row.id,
    );
    const rendered = new Set(renderedMemberKeys(model));
    for (const clippedId of everyMemberId.slice(0, ROWS_PAST_THE_CAP)) {
      expect(rendered.has(clippedId)).toBe(false);
    }
    for (const keptId of everyMemberId.slice(ROWS_PAST_THE_CAP)) {
      expect(rendered.has(keptId)).toBe(true);
    }
  });

  it("reports as clipped exactly what it did not render", () => {
    const model = foldedOverOneRun(OVER_CAP_MEMBER_COUNT, true);
    const chapter = model.chapterByHeaderKey.get(RUN_ID);
    expect(chapter?.clippedRowCount).toBe(ROWS_PAST_THE_CAP);
    expect((chapter?.rowCount ?? 0) - renderedMemberKeys(model).length).toBe(
      chapter?.clippedRowCount,
    );
  });

  it("opens a chapter under the cap whole", () => {
    const memberCount = CHAPTER_VISIBLE_ROW_CAP - 1;
    const model = foldedOverOneRun(memberCount, true);
    expect(renderedMemberKeys(model)).toHaveLength(memberCount);
    expect(model.chapterByHeaderKey.get(RUN_ID)?.clippedRowCount).toBe(0);
  });

  it("negative control: the same chapter shut still renders its receipt alone", () => {
    // Without this every case above would pass over a fold that had stopped
    // admitting anything, which is a chapter nobody can open at all.
    const model = foldedOverOneRun(OVER_CAP_MEMBER_COUNT, false);
    expect(renderedMemberKeys(model)).toHaveLength(1);
    expect(model.rows[0]?.type).toBe("run.completed");
  });

  it("negative control: the cap's selector returns a short chapter by identity", () => {
    // Without this the selection above could have been written as an unconditional
    // slice, which allocates a second array for every chapter in every fold.
    const shortRowIds = ["a", "b", "c"];
    expect(chapterRowIdsWithinCap(shortRowIds)).toBe(shortRowIds);
    expect(
      chapterRowIdsWithinCap(
        Array.from({ length: CHAPTER_VISIBLE_ROW_CAP + 1 }, (_u, i) => `r${String(i)}`),
      ),
    ).toHaveLength(CHAPTER_VISIBLE_ROW_CAP);
  });
});

describe("a chapter re-sealed over the rows a narrowing admitted", () => {
  const MEMBER_COUNT = 6;

  /** The chapter as the fold sealed it, before any narrowing. */
  function wholeChapter(): NonNullable<ReturnType<typeof chapterOf>> {
    const chapter = chapterOf(deriveLedgerWindow(oneRunLog(MEMBER_COUNT), false));
    if (chapter === undefined) {
      throw new Error("the fold produced no chapter for a finished run");
    }
    return chapter;
  }

  function chapterOf(model: LedgerWindowModel) {
    return model.chapterByHeaderKey.get(RUN_ID);
  }

  it("re-counts membership and carries the run's own facts through untouched", () => {
    const chapter = wholeChapter();
    const admitted = new Set(chapter.rowIds.slice(0, 2));
    const narrowed = narrowChapterToAdmittedRows(chapter, admitted);
    expect(narrowed?.rowCount).toBe(2);
    expect(narrowed?.rowIds).toStrictEqual([...admitted]);
    // Lifecycle and the terminal are facts about the SESSION. Re-deriving them over
    // the admitted rows would turn a finished run live the moment a narrowing
    // excluded its `run.completed` row, and rule 7 would then keep it open forever.
    expect(narrowed?.lifecycle).toBe("terminal");
    expect(narrowed?.terminalEventType).toBe(chapter.terminalEventType);
    expect(narrowed?.terminalRowId).toBe(chapter.terminalRowId);
  });

  it("answers undefined for a chapter the narrowing admits no row of", () => {
    expect(narrowChapterToAdmittedRows(wholeChapter(), new Set<string>())).toBeUndefined();
  });

  it("negative control: a narrowing that took nothing returns the chapter by identity", () => {
    const chapter = wholeChapter();
    expect(narrowChapterToAdmittedRows(chapter, new Set(chapter.rowIds))).toBe(chapter);
  });
});
