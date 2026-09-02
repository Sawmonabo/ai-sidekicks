// One loaded ledger window, derived from this window's session store.
//
// WHAT THIS MODULE IS FOR. `TimelinePane.tsx` renders; every derivation it renders
// is made here, once per store revision, so the component body holds no fold and no
// allocation. That split is `apps/desktop/AGENTS.md`'s rule about render bodies, and
// it is also what makes the pane cheap: the frame's budget is spent on the
// virtualizer's measurement pass, not on re-folding a ten-thousand-row log because
// a find field took a keystroke.
//
// WHY THE VIEWPORT ROW AND THE ROW BODY ARE TWO THINGS. The virtualizer's row is
// three identity members (`key`, `parentKey`, `rootCursor`) and no content — it
// decides placement, measurement, and pruning, and a viewport that also carried the
// body would re-measure every row whenever any body changed. So this module
// produces the identity list AND a lookup from key to the projected row, and the
// pane's renderer joins them at the one point a row is actually drawn.
//
// THE THREE THINGS THE LIST DECIDES AND A ROW NEVER KNOWS, which is the timeline row
// seat's own contract:
//
//   • `participantHue` — allocated over a join order, and NOT here. The session
//     store owns the wheel (`SessionStore.hueAllocator`): it admits the read's
//     participant join log first and then every actor the log attributes a row to,
//     which is the order rule 2 fixes. A second allocator over first-event
//     appearance was the same algorithm over a different order, so a participant
//     who joined early and spoke late wore one hue on their cast chip and another
//     on their rows — which defeats hue as an identity channel exactly where it is
//     supposed to work. The feed reads the store's assignment at the row it draws.
//   • `isSuperseded` — a rollback ranking over the rows AROUND a row, which is
//     `SupersededIndex`'s answer and never a member the row carries.
//   • `density` — the list's collapse state, which is `Spec-023 §Console Design
//     (Meridian)` rule 7: a terminal run's chapter folds and the live one stays open.

import { useCallback, useMemo, useState } from "react";

import { type TimelineRow } from "@ai-sidekicks/contracts";

import { projectFixtureShellRows } from "../../ledger/cards/index.js";
import { type LedgerViewportRow } from "../../ledger/frame/index.js";
import {
  ChapterCollapseState,
  LedgerChapterIndex,
  LedgerSeamIndex,
  SupersededIndex,
  type LedgerChapter,
  type LedgerSeam,
} from "../../ledger/structure/index.js";
import { useSessionStore, type ConsoleSessionEvent, type SessionStore } from "../../store/index.js";
import { type TimelineRowDensity } from "../../workspace/index.js";

/** Everything one render of the ledger needs, derived once per store revision. */
export interface LedgerWindowModel {
  /** The virtualizer's identity list. Memoized: the viewport keys its reconcile on it. */
  readonly viewportRows: readonly LedgerViewportRow[];
  /** The projected row behind each viewport key. */
  readonly rowsByKey: ReadonlyMap<string, TimelineRow>;
  /** Which rows a rollback boundary later in the log supersedes. */
  readonly supersededRowIds: ReadonlySet<string>;
  /** Which rows are collapsed, under rule 7's terminal-chapter fold. */
  readonly collapsedRowIds: ReadonlySet<string>;
  /**
   * The chapter behind each header row, keyed by the run id the header IS.
   *
   * Every terminal chapter has an entry, whether it is folded or open: a header a
   * person opened still renders, because the control that folds it back is on it.
   * A live chapter has none — it draws no header, its rows are top-level, and the
   * fold below never touches it.
   */
  readonly chapterByHeaderKey: ReadonlyMap<string, LedgerChapter>;
  /** Every seam in log order — what the replay dock's next-seam jump walks. */
  readonly seams: readonly LedgerSeam[];
  /**
   * The seam behind each row that is one — the lookup the feed's row renderer
   * consults BEFORE it delegates to the timeline row seat.
   *
   * Built from the same index that produced `seams`, so the row a jump lands on and
   * the row a person reads are one classification rather than two.
   */
  readonly seamByRowId: ReadonlyMap<string, LedgerSeam>;
  /** The rows in log order, for find, the chapter fold, and the replay scrub. */
  readonly rows: readonly TimelineRow[];
  /** Events the registered census carries no category for. Rendered, never hidden. */
  readonly unprojectableEventCount: number;
  /**
   * Whether the store recorded sequences it never received.
   *
   * A HOLE in what arrived, which is not the same fact as "rows exist before this
   * window's head" and is deliberately no longer used as one: the console holds one
   * live subscription and no range read, so the head of the window is the head of
   * everything it can reach. The feed names the hole in words instead.
   */
  readonly hasUnreceivedEntries: boolean;
  /** A run is mid-flight, so the viewport defers pruning rather than moving rows. */
  readonly hasActiveTurn: boolean;
}

