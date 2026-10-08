// Which of a window's rows a run group lets through. A second pass over the derived window, not a
// branch inside the derivation: the derivation changes when the log does, this changes when a
// person folds or opens a group, and folding inside would re-project every row on each press.

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";
import { readRunGroupKey } from "../runs/groups.js";
import { RUN_GROUP_VISIBLE_ROW_CAP } from "../runs/body.js";
import { type ViewportRow } from "../viewport/snapshot.js";
import { TranscriptRowRetention } from "../window/row-retention.js";
import {
  NO_ROWS_REMOVED,
  type TranscriptPipelineStage,
  type TranscriptWindowModel,
} from "../window/transcript-window.js";

/**
 * Puts a header at the first row of every run group, live or ended, and lets through the rows
 * of each open group.
 *
 * The header is one viewport row keyed by the run id, the `parentKey` every row of that run
 * group already carries, so the group counts once against the window cap folded or open. A
 * folded group is its header alone; its rows leave both the viewport rows and the body lookup. An
 * open group keeps only what `selectRunGroupRowIdsWithinCap` admits, so the header's `clipped`
 * figure names exactly the rows not on screen. The rows it withholds are returned as
 * `removedRows` for the find field's counts.
 */
export function foldRunGroupHeaders(
  model: TranscriptWindowModel,
  foldedRunIds: ReadonlySet<string>,
  retention: TranscriptRowRetention = new TranscriptRowRetention(),
): TranscriptPipelineStage {
  if (model.runGroupByHeaderKey.size === 0) {
    return { window: model, removedRows: NO_ROWS_REMOVED };
  }
  // Its own retention table, never the projection's: that stage files a run group's rows under
  // their run while this one files the header under no parent, so a shared table would thrash.
  retention.beginPass();
  const viewportRows: ViewportRow[] = [];
  const rows: TranscriptEventRow[] = [];
  const removedRows: TranscriptEventRow[] = [];
  const rowsByKey = new Map<string, TranscriptEventRow>();
  const headeredRunIds = new Set<string>();
  // Once per open run group, not per row: re-slicing a long run per row is quadratic.
  const cappedRowIdsByRunId = new Map<string, ReadonlySet<string>>();
  for (const [runId, runGroup] of model.runGroupByHeaderKey) {
    if (!foldedRunIds.has(runId) && runGroup.clippedRowCount > 0) {
      cappedRowIdsByRunId.set(runId, new Set(selectRunGroupRowIdsWithinCap(runGroup.rowIds)));
    }
  }
  for (const row of model.rows) {
    const runId = readRunGroupKey(row);
    if (runId === undefined) {
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
    const isOpenAndWithinCap =
      !foldedRunIds.has(runId) && (cappedRowIds === undefined || cappedRowIds.has(row.id));
    if (isOpenAndWithinCap) {
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
