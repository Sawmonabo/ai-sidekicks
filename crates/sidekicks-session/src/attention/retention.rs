//! How long the attention entries are kept: each session keeps a cut, a sequence of its log that
//! only moves up, and an entry at or under the cut goes once nothing reads it any more, which is
//! when it is resolved or, for an entry that never blocks on the person, seen by its subject, and
//! its web-address message is not still to send. An open wait never goes, and a send still to go
//! holds back only its own entry.
//!
//! The rule is one statement set, run wherever an entry can come to meet it: the write that moves
//! the cut, each write that resolves entries, which a rebuild's fold replays, and the seen write.
//! So the entries the live writes keep are the entries a rebuild of the same log keeps.

use std::sync::LazyLock;

use jiff::{SignedDuration, Timestamp};
use rusqlite::types::Value;
use sidekicks_contracts::attention::{AttentionSeverity, AttentionWebAddressState};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_store::database::statement::WriteStatement;

use crate::attention::projection::{binding, session_binding, statement, version_bump_sql};

/// How old a session's events are before the cut may pass them; an entry past the cut whose
/// web-address message is still to send stays until the send is decided.
const RETENTION_AGE: SignedDuration = SignedDuration::from_hours(24);

// The sequence of the event that raised the `attention_entries` row a statement reads.
const ENTRY_SEQUENCE: &str =
    "(SELECT sequence FROM session_events WHERE id = attention_entries.source_event_id)";

// The session's entries past its cut that nothing reads: resolved, or informational and seen by
// their subject, the session for an agent run's or a plan's entry and the workflow run for a
// workflow's, with no web-address message still to send.
static RETIRED_ENTRIES: LazyLock<String> = LazyLock::new(|| {
    format!(
        "attention_entries.session_id = @session_id
  AND {ENTRY_SEQUENCE} <= (SELECT retained_through_sequence FROM attention_versions
                            WHERE scope_key = @session_id)
  AND (attention_entries.resolved_at IS NOT NULL
       OR (attention_entries.severity = '{informational}'
           AND EXISTS (SELECT 1 FROM attention_seen
                        WHERE attention_seen.session_id = attention_entries.session_id
                          AND attention_seen.run_id = COALESCE(attention_entries.workflow_run_id, '')
                          AND attention_seen.seen_through_sequence >= {ENTRY_SEQUENCE})))
  AND NOT EXISTS (SELECT 1 FROM attention_deliveries AS send
                   WHERE send.entry_id = attention_entries.id
                     AND send.web_address_state = '{pending}')",
        informational = <&'static str>::from(AttentionSeverity::Informational),
        pending = <&'static str>::from(AttentionWebAddressState::Pending),
    )
});

static BUMP_IF_RETIRED_SQL: LazyLock<String> = LazyLock::new(|| {
    version_bump_sql(&format!(
        "EXISTS (SELECT 1 FROM attention_entries WHERE {})",
        *RETIRED_ENTRIES
    ))
});

static DELETE_RETIRED_DELIVERIES_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "DELETE FROM attention_deliveries
  WHERE entry_id IN (SELECT id FROM attention_entries WHERE {})",
        *RETIRED_ENTRIES
    )
});

static DELETE_RETIRED_ENTRIES_SQL: LazyLock<String> =
    LazyLock::new(|| format!("DELETE FROM attention_entries WHERE {}", *RETIRED_ENTRIES));

// The cut moves to the last event before the first one at or after `@retained_before`, read
// upward from the cut it stands at, so each event is passed over once and the cut never falls:
// the read starts past the stored cut and falls back to the session's newest event.
// A session with entries has its counts' row, which the raise that made them wrote.
const ADVANCE_CUT_SQL: &str = "UPDATE attention_versions
  SET retained_through_sequence = COALESCE(
    (SELECT sequence - 1 FROM session_events
      WHERE session_id = @session_id
        AND sequence > COALESCE(attention_versions.retained_through_sequence, -1)
        AND occurred_at >= @retained_before
      ORDER BY sequence LIMIT 1),
    (SELECT MAX(sequence) FROM session_events WHERE session_id = @session_id))
  WHERE scope_key = @session_id";

/// The statements that delete the session's entries past its cut that nothing reads, with their
/// deliveries, raising the counts when one goes; the last statements of every write that can
/// leave an entry meeting the rule.
pub(crate) fn retention_statements(session_id: SessionId) -> Vec<WriteStatement> {
    [
        &*BUMP_IF_RETIRED_SQL,
        &*DELETE_RETIRED_DELIVERIES_SQL,
        &*DELETE_RETIRED_ENTRIES_SQL,
    ]
    .into_iter()
    .map(|sql| statement(sql, vec![session_binding(session_id)]))
    .collect()
}

/// The write that moves the session's cut up to its last event a day older than `now`, then
/// applies the rule under the new cut. `now` is the caller's clock: nothing here reads one.
pub fn advance_retention_statements(session_id: SessionId, now: Timestamp) -> Vec<WriteStatement> {
    let retained_before = now
        .checked_sub(RETENTION_AGE)
        .ok()
        .and_then(WireInstant::from_timestamp)
        .expect("a day before the clock's instant is after year 0000");
    let mut statements = vec![statement(
        ADVANCE_CUT_SQL,
        vec![
            session_binding(session_id),
            binding(
                "@retained_before",
                Value::Text(retained_before.as_str().to_owned()),
            ),
        ],
    )];
    statements.extend(retention_statements(session_id));
    statements
}
