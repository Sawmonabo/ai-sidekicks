// The run-group fold: which of a window's rows a run's disclosure lets through.
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
//   • Which rows a run group contributes — its receipt while shut, the cap's own
//     window while open.
//   • Where a run group clips, which is `selectRunGroupRowIdsWithinCap` and is read by the
//     fold AND by the narrowing that re-seals a run group's figures, so one rule
//     decides both.
//   • Which run groups a person has opened, which is this mount's and not the log's.

import { type TimelineRow } from "@ai-sidekicks/contracts";
import { type TranscriptRowDensity } from "../transcript-row-renderer.js";
import { type RunGroup } from "../run-groups/run-groups.js";
import { RUN_GROUP_VISIBLE_ROW_CAP } from "../structure/structure-caps.js";
import { type ViewportRow } from "../viewport/viewport-snapshot.js";
import { TranscriptRowRetention } from "../window/row-retention.js";
import {
  NO_ROWS_REMOVED,
  readRunGroupKey,
  type TranscriptPipelineStage,
  type TranscriptWindowModel,
} from "../window/transcript-window.js";

/** What one mount remembers about which finished run groups a person opened. */
export interface RunGroupDisclosure {
  /** The terminal run groups that are open. Every other one is folded. */
  readonly openedTerminalRunIds: ReadonlySet<string>;
  /** Open a folded run group, or fold an opened one. */
  readonly toggle: (runGroup: RunGroup) => void;
  /** Fold every terminal run group — what the palette's collapse row runs. */
  readonly collapseAllTerminal: (runGroups: readonly RunGroup[]) => void;
}

/**
 * Fold every terminal run group that is not open into a header and its receipt.
 *
 * A SECOND PASS over the derived window rather than a branch inside the derivation,
 * because the two answer to different clocks: the derivation changes when the log
 * does and this changes when a person clicks a disclosure. Folding inside would
 * re-project ten thousand rows on every toggle.
 *
 * WHAT A HEADER ROW IS. One viewport row keyed by the run id — which is exactly the
 * key `readRunGroupKey` already hands every one of that run group's rows as their
 * `parentKey`. So emitting it does two things in one act: it gives the run group
 * something to draw, and it makes the run group's rows CHILDREN of a row the window
 * holds, which is what the cap's top-level rule was written for: a run group counts once
 * against the cap, folded or open.
 *
 * A FOLDED RUN GROUP KEEPS ITS RECEIPT. "Header and receipt" is the whole of the
 * folded shape: the header says which run ended and how much it holds, and the
 * terminal row says how it ended, in the daemon's own words. The rest is omitted
 * from the viewport rows AND from the body lookup, so nothing can draw a row the
 * fold has hidden.
 *
 * AND AN OPENED RUN GROUP KEEPS ONLY WHAT THE RUN GROUP CAP ADMITS, so one very long run
 * cannot open into a virtual window the run group ceiling does not bound, and the
 * header's `clipped` figure names only rows that are not on screen. The permitted
 * subset is selected HERE, by `selectRunGroupRowIdsWithinCap`, so the rows
 * outside it never reach the viewport and the header's `clipped` count is exactly
 * what is not rendered. The receipt is admitted whatever the cap says: a run group
 * whose terminal fell outside the window would report how it ended in a header that
 * could no longer show it.
 *
 * AND THE FOLD REPORTS WHAT IT WITHHELD, on the narrowing stage's rule and for its
 * reason: every finished run folds by default, so this is the largest of the
 * find field's four counts on any session that has finished a run, and the pass below
 * is the one that already separates those rows.
 */
