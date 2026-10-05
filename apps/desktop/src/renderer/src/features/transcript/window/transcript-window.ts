// One loaded transcript window, derived from a session's log once per store revision. The
// virtualizer's rows are identity only (`key`, `parentKey`, `rootCursor`); `rowsByKey` joins a key
// to its projected row. The window is unfurled (every member of every run group) because the fold
// in `feed/run-group-fold.ts` runs after it, and Find counts a folded group's rows.

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row/row";

import { type ProjectedSessionEvent } from "#renderer/store/session/entities/entities.js";
import {
  ChildRunIndex,
  type ChildRunEntry,
  type HandoffEntry,
} from "../dispatches/child-run-entries.js";
import { projectTranscriptRows } from "../projection/transcript-row-projection.js";
import { RunGroupIndex, readRunGroupKey, type RunGroup } from "../run-groups/run-groups.js";
import { SupersededIndex } from "../superseded/superseded-turns.js";
import {
  SystemMessageClassifier,
  type SystemMessageReading,
} from "../system-messages/system-message-classifier.js";
import { type ViewportRow } from "../viewport/viewport-snapshot.js";
import { replyRowIdsByFootRowId } from "./reply-rows.js";
import { TranscriptRowRetention } from "./row-retention.js";

/**
 * What one pipeline stage admitted and the rows it removed. The stage reports its own removals
 * because it already has them; deriving them downstream costs two whole-projection passes per
 * stage on every append while a query is in the find field.
 */
export interface TranscriptPipelineStage {
  readonly window: TranscriptWindowModel;
  /** The rows this stage took out of the window it was handed, in log order. */
  readonly removedRows: readonly TranscriptEventRow[];
}

/**
 * The removal a pass-through stage reports. One shared array: a consumer keys a memo on its
 * identity, and a fresh `[]` per pass would re-run that memo on every append.
 */
export const NO_ROWS_REMOVED: readonly TranscriptEventRow[] = [];

/** Everything one render of the transcript needs, derived once per store revision. */
export interface TranscriptWindowModel {
  /** The virtualizer's identity list; the viewport keys its reconcile on it. */
  readonly viewportRows: readonly ViewportRow[];
  readonly rowsByKey: ReadonlyMap<string, TranscriptEventRow>;
  /** Which rows a rollback boundary later in the log supersedes. */
  readonly supersededRowIds: ReadonlySet<string>;
  /** Which rows are collapsed, under the fold that closes every finished run group. */
  readonly collapsedRowIds: ReadonlySet<string>;
  /**
   * The run group behind each header row, keyed by the run id the header is. Every terminal run
   * group has an entry, folded or open; a live one has none, since it draws no header.
   */
  readonly runGroupByHeaderKey: ReadonlyMap<string, RunGroup>;
  /**
   * The system message behind each row that is one, consulted by the feed's row renderer before
   * the registered one. Only this map carries the classification; a second copy would go stale.
   */
  readonly systemMessageByRowId: ReadonlyMap<string, SystemMessageReading>;
  /**
   * The child-run summary behind each row that carries one. A re-summarized child has one entry,
   * at the row that first named it, carrying the latest summary.
   */
  readonly childRunEntryByRowId: ReadonlyMap<string, ChildRunEntry>;
  /** The handoff behind each row that is one, on the same dispatch. */
  readonly handoffEntryByRowId: ReadonlyMap<string, HandoffEntry>;
  /**
   * Each reply's rows, in log order, under the row that carries the reply's foot and its Copy of
   * the whole reply. Each list keeps its identity while the reply does not move.
   */
  readonly replyRowIdsByFootRowId: ReadonlyMap<string, readonly string[]>;
  /** The rows in log order, for find and the run group fold. */
  readonly rows: readonly TranscriptEventRow[];
  /** A run is mid-flight, so the viewport defers pruning rather than moving rows. */
  readonly hasActiveTurn: boolean;
}

/**
 * Derive the whole window from one log. Exported so a test can drive it with no store and no React.
 */
export function deriveTranscriptWindow(
  transcript: readonly ProjectedSessionEvent[],
  retention: TranscriptRowRetention = new TranscriptRowRetention(),
): TranscriptWindowModel {
  const projection = projectTranscriptRows(transcript);
  // Retain before the indexes read a row, so every index, the feed and every memo under it see the
  // object actually published. A fresh retention retains nothing, which suits a one-shot caller.
  retention.beginPass();
  const rows = projection.rows.map((row) => retention.retainRow(row));
  const runGroupIndex = new RunGroupIndex(rows);
  const supersededIndex = new SupersededIndex(rows);
  // One classifier reads the whole log; its pass is a local and reaches the model only as the map
  // below, so a narrowing and the feed share one classification.
  const systemMessages = new SystemMessageClassifier().systemMessages(rows);
  const childRunIndex = new ChildRunIndex(rows);
  const rowsByKey = new Map<string, TranscriptEventRow>();
  const viewportRows: ViewportRow[] = [];
  const supersededRowIds = new Set<string>();
  for (const row of rows) {
    rowsByKey.set(row.id, row);
    viewportRows.push(retention.retainRowIdentity(row, readRunGroupKey(row)));
    if (supersededIndex.isSuperseded(row.id)) {
      supersededRowIds.add(row.id);
    }
  }
  return {
    viewportRows,
    rowsByKey,
    supersededRowIds,
    collapsedRowIds: collapsedRowIdsOf(runGroupIndex),
    runGroupByHeaderKey: new Map(
      runGroupIndex.terminalRunGroups().map((runGroup) => [runGroup.runId, runGroup]),
    ),
    systemMessageByRowId: new Map(
      systemMessages.map((systemMessage) => [systemMessage.rowId, systemMessage]),
    ),
    childRunEntryByRowId: childRunIndex.childRunEntryByRowId(),
    handoffEntryByRowId: childRunIndex.handoffEntryByRowId(),
    replyRowIdsByFootRowId: new Map(
      [...replyRowIdsByFootRowId(rows)].map(([footRowId, rowIds]) => [
        footRowId,
        retention.retainReplyRowIds(footRowId, rowIds),
      ]),
    ),
    rows,
    // A run group with no terminal is a run the log has not seen end; the viewport asks the same
    // question before it prunes.
    hasActiveTurn: runGroupIndex.runGroups().length > runGroupIndex.terminalRunGroups().length,
  };
}

/**
 * Every row of a run group that has reached a terminal, asked of `terminalRunGroups()` so the fold
 * that decides a group is over and the one that collapses its rows are one fold.
 */
function collapsedRowIdsOf(runGroupIndex: RunGroupIndex): ReadonlySet<string> {
  const collapsed = new Set<string>();
  for (const runGroup of runGroupIndex.terminalRunGroups()) {
    for (const rowId of runGroup.rowIds) {
      collapsed.add(rowId);
    }
  }
  return collapsed;
}
