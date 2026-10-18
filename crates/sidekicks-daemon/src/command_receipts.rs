//! The command receipt's two-phase commit: a side-effecting tool call's receipt is accepted, then
//! claimed for execution by exactly one worker, then given its terminal status. Each phase is its
//! own write, so a restart finds a claimed receipt with no terminal status in flight and never runs
//! its command again.

use std::borrow::Cow;
use std::sync::{Arc, LazyLock};

use rusqlite::types::Value;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::wire::id::UuidText;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::database::statement::{
    DATABASE_NOW_SQL, StatementBindings, WriteStatement, nullable_text_binding, text_binding,
};
use crate::database::writer::{DatabaseWriter, WriteError};
use crate::uuid_v7::mint_uuid_v7;

/// One receipt's id, minted when its command is accepted.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "a side-effecting tool call's two-phase receipt")
)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct CommandReceiptId(Uuid);

/// A command to record before anything runs it.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "a side-effecting tool call's two-phase receipt")
)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CommandToReceive {
    /// The client's idempotency key, which names one command.
    pub(crate) command_id: String,
    /// The run the command belongs to, if any.
    pub(crate) run_id: Option<RunId>,
}

/// The receipt's status at acceptance: a refused command is recorded `rejected` and never run.
/// Stored by its camelCase name.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "a side-effecting tool call's two-phase receipt")
)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, strum::IntoStaticStr)]
#[strum(serialize_all = "camelCase")]
pub(crate) enum CommandAcceptance {
    /// The command was received and may run.
    Accepted,
    /// The command was refused and never runs.
    Rejected,
}

/// The receipt's status once its command has run. Stored by its camelCase name.
#[expect(dead_code, reason = "a side-effecting tool call's two-phase receipt")]
#[derive(Clone, Copy, Debug, PartialEq, Eq, strum::IntoStaticStr)]
#[strum(serialize_all = "camelCase")]
pub(crate) enum CommandOutcome {
    /// The command ran to its end.
    Completed,
    /// The command ran and failed.
    Failed,
}

/// Why a receipt was not accepted.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "a side-effecting tool call's two-phase receipt")
)]
#[derive(Debug, thiserror::Error)]
pub(crate) enum CommandReceiptError {
    /// The caller canceled before the receipt was written; nothing was written.
    #[error("the command was canceled before its receipt was written")]
    Canceled,
    /// The receipt's write failed, a command id that already has a receipt among the causes.
    #[error(transparent)]
    Write(#[from] WriteError),
}

#[cfg_attr(
    not(test),
    expect(dead_code, reason = "a side-effecting tool call's two-phase receipt")
)]
static ACCEPT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "INSERT INTO command_receipts (id, command_id, run_id, status, created_at)
  VALUES (@id, @command_id, @run_id, @status, {DATABASE_NOW_SQL})"
    )
});

// Only the first claim finds `started_at` empty, so only one worker changes the row.
#[expect(dead_code, reason = "a side-effecting tool call's two-phase receipt")]
static CLAIM_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE command_receipts
  SET started_at = {DATABASE_NOW_SQL}
  WHERE id = ? AND started_at IS NULL"
    )
});

#[expect(dead_code, reason = "a side-effecting tool call's two-phase receipt")]
static COMPLETE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE command_receipts
  SET status = @status, completed_at = {DATABASE_NOW_SQL}
  WHERE id = @id AND started_at IS NOT NULL AND completed_at IS NULL"
    )
});

/// Writes the command receipts, each phase of a receipt in its own write.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "a side-effecting tool call's two-phase receipt")
)]
pub(crate) struct CommandReceiptStore {
    /// The writer every phase goes through.
    writer: Arc<DatabaseWriter>,
}

