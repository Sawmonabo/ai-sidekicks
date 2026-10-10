// Which of the store's events stay once the viewport's window lets rows go: every event a row the
// window still holds is drawn from (`row-sources.ts`), and everything between them. Only an edge
// the window let rows go past moves, so an event that arrived after the pass, or a page that
// landed before the next one, stays.

import type { EventCursor } from "@ai-sidekicks/contracts/session/event-cursor";
import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

import { heldIdAsWireId } from "#renderer/services/daemon/wire/identifiers.js";
import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { type ViewportRow } from "../viewport/snapshot.js";
import { type PruneOutcome } from "../viewport/window-cap.js";
import { rowSourceSpanReader, type RowSourceWindows } from "../window/row-sources.js";

/** The first and last event the store keeps, by sequence; it lets go of every event outside. */
export interface KeptEventCursors {
  readonly firstKeptCursor: EventCursor;
  readonly lastKeptCursor: EventCursor;
}

/** Where a window's rows are drawn from: the log, unfolded and as the feed draws it. */
export interface KeptEventSources extends RowSourceWindows {
  /** The store's log as it stands now. */
  readonly log: readonly ProjectedSessionEvent[];
}

/**
 * The events the store keeps after `prune` let rows go, or `undefined` when nothing it held lies
 * past an edge the pass cut. `heldRows` are the rows the window holds after the pass, and the rows
 * waiting to join it.
 */
export function keptEventCursors(
  prune: PruneOutcome,
  heldRows: readonly ViewportRow[],
  sources: KeptEventSources,
): KeptEventCursors | undefined {
  const spanOf = rowSourceSpanReader(sources);
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
