//! The command receipt: a side-effecting tool call's receipt is recorded and claimed in one write
//! before the call is sent, so a restart finds it in flight and never runs its command again. Its
//! end is written once: inline, at its result's hand-off, or at its session's close.

use std::borrow::Cow;
use std::sync::{Arc, LazyLock};

use rusqlite::types::Value;
use rusqlite::{Connection, Row};
use sidekicks_contracts::mcp::server::McpServerName;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_store::database::statement::{
    DATABASE_NOW_SQL, StatementBindings, WriteStatement, text_binding,
};
use sidekicks_store::database::stored_column::text_column;
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::client::tasks::{McpServerEndpoint, McpTaskGeneration};

/// One receipt's id, minted when its command is recorded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct CommandReceiptId(Uuid);

/// The receipt's status from the write that records and claims its command until the command
/// ends. Stored by its camelCase name.
#[derive(Clone, Copy, Debug, PartialEq, Eq, strum::IntoStaticStr, strum::VariantArray)]
#[strum(serialize_all = "camelCase")]
pub(crate) enum CommandAcceptance {
    /// The command was recorded and claimed, and has not ended.
    Accepted,
}

/// The receipt's status once its command has ended. Stored by its camelCase name.
#[derive(Clone, Copy, Debug, PartialEq, Eq, strum::IntoStaticStr, strum::VariantArray)]
#[strum(serialize_all = "camelCase")]
pub(crate) enum CommandOutcome {
    /// The command ran to its end.
    Completed,
    /// The command ran and failed.
    Failed,
    /// The end is unknown, because the result was lost or the server no longer knows the task;
    /// the command is never run again.
    Unknown,
}

/// Why a receipt was not recorded.
#[derive(Debug, thiserror::Error)]
pub(crate) enum CommandReceiptError {
    /// The caller canceled before the receipt was written; nothing was written.
    #[error("the command was canceled before its receipt was written")]
    Canceled,
    /// The receipt's write failed, a command id that already has a receipt among the causes.
    #[error(transparent)]
    Write(#[from] WriteError),
}

static ACCEPT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "INSERT INTO command_receipts (id, command_id, run_id, status, created_at)
  VALUES (@id, @command_id, @run_id, @status, {DATABASE_NOW_SQL})"
    )
});

static CLAIM_SQL: LazyLock<String> = LazyLock::new(|| {
    format!("UPDATE command_receipts SET started_at = {DATABASE_NOW_SQL} WHERE id = ?")
});

// Ends a claimed receipt that has not ended, whether or not it moved to the background: a session's
// close writes the end, since nothing is delivered after a close.
static COMPLETE_AT_SESSION_CLOSE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE command_receipts
  SET status = @status, completed_at = {DATABASE_NOW_SQL}
  WHERE id = @id AND started_at IS NOT NULL AND completed_at IS NULL"
    )
});

// The inline end leaves a backgrounded call to its result's hand-off.
static COMPLETE_SQL: LazyLock<String> =
    LazyLock::new(|| format!("{} AND backgrounded = 0", *COMPLETE_AT_SESSION_CLOSE_SQL));

const MOVE_ENDPOINT_SQL: &str = "UPDATE command_receipts SET mcp_server_endpoint = @new_endpoint
  WHERE mcp_server_endpoint = @old_endpoint";

const BACKGROUND_SQL: &str = "UPDATE command_receipts SET backgrounded = 1
  WHERE command_id = ? AND completed_at IS NULL AND backgrounded = 0";

static HAND_OFF_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE command_receipts
  SET status = @status, completed_at = {DATABASE_NOW_SQL}, delivered = 1
  WHERE id = @id AND started_at IS NOT NULL AND completed_at IS NULL AND backgrounded = 1"
    )
});

// The WHERE is the in-flight index's own, so the read is served by it.
const IN_FLIGHT_SQL: &str = "SELECT id, command_id, run_id, mcp_task_id, mcp_task_generation,
  mcp_server_name, mcp_server_endpoint, backgrounded
  FROM command_receipts
  WHERE started_at IS NOT NULL AND completed_at IS NULL
  ORDER BY run_id";

