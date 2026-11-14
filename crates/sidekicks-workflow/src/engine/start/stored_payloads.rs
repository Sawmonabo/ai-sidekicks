//! The payloads a start stores before its run's row: each kept as an artifact is recorded under its
//! run as it is stored, the run's own write deletes the run's records, and a start that makes no
//! run deletes each payload with its record. A record left is what a stop cut, which the restart
//! reads by its session and deletes.

use std::borrow::Cow;

use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::workflow::definition::item::WorkflowItem;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::step::record::{WorkflowPayloadRef, WorkflowStepKey};
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};

use crate::engine::ports::{PortError, StepPayloadArtifacts};
use crate::runs::step_payload::{StepPayloadWriteError, write_step_payload};

const RECORD_SQL: &str = "INSERT INTO workflow_start_payloads
    (artifact_id, session_id, workflow_run_id)
  VALUES (@artifact_id, @session_id, @workflow_run_id)";

const FORGET_RUN_SQL: &str =
    "DELETE FROM workflow_start_payloads WHERE workflow_run_id = @workflow_run_id";

const FORGET_PAYLOAD_SQL: &str =
    "DELETE FROM workflow_start_payloads WHERE artifact_id = @artifact_id";

/// The payloads a stop left in a session: those its starts stored and recorded that no run's write
/// or start's cleanup took back.
pub(crate) const LEFT_PAYLOADS_SQL: &str =
    "SELECT artifact_id FROM workflow_start_payloads WHERE session_id = ?1";

/// Why a start's payload was not kept: its write, or the record of the artifact it was kept as,
/// which the start's cleanup still deletes.
#[derive(Debug, thiserror::Error)]
pub(crate) enum StartPayloadError {
    /// The payload did not write.
    #[error(transparent)]
    Write(StepPayloadWriteError),
    /// The artifact was kept, and its record under the run was not written.
    #[error("a payload the start stored could not be recorded under its run")]
    Record(#[source] WriteError),
}

/// The payloads one start stored, each kept as an artifact recorded under the start's run.
pub(crate) struct StartPayloads<'start> {
    writer: &'start DatabaseWriter,
    payloads: &'start dyn StepPayloadArtifacts,
    session_id: SessionId,
    workflow_run_id: WorkflowRunId,
    stored: Vec<ArtifactId>,
}

impl<'start> StartPayloads<'start> {
    /// The payloads of the start of `workflow_run_id` in `session_id`, none stored yet.
    pub(crate) fn new(
        writer: &'start DatabaseWriter,
        payloads: &'start dyn StepPayloadArtifacts,
        session_id: SessionId,
        workflow_run_id: WorkflowRunId,
    ) -> Self {
        Self {
            writer,
            payloads,
            session_id,
            workflow_run_id,
            stored: Vec::new(),
        }
    }

    /// The store the start writes its payloads through, for the reads its copies take.
    pub(crate) fn payloads(&self) -> &'start dyn StepPayloadArtifacts {
        self.payloads
    }

    /// `items`, a payload of `step`, inline within the cap, else stored in the start's session as
    /// an artifact and recorded under its run. Fails as [`StartPayloadError`] says.
    pub(crate) async fn store(
        &mut self,
        step: &WorkflowStepKey,
        items: &[WorkflowItem],
    ) -> Result<WorkflowPayloadRef, StartPayloadError> {
        let payload_ref = write_step_payload(self.payloads, self.session_id, step, items)
            .await
            .map_err(StartPayloadError::Write)?;
        if let WorkflowPayloadRef::Artifact { artifact_id, .. } = &payload_ref {
            self.record(*artifact_id).await?;
        }
        Ok(payload_ref)
    }

    /// `bytes`, holding `item_count` entries, stored under `step` in the start's session as an
    /// artifact and recorded under its run. Fails with [`StartPayloadError::Write`] when the store
    /// refuses it.
    pub(crate) async fn store_bytes(
        &mut self,
        step: &WorkflowStepKey,
        bytes: Vec<u8>,
        item_count: u64,
    ) -> Result<ArtifactId, StartPayloadError> {
        let artifact_id = self
            .payloads
            .write(self.session_id, step, bytes, item_count)
            .await
            .map_err(|error| StartPayloadError::Write(StepPayloadWriteError::Artifact(error)))?;
        self.record(artifact_id).await?;
        Ok(artifact_id)
    }

    /// The statement the run's own write deletes the run's records with, which leaves its
    /// payloads to the run.
    pub(crate) fn forget_statement(&self) -> WriteStatement {
        WriteStatement {
            sql: Cow::Borrowed(FORGET_RUN_SQL),
            bindings: StatementBindings::Named(vec![text_binding(
                "@workflow_run_id",
                self.workflow_run_id.text().as_str(),
            )]),
            expected_row_count: None,
        }
    }

    /// Deletes each payload stored, with its record, for a start that made no run; answers each
    /// payload whose delete failed with the failure, its record kept for the restart.
    pub(crate) async fn discard(self) -> Vec<(ArtifactId, PortError)> {
        let mut left = Vec::new();
        for artifact_id in self.stored {
            match self.payloads.delete(&artifact_id).await {
                Ok(()) => {
                    if let Err(error) = forget_payload(self.writer, artifact_id).await {
                        left.push((artifact_id, Box::new(error) as PortError));
                    }
                }
                Err(removal) => left.push((artifact_id, removal)),
            }
        }
        left
    }

    // Records `artifact_id` under the start's run, once it is named for the cleanup.
    async fn record(&mut self, artifact_id: ArtifactId) -> Result<(), StartPayloadError> {
        self.stored.push(artifact_id);
        self.writer
            .write(vec![WriteStatement {
                sql: Cow::Borrowed(RECORD_SQL),
                bindings: StatementBindings::Named(vec![
                    text_binding("@artifact_id", artifact_id.text().as_str()),
                    text_binding("@session_id", self.session_id.text().as_str()),
                    text_binding("@workflow_run_id", self.workflow_run_id.text().as_str()),
                ]),
                expected_row_count: Some(1),
            }])
            .await
            .map(drop)
            .map_err(StartPayloadError::Record)
    }
}

/// Deletes the record of `artifact_id`, a payload deleted since. Fails as the write fails.
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