/**
 * The cut unit the window cap prunes by.
 *
 * `LedgerWindowRow.rootCursor` is the `timeline.read` cursor a row was read at, and
 * this console performs no timeline read — it holds one live subscription and the
 * whole log it delivered. So each row is its own cut unit, which is the FINEST the
 * cap can act on and therefore the least it can over-drop: a single shared cursor
 * would make the cap all-or-nothing over the entire window.
 */
function cutUnitFor(row: TimelineRow): string {
  return row.id;
}

/**
 * The chapter a row hangs from, or `undefined` for a top-level row.
 *
 * Read off the arm rather than off the payload: `kind` is the discriminator the
 * contract guarantees, and three of the four arms carry `runId` structurally while
 * the `general` arm structurally cannot.
 */
function chapterKeyFor(row: TimelineRow): string | undefined {
  return row.kind === "general" ? undefined : row.runId;
}

/**
 * Which rows are collapsed: every row of a chapter that has reached a terminal.
 *
 * Rule 7 in terms — "run chapters collapse once terminal and the live chapter stays
 * open" — asked of the chapter index's own `terminalChapters()` rather than
 * re-derived from a terminal event type here, so the fold that decides a chapter is
 * over and the fold that decides a row is collapsed are one fold.
 */
function collapsedRowIdsOf(chapterIndex: LedgerChapterIndex): ReadonlySet<string> {
  const collapsed = new Set<string>();
  for (const chapter of chapterIndex.terminalChapters()) {
    for (const rowId of chapter.rowIds) {
      collapsed.add(rowId);
    }
  }
  return collapsed;
}

/** One row's collapse state, from the list's own decision. */
export function densityFor(
  rowId: string,
  collapsedRowIds: ReadonlySet<string>,
): TimelineRowDensity {
  return collapsedRowIds.has(rowId) ? "collapsed" : "expanded";
}

/**
 * Derive the whole window from one log.
 *
 * Exported beside the hook so the fold can be driven by a test and by the bench tier
 * with no store and no React at all — `foldChapters`' own precedent, for its reason.
 */
export function deriveLedgerWindow(
  timeline: readonly ConsoleSessionEvent[],
  hasUnreceivedEntries: boolean,
): LedgerWindowModel {
  const projection = projectFixtureShellRows(timeline);
  const { rows } = projection;
  const chapterIndex = new LedgerChapterIndex(rows);
  const supersededIndex = new SupersededIndex(rows);
  // The seam vocabulary has one classifier; this is the instance that reads the
  // whole log, which is what replay's next-seam jump walks. The rail's own instance
  // reads the pruned window in `ledger-feed-model.ts`, because the rail marks what
  // is on screen.
  const seamIndex = new LedgerSeamIndex();
  const seams = seamIndex.seams(rows);
  const rowsByKey = new Map<string, TimelineRow>();
  const viewportRows: LedgerViewportRow[] = [];
  const supersededRowIds = new Set<string>();
  for (const row of rows) {
    rowsByKey.set(row.id, row);
    viewportRows.push(viewportRowFor(row, chapterKeyFor(row)));
    if (supersededIndex.isSuperseded(row.id)) {
      supersededRowIds.add(row.id);
    }
  }
  return {
    viewportRows,
    rowsByKey,
    supersededRowIds,
    collapsedRowIds: collapsedRowIdsOf(chapterIndex),
    chapterByHeaderKey: new Map(
      chapterIndex.terminalChapters().map((chapter) => [chapter.runId, chapter]),
    ),
    seams,
    seamByRowId: new Map(seams.map((seam) => [seam.rowId, seam])),
    rows,
    unprojectableEventCount: projection.unprojectableEventCount,
    hasUnreceivedEntries,
    // A chapter with no terminal is a run the log has not seen end. That is the
    // same question the viewport asks before it prunes, and it is answered from the
    // fold that already exists rather than from a second read of the run partition.
    hasActiveTurn: chapterIndex.chapters().length > chapterIndex.terminalChapters().length,
  };
}

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
 */
