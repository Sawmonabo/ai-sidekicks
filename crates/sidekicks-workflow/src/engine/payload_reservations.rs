//! The reservations of the payloads a run stores as artifacts ahead of the write that names them:
//! a start's, before its run's row, and a turn's, before the turn's write. Each id is reserved
//! under its run in one write before any artifact is stored under it. A start's run write deletes
//! the run's reservations, and a turn's write deletes those of the ids it reserved, but for an
//! artifact it could not delete; a start or turn whose write never lands deletes each artifact
//! with its reservation, keeping the reservation of one that will not delete. A reservation left
//! is what a stop cut or a cleanup could not finish, which the restart reads by its session and
//! deletes, its artifact or the lack of one alike, once no start or turn of its run is under way.

use std::borrow::Cow;

use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::UuidText;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};

use crate::runs::step_payload::StepPayloadWriteError;

const RESERVE_SQL: &str = "INSERT INTO workflow_payload_reservations
    (artifact_id, session_id, workflow_run_id)
  VALUES (@artifact_id, @session_id, @workflow_run_id)";

const FORGET_RUN_SQL: &str =
    "DELETE FROM workflow_payload_reservations WHERE workflow_run_id = @workflow_run_id";

const FORGET_PAYLOADS_SQL: &str = "DELETE FROM workflow_payload_reservations
  WHERE artifact_id IN (SELECT value FROM json_each(@artifact_ids))";

/// The payloads reserved in a session, each with the run it was reserved under and whether that
/// run has a row still unfinished: those no start's or turn's write named and no cleanup took
/// back, and those of a run under way.
pub(crate) const LEFT_PAYLOADS_SQL: &str = "SELECT reservation.artifact_id,
    reservation.workflow_run_id,
    EXISTS (SELECT 1 FROM workflow_runs AS run
      WHERE run.id = reservation.workflow_run_id AND run.finished_at IS NULL)
  FROM workflow_payload_reservations AS reservation
  WHERE reservation.session_id = ?1";

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

/// The statement that deletes every reservation of `workflow_run_id`, which a start's write of the
/// run's row runs, leaving the start's payloads to the run.
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

/// The statement that deletes the reservation of each of `artifact_ids`, which a turn's write runs
/// for the ids it reserved, leaving each artifact it stored to the row that names it.
pub(crate) fn forget_payloads_statement(artifact_ids: &[ArtifactId]) -> WriteStatement {
    let artifact_ids = artifact_ids
        .iter()
        .map(ArtifactId::text)
        .collect::<Vec<_>>();
    let artifact_ids = serde_json::to_string(
        &artifact_ids
            .iter()
            .map(UuidText::as_str)
            .collect::<Vec<_>>(),
    )
    .expect("a list of strings serializes");
    WriteStatement {
        sql: Cow::Borrowed(FORGET_PAYLOADS_SQL),
        bindings: StatementBindings::Named(vec![text_binding("@artifact_ids", &artifact_ids)]),
        expected_row_count: None,
    }
}

/// Deletes the reservation of each of `artifact_ids`, payloads deleted since or never stored, in
/// one write; writes nothing for none. Fails as the write fails, every reservation kept.
pub(crate) async fn forget_payloads(
    writer: &DatabaseWriter,
    artifact_ids: &[ArtifactId],
) -> Result<(), WriteError> {
    if artifact_ids.is_empty() {
        return Ok(());
    }
    writer
        .write(vec![forget_payloads_statement(artifact_ids)])
        .await
        .map(drop)
}
