// Which of the store's events stay once the viewport's window lets rows go, or a long run's window
// leaves rows out: every event a row the window still holds is drawn from (`row-sources.ts`), and
// everything between them but the stretches of a run its window left out. Only an edge the window
// let rows go past, or a run's window left rows out past, moves, so an event that arrived after
// the pass, or a page that landed before the next one, stays. A run group's header keeps only the
// rows its window holds, and the calls read ahead past an edge line in the drawn band; a folded
// group's header keeps the rows of its whole stretch the log holds.

import type { EventCursor } from "@ai-sidekicks/contracts/session/event-cursor";

import { heldIdAsWireId } from "#renderer/services/daemon/wire/identifiers.js";
import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { type ReleasedStretchBounds } from "#renderer/store/session/transcript-window.js";
import { type RunCallWindow } from "../runs/call-window.js";
import { type RunGroup } from "../runs/groups.js";
import { type ViewportRow } from "../viewport/snapshot.js";
import {
  rowSourceSpanReader,
  type RowSourceSpan,
  type RowSourceWindows,
} from "../window/row-sources.js";

/**
 * The first and last event the store keeps, by sequence, and the stretches inside them it lets go;
 * it lets go of every event outside.
 */
export interface KeptEventCursors {
  readonly firstKeptCursor: EventCursor;
  readonly lastKeptCursor: EventCursor;
  readonly releasedBetween: readonly ReleasedStretchBounds[];
}

/** Where a window's rows are drawn from: the log, unfolded and as the feed draws it. */
export interface KeptEventSources extends RowSourceWindows {
  /** The store's log as it stands now. */
  readonly log: readonly ProjectedSessionEvent[];
  /**
   * An open run group's window as the feed last cut it, reaching on over the calls read ahead past
   * an edge line in the drawn band, or `undefined` for a folded group.
   */
  readonly callWindowOf: (runGroupKey: string) => RunCallWindow | undefined;
}

/**
 * The events the store keeps once the window let go of the rows `letGoRowKeys` names, by one pass
 * or several, and the runs' windows left rows out, or `undefined` when nothing it held lies past
 * an edge those passes or windows cut. `heldRows` are the rows the window holds now, and the rows
 * waiting to join it.
 */
export function keptEventCursors(
  letGoRowKeys: readonly string[],
  heldRows: readonly ViewportRow[],
  sources: KeptEventSources,
): KeptEventCursors | undefined {
  const spanOf = rowSourceSpanReader(sources);
  const heldSpans: RowSourceSpan[] = [];
  const cutSpans: RowSourceSpan[] = [];
  for (const heldRow of heldRows) {
    const runGroup = sources.transcriptWindow.runGroupByHeaderKey.get(heldRow.key);
    const held =
      runGroup === undefined ? spanOf(heldRow.key) : runGroupHeldSpan(runGroup, sources, cutSpans);
    if (held !== undefined) {
      heldSpans.push(held);
    }
  }
  const { log } = sources;
  const oldest = log[0];
  const newest = log.at(-1);
  const first = heldSpans.reduce<RowSourceSpan["first"] | undefined>(
    (lowest, span) =>
      lowest === undefined || span.first.sequence < lowest.sequence ? span.first : lowest,
    undefined,
  );
  const last = heldSpans.reduce<RowSourceSpan["last"] | undefined>(
    (highest, span) =>
      highest === undefined || span.last.sequence > highest.sequence ? span.last : highest,
    undefined,
  );
  if (first === undefined || last === undefined || oldest === undefined || newest === undefined) {
    return undefined;
  }
  const prunedSpans = [...letGoRowKeys.flatMap((rowKey) => spanOf(rowKey) ?? []), ...cutSpans];
  const isHeadLetGo = prunedSpans.some((span) => span.first.sequence < first.sequence);
  const isTailLetGo = prunedSpans.some((span) => span.last.sequence > last.sequence);
  const stretches = releasedStretchesOf(cutSpans, heldSpans, log, first.sequence, last.sequence);
  if (!isHeadLetGo && !isTailLetGo && stretches.length === 0) {
    return undefined;
  }
  return {
    firstKeptCursor: isHeadLetGo ? first.cursor : heldIdAsWireId(oldest.cursor),
    lastKeptCursor: isTailLetGo ? last.cursor : heldIdAsWireId(newest.cursor),
    releasedBetween: stretches.map(({ before, after }) => ({
      lastHeldCursorBefore: heldIdAsWireId(before.cursor),
      firstHeldCursorAfter: heldIdAsWireId(after.cursor),
    })),
  };
}

