// Reads one `transcript.read` window, backward or forward, as the app's own event log. The store's
// log is `ProjectedSessionEvent` and no feature reads a wire shape, so this is the second decode
// boundary after `session/event/payload.ts`.
//
// The app takes the daemon's stamps rather than projecting them: a row of a run carries its turn
// position, epoch and superseded marker onto the event as its run stamp, exactly as a stream change
// carries the stamp the daemon gave it, so a row read and a row streamed say the same thing. The
// decode is total: every member the log holds is required on the row except an optional `actor`,
// so no row is dropped. Whether more rows lie beyond the window is the reply's `hasMore`, never
// inferred from a short page.

import type { TranscriptReadResponse } from "@ai-sidekicks/contracts/transcript/operations";
import type {
  TranscriptEventRow,
  TranscriptRunStamp,
} from "@ai-sidekicks/contracts/transcript/row";

import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import type { TranscriptWindowEdge } from "#renderer/store/session/state.js";

/** One read window, in the shape the store's log speaks. */
export interface TranscriptPage {
  /**
   * The window's rows as app events, oldest to newest as the response schema orders them. Not
   * re-sorted: the store's merges order what they admit.
   */
  readonly events: readonly ProjectedSessionEvent[];
  /**
   * The far edge of the window: the reply's `nextCursor`, relayed verbatim, which the next read in
   * the same direction is asked with, and its `hasMore`, verbatim. `hasMore` is never derived from
   * the cursor, because the terminal arm may carry a cursor too.
   */
  readonly edge: TranscriptWindowEdge;
}

/**
 * Reads one `transcript.read` window into the app's event log. It takes the parsed response
 * because `callDaemon` has already held the reply to the registered schema.
 */
export function readTranscriptPage(response: TranscriptReadResponse): TranscriptPage {
  return {
    events: response.entries.map(readTranscriptEventRowAsEvent),
    edge: { cursor: response.nextCursor, hasMore: response.hasMore },
  };
}

/**
 * Reads one projected row back as the log entry it came from, at the cursor the row was stored
 * at, so a link naming the message by its cursor finds it. `type` becomes `kind` and
 * `timestamp` becomes `occurredAt`; `actor` carries to `actorId`, and its absence stays absence.
 * `payload` is spread, not carried by reference, because the rollback arm's payload is a typed
 * event while the store's log holds a keyed record.
 */
function readTranscriptEventRowAsEvent(row: TranscriptEventRow): ProjectedSessionEvent {
  const runStamp = runStampOf(row);
  return {
    id: row.id,
    sessionId: row.sessionId,
    sequence: row.sequence,
    cursor: row.cursor,
    kind: row.type,
    occurredAt: row.timestamp,
    ...(row.actor === undefined ? {} : { actorId: row.actor }),
    payload: { ...row.payload },
    ...(runStamp === undefined ? {} : { runStamp }),
  };
}

/** The run stamp a row of a run carries, or `undefined` on a general row, which names no run. */
function runStampOf(row: TranscriptEventRow): TranscriptRunStamp | undefined {
  if (row.kind === "general") {
    return undefined;
  }
  return {
    position: row.position,
    epoch: row.epoch,
    ...(row.superseded === undefined ? {} : { superseded: row.superseded }),
  };
}
