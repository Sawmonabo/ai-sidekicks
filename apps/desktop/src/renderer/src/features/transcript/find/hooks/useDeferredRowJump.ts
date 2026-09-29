import { useCallback, useEffect, useState } from "react";

import { type TimelineRow } from "@ai-sidekicks/contracts";

/**
 * Hold a jump until the row it names is one the viewport holds, then spend it.
 *
 * ONE REQUEST AT A TIME, last one wins: a second ask is a person having changed
 * their mind, and queueing the first would scroll them somewhere they had already
 * moved on from. A request whose row never becomes reachable simply never spends —
 * it costs one comparison per reconcile and nothing else, and there is deliberately
 * no timeout, because a deadline here would abandon a jump exactly when a slow
 * widening finally delivered the row.
 *
 * And it dies with the question that asked it: `questionRowId` is the row the transcript
 * is currently being asked about, and a held request no longer about that row is
 * abandoned during render rather than spent later, when a window widening minutes later
 * would scroll the reader away from what they were reading.
 */
export function useDeferredRowJump(inputs: {
  readonly visibleRows: readonly TimelineRow[];
  readonly jumpToRow: (rowId: string) => void;
  /** The row the transcript's current question names: `jumpOutcomeRowId`'s answer. */
  readonly questionRowId: string | undefined;
}): (rowId: string) => void {
  const { visibleRows, jumpToRow, questionRowId } = inputs;
  const [requestedRowId, setRequestedRowId] = useState<string | undefined>(undefined);
  // Adjusted during render rather than in an effect, so the request is gone before
  // the effect below could spend it against a window that widened in the same pass.
  if (requestedRowId !== undefined && requestedRowId !== questionRowId) {
    setRequestedRowId(undefined);
  }
  useEffect(() => {
    if (requestedRowId === undefined) {
      return;
    }
    if (!visibleRows.some((row) => row.id === requestedRowId)) {
      return;
    }
    // Cleared before the jump, so a scroll that republishes the snapshot re-runs
    // this effect against no request rather than jumping a second time.
    setRequestedRowId(undefined);
    jumpToRow(requestedRowId);
  }, [requestedRowId, visibleRows, jumpToRow]);
  return useCallback((rowId: string) => {
    setRequestedRowId(rowId);
  }, []);
}
