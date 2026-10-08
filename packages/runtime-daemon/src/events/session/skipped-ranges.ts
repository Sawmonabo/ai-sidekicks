// The damaged ranges a session continued past. Each `recovery.damaged_events_skipped` event names
// one, and every read of the session's events leaves the range out, so a damaged row stays in the
// log, is never rewritten, and is never read again.

import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";

/** The event that names a skipped range. */
export const DAMAGED_EVENTS_SKIPPED_TYPE: SessionEventType & "recovery.damaged_events_skipped" =
  "recovery.damaged_events_skipped";

/**
 * The SQL condition that holds for a `session_events` row, aliased `eventAlias` in the query,
 * unless the row sits in a range its session skipped. It probes the session's skip events
 * through the `(session_id, type)` index.
 */
export function outsideSkippedRangesSql(eventAlias: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM session_events AS skip
     WHERE skip.session_id = ${eventAlias}.session_id
       AND skip.type = '${DAMAGED_EVENTS_SKIPPED_TYPE}'
       AND ${eventAlias}.sequence BETWEEN json_extract(skip.payload, '$.fromSequence')
                                      AND json_extract(skip.payload, '$.toSequence'))`;
}
