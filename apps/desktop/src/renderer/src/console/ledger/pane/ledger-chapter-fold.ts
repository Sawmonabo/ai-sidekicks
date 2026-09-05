// The chapter fold: which of a window's rows a run's disclosure lets through.
//
// A SECOND PASS OVER THE DERIVED WINDOW rather than a branch inside the derivation,
// and its own module for the same reason it is its own pass: the two answer to
// different clocks. The derivation changes when the log does; this changes when a
// person clicks a disclosure, and folding inside would re-project ten thousand rows
// on every toggle.
//
// THREE DECISIONS LIVE HERE AND NOWHERE ELSE, because each of them is a way the
// fold could quietly lie about what is on screen:
//
//   • Which rows a chapter contributes — its receipt while shut, the cap's own
//     window while open.
//   • Where a chapter clips, which is `chapterRowIdsWithinCap` and is read by the
//     fold AND by the narrowing that re-seals a chapter's figures, so one rule
//     decides both.
//   • Which chapters a person has opened, which is this mount's and not the log's.

import { useCallback, useMemo } from "react";

import { type TimelineRow } from "@ai-sidekicks/contracts";

import { useConsoleBridge } from "../../bridge/index.js";
import { type LedgerViewportRow } from "../frame/index.js";
import {
  CHAPTER_VISIBLE_ROW_CAP,
  ChapterCollapseState,
  type LedgerChapter,
} from "../structure/index.js";
import { useSessionScopedState, type TimelineRowDensity } from "../../seats/index.js";
import { LedgerRowRetention } from "./ledger-row-retention.js";
import { chapterKeyFor, type LedgerWindowModel } from "./ledger-window.js";

/**
 * Fold every terminal chapter that is not open into a header and its receipt.
 *
 * A SECOND PASS over the derived window rather than a branch inside the derivation,
 * because the two answer to different clocks: the derivation changes when the log
 * does and this changes when a person clicks a disclosure. Folding inside would
 * re-project ten thousand rows on every toggle.
 *
 * WHAT A HEADER ROW IS. One viewport row keyed by the run id — which is exactly the
 * key `chapterKeyFor` already hands every one of that chapter's rows as their
 * `parentKey`. So emitting it does two things in one act: it gives the chapter
 * something to draw, and it makes the chapter's rows CHILDREN of a row the window
 * holds, which is what the cap's top-level rule was written for. Before this, every
 * run row named its run and no row WAS its run, so a run-only log counted every row
 * against the cap; now a chapter counts once, folded or open.
 *
 * A FOLDED CHAPTER KEEPS ITS RECEIPT. "Header and receipt" is the whole of the
 * folded shape: the header says which run ended and how much it holds, and the
 * terminal row says how it ended, in the daemon's own words. The rest is omitted
 * from the viewport rows AND from the body lookup, so nothing can draw a row the
 * fold has hidden.
 *
 * AND AN OPENED CHAPTER KEEPS ONLY WHAT THE CHAPTER CAP ADMITS. Opening one used to
 * admit every member it had, while its header went on reporting the excess as
 * `clipped` — so the figure named rows that were on screen, and one very long run
 * could open into a virtual window the 120-row chapter ceiling did nothing to bound.
 * The permitted subset is selected HERE, by `chapterRowIdsWithinCap`, so the rows
 * outside it never reach the viewport and the header's `clipped` count is exactly
 * what is not rendered. The receipt is admitted whatever the cap says: a chapter
 * whose terminal fell outside the window would report how it ended in a header that
 * could no longer show it.
 */
