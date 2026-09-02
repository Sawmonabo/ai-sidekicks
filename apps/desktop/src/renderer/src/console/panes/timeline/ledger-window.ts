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

import { useMemo } from "react";

import { type TimelineRow } from "@ai-sidekicks/contracts";

import { projectFixtureShellRows } from "../../ledger/cards/index.js";
import { type LedgerViewportRow } from "../../ledger/frame/index.js";
import {
  LedgerChapterIndex,
  LedgerSeamIndex,
  ProvenanceRailModel,
  SupersededIndex,
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
  /** The rail's derivation over this window. */
  readonly railModel: ProvenanceRailModel;
  /** Every seam in log order — what the replay dock's next-seam jump walks. */
  readonly seams: readonly LedgerSeam[];
  /** The rows in log order, for find, the chapter fold, and the replay scrub. */
  readonly rows: readonly TimelineRow[];
  /** Events the registered census carries no category for. Rendered, never hidden. */
  readonly unprojectableEventCount: number;
  /** Whether the store knows of rows it has not got. Drives the rail's dotted head. */
  readonly hasEarlierRows: boolean;
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
  hasEarlierRows: boolean,
): LedgerWindowModel {
  const projection = projectFixtureShellRows(timeline);
  const { rows } = projection;
  const chapterIndex = new LedgerChapterIndex(rows);
  const supersededIndex = new SupersededIndex(rows);
  // One classifier, shared by the rail and the seam list, rather than two indexes
  // deriving the same vocabulary twice over the same rows.
  const seamIndex = new LedgerSeamIndex();
  const rowsByKey = new Map<string, TimelineRow>();
  const viewportRows: LedgerViewportRow[] = [];
  const supersededRowIds = new Set<string>();
  for (const row of rows) {
    rowsByKey.set(row.id, row);
    viewportRows.push({
      key: row.id,
      parentKey: chapterKeyFor(row),
      rootCursor: cutUnitFor(row),
    });
    if (supersededIndex.isSuperseded(row.id)) {
      supersededRowIds.add(row.id);
    }
  }
  return {
    viewportRows,
    rowsByKey,
    supersededRowIds,
    collapsedRowIds: collapsedRowIdsOf(chapterIndex),
    railModel: new ProvenanceRailModel({ rows, hasEarlierRows }, seamIndex),
    seams: seamIndex.seams(rows),
    rows,
    unprojectableEventCount: projection.unprojectableEventCount,
    hasEarlierRows,
    // A chapter with no terminal is a run the log has not seen end. That is the
    // same question the viewport asks before it prunes, and it is answered from the
    // fold that already exists rather than from a second read of the run partition.
    hasActiveTurn: chapterIndex.chapters().length > chapterIndex.terminalChapters().length,
  };
}

/**
 * Subscribe to one session's log and derive its window.
 *
 * The subscription is the store's `timeline` and its gap list and nothing else, so a
 * change to an entity partition — a run transition the ledger already saw as a row —
 * does not re-fold the log. The store replaces the log's identity only when it
 * admits an event, which is what makes the memo below fire exactly then.
 */
export function useLedgerWindow(sessionStore: SessionStore): LedgerWindowModel {
  const timeline = useSessionStore(sessionStore, readTimeline);
  const hasEarlierRows = useSessionStore(sessionStore, readHasGaps);
  return useMemo(() => deriveLedgerWindow(timeline, hasEarlierRows), [timeline, hasEarlierRows]);
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
