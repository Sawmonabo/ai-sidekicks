import { useCallback, useEffect, useState } from "react";

import { type TimelineRow } from "@ai-sidekicks/contracts";

/**
 * Holds a jump until the row it names is one the viewport holds, then spends it.
 *
 * One request at a time, last one wins. There is no timeout: a deadline would abandon a jump
 * just as a slow widening delivers the row. A held request is dropped during render once
 * `questionRowId` stops naming its row, so a later widening cannot scroll the reader away.
 */
export function useDeferredRowJump(inputs: {
  readonly visibleRows: readonly TimelineRow[];
  readonly jumpToRow: (rowId: string) => void;
  /** The row the transcript's current question names: `jumpOutcomeRowId`'s answer. */
  readonly questionRowId: string | undefined;
}): (rowId: string) => void {
  const { visibleRows, jumpToRow, questionRowId } = inputs;
  const [requestedRowId, setRequestedRowId] = useState<string | undefined>(undefined);
  // Adjusted during render, so the request is gone before the effect could spend it.
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
    // Cleared before the jump, so a republished snapshot does not jump a second time.
    setRequestedRowId(undefined);
    jumpToRow(requestedRowId);
  }, [requestedRowId, visibleRows, jumpToRow]);
  return useCallback((rowId: string) => {
    setRequestedRowId(rowId);
  }, []);
}
