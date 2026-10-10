// The rows of the log one row of a window is drawn from: a run group's header from every row of its
// group, a reply's foot from every row of the reply, and a child run's summary from the child's own
// rows; any other row from its own event.

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

import { type TranscriptWindowModel } from "./transcript-window.js";

/** The windows a row's sources are read from: the log unfolded, and as the feed draws it. */
export interface RowSourceWindows {
  /** Every row of every run group, before any fold. */
  readonly unfurledWindow: TranscriptWindowModel;
  /** The window the rows are keyed by: folded by run group, holding the rows the feed draws. */
  readonly transcriptWindow: TranscriptWindowModel;
}

/** The oldest and newest row one row of the window is drawn from. */
export interface RowSourceSpan {
  readonly first: TranscriptEventRow;
  readonly last: TranscriptEventRow;
}

/**
 * Reads a window row's key as the span of rows it is drawn from, or `undefined` for a key the log
 * no longer carries. Each child run's span is gathered once, on the first key that asks for one.
 */
export function rowSourceSpanReader(
  sources: RowSourceWindows,
): (rowKey: string) => RowSourceSpan | undefined {
  const { unfurledWindow, transcriptWindow } = sources;
  let spanByRunId: ReadonlyMap<string, RowSourceSpan> | undefined;
  const runSpan = (runId: string): RowSourceSpan | undefined => {
    spanByRunId ??= runSpans(unfurledWindow.rows);
    return spanByRunId.get(runId);
  };
  return (rowKey) => {
    const runGroup = transcriptWindow.runGroupByHeaderKey.get(rowKey);
    if (runGroup !== undefined) {
      return runGroupSpan(runGroup.rowIds, unfurledWindow.rowsByKey);
    }
    const row = unfurledWindow.rowsByKey.get(rowKey);
    if (row === undefined) {
      return undefined;
    }
    const replyRows = (transcriptWindow.replyRowIdsByFootRowId.get(rowKey) ?? []).flatMap(
      (replyRowId) => unfurledWindow.rowsByKey.get(replyRowId) ?? [],
    );
    const childRun =
      row.kind === "run" && row.childRunSummary !== undefined
        ? runSpan(row.childRunSummary.runId)
        : undefined;
    return widestSpan([
      { first: row, last: row },
      ...replyRows.map((replyRow) => ({ first: replyRow, last: replyRow })),
      ...(childRun === undefined ? [] : [childRun]),
    ]);
  };
}

/** A run group's first and last row, or `undefined` when the log holds neither. */
function runGroupSpan(
  rowIds: readonly string[],
  rowsByKey: ReadonlyMap<string, TranscriptEventRow>,
): RowSourceSpan | undefined {
  const firstRowId = rowIds[0];
  const lastRowId = rowIds.at(-1);
  const first = firstRowId === undefined ? undefined : rowsByKey.get(firstRowId);
  const last = lastRowId === undefined ? undefined : rowsByKey.get(lastRowId);
  return first === undefined || last === undefined ? undefined : { first, last };
}

/** Each run's oldest and newest row in the log. */
function runSpans(rows: readonly TranscriptEventRow[]): ReadonlyMap<string, RowSourceSpan> {
  const spanByRunId = new Map<string, RowSourceSpan>();
  for (const row of rows) {
    if (row.kind === "general") {
      continue;
    }
    const runId = row.runId;
    const span = spanByRunId.get(runId);
    spanByRunId.set(runId, span === undefined ? { first: row, last: row } : { ...span, last: row });
  }
  return spanByRunId;
}

/** The span from the oldest first row to the newest last row of `spans`, never empty. */
function widestSpan(spans: readonly [RowSourceSpan, ...RowSourceSpan[]]): RowSourceSpan {
  return spans.reduce((widest, span) => ({
    first: span.first.sequence < widest.first.sequence ? span.first : widest.first,
    last: span.last.sequence > widest.last.sequence ? span.last : widest.last,
  }));
}