impl CommandReceiptStore {
    /// A store writing through `writer`.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "a side-effecting tool call's two-phase receipt")
    )]
    pub(crate) fn new(writer: Arc<DatabaseWriter>) -> Self {
        Self { writer }
    }

    /// Records the command with `status` and returns its receipt id. Checks `cancellation` once,
    /// before the write, failing with [`CommandReceiptError::Canceled`] and writing nothing; past
    /// that check it runs to its answer. Fails with [`CommandReceiptError::Write`] as the write
    /// fails, a command id that already has a receipt among the causes, so a command is received
    /// once.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "a side-effecting tool call's two-phase receipt")
    )]
    pub(crate) async fn accept(
        &self,
        command: &CommandToReceive,
        status: CommandAcceptance,
        cancellation: &CancellationToken,
    ) -> Result<CommandReceiptId, CommandReceiptError> {
        if cancellation.is_cancelled() {
            return Err(CommandReceiptError::Canceled);
        }
        let receipt_id = CommandReceiptId(mint_uuid_v7());
        let receipt_text = receipt_id.0.to_string();
        let run_text = command.run_id.map(|run_id| run_id.text());
        self.writer
            .write(vec![WriteStatement {
                sql: Cow::Borrowed(ACCEPT_SQL.as_str()),
                bindings: StatementBindings::Named(vec![
                    text_binding("@id", &receipt_text),
                    text_binding("@command_id", &command.command_id),
                    nullable_text_binding("@run_id", run_text.as_ref().map(UuidText::as_str)),
                    text_binding("@status", <&'static str>::from(status)),
                ]),
                expected_row_count: Some(1),
            }])
            .await?;
        Ok(receipt_id)
    }

    /// Claims the receipt for execution; true only for the one caller that claimed it. A caller
    /// that gets false runs nothing, because another worker owns the execution. Fails as the
    /// write fails.
    #[expect(dead_code, reason = "a side-effecting tool call's two-phase receipt")]
    pub(crate) async fn claim_for_execution(
        &self,
        receipt_id: CommandReceiptId,
    ) -> Result<bool, WriteError> {
        let results = self
            .writer
            .write(vec![WriteStatement {
                sql: Cow::Borrowed(CLAIM_SQL.as_str()),
                bindings: StatementBindings::Positional(vec![Value::Text(
                    receipt_id.0.to_string(),
                )]),
                expected_row_count: None,
            }])
            .await?;
        Ok(results.first().is_some_and(|claim| claim.row_count == 1))
    }

    /// Records how the claimed command ended. Fails with [`WriteError::Refused`] when the receipt
    /// was never claimed or already has its terminal status, and as the write fails.
    #[expect(dead_code, reason = "a side-effecting tool call's two-phase receipt")]
    pub(crate) async fn complete(
        &self,
        receipt_id: CommandReceiptId,
        status: CommandOutcome,
    ) -> Result<(), WriteError> {
        let receipt_text = receipt_id.0.to_string();
        self.writer
            .write(vec![WriteStatement {
                sql: Cow::Borrowed(COMPLETE_SQL.as_str()),
                bindings: StatementBindings::Named(vec![
                    text_binding("@id", &receipt_text),
                    text_binding("@status", <&'static str>::from(status)),
                ]),
                expected_row_count: Some(1),
            }])
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use rstest::rstest;
    use tokio_util::sync::CancellationToken;

    use super::{CommandAcceptance, CommandReceiptError, CommandReceiptStore, CommandToReceive};
    use crate::database::writer::test_file::TestDatabase;
    use crate::database::writer::{DatabaseWriter, DatabaseWriterOptions};

    // The test database holds no `command_receipts` table, so an accept that wrote would fail with
    // SQLite's refusal of the write, never with the cancel.
    #[rstest]
    #[case::accepted(CommandAcceptance::Accepted)]
    #[case::rejected(CommandAcceptance::Rejected)]
    #[tokio::test]
    async fn a_canceled_accept_answers_canceled_and_writes_nothing(
        #[case] status: CommandAcceptance,
    ) {
        let database = TestDatabase::new();
        let writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
            .await
            .expect("the writer opens its database");
        let store = CommandReceiptStore::new(Arc::new(writer));
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        let command = CommandToReceive {
            command_id: "tool-call-1".to_owned(),
            run_id: None,
        };

        let accepted = store.accept(&command, status, &cancellation).await;

        assert!(
            matches!(accepted, Err(CommandReceiptError::Canceled)),
            "a canceled accept answers the cancel: {accepted:?}"
        );
    }
}