export function foldRunGroupHeaders(
  model: TranscriptWindowModel,
  openedTerminalRunIds: ReadonlySet<string>,
  retention: TranscriptRowRetention = new TranscriptRowRetention(),
): TranscriptPipelineStage {
  if (model.runGroupByHeaderKey.size === 0) {
    return { window: model, removedRows: NO_ROWS_REMOVED };
  }
  // ITS OWN table, never the projection's: this pass files a live run group's rows
  // under no parent while the projection files them under their run, so one table
  // shared between the two stages would answer each with the other's triple and
  // thrash on every pass. The early return above leaves the table untouched, which is
  // correct — a window with no run groups publishes the projection's own rows unchanged.
  retention.beginPass();
  const viewportRows: ViewportRow[] = [];
  const rows: TimelineRow[] = [];
  const removedRows: TimelineRow[] = [];
  const rowsByKey = new Map<string, TimelineRow>();
  const headeredRunIds = new Set<string>();
  // Computed once per opened run group rather than per row: the selection is a fact
  // about the run group, and asking it inside the loop would re-slice a 4,000-row run
  // four thousand times.
  const cappedRowIdsByRunId = new Map<string, ReadonlySet<string>>();
  for (const [runId, runGroup] of model.runGroupByHeaderKey) {
    if (openedTerminalRunIds.has(runId) && runGroup.clippedRowCount > 0) {
      cappedRowIdsByRunId.set(runId, new Set(selectRunGroupRowIdsWithinCap(runGroup.rowIds)));
    }
  }
  for (const row of model.rows) {
    const runId = readRunGroupKey(row);
    const runGroup = runId === undefined ? undefined : model.runGroupByHeaderKey.get(runId);
    if (runGroup === undefined || runId === undefined) {
      viewportRows.push(retention.retainRowIdentity(row, undefined));
      rows.push(row);
      rowsByKey.set(row.id, row);
      continue;
    }
    if (!headeredRunIds.has(runId)) {
      headeredRunIds.add(runId);
      // At the run group's FIRST row, so the header sits where the run group starts and
      // the log's order is untouched. The header is its own cut unit: pruning it
      // takes its subtree with it, which is the ancestor closure the cap performs.
      viewportRows.push(retention.retainGroupHeaderIdentity(runId));
    }
    const cappedRowIds = cappedRowIdsByRunId.get(runId);
    const isOpenedAndWithinCap =
      openedTerminalRunIds.has(runId) && (cappedRowIds === undefined || cappedRowIds.has(row.id));
    if (isOpenedAndWithinCap || row.id === runGroup.terminalRowId) {
      viewportRows.push(retention.retainRowIdentity(row, runId));
      rows.push(row);
      rowsByKey.set(row.id, row);
      continue;
    }
    removedRows.push(row);
  }
  return {
    window: {
      ...model,
      viewportRows,
      rows,
      rowsByKey,
      seamByRowId: new Map([...model.seamByRowId].filter(([rowId]) => rowsByKey.has(rowId))),
    },
    removedRows,
  };
}

/**
 * The run group rows the cap admits — the NEWEST `RUN_GROUP_VISIBLE_ROW_CAP` of them.
 *
 * Newest and not oldest because `run-groups.ts` says where the clip is drawn: the
 * body "clips behind a top-edge fade", so the rows the cap keeps are the ones at
 * the bottom of the run group and the remainder is the run's older head. Reading it
 * the other way round would fade the newest work of a long run out of view and
 * leave its opening on screen.
 *
 * The array is returned BY IDENTITY when the run group is under the cap, so a
 * run group nothing was taken from allocates nothing.
 */
export function selectRunGroupRowIdsWithinCap(rowIds: readonly string[]): readonly string[] {
  return rowIds.length <= RUN_GROUP_VISIBLE_ROW_CAP
    ? rowIds
    : rowIds.slice(-RUN_GROUP_VISIBLE_ROW_CAP);
}

/**
 * One run group as a narrowing leaves it, or `undefined` when it admits no row of it.
 *
 * WHAT THE NARROWING MAY CHANGE AND WHAT IT MAY NOT. Membership is a fact about the
 * narrowing, so `rowIds`, `rowCount` and the clipped figure are re-derived over the
 * admitted rows — a header reporting the whole run's count over a body holding four
 * of its rows would make its own figure a lie. Lifecycle, the terminal that ended
 * the run and the row it was read from are facts about the SESSION, so they are
 * carried through untouched: a filter that hid a run's `run.completed` row would
 * otherwise turn a finished run group live, and a live run group stays open, so it
 * would then stay open forever.
 *
 * The clipped figure is re-derived from the cap's own selector rather than from a
 * second subtraction, so there is one expression of where a run group clips.
 */
export function narrowRunGroupToAdmittedRows(
  runGroup: RunGroup,
  admittedRowIds: ReadonlySet<string>,
): RunGroup | undefined {
  const rowIds = runGroup.rowIds.filter((rowId) => admittedRowIds.has(rowId));
  if (rowIds.length === 0) {
    return undefined;
  }
  if (rowIds.length === runGroup.rowIds.length) {
    return runGroup;
  }
  return {
    ...runGroup,
    rowIds,
    rowCount: rowIds.length,
    clippedRowCount: rowIds.length - selectRunGroupRowIdsWithinCap(rowIds).length,
  };
}

/** One row's collapse state, from the list's own decision. */
export function densityFor(
  rowId: string,
  collapsedRowIds: ReadonlySet<string>,
): TranscriptRowDensity {
  return collapsedRowIds.has(rowId) ? "collapsed" : "expanded";
}
