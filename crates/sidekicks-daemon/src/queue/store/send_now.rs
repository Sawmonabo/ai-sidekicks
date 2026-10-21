//! The mark a waiting message carries once a person's `Send now` handed it ahead of what its
//! provider held: the request's key and the id its answer carries, written before the hand, so a
//! `Send now` sent again under the same key answers what the first did and dispatches nothing.

use std::borrow::Cow;
use std::sync::LazyLock;

use rusqlite::{Connection, OptionalExtension};
use sidekicks_contracts::run::intervention::InterventionId;
use sidekicks_contracts::run::queue::{QueueItemId, QueueItemState};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_contracts::wire::instant::WireInstant;

use crate::database::statement::{StatementBindings, WriteStatement, text_binding};
use crate::database::stored_column::text_column;

/// One `Send now` a session's queue recorded: the message it handed and the id its answer carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SentNow {
    /// The message handed first.
    pub(crate) item_id: QueueItemId,
    /// The id the answer carries.
    pub(crate) intervention_id: InterventionId,
}

const SELECT_SENT_NOW_SQL: &str =
    "SELECT id, send_now_id FROM queue_items WHERE session_id = ? AND send_now_key = ?";

// Marks a message still waiting and never sent now; a key spent in the session refuses at the
// table's own uniqueness.
static MARK_SENT_NOW_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE queue_items SET send_now_key = @key, send_now_id = @send_now_id, updated_at = @now
  WHERE id = @id AND state = '{}' AND send_now_key IS NULL",
        <&'static str>::from(QueueItemState::Queued)
    )
});

/// The statement that marks `item_id` sent now under `key`, its answer carrying
/// `intervention_id`; refused once the message has left `queued` or was sent now before.
pub(crate) fn mark_sent_now_statement(
    item_id: &QueueItemId,
    key: &ClientUuid,
    intervention_id: &InterventionId,
    now: &WireInstant,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(MARK_SENT_NOW_SQL.as_str()),
        bindings: StatementBindings::Named(vec![
            text_binding("@id", item_id.text().as_str()),
            text_binding("@key", key.as_str()),
            text_binding("@send_now_id", intervention_id.text().as_str()),
            text_binding("@now", now.as_str()),
        ]),
        expected_row_count: Some(1),
    }
}

/// The `Send now` the session's queue recorded under `key`, or `None`. Fails when SQLite refuses
/// the read or a stored id does not read as its type.
pub(crate) fn read_sent_now(
    reader: &Connection,
    session_id: &SessionId,
    key: &ClientUuid,
) -> rusqlite::Result<Option<SentNow>> {
    reader
        .prepare_cached(SELECT_SENT_NOW_SQL)?
        .query_row([session_id.text().as_str(), key.as_str()], |row| {
            Ok(SentNow {
                item_id: text_column(row, 0, |text| QueueItemId::new(&text))?,
                intervention_id: text_column(row, 1, |text| InterventionId::new(&text))?,
            })
        })
        .optional()
}
