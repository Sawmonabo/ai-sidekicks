//! The record of each request a provider sees more than once, kept beside the usage rows: the
//! first sighting of a request opens a record in its row's own write, and each later sighting from
//! another source marks that record and is passed over, so the request is priced once in whatever
//! order its sightings arrive. The record is never cleared by a session's rebuild; it leaves with
//! its session's purge or its account's removal.

use std::borrow::Cow;

use rusqlite::types::Value;
use sidekicks_contracts::event::usage::UsageSighting;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::BoundedText;
use sidekicks_store::database::statement::{
    StatementBindings, WriteStatement, nullable_text_binding, text_binding,
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

/// The statement a priced row's own write carries for `sighting`, the row's on `session_id` under
/// `provider_account_id`: it opens the sighting's record and is refused, so the row is not written,
/// where the source's own id is recorded already or an older record of its key holds no sighting
/// from its source, which [`mark_sighting_statements`] then takes.
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

/// The two statements of one write that pass `sighting` over: the first marks the oldest record of
/// its key that holds no sighting from its source and changes one row where it did; the second
/// returns a row where the source's own id is recorded already. Where neither did, the record
/// moved since the row's write was refused, and the row's write is tried again.
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