/// Writes the command receipts: each receipt recorded and claimed in one write, and its end in
/// another. Clones write through the same writer.
#[derive(Clone)]
pub(crate) struct CommandReceiptStore {
    /// The writer every receipt's writes go through.
    writer: Arc<DatabaseWriter>,
}

impl CommandReceiptStore {
    /// A store writing through `writer`.
    pub(crate) fn new(writer: Arc<DatabaseWriter>) -> Self {
        Self { writer }
    }

    /// Records the command of `run_id` and claims it in one write, before anything is sent, and
    /// returns its receipt id. Checks `cancellation` once, before the write, failing with
    /// [`CommandReceiptError::Canceled`] and writing nothing; past that check it runs to its
    /// answer. Fails with [`CommandReceiptError::Write`] as the write fails, a command id that
    /// already has a receipt among the causes, so a command is received once.
    pub(crate) async fn accept_and_claim(
        &self,
        command_id: &str,
        run_id: RunId,
        cancellation: &CancellationToken,
    ) -> Result<CommandReceiptId, CommandReceiptError> {
        if cancellation.is_cancelled() {
            return Err(CommandReceiptError::Canceled);
        }
        let receipt_id = CommandReceiptId(mint_uuid_v7());
        let receipt_text = receipt_id.0.to_string();
        self.writer
            .write(vec![
                WriteStatement {
                    sql: Cow::Borrowed(ACCEPT_SQL.as_str()),
                    bindings: StatementBindings::Named(vec![
                        text_binding("@id", &receipt_text),
                        text_binding("@command_id", command_id),
                        text_binding("@run_id", run_id.text().as_str()),
                        text_binding("@status", CommandAcceptance::Accepted.into()),
                    ]),
                    expected_row_count: Some(1),
                },
                WriteStatement {
                    sql: Cow::Borrowed(CLAIM_SQL.as_str()),
                    bindings: StatementBindings::Positional(vec![Value::Text(receipt_text)]),
                    expected_row_count: Some(1),
                },
            ])
            .await?;
        Ok(receipt_id)
    }

    /// Records how the claimed command ended, inline. Fails with [`WriteError::Refused`] when the
    /// receipt was never claimed, already ended, or moved to the background, whose end its
    /// result's hand-off writes; and as the write fails.
    pub(crate) async fn complete(
        &self,
        receipt_id: CommandReceiptId,
        outcome: CommandOutcome,
    ) -> Result<(), WriteError> {
        self.write_end(&COMPLETE_SQL, receipt_id, outcome).await
    }

    /// Records how the claimed command ended when its session closes, a backgrounded one too,
    /// since nothing is delivered after a close; its delivery stays unwritten. Only the session's
    /// close writes through it: every other end, a caller's cancel included, takes
    /// [`Self::complete`], which leaves a backgrounded command's hand-off owed. Fails with
    /// [`WriteError::Refused`] when the receipt was never claimed or already ended, and as the
    /// write fails.
    pub(crate) async fn complete_at_session_close(
        &self,
        receipt_id: CommandReceiptId,
        outcome: CommandOutcome,
    ) -> Result<(), WriteError> {
        self.write_end(&COMPLETE_AT_SESSION_CLOSE_SQL, receipt_id, outcome)
            .await
    }

    async fn write_end(
        &self,
        sql: &'static str,
        receipt_id: CommandReceiptId,
        outcome: CommandOutcome,
    ) -> Result<(), WriteError> {
        self.writer
            .write(vec![end_statement(sql, receipt_id, outcome)])
            .await?;
        Ok(())
    }
}

// One statement that writes `outcome` as the receipt's end through `sql`, which binds `@status` and
// `@id` and must change the one row.
fn end_statement(
    sql: &'static str,
    receipt_id: CommandReceiptId,
    outcome: CommandOutcome,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(sql),
        bindings: StatementBindings::Named(vec![
            text_binding("@id", &receipt_id.0.to_string()),
            text_binding("@status", outcome.into()),
        ]),
        expected_row_count: Some(1),
    }
}

