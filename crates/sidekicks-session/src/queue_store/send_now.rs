//! A person's `Send now`: the mark a waiting message carries while the `Send now` that put it ahead
//! of what its provider holds is in force, the id its answer carries, written with its place first
//! before the hand; and the record of each key a `Send now` spent on a run, which keeps the message
//! and that id for the run's life. A `Send now` sent again answers that id, handing the message
//! again only while its mark is in force and its provider no longer holds it, and a later order
//! that puts the message after another clears the mark but keeps the key's record.

use std::borrow::Cow;
use std::sync::LazyLock;

use rusqlite::{Connection, OptionalExtension};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::InterventionId;
use sidekicks_contracts::run::queue::{QueueItemId, QueueItemState};
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::stored_column::text_column;

/// One `Send now` a run's key recorded: the message it handed and the id its answer carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SentNow {
    /// The message handed first.
    pub item_id: QueueItemId,
    /// The id the answer carries.
    pub intervention_id: InterventionId,
}

const SELECT_SENT_NOW_SQL: &str = "SELECT queue_item_id, intervention_id FROM send_now_requests
  WHERE target_run_id = ? AND client_idempotency_key = ?";

// A key already recorded keeps its first record: a `Send now` run again under it while its mark is
// in force records nothing new.
const RECORD_SENT_NOW_SQL: &str = "INSERT INTO send_now_requests
  (target_run_id, client_idempotency_key, queue_item_id, intervention_id, created_at)
  VALUES (@run_id, @key, @item_id, @send_now_id, @now)
  ON CONFLICT (target_run_id, client_idempotency_key) DO NOTHING";

// Marks a message still waiting and carrying no mark.
static MARK_SENT_NOW_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE queue_items SET send_now_id = @send_now_id, updated_at = @now
  WHERE id = @id AND state = '{}' AND send_now_id IS NULL",
        <&'static str>::from(QueueItemState::Queued)
    )
});

// Clears the mark of a message still waiting.
static CLEAR_SENT_NOW_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE queue_items SET send_now_id = NULL, updated_at = @now
  WHERE id = @id AND state = '{}'",
        <&'static str>::from(QueueItemState::Queued)
    )
});

/// The statement that records `key`, spent by a `Send now` on `run_id`, as `sent`, unless the key
/// already holds a record, which it keeps.
pub fn record_sent_now_statement(
    run_id: &RunId,
    key: &ClientUuid,
    sent: &SentNow,
    now: &WireInstant,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(RECORD_SENT_NOW_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@run_id", run_id.text().as_str()),
            text_binding("@key", key.as_str()),
            text_binding("@item_id", sent.item_id.text().as_str()),
            text_binding("@send_now_id", sent.intervention_id.text().as_str()),
            text_binding("@now", now.as_str()),
        ]),
        expected_row_count: None,
    }
}

/// The statement that marks `item_id` sent now, its answer carrying `intervention_id`; refused
/// once the message has left `queued` or carries a mark.
pub fn mark_sent_now_statement(
    item_id: &QueueItemId,
    intervention_id: &InterventionId,
    now: &WireInstant,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(MARK_SENT_NOW_SQL.as_str()),
        bindings: StatementBindings::Named(vec![
            text_binding("@id", item_id.text().as_str()),
            text_binding("@send_now_id", intervention_id.text().as_str()),
            text_binding("@now", now.as_str()),
        ]),
        expected_row_count: Some(1),
    }
}

/// The statement that clears the `Send now` mark of `item_id`, so it goes in its place; refused
/// once the message has left `queued`. The key's record stays.
pub fn clear_sent_now_statement(item_id: &QueueItemId, now: &WireInstant) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(CLEAR_SENT_NOW_SQL.as_str()),
        bindings: StatementBindings::Named(vec![
            text_binding("@id", item_id.text().as_str()),
            text_binding("@now", now.as_str()),
        ]),
        expected_row_count: Some(1),
    }
}

/// The `Send now` recorded under `key` on `run_id`, or `None`. Fails when SQLite refuses the read
/// or a stored id does not read as its type.
pub fn read_sent_now(
    reader: &Connection,
    run_id: &RunId,
    key: &ClientUuid,
) -> rusqlite::Result<Option<SentNow>> {
    reader
        .prepare_cached(SELECT_SENT_NOW_SQL)?
        .query_row([run_id.text().as_str(), key.as_str()], |row| {
            Ok(SentNow {
                item_id: text_column(row, 0, |text| QueueItemId::new(&text))?,
                intervention_id: text_column(row, 1, |text| InterventionId::new(&text))?,
            })
        })
        .optional()
}
