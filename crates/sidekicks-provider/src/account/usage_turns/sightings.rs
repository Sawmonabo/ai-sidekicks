//! The record of each request a provider sees more than once, kept beside the usage rows: the
//! first sighting of a request opens a record in its row's own write, and each later sighting from
//! another source marks that record in a write of its own and is passed over, so the request is
//! priced once in whatever order its sightings arrive, each sighting in one write. Which write a
//! sighting takes is read first; each write's own statements decide again, so a write still queued
//! when the store was read is never counted twice. A record's first sighting is linked to the event
//! of the row it priced, and a later sighting on a run counts that row's tokens toward the run
//! where the row was the session's own and no sighting counted it yet. A request no session holds,
//! charged as its account's spend outside any session, opens its record on no session in its row's
//! own write, with the row's tokens, or marks the record a session's sighting opened, so whichever
//! comes second is passed over; a later sighting on a run counts those tokens toward the run, so a
//! run's count holds its request whichever sighting came first, and a session's mark on such a
//! record carries that session. The record is never cleared by a session's rebuild; it leaves with
//! its session's purge or its account's removal, and a record that counts toward a run not yet
//! ended for good outlives its account's removal until that run's final state, so the run's count
//! read after a restart, an interrupted run continued included, still holds it.

use std::borrow::Cow;
use std::sync::LazyLock;

use rusqlite::Connection;
use rusqlite::types::Value;
use sidekicks_contracts::event::envelope::EventCategory;
use sidekicks_contracts::event::usage::UsageSighting;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::BoundedText;
use sidekicks_store::database::schema::RUN_FINAL_EVENT_TYPES_SQL;
use sidekicks_store::database::statement::{
    StatementBindings, StatementResult, WriteStatement, named_bindings, nullable_text_binding,
    text_binding,
};

use crate::driver::contract::account::WindowTurnSpend;

/// Whether a sighting is passed over, as SQL over its `@match_key`, `@source` and
/// `@sighting_key`: its source's own id is recorded already, or a record of its key holds no
/// sighting from its source.
pub(super) const SIGHTING_PASSED_OVER_CONDITION: &str = "(EXISTS (SELECT 1 FROM usage_sightings
                                    WHERE sighting_key = @sighting_key)
  OR EXISTS (SELECT 1 FROM usage_sightings WHERE match_key = @match_key
             GROUP BY record_id HAVING SUM(source = @source) = 0))";

// A new record for a sighting, the first of its request, on its session and account: one row,
// unless the sighting is passed over.
static OPEN_SIGHTING_RECORD_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "INSERT INTO usage_sightings
  (record_id, match_key, source, sighting_key, session_id, account_id)
SELECT COALESCE((SELECT MAX(record_id) FROM usage_sightings), 0) + 1, @match_key, @source,
  @sighting_key, @session_id, @account_id
WHERE NOT {SIGHTING_PASSED_OVER_CONDITION}"
    )
});

// As a new record above, on no session, with the tokens of the row it is written beside, and only
// while its account is registered and not being removed, as that row.
static OPEN_SESSIONLESS_SIGHTING_RECORD_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "INSERT INTO usage_sightings
  (record_id, match_key, source, sighting_key, account_id, token_count)
SELECT COALESCE((SELECT MAX(record_id) FROM usage_sightings), 0) + 1, @match_key, @source,
  @sighting_key, @account_id, @token_count
WHERE NOT {SIGHTING_PASSED_OVER_CONDITION}
  AND EXISTS (SELECT 1 FROM provider_accounts
              WHERE account_id = @account_id AND removal_intent = 0)"
    )
});

// The mark of a sighting on the oldest record of its key that holds none from its source, on that
// record's account and session, `@session_id` where the record has none, unless its source's own
// id is recorded already. It counts toward `@run_id` where the record's row was the session's own,
// on no run, or a row no session owns, and no sighting of the record counts toward one yet; it
// returns the run it counts toward and its record.
const MARK_SIGHTING_SQL: &str = "INSERT INTO usage_sightings
  (record_id, match_key, source, sighting_key, session_id, account_id, run_id)
SELECT record_id, @match_key, @source, @sighting_key, COALESCE(session_id, @session_id),
  account_id,
  CASE WHEN COUNT(run_id) = 0 AND (
    EXISTS (SELECT 1 FROM usage_sightings AS opener
            JOIN session_events AS event ON event.id = opener.event_id
            WHERE opener.record_id = usage_sightings.record_id AND event.run_id IS NULL)
    OR EXISTS (SELECT 1 FROM usage_sightings AS opener
               WHERE opener.record_id = usage_sightings.record_id
                 AND opener.token_count IS NOT NULL))
  THEN @run_id END
FROM usage_sightings
WHERE match_key = @match_key
  AND NOT EXISTS (SELECT 1 FROM usage_sightings WHERE sighting_key = @sighting_key)