/// The statement that moves the call of `command_id` to the background, so its result is owed a
/// delivery. Refused (`WriteError::Refused`) on an ended or already backgrounded call.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the tool route, which moves a long call to the background"
    )
)]
pub(crate) fn background_statement(command_id: &str) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(BACKGROUND_SQL),
        bindings: StatementBindings::Positional(vec![Value::Text(command_id.to_owned())]),
        expected_row_count: Some(1),
    }
}

/// The statement that writes a backgrounded call's `outcome` and marks its result delivered. It
/// joins the delivery's own write, so the end and the delivery commit together or not at all.
/// Refused (`WriteError::Refused`) on a receipt never claimed, already ended or never backgrounded.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the result's delivery, which hands a backgrounded call's end over"
    )
)]
pub(crate) fn hand_off_statement(
    receipt_id: CommandReceiptId,
    outcome: CommandOutcome,
) -> WriteStatement {
    end_statement(&HAND_OFF_SQL, receipt_id, outcome)
}

/// The statement that has every task accepted on the server at `old` name it at `new`, the same
/// server's endpoint under a new address key, so the task still resumes on it.
pub(crate) fn move_endpoint_statement(
    old: &McpServerEndpoint,
    new: &McpServerEndpoint,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(MOVE_ENDPOINT_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@old_endpoint", old.as_str()),
            text_binding("@new_endpoint", new.as_str()),
        ]),
        expected_row_count: None,
    }
}

/// A claimed receipt with no end, as the restart's sweep reads it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct InFlightReceipt {
    /// The receipt's id.
    pub(crate) id: CommandReceiptId,
    /// The client's idempotency key, which names the command.
    pub(crate) command_id: String,
    /// The run the command belongs to.
    pub(crate) run_id: RunId,
    /// The task the call was accepted as, `None` while no handle is stored.
    pub(crate) task: Option<InFlightTask>,
    /// Whether the call moved to the background, so its result is owed a delivery.
    pub(crate) is_backgrounded: bool,
}

/// The task an in-flight receipt's call was accepted as, and where to resume it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct InFlightTask {
    /// The task id the receiver generated.
    pub(crate) mcp_task_id: String,
    /// The protocol of the server that accepted the task.
    pub(crate) mcp_task_generation: McpTaskGeneration,
    /// The name of the server that accepted the task.
    pub(crate) server_name: McpServerName,
    /// Which server accepted the task, so it is resumed only there.
    pub(crate) endpoint: McpServerEndpoint,
}

/// Every claimed receipt with no end, ordered by run. Fails as the statement fails; a row that
/// does not read as its types is its own `Err`, so one damaged row never strands the others.
pub(crate) fn read_in_flight_receipts(
    connection: &Connection,
) -> rusqlite::Result<Vec<rusqlite::Result<InFlightReceipt>>> {
    let mut statement = connection.prepare_cached(IN_FLIGHT_SQL)?;
    let receipts = statement
        .query_map([], in_flight_receipt_from_row)?
        .collect();
    Ok(receipts)
}

