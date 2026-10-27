//! The damaged ranges a session continued past. Each `session.damagedEvents.skipped` event names
//! one, and every read of the session's events leaves the range out, so a damaged row stays in the
//! log, is never rewritten, and is never read again.

use sidekicks_contracts::event::registry::SessionEventType;

/// The event that names a skipped range.
pub const DAMAGED_EVENTS_SKIPPED_TYPE: SessionEventType =
    SessionEventType::SessionDamagedEventsSkipped;

/// The SQL condition that holds for a `session_events` row, aliased `event_alias` in the query,
/// unless the row sits in a range its session skipped. It reads the sessions holding a skip once
/// per statement through the partial index of skip events, and probes the ranges of those sessions
/// alone, through the `(session_id, type)` index.
pub fn outside_skipped_ranges_sql(event_alias: &str) -> String {
    let skip_type = DAMAGED_EVENTS_SKIPPED_TYPE.as_str();
    format!(
        "({event_alias}.session_id NOT IN (
      SELECT session_id FROM session_events WHERE type = '{skip_type}')
    OR NOT EXISTS (
      SELECT 1 FROM session_events AS skip
       WHERE skip.session_id = {event_alias}.session_id
         AND skip.type = '{skip_type}'
         AND {event_alias}.sequence BETWEEN json_extract(skip.payload, '$.fromSequence')
                                        AND json_extract(skip.payload, '$.toSequence')))"
    )
}
