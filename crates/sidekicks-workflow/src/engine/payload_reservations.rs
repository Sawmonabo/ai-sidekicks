//! The reservations of the payloads a run stores as artifacts ahead of the write that names them:
//! a start's, before its run's row, and a turn's, before the turn's write. Each id is reserved
//! under its run in one write before any artifact is stored under it; the write that names the
//! artifacts deletes the run's reservations, and a start or turn whose write never lands deletes
//! each artifact with its reservation. A reservation left is what a stop cut, which the restart
//! reads by its session and deletes, its artifact or the lack of one alike.

use std::borrow::Cow;

use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};

use crate::runs::step_payload::StepPayloadWriteError;

const RESERVE_SQL: &str = "INSERT INTO workflow_payload_reservations
    (artifact_id, session_id, workflow_run_id)
  VALUES (@artifact_id, @session_id, @workflow_run_id)";

const FORGET_RUN_SQL: &str =
    "DELETE FROM workflow_payload_reservations WHERE workflow_run_id = @workflow_run_id";

const FORGET_PAYLOAD_SQL: &str =
    "DELETE FROM workflow_payload_reservations WHERE artifact_id = @artifact_id";

/// The payloads a stop left in a session, each with the run it was reserved under: those no
/// start's or turn's write named and no cleanup took back.
pub(crate) const LEFT_PAYLOADS_SQL: &str =
    "SELECT artifact_id, workflow_run_id FROM workflow_payload_reservations WHERE session_id = ?1";

/// Why a payload kept as an artifact under a reservation was not kept: its reservation, written
/// first, or its write after it, whose reservation the cleanup deletes.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ReservedPayloadError {
    /// The payload did not write.
    #[error(transparent)]
    Write(#[from] StepPayloadWriteError),
    /// The reservation under the run was not written, so nothing was stored.
    #[error("a payload could not be reserved under its run")]
    Reservation(#[source] WriteError),
}

/// Reserves each of `artifact_ids` under `workflow_run_id` in `session_id`, in one write, before
/// any is stored; writes nothing for none. Fails as the write fails, nothing reserved.
pub(crate) async fn reserve_payload_ids(
    writer: &DatabaseWriter,
    session_id: SessionId,
    workflow_run_id: WorkflowRunId,
    artifact_ids: &[ArtifactId],
) -> Result<(), WriteError> {
    if artifact_ids.is_empty() {
        return Ok(());
    }
    let statements = artifact_ids
        .iter()
        .map(|artifact_id| WriteStatement {
            sql: Cow::Borrowed(RESERVE_SQL),
            bindings: StatementBindings::Named(vec![
                text_binding("@artifact_id", artifact_id.text().as_str()),
                text_binding("@session_id", session_id.text().as_str()),
                text_binding("@workflow_run_id", workflow_run_id.text().as_str()),
            ]),
            expected_row_count: Some(1),
        })
        .collect();
    writer.write(statements).await.map(drop)
}

/// The statement that deletes every reservation of `workflow_run_id`, which the write that names
/// its artifacts runs, leaving them to the rows that name them.
pub(crate) fn forget_run_statement(workflow_run_id: WorkflowRunId) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(FORGET_RUN_SQL),
        bindings: StatementBindings::Named(vec![text_binding(
            "@workflow_run_id",
            workflow_run_id.text().as_str(),
        )]),
        expected_row_count: None,
    }
}

/// Deletes every reservation of `workflow_run_id`, whose reserved artifacts are deleted since.
/// Fails as the write fails.
pub(crate) async fn forget_run_reservations(
    writer: &DatabaseWriter,
    workflow_run_id: WorkflowRunId,
) -> Result<(), WriteError> {
    writer
        .write(vec![forget_run_statement(workflow_run_id)])
        .await
        .map(drop)
}

/// Deletes the reservation of `artifact_id`, a payload deleted since. Fails as the write fails.
pub(crate) async fn forget_payload(
    writer: &DatabaseWriter,
    artifact_id: ArtifactId,
) -> Result<(), WriteError> {
    writer
        .write(vec![WriteStatement {
            sql: Cow::Borrowed(FORGET_PAYLOAD_SQL),
            bindings: StatementBindings::Named(vec![text_binding(
                "@artifact_id",
                artifact_id.text().as_str(),
            )]),
            expected_row_count: None,
        }])
        .await
        .map(drop)
}