fn in_flight_receipt_from_row(row: &Row<'_>) -> rusqlite::Result<InFlightReceipt> {
    let task = match row.get::<_, Option<String>>(3)? {
        None => None,
        Some(mcp_task_id) => Some(InFlightTask {
            mcp_task_id,
            mcp_task_generation: text_column(row, 4, |text| text.parse())?,
            server_name: text_column(row, 5, McpServerName::new)?,
            endpoint: McpServerEndpoint::from_stored(row.get(6)?),
        }),
    };
    Ok(InFlightReceipt {
        id: text_column(row, 0, |text| Uuid::parse_str(&text).map(CommandReceiptId))?,
        command_id: row.get(1)?,
        run_id: text_column(row, 2, |text| RunId::new(&text))?,
        task,
        is_backgrounded: row.get(7)?,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use sidekicks_contracts::mcp::server::McpServerName;
    use sidekicks_store::database::writer::test_file::{TestDatabase, test_run_id};
    use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions, WriteError};
    use tokio_util::sync::CancellationToken;

    use super::{
        CommandOutcome, CommandReceiptError, CommandReceiptId, CommandReceiptStore,
        InFlightReceipt, InFlightTask, background_statement, hand_off_statement,
        read_in_flight_receipts,
    };
    use crate::client::tasks::{McpServerEndpoint, McpTaskGeneration};
    use crate::schema::schema_parts;

    /// A fresh database, the writer over it and a store writing through that writer.
    async fn receipt_store() -> (TestDatabase, Arc<DatabaseWriter>, CommandReceiptStore) {
        let database = TestDatabase::new(schema_parts());
        let writer = Arc::new(
            DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
                .await
                .expect("the writer opens its database"),
        );
        let store = CommandReceiptStore::new(Arc::clone(&writer));
        (database, writer, store)
    }

    /// The in-flight read, each damaged row as `None`.
    fn in_flight(database: &TestDatabase) -> Vec<Option<InFlightReceipt>> {
        read_in_flight_receipts(&database.reader())
            .expect("the in-flight statement runs")
            .into_iter()
            .map(Result::ok)
            .collect()
    }

    /// The statement whose row count refused `result`'s write, `None` for a kept write.
    fn refused_statement(result: Result<impl Sized, WriteError>) -> Option<usize> {
        result
            .err()
            .and_then(|error| error.refused_statement_index())
    }

    /// The receipt's status, whether its end is written, and its delivery.
    fn stored_end(database: &TestDatabase, receipt_id: CommandReceiptId) -> (String, bool, i64) {
        database
            .reader()
            .query_row(
                "SELECT status, completed_at IS NOT NULL, delivered FROM command_receipts \
                 WHERE id = ?",
                [receipt_id.0.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("the receipt reads")
    }

    // A canceled accept writes nothing; an uncanceled one is claimed in the same write, so it reads
    // in flight with its task once stored, beside a damaged row read as its own failure, until its
    // end.
    #[tokio::test]
    async fn a_receipt_is_written_only_uncanceled_and_reads_in_flight_until_its_end() {
        let (database, _writer, store) = receipt_store().await;
        let first_run = test_run_id();
        let second_run = test_run_id();
        let damaged_run = test_run_id();
        let canceled = CancellationToken::new();
        canceled.cancel();

        let refused = store
            .accept_and_claim("tool-call-1", first_run, &canceled)
            .await;
        let rows_after_cancel: i64 = database
            .reader()
            .query_row("SELECT count(*) FROM command_receipts", [], |row| {
                row.get(0)
            })
            .expect("the receipts count");
        let first = store
            .accept_and_claim("tool-call-1", first_run, &CancellationToken::new())
            .await
            .expect("an uncanceled accept writes its receipt");
        let second = store
            .accept_and_claim("tool-call-2", second_run, &CancellationToken::new())
            .await
            .expect("the second receipt writes");
        let reader = database.reader();
        reader
            .execute(
                "UPDATE command_receipts SET mcp_task_id = 'task-9', mcp_task_generation = 'v2', \
                 mcp_server_name = 'tracker', mcp_server_endpoint = ?1 WHERE id = ?2",
                [McpServerEndpoint::stdio().as_str(), &second.0.to_string()],
            )
            .expect("the second receipt's task is stored");
        reader
            .execute(
                "INSERT INTO command_receipts (id, command_id, run_id, status, started_at, \
                 created_at) VALUES ('not-a-uuid', 'tool-call-3', ?, 'accepted', 't', 't')",
                [damaged_run.text().as_str()],
            )
            .expect("the damaged receipt is seeded");
        let read_before_end = in_flight(&database);
        store
            .complete(first, CommandOutcome::Completed)
            .await
            .expect("the first receipt ends");
        let read_after_end = in_flight(&database);

        assert!(
            matches!(refused, Err(CommandReceiptError::Canceled)),
            "a canceled accept answers the cancel: {refused:?}"
        );
        assert_eq!(rows_after_cancel, 0, "a canceled accept writes no receipt");
        let first_in_flight = InFlightReceipt {
            id: first,
            command_id: "tool-call-1".to_owned(),
            run_id: first_run,
            task: None,
            is_backgrounded: false,
        };
        let second_in_flight = InFlightReceipt {
            id: second,
            command_id: "tool-call-2".to_owned(),
            run_id: second_run,
            task: Some(InFlightTask {
                mcp_task_id: "task-9".to_owned(),
                mcp_task_generation: McpTaskGeneration::V2,
                server_name: McpServerName::new("tracker".to_owned()).expect("a server name"),
                endpoint: McpServerEndpoint::stdio(),
            }),
            is_backgrounded: false,
        };
        assert_eq!(
            read_before_end,
            [Some(first_in_flight), Some(second_in_flight.clone()), None]
        );
        assert_eq!(read_after_end, [Some(second_in_flight), None]);
    }

    // The background move holds the inline end off a backgrounded call, whose end only its
    // hand-off, which also marks it delivered, or its session's close writes; each write lands
    // once.
    #[tokio::test]
    async fn a_backgrounded_call_ends_only_by_its_hand_off_or_its_sessions_close() {
        let (database, writer, store) = receipt_store().await;
        let run_id = test_run_id();
        let uncanceled = CancellationToken::new();
        let accept =
            |command_id: &'static str| store.accept_and_claim(command_id, run_id, &uncanceled);
        let in_flight_receipt = |id, command_id: &str, is_backgrounded| InFlightReceipt {
            id,
            command_id: command_id.to_owned(),
            run_id,
            task: None,
            is_backgrounded,
        };

        let r1 = accept("call-1").await.expect("R1 is claimed");
        writer
            .write(vec![background_statement("call-1")])
            .await
            .expect("R1 moves to the background");
        assert_eq!(
            in_flight(&database),
            [Some(in_flight_receipt(r1, "call-1", true))]
        );
        let backgrounded_again = writer.write(vec![background_statement("call-1")]).await;
        assert_eq!(refused_statement(backgrounded_again), Some(0));
        let completed_inline = store.complete(r1, CommandOutcome::Completed).await;
        assert_eq!(refused_statement(completed_inline), Some(0));
        writer
            .write(vec![hand_off_statement(r1, CommandOutcome::Unknown)])
            .await
            .expect("R1's end is handed off");
        assert_eq!(stored_end(&database, r1), ("unknown".to_owned(), true, 1));
        assert_eq!(in_flight(&database), []);
        let handed_off_again = writer
            .write(vec![hand_off_statement(r1, CommandOutcome::Unknown)])
            .await;
        assert_eq!(refused_statement(handed_off_again), Some(0));
        let backgrounded_after_end = writer.write(vec![background_statement("call-1")]).await;
        assert_eq!(refused_statement(backgrounded_after_end), Some(0));

        let r2 = accept("call-2").await.expect("R2 is claimed");
        let handed_off_inline_call = writer
            .write(vec![hand_off_statement(r2, CommandOutcome::Completed)])
            .await;
        assert_eq!(refused_statement(handed_off_inline_call), Some(0));
        assert_eq!(
            in_flight(&database),
            [Some(in_flight_receipt(r2, "call-2", false))]
        );
        store
            .complete(r2, CommandOutcome::Completed)
            .await
            .expect("R2 ends inline");
        assert_eq!(stored_end(&database, r2), ("completed".to_owned(), true, 0));

        let r3 = accept("call-3").await.expect("R3 is claimed");
        writer
            .write(vec![background_statement("call-3")])
            .await
            .expect("R3 moves to the background");
        store
            .complete_at_session_close(r3, CommandOutcome::Unknown)
            .await
            .expect("R3 ends at its session's close");
        assert_eq!(stored_end(&database, r3), ("unknown".to_owned(), true, 0));
        assert_eq!(in_flight(&database), []);
    }
}