/**
 * A held header's span: the rows its open window holds, adding the stretches its window left out
 * to `cutSpans`, or every row of a folded group the log holds; `undefined` for a group the log
 * holds no row of.
 */
function runGroupHeldSpan(
  runGroup: RunGroup,
  sources: KeptEventSources,
  cutSpans: RowSourceSpan[],
): RowSourceSpan | undefined {
  const rowsByKey = sources.unfurledWindow.rowsByKey;
  const spanBetween = (firstPosition: number, lastPosition: number): RowSourceSpan | undefined => {
    const firstRowId = runGroup.rowIds[firstPosition];
    const lastRowId = runGroup.rowIds[lastPosition];
    const firstRow = firstRowId === undefined ? undefined : rowsByKey.get(firstRowId);
    const lastRow = lastRowId === undefined ? undefined : rowsByKey.get(lastRowId);
    return firstRow === undefined || lastRow === undefined || firstPosition > lastPosition
      ? undefined
      : { first: firstRow, last: lastRow };
  };
  const lastPosition = runGroup.rowIds.length - 1;
  const window = sources.callWindowOf(runGroup.key);
  if (window === undefined) {
    return spanBetween(0, lastPosition);
  }
  for (const cut of [
    spanBetween(0, window.firstRowPosition - 1),
    spanBetween(window.lastRowPosition + 1, lastPosition),
  ]) {
    if (cut !== undefined) {
      cutSpans.push(cut);
    }
  }
  return spanBetween(window.firstRowPosition, window.lastRowPosition);
}

/** Two held events of the log and every event between them, which the store lets go. */
interface HeldStretchBounds {
  readonly before: ProjectedSessionEvent;
  readonly after: ProjectedSessionEvent;
}

/**
 * The stretches strictly inside the kept span that the runs' windows left out and no held row is
 * drawn from, each bounded by two events the store keeps; stretches with no event between them
 * are one.
 */
function releasedStretchesOf(
  cutSpans: readonly RowSourceSpan[],
  heldSpans: readonly RowSourceSpan[],
  log: readonly ProjectedSessionEvent[],
  firstKeptSequence: number,
  lastKeptSequence: number,
): readonly HeldStretchBounds[] {
  // Each cut span's sequences inside the kept span, less every held row's.
  const intervals = cutSpans.flatMap((cut) =>
    heldSpans.reduce<readonly SequenceInterval[]>(
      (remaining, held) => remaining.flatMap((interval) => intervalOutside(interval, held)),
      [
        {
          from: Math.max(cut.first.sequence, firstKeptSequence + 1),
          to: Math.min(cut.last.sequence, lastKeptSequence - 1),
        },
      ],
    ),
  );
  // Each interval as the log positions it holds, in log order, merged where no event parts them.
  const positionRanges = intervals
    .map(({ from, to }) => ({
      first: log.findIndex((event) => event.sequence >= from),
      last: log.findLastIndex((event) => event.sequence <= to),
    }))
    .filter(({ first, last }) => first !== -1 && first <= last)
    .toSorted((left, right) => left.first - right.first);
  const merged: { first: number; last: number }[] = [];
  for (const range of positionRanges) {
    const previous = merged.at(-1);
    if (previous !== undefined && range.first <= previous.last + 1) {
      previous.last = Math.max(previous.last, range.last);
    } else {
      merged.push({ ...range });
    }
  }
  return merged.flatMap(({ first, last }) => {
    const before = log[first - 1];
    const after = log[last + 1];
    return before === undefined || after === undefined ? [] : [{ before, after }];
  });
}

/** A closed run of sequences. */
interface SequenceInterval {
  readonly from: number;
  readonly to: number;
}

/** The parts of `interval` before and after the sequences `held` spans. */
function intervalOutside(interval: SequenceInterval, held: RowSourceSpan): SequenceInterval[] {
  return [
    ...(held.first.sequence > interval.from
      ? [{ from: interval.from, to: Math.min(interval.to, held.first.sequence - 1) }]
      : []),
    ...(held.last.sequence < interval.to
      ? [{ from: Math.max(interval.from, held.last.sequence + 1), to: interval.to }]
      : []),
  ].filter(({ from, to }) => from <= to);
}
