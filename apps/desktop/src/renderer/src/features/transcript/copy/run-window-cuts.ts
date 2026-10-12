// The rows a long run's window cuts, which a copy reads in place of the edge lines that stand for
// them: a copy over a run takes every row of it in reading order, as a copy of the conversation
// does, never the edge line's count. A selection that reaches an edge line takes the whole stretch
// the line stands for.

import { readRunWindowEdgeKey, type RunWindowEdgeRow } from "../runs/call-window.js";
import { type TranscriptWindowModel } from "../window/transcript-window.js";

/** Whether any of `rowKeys` is the edge line of a run's window in `drawnWindow`. */
export function hasRunWindowEdge(
  rowKeys: readonly string[],
  drawnWindow: TranscriptWindowModel,
): boolean {
  return rowKeys.some(
    (rowKey) => readRunWindowEdgeKey(rowKey, drawnWindow.runGroupByHeaderKey) !== undefined,
  );
}

/**
 * `rowKeys`, drawn from `drawnWindow`, with each edge line of a run's window in place of the drawn
 * rows of its run group the window cut on that side, in reading order. The keys come back as they
 * are when none is an edge line.
 */
export function rowKeysWithRunWindowCuts(
  rowKeys: readonly string[],
  drawnWindow: TranscriptWindowModel,
): readonly string[] {
  if (!hasRunWindowEdge(rowKeys, drawnWindow)) {
    return rowKeys;
  }
  return rowKeys.flatMap((rowKey) => {
    const edgeRow = readRunWindowEdgeKey(rowKey, drawnWindow.runGroupByHeaderKey);
    return edgeRow === undefined ? [rowKey] : cutRowIdsOf(edgeRow, drawnWindow);
  });
}

/**
 * The drawn rows of an edge line's run group the window cut on the line's side: those before the
 * first one `drawnWindow` holds, or after the last.
 */
function cutRowIdsOf(
  { runGroup, edge }: RunWindowEdgeRow,
  drawnWindow: TranscriptWindowModel,
): string[] {
  const drawnRowIds = runGroup.drawnRowPositions.flatMap(
    (position) => runGroup.rowIds[position] ?? [],
  );
  const isCut = (rowId: string): boolean => !drawnWindow.rowsByKey.has(rowId);
  if (edge === "earlier") {
    const firstHeld = drawnRowIds.findIndex((rowId) => !isCut(rowId));
    return drawnRowIds.slice(0, firstHeld === -1 ? drawnRowIds.length : firstHeld);
  }
  const lastHeld = drawnRowIds.findLastIndex((rowId) => !isCut(rowId));
  return drawnRowIds.slice(lastHeld + 1);
}
