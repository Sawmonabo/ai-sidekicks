//! The task handle recorder: the one writer of `command_receipts.mcp_task_id`, the handle an MCP
//! task-augmented call's acceptance names, which recovery polls instead of halting the call, and of
//! `mcp_task_generation`, which says how to poll it and is written in the same statement.
//!
//! - A handle past the column's bound is refused, never cut, since a cut handle names another
//!   task; a refusal leaves the column `NULL`, so after a restart the call stays halted, never
//!   run again.
//! - The first handle wins: the claim writes only a `NULL` column, and the read-back in the same
//!   write tells an absent receipt, the same handle and generation already stored, and a
//!   different pair apart.

use std::borrow::Cow;
use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rusqlite::types::Value as SqlValue;
use serde_json::{Map, Value};
use sidekicks_contracts::provider::id::ProviderId;
use strum::IntoStaticStr;

use crate::client::tasks::{McpTaskHandleObservation, McpTaskHandleSink};
use sidekicks_provider::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::writer::{DatabaseWriter, WriteError, sqlite_error_code};

/// The longest stored task handle, in code points as SQLite's `length()` counts them: the bound
/// the column's check holds, repeated so a refusal names the server, tool and length instead of
/// an opaque constraint failure.
pub(crate) const MCP_TASK_ID_MAX_LENGTH: usize = 256;

/// Claims the receipt's handle and generation columns together, only while the handle is still
/// `NULL`, since the table's check holds both set or both `NULL`.
const CLAIM_HANDLE_SQL: &str = "UPDATE command_receipts \
                                SET mcp_task_id = @mcp_task_id, \
                                    mcp_task_generation = @mcp_task_generation \
                                WHERE command_id = @command_id AND mcp_task_id IS NULL";

/// Reads the receipt's handle and generation back, in the same write as the claim.
const READ_STORED_HANDLE_SQL: &str = "SELECT mcp_task_id, mcp_task_generation \
                                      FROM command_receipts WHERE command_id = @command_id";

/// Why a handle was not stored. The first three are what the column's check refuses; the last two
/// are states of the receipt row the check cannot express.
#[derive(Clone, Copy, Debug, PartialEq, Eq, IntoStaticStr)]
#[strum(serialize_all = "camelCase")]
pub(crate) enum McpTaskHandleRefusalReason {
    /// The handle is empty.
    HandleEmpty,
    /// The handle is longer than [`MCP_TASK_ID_MAX_LENGTH`].
    HandleTooLong,
    /// The handle holds U+0000.
    HandleContainsNul,
    /// No receipt row carries the dispatch's command id.
    ReceiptAbsent,
    /// The receipt already holds a different handle, or this handle under the other generation.
    HandleConflict,
}

/// What offering one handle to its receipt row came to; `AlreadyRecorded` is a success.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum McpTaskHandleRecordOutcome {
    /// The handle is stored.
    Recorded,
    /// The receipt already held this same handle under this same generation.
    AlreadyRecorded,
    /// The handle was not stored, for `reason`; the column is unchanged.
    Refused {
        /// Why.
        reason: McpTaskHandleRefusalReason,
    },
    /// The database failed the write; the column is unchanged.
    StorageFailed,
}

/// One bounded walk over a handle: it stops at the first U+0000 or the first code point past the
/// bound, so an untrusted handle of any size costs at most one code point more than the bound.
struct HandleScan {
    /// Code points walked: the exact length for a clean handle, else where the walk stopped.
    scanned_code_points: usize,
    has_nul: bool,
}

impl HandleScan {
    fn of(handle: &str) -> Self {
        let mut scanned_code_points = 0;
        for character in handle.chars().take(MCP_TASK_ID_MAX_LENGTH + 1) {
            scanned_code_points += 1;
            if character == '\0' {
                return Self {
                    scanned_code_points,
                    has_nul: true,
                };
            }
        }
        Self {
            scanned_code_points,
            has_nul: false,
        }
    }

    /// Why the column's check would refuse the handle, or `None` when it can be stored.
    fn refusal(&self) -> Option<McpTaskHandleRefusalReason> {
        if self.scanned_code_points == 0 {
            Some(McpTaskHandleRefusalReason::HandleEmpty)
        } else if self.has_nul {
            Some(McpTaskHandleRefusalReason::HandleContainsNul)
        } else if self.scanned_code_points > MCP_TASK_ID_MAX_LENGTH {
            Some(McpTaskHandleRefusalReason::HandleTooLong)
        } else {
            None
        }
    }
}

/// Stores each observed task handle on its dispatch's command receipt row, one recorder per driver
/// binding, whose provider its diagnostics name. It never fails the turn: every failure is an
/// outcome and a diagnostic, and leaves the column `NULL`.
pub(crate) struct McpTaskHandleRecorder {
    writer: Arc<DatabaseWriter>,
    provider: ProviderId,
}