GROUP BY record_id HAVING SUM(source = @source) = 0
ORDER BY record_id LIMIT 1
RETURNING run_id, record_id";

// The link of a record its row's write just opened to that row's event: the newest sighting of its
// key from its source, which no later write can have added, while it names no event.
const LINK_SIGHTING_RECORD_SQL: &str = "UPDATE usage_sightings SET event_id = @event_id
WHERE sighting_id = (SELECT MAX(sighting_id) FROM usage_sightings
                     WHERE match_key = @match_key AND source = @source)
  AND event_id IS NULL";

// An account's records, each whole, but for one with a sighting that counts toward a run that has
// not ended for good: that run's count, read again after a restart, reads the record's row. A run
// whose log holds a final state has ended, since no change leaves one; an interrupted run is
// continued by a send, so its interrupt ends nothing.
static RELEASE_ACCOUNT_SIGHTINGS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "DELETE FROM usage_sightings
WHERE account_id = @account_id
  AND record_id NOT IN (
    SELECT counted.record_id FROM usage_sightings AS counted
    WHERE counted.account_id = @account_id AND counted.run_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM session_events AS ended
                      WHERE ended.category = '{}' AND ended.type IN ({})
                        AND ended.run_id = counted.run_id))",
        EventCategory::RunLifecycle.as_str(),
        *RUN_FINAL_EVENT_TYPES_SQL
    )
});

// The records that count toward a run whose account is no longer registered, each whole.
const RELEASE_ENDED_RUN_SIGHTINGS_SQL: &str = "DELETE FROM usage_sightings
WHERE record_id IN (SELECT record_id FROM usage_sightings WHERE run_id = @run_id)
  AND account_id NOT IN (SELECT account_id FROM provider_accounts)";

// Whether a source's own id is recorded, as a record's first sighting or as a mark.
const SIGHTING_KEY_RECORDED_SQL: &str =
    "SELECT 1 FROM usage_sightings WHERE sighting_key = @sighting_key";

// Whether a sighting is passed over.
static SIGHTING_PASSED_OVER_SQL: LazyLock<String> =
    LazyLock::new(|| format!("SELECT {SIGHTING_PASSED_OVER_CONDITION}"));

/// Whether `sighting` is passed over as the store stands, read on `connection`: its source's own
/// id recorded already, or a record of its key holding no sighting from its source, which
/// [`mark_sighting_statements`] marks; any other opens its record with
/// [`open_sighting_record_statement`]. Each of those decides again in its own write, so a write
/// queued since the read only sends the sighting back to be read again. Fails as SQLite does.
pub fn read_sighting_passed_over(
    connection: &Connection,
    sighting: &UsageSighting,
) -> rusqlite::Result<bool> {
    let bindings = sighting_bindings(sighting);
    connection
        .prepare_cached(&SIGHTING_PASSED_OVER_SQL)?
        .query_row(named_bindings(&bindings).as_slice(), |row| row.get(0))
}

/// The statement a priced row's own write carries for `sighting`, the row's on `session_id` under
/// `provider_account_id`: it opens the sighting's record and is refused, so the row is not written,
/// where the source's own id is recorded already or an older record of its key holds no sighting
/// from its source, which the store came to hold since [`read_sighting_passed_over`] read it.
pub fn open_sighting_record_statement(
    sighting: &UsageSighting,
    session_id: SessionId,
    provider_account_id: &ProviderAccountId,
) -> WriteStatement {
    let mut bindings = sighting_bindings(sighting);
    bindings.extend([
        text_binding("@session_id", session_id.text().as_str()),
        text_binding("@account_id", provider_account_id.as_str()),
    ]);
    WriteStatement {
        sql: Cow::Borrowed(OPEN_SIGHTING_RECORD_SQL.as_str()),
        bindings: StatementBindings::Named(bindings),
        expected_row_count: Some(1),
    }
}

/// The three statements a held row no session owns carries for `sighting` after the row, in the
/// row's own write, the row charged to `provider_account_id` for `spend`: the first opens the
/// sighting's record on no session, with the row's tokens, where the sighting is not passed over
/// and the account is registered, as the row is then written, and answers a row where it did; the
/// second marks the oldest record of its key that holds no sighting from its source, counting
/// toward no run, where it is passed over; the third answers a row where its source's own id is
/// recorded. So a request a session's file read priced first is not charged again, and one charged
/// here first passes a later file read over and counts toward the run a later sighting is seen on.
pub fn sessionless_sighting_statements(
    sighting: &UsageSighting,
    provider_account_id: &ProviderAccountId,
    spend: &WindowTurnSpend,
) -> [WriteStatement; 3] {
    let token_count =
        spend.input_tokens.map_or(0, i64::from) + spend.output_tokens.map_or(0, i64::from);
    let mut bindings = sighting_bindings(sighting);
    bindings.extend([
        text_binding("@account_id", provider_account_id.as_str()),
        (Cow::Borrowed("@token_count"), Value::Integer(token_count)),
    ]);
    let [mark, recorded] = mark_sighting_statements(sighting, None, None);
    [
        WriteStatement {
            sql: Cow::Borrowed(OPEN_SESSIONLESS_SIGHTING_RECORD_SQL.as_str()),
            bindings: StatementBindings::Named(bindings),
            expected_row_count: None,
        },
        mark,
        recorded,
    ]
}