export function foldChapterHeaders(
  model: LedgerWindowModel,
  openedTerminalRunIds: ReadonlySet<string>,
  retention: LedgerRowRetention = new LedgerRowRetention(),
): LedgerWindowModel {
  if (model.chapterByHeaderKey.size === 0) {
    return model;
  }
  // ITS OWN table, never the projection's: this pass files a live chapter's rows
  // under no parent while the projection files them under their run, so one table
  // shared between the two stages would answer each with the other's triple and
  // thrash on every pass. The early return above leaves the table untouched, which is
  // correct — a chapterless window publishes the projection's own rows unchanged.
  retention.beginPass();
  const viewportRows: LedgerViewportRow[] = [];
  const rows: TimelineRow[] = [];
  const rowsByKey = new Map<string, TimelineRow>();
  const headeredRunIds = new Set<string>();
  // Computed once per opened chapter rather than per row: the selection is a fact
  // about the chapter, and asking it inside the loop would re-slice a 4,000-row run
  // four thousand times.
  const cappedRowIdsByRunId = new Map<string, ReadonlySet<string>>();
  for (const [runId, chapter] of model.chapterByHeaderKey) {
    if (openedTerminalRunIds.has(runId) && chapter.clippedRowCount > 0) {
      cappedRowIdsByRunId.set(runId, new Set(chapterRowIdsWithinCap(chapter.rowIds)));
    }
  }
  for (const row of model.rows) {
    const runId = chapterKeyFor(row);
    const chapter = runId === undefined ? undefined : model.chapterByHeaderKey.get(runId);
    if (chapter === undefined || runId === undefined) {
      viewportRows.push(retention.retainRowIdentity(row, undefined));
      rows.push(row);
      rowsByKey.set(row.id, row);
      continue;
    }
    if (!headeredRunIds.has(runId)) {
      headeredRunIds.add(runId);
      // At the chapter's FIRST row, so the header sits where the chapter starts and
      // the log's order is untouched. The header is its own cut unit: pruning it
      // takes its subtree with it, which is the ancestor closure the cap performs.
      viewportRows.push(retention.retainChapterHeaderIdentity(runId));
    }
    const cappedRowIds = cappedRowIdsByRunId.get(runId);
    const isOpenedAndWithinCap =
      openedTerminalRunIds.has(runId) && (cappedRowIds === undefined || cappedRowIds.has(row.id));
    if (isOpenedAndWithinCap || row.id === chapter.terminalRowId) {
      viewportRows.push(retention.retainRowIdentity(row, runId));
      rows.push(row);
      rowsByKey.set(row.id, row);
    }
  }
  return {
    ...model,
    viewportRows,
    rows,
    rowsByKey,
    seamByRowId: new Map([...model.seamByRowId].filter(([rowId]) => rowsByKey.has(rowId))),
  };
}

/**
 * The chapter rows the cap admits — the NEWEST `CHAPTER_VISIBLE_ROW_CAP` of them.
 *
 * Newest and not oldest because `chapters.ts` says where the clip is drawn: the
 * body "clips behind a top-edge fade", so the rows the cap keeps are the ones at
 * the bottom of the chapter and the remainder is the run's older head. Reading it
 * the other way round would fade the newest work of a long run out of view and
 * leave its opening on screen.
 *
 * The array is returned BY IDENTITY when the chapter is under the cap, so a
 * chapter nothing was taken from allocates nothing.
 */
export function chapterRowIdsWithinCap(rowIds: readonly string[]): readonly string[] {
  return rowIds.length <= CHAPTER_VISIBLE_ROW_CAP ? rowIds : rowIds.slice(-CHAPTER_VISIBLE_ROW_CAP);
}

/**
 * One chapter as a narrowing leaves it, or `undefined` when it admits no row of it.
 *
 * WHAT THE NARROWING MAY CHANGE AND WHAT IT MAY NOT. Membership is a fact about the
 * narrowing, so `rowIds`, `rowCount` and the clipped figure are re-derived over the
 * admitted rows — a header reporting the whole run's count over a body holding four
 * of its rows would make its own figure a lie. Lifecycle, the terminal that ended
 * the run and the row it was read from are facts about the SESSION, so they are
 * carried through untouched: a filter that hid a run's `run.completed` row would
 * otherwise turn a finished chapter live, and rule 7 would then keep it open
 * forever.
 *
 * The clipped figure is re-derived from the cap's own selector rather than from a
 * second subtraction, so there is one expression of where a chapter clips.
 */
export function narrowChapterToAdmittedRows(
  chapter: LedgerChapter,
  admittedRowIds: ReadonlySet<string>,
): LedgerChapter | undefined {
  const rowIds = chapter.rowIds.filter((rowId) => admittedRowIds.has(rowId));
  if (rowIds.length === 0) {
    return undefined;
  }
  if (rowIds.length === chapter.rowIds.length) {
    return chapter;
  }
  return {
    ...chapter,
    rowIds,
    rowCount: rowIds.length,
    clippedRowCount: rowIds.length - chapterRowIdsWithinCap(rowIds).length,
  };
}

