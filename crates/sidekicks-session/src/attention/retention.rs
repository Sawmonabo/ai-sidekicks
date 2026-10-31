//! How long the attention entries are kept: each session keeps a cut, a sequence of its log that
//! only moves up, and an entry at or under the cut goes once nothing reads it any more, which is
//! when it is resolved or, for an entry that never blocks on the person, seen by its subject, and
//! its web-address message is not still to send. An open wait never goes, and a send still to go
//! holds back only its own entry.
//!
//! The rule is one statement set, run wherever an entry can come to meet it: the write that moves
//! the cut, each write that resolves entries, which a rebuild's fold replays, and the seen write.
//! So the entries the live writes keep are the entries a rebuild of the same log keeps.
//!
//! A provider's build moved to leaves the list a day after it was recorded, by the same age, on its
//! day through the wall clock's timer and in each write that moves the cut; a build only available
//! never leaves on a timer.

use std::sync::LazyLock;

use jiff::{SignedDuration, Timestamp};
use rusqlite::Connection;
use rusqlite::types::Value;
use sidekicks_contracts::attention::{AttentionSeverity, AttentionWebAddressState};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_provider::build_record::{is_retirement_due, listed_builds, retirement_statements};
use sidekicks_store::database::statement::WriteStatement;

use crate::attention::projection::{binding, session_binding, statement, version_bump_sql};
use crate::attention::provider_build::record_change_statements;

/// How old a session's events are before the cut may pass them; an entry past the cut whose
/// web-address message is still to send stays until the send is decided.
const RETENTION_AGE: SignedDuration = SignedDuration::from_hours(24);

// How far past its day a build's retirement is armed: one step of a stored instant, since a line
// retires only once recorded strictly before the day's start.
const RETIREMENT_STEP: SignedDuration = SignedDuration::from_millis(1);

/// The sequence of the event that raised the `attention_entries` row a statement reads, as an SQL
/// expression.
pub(crate) const ENTRY_SEQUENCE: &str =
    "(SELECT sequence FROM session_events WHERE id = attention_entries.source_event_id)";

/// Whether the entry `entry` names, raised by the event at `sequence`, is seen: its subject's mark
/// is at or past that sequence. The subject is the session for an agent run's or a plan's entry
/// and the workflow run for a workflow's. Both are SQL expressions of the statement the condition
/// sits in.
pub(crate) fn seen_entry_sql(entry: &str, sequence: &str) -> String {
    format!(
        "EXISTS (SELECT 1 FROM attention_seen AS mark
   WHERE mark.session_id = {entry}.session_id
     AND mark.run_id = COALESCE({entry}.workflow_run_id, '')
     AND mark.seen_through_sequence >= {sequence})"
    )
}

// The session's entries past its cut that nothing reads: resolved, or informational and seen by
// their subject, with no web-address message still to send.
static RETIRED_ENTRIES: LazyLock<String> = LazyLock::new(|| {
    format!(
        "attention_entries.session_id = @session_id
  AND {ENTRY_SEQUENCE} <= (SELECT retained_through_sequence FROM attention_versions
                            WHERE scope_key = @session_id)
  AND (attention_entries.resolved_at IS NOT NULL
       OR (attention_entries.severity = '{informational}' AND {seen}))
  AND NOT EXISTS (SELECT 1 FROM attention_deliveries AS send
                   WHERE send.entry_id = attention_entries.id
                     AND send.web_address_state = '{pending}')",
        informational = <&'static str>::from(AttentionSeverity::Informational),
        seen = seen_entry_sql("attention_entries", ENTRY_SEQUENCE),
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
    let retained_before = retained_before(now);
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

/// The write that retires every provider build moved to that was recorded more than a day before
/// `now`, read on `reader`, with the bump of the machine's count; empty when none is due, so a pass
/// that retires nothing wakes no follower. `now` is the caller's clock. Fails when the read fails.
pub(crate) fn provider_build_retirement_statements(
    reader: &Connection,
    now: Timestamp,
) -> rusqlite::Result<Vec<WriteStatement>> {
    let before = retained_before(now);
    if !is_retirement_due(reader, &before)? {
        return Ok(Vec::new());
    }
    let at = WireInstant::from_timestamp(now).expect("the clock's instant is after year 0000");
    let mut statements = record_change_statements();
    statements.extend(retirement_statements(&before, &at));
    Ok(statements)
}

/// The first instant at which a listed provider build moved to is due to retire, read on `reader`:
/// one millisecond past a day after the earliest was recorded; `None` while none is listed. Fails
/// when the read fails.
pub(crate) fn next_provider_build_retirement(
    reader: &Connection,
) -> rusqlite::Result<Option<Timestamp>> {
    Ok(listed_builds(reader)?
        .into_iter()
        .filter(|build| build.from_version.is_some())
        .filter_map(|build| build.recorded_at.timestamp())
        .min()
        .and_then(|recorded_at| {
            recorded_at
                .checked_add(RETENTION_AGE + RETIREMENT_STEP)
                .ok()
        }))
}

// A day before `now`, the age past which the cut and a moved-to build's line may go.
fn retained_before(now: Timestamp) -> WireInstant {
    now.checked_sub(RETENTION_AGE)
        .ok()
        .and_then(WireInstant::from_timestamp)
        .expect("a day before the clock's instant is after year 0000")
}
