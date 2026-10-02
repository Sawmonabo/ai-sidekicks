// Which of a window's rows a run group's disclosure lets through. A second pass over the
// derived window, not a branch inside the derivation: the derivation changes when the log
// does, this changes when a person toggles a disclosure, and folding inside would
// re-project every row on each toggle.

import { type TimelineRow } from "@ai-sidekicks/contracts";
import { type TranscriptRowDensity } from "../transcript-row-renderer.js";
import { readRunGroupKey, type RunGroup } from "../run-groups/run-groups.js";
import { RUN_GROUP_VISIBLE_ROW_CAP } from "../run-groups/run-group-body.js";
import { type ViewportRow } from "../viewport/viewport-snapshot.js";
import { TranscriptRowRetention } from "../window/row-retention.js";
import {
  NO_ROWS_REMOVED,
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
 * Folds every terminal run group that is not open into a header and its receipt.
 *
 * The header is one viewport row keyed by the run id, the `parentKey` every row of that run
 * group already carries, so the group counts once against the window cap folded or open.
 * The receipt (the terminal row) is always kept; other rows of a folded group leave both the
 * viewport rows and the body lookup. An opened group keeps only what
 * `selectRunGroupRowIdsWithinCap` admits, so the header's `clipped` figure names exactly the
 * rows not on screen. The rows it withholds are returned as `removedRows` for the find
 * field's counts.
 */
export function foldRunGroupHeaders(
  model: TranscriptWindowModel,
  openedTerminalRunIds: ReadonlySet<string>,
  retention: TranscriptRowRetention = new TranscriptRowRetention(),
): TranscriptPipelineStage {
  if (model.runGroupByHeaderKey.size === 0) {
    return { window: model, removedRows: NO_ROWS_REMOVED };
  }
  // Its own retention table, never the projection's: that stage files a live run group's rows
  // under their run while this one files them under no parent, so a shared table would thrash.
  retention.beginPass();
  const viewportRows: ViewportRow[] = [];
  const rows: TimelineRow[] = [];
  const removedRows: TimelineRow[] = [];
  const rowsByKey = new Map<string, TimelineRow>();
  const headeredRunIds = new Set<string>();
  // Once per opened run group, not per row: re-slicing a long run per row is quadratic.
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
      // At the group's first row, so the header sits where the run starts and log order holds.
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
      systemMessageByRowId: new Map(
        [...model.systemMessageByRowId].filter(([rowId]) => rowsByKey.has(rowId)),
      ),
    },
    removedRows,
  };
}

/**
 * The run group rows the cap admits: the newest `RUN_GROUP_VISIBLE_ROW_CAP` of them.
 *
 * The body clips its older head behind a top-edge fade, so the newest rows stay on screen.
 * Returns the input array itself when it is under the cap.
 */
export function selectRunGroupRowIdsWithinCap(rowIds: readonly string[]): readonly string[] {
  return rowIds.length <= RUN_GROUP_VISIBLE_ROW_CAP
    ? rowIds
    : rowIds.slice(-RUN_GROUP_VISIBLE_ROW_CAP);
}

/** One row's collapse state, from the list's own decision. */
export function densityFor(
  rowId: string,
  collapsedRowIds: ReadonlySet<string>,
): TranscriptRowDensity {
  return collapsedRowIds.has(rowId) ? "collapsed" : "expanded";
}
