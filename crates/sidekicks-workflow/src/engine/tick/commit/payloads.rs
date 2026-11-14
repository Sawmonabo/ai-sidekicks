//! How a turn stores a payload above the inline cap: under an id the turn reserved under its run
//! before the artifact is stored, the turn's first such payload reserving a block of ids in one
//! write and later ones taking the block's next, so a stop between a store and the turn's write
//! leaves a reservation the restart deletes the artifact by. The turn's write deletes the
//! reservation of each id it reserved but an artifact's that may be stored and that no row names.

use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::workflow::definition::item::WorkflowItem;
use sidekicks_contracts::workflow::run::step::record::{WorkflowPayloadRef, WorkflowStepKey};

use super::RunTurnCommit;
use crate::engine::payload_reservations::{ReservedPayloadError, reserve_payload_ids};
use crate::runs::step_payload::{
    StepPayloadWriteError, inline_step_payload, mint_payload_artifact_id, prepare_artifact_payload,
};

/// How many ids a turn reserves in one write: at its first payload above the inline cap, and again
/// each time those are used up. A turn that stores none reserves none.
const TURN_RESERVED_ID_COUNT: usize = 8;

impl RunTurnCommit {
    /// `items`, a payload of `step`, as the reference its row stores: inline within the cap, else
    /// stored in the run's session as an artifact under an id the turn reserved first. Fails with
    /// [`ReservedPayloadError::Reservation`] when the reservation is not written, nothing stored,
    /// and with [`ReservedPayloadError::Write`] when the items do not write as JSON or the store
    /// refuses them, a refused artifact's reservation kept, since the store may hold part of it.
    pub(crate) async fn store_payload(
        &mut self,
        step: &WorkflowStepKey,
        items: &[WorkflowItem],
    ) -> Result<WorkflowPayloadRef, ReservedPayloadError> {
        if let Some(inline) = inline_step_payload(items)? {
            return Ok(inline);
        }
        let artifact_id = self.reserved_id().await?;
        let written = prepare_artifact_payload(artifact_id, items)?
            .write(&*self.payloads, self.keys.session_id, step)
            .await;
        if matches!(written, Err(StepPayloadWriteError::Artifact(_))) {
            self.keep_reservation(artifact_id);
        }
        written.map_err(ReservedPayloadError::Write)
    }

    /// Keeps the reservation of `artifact_id` past the turn's write, for an artifact that may be
    /// stored and that no row names, which the restart's sweep then deletes.
    pub(crate) fn keep_reservation(&mut self, artifact_id: ArtifactId) {
        self.reserved_ids
            .retain(|reserved| *reserved != artifact_id);
    }

    /// The turn's next reserved id, reserving a block under the run first when none is left.
    async fn reserved_id(&mut self) -> Result<ArtifactId, ReservedPayloadError> {
        if self.spare_ids.is_empty() {
            let block: Vec<ArtifactId> = (0..TURN_RESERVED_ID_COUNT)
                .map(|_| mint_payload_artifact_id())
                .collect();
            reserve_payload_ids(&self.writer, self.keys.session_id, self.run_id, &block)
                .await
                .map_err(ReservedPayloadError::Reservation)?;
            self.reserved_ids.extend_from_slice(&block);
            self.spare_ids = block;
        }
        Ok(self
            .spare_ids
            .pop()
            .expect("a block was just reserved where none was left"))
    }
}
