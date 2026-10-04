// Reads one backward `timeline.read` window as the app's own event log. The store's log is
// `ProjectedSessionEvent` and no feature reads a wire shape, so this is the second decode boundary
// after `session-event-payload.ts`.
//
// A page is decoded into the log rather than shown as rows because the app projects the
// daemon's derived `summary`, `position` and `epoch` itself over the whole window it holds; a row
// spliced in with ordinals from another window would disagree with its neighbors. The decode is
// total: every member the log holds is required on the row except an optional `actor`, so no row is
// dropped. Whether more rows remain is the reply's `hasMore`, never inferred from a short page.

import type { TimelineReadResponse } from "@ai-sidekicks/contracts/timeline/operations";
import type { TimelineRow } from "@ai-sidekicks/contracts/timeline/row";

import type { ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";

/** One backward window, in the shape the store's log speaks. */
export interface EarlierTimelinePage {
  /**
   * The window's rows as app events, in the order the producer sent them. Not re-sorted: the
   * response schema already orders `entries` oldest to newest, and the store's merge orders what
   * it admits.
   */
  readonly events: readonly ProjectedSessionEvent[];
  /**
   * Whether rows remain before this window: the reply's `hasMore`, verbatim. Not derived from
   * `nextCursor`, because the terminal arm may carry a cursor too.
   */
  readonly hasEarlierRows: boolean;
  /**
   * Where this window ended, the position the next backward page is asked before. Present on every
   * continuing page and permitted on a terminal one. It is opaque: relayed verbatim or not at all
   * (`store/session/timeline-resume.ts`).
   */
  readonly nextBeforeCursor: string | undefined;
}

/**
 * Reads one backward `timeline.read` window into the app's event log. It takes the parsed
 * response because `callDaemon` has already held the reply to the registered schema.
 */
export function readEarlierTimelinePage(response: TimelineReadResponse): EarlierTimelinePage {
  return {
    events: response.entries.map(readTimelineRowAsEvent),
    hasEarlierRows: response.hasMore,
    nextBeforeCursor: response.nextCursor,
  };
}

/**
 * Reads one projected row back as the log entry it came from. `type` becomes `kind` and
 * `timestamp` becomes `occurredAt`; `actor` carries to `actorId`, and its absence stays absence.
 * `payload` is spread, not carried by reference, because the rollback arm's payload is a typed
 * event while the store's log holds a keyed record.
 */
function readTimelineRowAsEvent(row: TimelineRow): ProjectedSessionEvent {
  return {
    id: row.id,
    sessionId: row.sessionId,
    sequence: row.sequence,
    kind: row.type,
    occurredAt: row.timestamp,
    ...(row.actor === undefined ? {} : { actorId: row.actor }),
    payload: { ...row.payload },
  };
}