/**
 * Fold the chapters of the window a narrowing left.
 *
 * Its own hook rather than a second half of the projection, so a disclosure toggle
 * re-folds over a projection and a narrowing it did not have to redo — and so the
 * narrowing has somewhere to sit between the two.
 */
export function useFoldedChapters(
  model: LedgerWindowModel,
  openedTerminalRunIds: ReadonlySet<string>,
  sessionId: string,
): LedgerWindowModel {
  // One table per SESSION rather than per mount — the projection hook's own idiom,
  // for its reason, and a second INSTANCE rather than a second class. The session is
  // the subject because this pane follows a navigation that changes which log it is
  // of without unmounting, and a table carried across that holds the rows of a
  // session nobody is reading.
  const bridge = useConsoleBridge();
  const retention = useSessionScopedState(bridge, sessionId, () => new LedgerRowRetention());
  const heldRetention = retention.value;
  return useMemo(
    () => foldChapterHeaders(model, openedTerminalRunIds, heldRetention),
    [model, openedTerminalRunIds, heldRetention],
  );
}

/** What one mount remembers about which finished chapters a person opened. */
export interface LedgerChapterDisclosure {
  /** The terminal chapters that are open. Every other one is folded. */
  readonly openedTerminalRunIds: ReadonlySet<string>;
  /** Open a folded chapter, or fold an opened one. */
  readonly toggle: (chapter: LedgerChapter) => void;
  /** Fold every terminal chapter — what the palette's collapse row runs. */
  readonly collapseAllTerminal: (chapters: readonly LedgerChapter[]) => void;
}

/**
 * Hold one session's chapter disclosure.
 *
 * `ChapterCollapseState` is the single owner of the rule — a live chapter answers
 * open before any stored state is read — so this hook does not restate it; it
 * publishes the instance's opened set so a toggle repaints. The set is derived from
 * the instance and written nowhere else, which is what keeps it one source of truth
 * mirrored rather than two states kept in step.
 *
 * SCOPED TO THE SESSION, NOT TO THE MOUNT, and the difference is not academic: the
 * shell opens session stores and never closes them, so moving from one open session
 * to another re-renders this pane at the same position rather than unmounting it. A
 * `useState` holder therefore carried session A's decisions into session B — its
 * opened run ids are A's, so a B chapter that happens to share a run id opens by
 * itself and every other terminal chapter in B is folded by a decision made in A.
 * BOTH halves are held per session, because the instance and its published mirror
 * are one fact: re-seeding the instance alone would leave the mirror standing.
 */
export function useChapterDisclosure(sessionId: string): LedgerChapterDisclosure {
  const bridge = useConsoleBridge();
  const collapse = useSessionScopedState(bridge, sessionId, () => new ChapterCollapseState());
  const opened = useSessionScopedState<ReadonlySet<string>>(
    bridge,
    sessionId,
    () => new Set<string>(),
  );
  const collapseState = collapse.value;
  const publishOpened = opened.publish;
  const publish = useCallback(() => {
    publishOpened(new Set(collapseState.openedTerminalRunIds));
  }, [collapseState, publishOpened]);
  const toggle = useCallback(
    (chapter: LedgerChapter) => {
      if (collapseState.isOpen(chapter)) {
        collapseState.close(chapter);
      } else {
        collapseState.open(chapter);
      }
      publish();
    },
    [collapseState, publish],
  );
  const collapseAllTerminal = useCallback(
    (chapters: readonly LedgerChapter[]) => {
      collapseState.collapseAllTerminal(chapters);
      publish();
    },
    [collapseState, publish],
  );
  const openedTerminalRunIds = opened.value;
  return useMemo(
    () => ({ openedTerminalRunIds, toggle, collapseAllTerminal }),
    [openedTerminalRunIds, toggle, collapseAllTerminal],
  );
}

/** One row's collapse state, from the list's own decision. */
export function densityFor(
  rowId: string,
  collapsedRowIds: ReadonlySet<string>,
): TimelineRowDensity {
  return collapsedRowIds.has(rowId) ? "collapsed" : "expanded";
}
