//! The record of each request a provider sees more than once, kept beside the usage rows: the
//! first sighting of a request opens a record in its row's own write, and each later sighting from
//! another source marks that record in a write of its own and is passed over, so the request is
//! priced once in whatever order its sightings arrive, each sighting in one write. Which write a
//! sighting takes is read first; each write's own statements decide again, so a write still queued
//! when the store was read is never counted twice. The record is never cleared by a session's
//! rebuild; it leaves with its session's purge or its account's removal.

use std::borrow::Cow;

use rusqlite::Connection;
use rusqlite::types::Value;
use sidekicks_contracts::event::usage::UsageSighting;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::BoundedText;
use sidekicks_store::database::statement::{
    StatementBindings, StatementResult, WriteStatement, named_bindings, nullable_text_binding,
    text_binding,
};

// A new record for a sighting, the first of its request, on its session and account: one row,
// unless its source's own id is recorded already or an older record of its key holds no sighting
// from its source.
const OPEN_SIGHTING_RECORD_SQL: &str = "INSERT INTO usage_sightings
  (record_id, match_key, source, sighting_key, session_id, account_id)
SELECT COALESCE((SELECT MAX(record_id) FROM usage_sightings), 0) + 1, @match_key, @source,
  @sighting_key, @session_id, @account_id
WHERE NOT EXISTS (SELECT 1 FROM usage_sightings WHERE sighting_key = @sighting_key)
  AND NOT EXISTS (SELECT 1 FROM usage_sightings WHERE match_key = @match_key
                  GROUP BY record_id HAVING SUM(source = @source) = 0)";

// The mark of a sighting on the oldest record of its key that holds none from its source, on that
// record's session and account, unless its source's own id is recorded already.
const MARK_SIGHTING_SQL: &str = "INSERT INTO usage_sightings
  (record_id, match_key, source, sighting_key, session_id, account_id)
SELECT record_id, @match_key, @source, @sighting_key, session_id, account_id FROM usage_sightings
WHERE match_key = @match_key
  AND NOT EXISTS (SELECT 1 FROM usage_sightings WHERE sighting_key = @sighting_key)
GROUP BY record_id HAVING SUM(source = @source) = 0
ORDER BY record_id LIMIT 1";

// Whether a source's own id is recorded, as a record's first sighting or as a mark.
const SIGHTING_KEY_RECORDED_SQL: &str =
    "SELECT 1 FROM usage_sightings WHERE sighting_key = @sighting_key";

// Whether a sighting is passed over: its source's own id is recorded already, or a record of its
// key holds no sighting from its source.
const SIGHTING_PASSED_OVER_SQL: &str = "SELECT
  EXISTS (SELECT 1 FROM usage_sightings WHERE sighting_key = @sighting_key)
  OR EXISTS (SELECT 1 FROM usage_sightings WHERE match_key = @match_key
             GROUP BY record_id HAVING SUM(source = @source) = 0)";

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
        .prepare_cached(SIGHTING_PASSED_OVER_SQL)?
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
        sql: Cow::Borrowed(OPEN_SIGHTING_RECORD_SQL),
        bindings: StatementBindings::Named(bindings),
        expected_row_count: Some(1),
    }
}

/// The two statements of the one write that passes `sighting` over: the first marks the oldest
/// record of its key that holds no sighting from its source and changes one row where it did; the
/// second returns a row where the source's own id is recorded already. Where neither did, the
/// record moved since [`read_sighting_passed_over`] read it, and the sighting is read again; the
/// write's results read through [`is_sighting_passed_over`].
pub fn mark_sighting_statements(sighting: &UsageSighting) -> [WriteStatement; 2] {
    [
        WriteStatement {
            sql: Cow::Borrowed(MARK_SIGHTING_SQL),
            bindings: StatementBindings::Named(sighting_bindings(sighting)),
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

fn sighting_bindings(sighting: &UsageSighting) -> Vec<(Cow<'static, str>, Value)> {
    vec![
        text_binding("@match_key", sighting.match_key.as_str()),
        text_binding("@source", sighting.source.into()),
        nullable_text_binding(
            "@sighting_key",
            sighting.sighting_key.as_ref().map(BoundedText::as_str),
        ),
    ]
}