impl McpTaskHandleRecorder {
    /// A recorder writing through `writer` for `provider`'s binding.
    #[expect(
        dead_code,
        reason = "the session's tool-server connections, which the tool-server units open, hand \
                  each task handle to it"
    )]
    pub(crate) fn new(writer: Arc<DatabaseWriter>, provider: ProviderId) -> Self {
        Self { writer, provider }
    }

    /// Offers `observation`'s handle to its receipt row. Every refusal and storage failure is
    /// logged and returned, never raised, and leaves the column as it was.
    pub(crate) async fn store(
        &self,
        observation: &McpTaskHandleObservation,
    ) -> McpTaskHandleRecordOutcome {
        let handle = observation.mcp_task_id.as_str();
        let scan = HandleScan::of(handle);
        if let Some(reason) = scan.refusal() {
            return self.refuse(observation, reason, scan.scanned_code_points);
        }
        let command_id = &observation.dispatch.command_id;
        let statement = |sql: &'static str, bindings| WriteStatement {
            sql: Cow::Borrowed(sql),
            bindings: StatementBindings::Named(bindings),
            expected_row_count: None,
        };
        let write = self
            .writer
            .write(vec![
                statement(
                    CLAIM_HANDLE_SQL,
                    vec![
                        text_binding("@mcp_task_id", handle),
                        text_binding(
                            "@mcp_task_generation",
                            <&str>::from(observation.mcp_task_generation),
                        ),
                        text_binding("@command_id", command_id),
                    ],
                ),
                statement(
                    READ_STORED_HANDLE_SQL,
                    vec![text_binding("@command_id", command_id)],
                ),
            ])
            .await;
        let results = match write {
            Ok(results) => results,
            Err(error) => return self.report_storage_failure(observation, &error),
        };
        let [claim, stored] = <[_; 2]>::try_from(results)
            .expect("the writer answers one result per statement it was given");
        if claim.row_count > 0 {
            return McpTaskHandleRecordOutcome::Recorded;
        }
        // Nothing changed: the receipt is absent or holds a handle; the read-back says which.
        let generation = <&str>::from(observation.mcp_task_generation);
        let reason = match stored.rows.first().map(Vec::as_slice) {
            None => McpTaskHandleRefusalReason::ReceiptAbsent,
            Some(
                [
                    SqlValue::Text(stored_handle),
                    SqlValue::Text(stored_generation),
                ],
            ) if stored_handle == handle && stored_generation == generation => {
                return McpTaskHandleRecordOutcome::AlreadyRecorded;
            }
            Some(_) => McpTaskHandleRefusalReason::HandleConflict,
        };
        self.refuse(observation, reason, scan.scanned_code_points)
    }

    /// Logs a refused handle by its length alone, never the handle, which is untrusted output of
    /// any size.
    fn refuse(
        &self,
        observation: &McpTaskHandleObservation,
        reason: McpTaskHandleRefusalReason,
        scanned_code_points: usize,
    ) -> McpTaskHandleRecordOutcome {
        let mut details = dispatch_details(observation);
        details.insert(
            "handleCodePointsScanned".to_owned(),
            Value::from(scanned_code_points),
        );
        emit_driver_diagnostic(&DriverDiagnosticRecord {
            provider: self.provider.clone(),
            provider_account_id: None,
            kind: DriverDiagnosticKind::McpTaskHandleWriteRefused,
            raw_wire_type: None,
            disposition_reason: <&str>::from(reason).to_owned(),
            details,
        });
        McpTaskHandleRecordOutcome::Refused { reason }
    }

    /// Logs a write the database failed, a local fault kept apart from the peer's bad handle, by
    /// its SQLite result code and the writer's own words, which carry no SQL.
    fn report_storage_failure(
        &self,
        observation: &McpTaskHandleObservation,
        error: &WriteError,
    ) -> McpTaskHandleRecordOutcome {
        let sqlite_code = sqlite_error_code(error);
        let mut details = dispatch_details(observation);
        details.insert("writeError".to_owned(), Value::from(error.to_string()));
        emit_driver_diagnostic(&DriverDiagnosticRecord {
            provider: self.provider.clone(),
            provider_account_id: None,
            kind: DriverDiagnosticKind::McpTaskHandleWriteFailed,
            raw_wire_type: None,
            disposition_reason: sqlite_code.map_or_else(
                || "unknownStorageError".to_owned(),
                |code| format!("{code:?}"),
            ),
            details,
        });
        McpTaskHandleRecordOutcome::StorageFailed
    }
}

impl McpTaskHandleSink for McpTaskHandleRecorder {
    fn record(&self, observation: McpTaskHandleObservation) -> BoxFuture<'_, ()> {
        // The outcome is already logged; the sink's caller only waits for it to settle.
        async move {
            self.store(&observation).await;
        }
        .boxed()
    }
}

/// The dispatch's identity as diagnostic details: its command id, server and tool.
fn dispatch_details(observation: &McpTaskHandleObservation) -> Map<String, Value> {
    let dispatch = &observation.dispatch;
    Map::from_iter([
        (
            "commandId".to_owned(),
            Value::from(dispatch.command_id.as_str()),
        ),
        (
            "serverName".to_owned(),
            Value::from(dispatch.server_name.as_str()),
        ),
        (
            "toolName".to_owned(),
            Value::from(dispatch.tool_name.as_str()),
        ),
    ])
}