/// The statement a priced row's live write carries after its event, as `event_id`, for the record
/// [`open_sighting_record_statement`] opened in that write for `sighting`: it links the record to
/// the row, whose tokens a run the request is later seen on counts.
pub fn link_sighting_record_statement(sighting: &UsageSighting, event_id: &str) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(LINK_SIGHTING_RECORD_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@event_id", event_id),
            text_binding("@match_key", sighting.match_key.as_str()),
            text_binding("@source", sighting.source.into()),
        ]),
        expected_row_count: None,
    }
}

/// The two statements of the one write that passes `sighting` over, seen on `session_id`'s
/// `run_id` or on the session's own spend, or outside any session with neither: the first marks
/// the oldest record of its key that holds no sighting from its source and returns a row where it
/// did, counting the record's row toward `run_id` where that row was the session's own or no
/// session's and nothing counted it yet; the second returns a row where the source's own id is
/// recorded already. Where neither did, the record moved since [`read_sighting_passed_over`] read
/// it, and the sighting is read again; the write's results read through
/// [`is_sighting_passed_over`] and [`counted_record`].
pub fn mark_sighting_statements(
    sighting: &UsageSighting,
    session_id: Option<SessionId>,
    run_id: Option<RunId>,
) -> [WriteStatement; 2] {
    let mut bindings = sighting_bindings(sighting);
    bindings.extend([
        (
            Cow::Borrowed("@session_id"),
            Value::from(session_id.map(|session_id| session_id.text().as_str().to_owned())),
        ),
        (
            Cow::Borrowed("@run_id"),
            Value::from(run_id.map(|run_id| run_id.text().as_str().to_owned())),
        ),
    ]);
    [
        WriteStatement {
            sql: Cow::Borrowed(MARK_SIGHTING_SQL),
            bindings: StatementBindings::Named(bindings),
            expected_row_count: None,
        },
        WriteStatement {
            sql: Cow::Borrowed(SIGHTING_KEY_RECORDED_SQL),
            bindings: StatementBindings::Named(vec![nullable_text_binding(
                "@sighting_key",
                sighting.sighting_key.as_ref().map(BoundedText::as_str),
            )]),
            expected_row_count: None,
        },
    ]
}

/// Whether the results of [`mark_sighting_statements`]' write passed its sighting over: a row in
/// either, its record marked or its source's id recorded already; `false` where the record moved.
pub fn is_sighting_passed_over(marked: &[StatementResult]) -> bool {
    marked.iter().any(|result| result.row_count > 0)
}

/// The record whose row the results of [`mark_sighting_statements`]' write counted toward the run
/// it was given; `None` where the mark counted toward no run or marked nothing.
pub fn counted_record(marked: &[StatementResult]) -> Option<i64> {
    match marked.first()?.rows.first()?.as_slice() {
        [Value::Text(_), Value::Integer(record_id)] => Some(*record_id),
        _ => None,
    }
}

/// The statement an account's removal writes beside the deletion of its row: it deletes the
/// account's sighting records, but keeps each that counts toward a run not yet ended for good,
/// which [`release_ended_run_sightings_statement`] deletes at that run's final state.
pub fn release_account_sightings_statement(
    provider_account_id: &ProviderAccountId,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(RELEASE_ACCOUNT_SIGHTINGS_SQL.as_str()),
        bindings: StatementBindings::Named(vec![text_binding(
            "@account_id",
            provider_account_id.as_str(),
        )]),
        expected_row_count: None,
    }
}

/// The statement a run's change into a final state writes: it deletes the sighting records that
/// count toward `run_id` whose account was removed while the run lived.
pub fn release_ended_run_sightings_statement(run_id: RunId) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(RELEASE_ENDED_RUN_SIGHTINGS_SQL),
        bindings: StatementBindings::Named(vec![text_binding("@run_id", run_id.text().as_str())]),
        expected_row_count: None,
    }
}

/// The bindings of `sighting` that `SIGHTING_PASSED_OVER_CONDITION` reads.
pub(super) fn sighting_bindings(sighting: &UsageSighting) -> Vec<(Cow<'static, str>, Value)> {
    vec![
        text_binding("@match_key", sighting.match_key.as_str()),
        text_binding("@source", sighting.source.into()),
        nullable_text_binding(
            "@sighting_key",
            sighting.sighting_key.as_ref().map(BoundedText::as_str),
        ),
    ]
}