export function foldChapterHeaders(
  model: LedgerWindowModel,
  openedTerminalRunIds: ReadonlySet<string>,
): LedgerWindowModel {
  if (model.chapterByHeaderKey.size === 0) {
    return model;
  }
  const viewportRows: LedgerViewportRow[] = [];
  const rows: TimelineRow[] = [];
  const rowsByKey = new Map<string, TimelineRow>();
  const headeredRunIds = new Set<string>();
  for (const row of model.rows) {
    const runId = chapterKeyFor(row);
    const chapter = runId === undefined ? undefined : model.chapterByHeaderKey.get(runId);
    if (chapter === undefined || runId === undefined) {
      viewportRows.push(viewportRowFor(row, undefined));
      rows.push(row);
      rowsByKey.set(row.id, row);
      continue;
    }
    if (!headeredRunIds.has(runId)) {
      headeredRunIds.add(runId);
      // At the chapter's FIRST row, so the header sits where the chapter starts and
      // the log's order is untouched. The header is its own cut unit: pruning it
      // takes its subtree with it, which is the ancestor closure the cap performs.
      viewportRows.push({ key: runId, parentKey: undefined, rootCursor: runId });
    }
    if (openedTerminalRunIds.has(runId) || row.id === chapter.terminalRowId) {
      viewportRows.push(viewportRowFor(row, runId));
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

/** One row's place in the virtualizer's identity list. */
function viewportRowFor(row: TimelineRow, parentKey: string | undefined): LedgerViewportRow {
  return { key: row.id, parentKey, rootCursor: cutUnitFor(row) };
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
 * Hold one mount's chapter disclosure.
 *
 * `ChapterCollapseState` is the single owner of the rule — a live chapter answers
 * open before any stored state is read — so this hook does not restate it; it
 * publishes the instance's opened set into React state so a toggle repaints. The
 * set is derived from the instance and written nowhere else, which is what keeps it
 * one source of truth mirrored rather than two states kept in step.
 */
export function useChapterDisclosure(): LedgerChapterDisclosure {
  const [collapseState] = useState(() => new ChapterCollapseState());
  const [openedTerminalRunIds, setOpenedTerminalRunIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const publish = useCallback(() => {
    setOpenedTerminalRunIds(new Set(collapseState.openedTerminalRunIds));
  }, [collapseState]);
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
  return useMemo(
    () => ({ openedTerminalRunIds, toggle, collapseAllTerminal }),
    [openedTerminalRunIds, toggle, collapseAllTerminal],
  );
}

/**
 * Subscribe to one session's log and derive its window.
 *
 * The subscription is the store's `timeline` and its gap list and nothing else, so a
 * change to an entity partition — a run transition the ledger already saw as a row —
 * does not re-fold the log. The store replaces the log's identity only when it
 * admits an event, which is what makes the memo below fire exactly then.
 */
export function useLedgerWindow(
  sessionStore: SessionStore,
  openedTerminalRunIds: ReadonlySet<string>,
): LedgerWindowModel {
  const timeline = useSessionStore(sessionStore, readTimeline);
  const hasUnreceivedEntries = useSessionStore(sessionStore, readHasGaps);
  const derived = useMemo(
    () => deriveLedgerWindow(timeline, hasUnreceivedEntries),
    [timeline, hasUnreceivedEntries],
  );
  // Two memos rather than one, so a disclosure toggle re-folds the chapters over a
  // projection it did not have to redo.
  return useMemo(
    () => foldChapterHeaders(derived, openedTerminalRunIds),
    [derived, openedTerminalRunIds],
  );
}

/** The log this window holds. A named function, so the selector identity is stable. */
function readTimeline(state: {
  readonly timeline: readonly ConsoleSessionEvent[];
}): readonly ConsoleSessionEvent[] {
  return state.timeline;
}

/** Whether the store knows of sequences it never received. */
function readHasGaps(state: { readonly gaps: readonly unknown[] }): boolean {
  return state.gaps.length > 0;
}
