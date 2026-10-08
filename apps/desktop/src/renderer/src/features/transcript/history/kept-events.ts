// Which of the store's events stay once the viewport's window lets rows go: every event a row the
// window still holds is drawn from, and everything between them. A run group's header is drawn
// from its whole run, a reply's foot from every row of the reply, and a child run's summary from
// the child's own rows; any other row from its own event. Only an edge the window let rows go past
// moves, so an event that arrived after the pass, or a page that landed before the next one, stays.

import type { EventCursor } from "@ai-sidekicks/contracts/session/event-cursor";
import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

import { heldIdAsWireId } from "#renderer/services/daemon/wire/identifiers.js";
import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { readRunGroupKey } from "../runs/groups.js";
import { type ViewportRow } from "../viewport/snapshot.js";
import { type PruneOutcome } from "../viewport/window-cap.js";
import { type TranscriptWindowModel } from "../window/transcript-window.js";

/** The first and last event the store keeps, by sequence; it lets go of every event outside. */
export interface KeptEventCursors {
  readonly firstKeptCursor: EventCursor;
  readonly lastKeptCursor: EventCursor;
}

/** Where a window's rows are drawn from: the log, unfolded and as the feed draws it. */
export interface KeptEventSources {
  /** Every row of every run group, before any fold. */
  readonly unfurledWindow: TranscriptWindowModel;
  /** The window the viewport draws: folded by run group, holding only rows the feed draws. */
  readonly transcriptWindow: TranscriptWindowModel;
  /** The store's log as it stands now. */
  readonly log: readonly ProjectedSessionEvent[];
}

/**
 * The events the store keeps after `prune` let rows go, or `undefined` when nothing it held lies
 * past an edge the pass cut. `heldRows` are the rows the window holds after the pass.
 */
export function keptEventCursors(
  prune: PruneOutcome,
  heldRows: readonly ViewportRow[],
  sources: KeptEventSources,
): KeptEventCursors | undefined {
  const spanOf = sourceSpanReader(sources);
  let first: TranscriptEventRow | undefined;
  let last: TranscriptEventRow | undefined;
  for (const heldRow of heldRows) {
    const span = spanOf(heldRow.key);
    if (span === undefined) {
      continue;
    }
    first = first === undefined || span.first.sequence < first.sequence ? span.first : first;
    last = last === undefined || span.last.sequence > last.sequence ? span.last : last;
  }
  const oldest = sources.log[0];
  const newest = sources.log[sources.log.length - 1];
  if (first === undefined || last === undefined || oldest === undefined || newest === undefined) {
    return undefined;
  }
  const prunedSpans = prune.prunedKeys.flatMap((rowKey) => spanOf(rowKey) ?? []);
  const keptFirst = first;
  const keptLast = last;
  const isHeadLetGo = prunedSpans.some((span) => span.first.sequence < keptFirst.sequence);
  const isTailLetGo = prunedSpans.some((span) => span.last.sequence > keptLast.sequence);
  if (!isHeadLetGo && !isTailLetGo) {
    return undefined;
  }
  return {
    firstKeptCursor: isHeadLetGo ? keptFirst.cursor : heldIdAsWireId(oldest.cursor),
    lastKeptCursor: isTailLetGo ? keptLast.cursor : heldIdAsWireId(newest.cursor),
  };
}

/** The oldest and newest row one row of the window is drawn from. */
interface SourceSpan {
  readonly first: TranscriptEventRow;
  readonly last: TranscriptEventRow;
}

/**
 * Reads a window row's key as the span of rows it is drawn from, or `undefined` for a key the log
 * no longer carries. Each run's span is gathered once, on the first key that asks for one.
 */
function sourceSpanReader(sources: KeptEventSources): (rowKey: string) => SourceSpan | undefined {
  const { unfurledWindow, transcriptWindow } = sources;
  let spanByRunId: ReadonlyMap<string, SourceSpan> | undefined;
  const runSpan = (runId: string): SourceSpan | undefined => {
    spanByRunId ??= runSpans(unfurledWindow.rows);
    return spanByRunId.get(runId);
  };
  return (rowKey) => {
    if (transcriptWindow.runGroupByHeaderKey.has(rowKey)) {
      return runSpan(rowKey);
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

/** Each run's oldest and newest row in the log. */
function runSpans(rows: readonly TranscriptEventRow[]): ReadonlyMap<string, SourceSpan> {
  const spanByRunId = new Map<string, SourceSpan>();
  for (const row of rows) {
    const runId = readRunGroupKey(row);
    if (runId === undefined) {
      continue;
    }
    const span = spanByRunId.get(runId);
    spanByRunId.set(runId, span === undefined ? { first: row, last: row } : { ...span, last: row });
  }
  return spanByRunId;
}

/** The span from the oldest first row to the newest last row of `spans`, never empty. */
function widestSpan(spans: readonly [SourceSpan, ...SourceSpan[]]): SourceSpan {
  return spans.reduce((widest, span) => ({
    first: span.first.sequence < widest.first.sequence ? span.first : widest.first,
    last: span.last.sequence > widest.last.sequence ? span.last : widest.last,
  }));
}
