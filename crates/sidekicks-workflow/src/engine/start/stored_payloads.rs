//! The payloads a start stores before its run's row: each kept as an artifact is reserved under
//! its run, under an id minted for it, before it is stored, the reservations of payloads stored
//! together in one write; the run's own write deletes the run's reservations, and a start that
//! makes no run deletes each payload with its reservation.

use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::workflow::definition::item::WorkflowItem;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::step::record::{WorkflowPayloadRef, WorkflowStepKey};
use sidekicks_store::database::statement::WriteStatement;
use sidekicks_store::database::writer::DatabaseWriter;

use crate::engine::payload_reservations::{
    ReservedPayloadError, forget_payloads, forget_run_statement, reserve_payload_ids,
};
use crate::engine::ports::{PortError, StepPayloadArtifacts};
use crate::runs::step_payload::{
    PreparedStepPayload, StepPayloadWriteError, mint_payload_artifact_id, prepare_step_payload,
};

/// The payloads one start stored, each kept as an artifact reserved under the start's run.
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

    /// `items`, a payload of `step`, inline within the cap, else reserved under the start's run
    /// and then stored in the start's session as an artifact. Fails as [`ReservedPayloadError`]
    /// says.
    pub(crate) async fn store(
        &mut self,
        step: &WorkflowStepKey,
        items: &[WorkflowItem],
    ) -> Result<WorkflowPayloadRef, ReservedPayloadError> {
        let prepared = prepare_step_payload(items)?;
        self.reserve(prepared.artifact_id()).await?;
        self.write(prepared, step).await
    }

    /// `bytes`, holding `item_count` entries, reserved under the start's run and then stored under
    /// `step` in the start's session as an artifact. Fails with
    /// [`ReservedPayloadError::Reservation`] when its reservation is not written, and with
    /// [`ReservedPayloadError::Write`] when the store refuses it.
    pub(crate) async fn store_bytes(
        &mut self,
        step: &WorkflowStepKey,
        bytes: Vec<u8>,
        item_count: u64,
    ) -> Result<ArtifactId, ReservedPayloadError> {
        let artifact_id = mint_payload_artifact_id();
        self.reserve([artifact_id]).await?;
        self.payloads
            .write(self.session_id, step, artifact_id, bytes, item_count)
            .await
            .map_err(StepPayloadWriteError::Artifact)?;
        Ok(artifact_id)
    }

    /// The reference of `prepared`, a payload of `step` whose artifact, if it names one, is
    /// reserved, once that artifact is stored in the start's session. Fails with
    /// [`ReservedPayloadError::Write`] when the store refuses it.
    pub(crate) async fn write(
        &self,
        prepared: PreparedStepPayload,
        step: &WorkflowStepKey,
    ) -> Result<WorkflowPayloadRef, ReservedPayloadError> {
        Ok(prepared.write(self.payloads, self.session_id, step).await?)
    }

    /// The statement the run's own write deletes the run's reservations with, which leaves its
    /// payloads to the run.
    pub(crate) fn forget_statement(&self) -> WriteStatement {
        forget_run_statement(self.workflow_run_id)
    }

    /// Deletes each payload reserved, with its reservation, for a start that made no run, one
    /// never stored among them; answers each payload whose delete failed with the failure, its
    /// reservation kept for the restart.
    pub(crate) async fn discard(self) -> Vec<(ArtifactId, PortError)> {
        let mut left = Vec::new();
        for artifact_id in self.stored {
            match self.payloads.delete(&artifact_id).await {
                Ok(()) => {
                    if let Err(error) = forget_payloads(self.writer, &[artifact_id]).await {
                        left.push((artifact_id, Box::new(error) as PortError));
                    }
                }
                Err(removal) => left.push((artifact_id, removal)),
            }
        }
        left
    }

    /// Reserves each of `artifact_ids` under the start's run in one write, before any is stored,
    /// each named for the cleanup first. Fails with [`ReservedPayloadError::Reservation`].
    pub(crate) async fn reserve(
        &mut self,
        artifact_ids: impl IntoIterator<Item = ArtifactId>,
    ) -> Result<(), ReservedPayloadError> {
        let first = self.stored.len();
        self.stored.extend(artifact_ids);
        reserve_payload_ids(
            self.writer,
            self.session_id,
            self.workflow_run_id,
            &self.stored[first..],
        )
        .await
        .map_err(ReservedPayloadError::Reservation)
    }
}
