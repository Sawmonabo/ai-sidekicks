//! An approval card raiser for a test whose runs raise no card, keeping each wait whose card it
//! was told to withdraw.

use std::sync::Mutex;

use futures::future::BoxFuture;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::UuidTextForm;
use sidekicks_std::mutex_lock::lock;

use super::{ApprovalCardRaiser, PortError, REFUSED_PORT_CALL, WorkflowApprovalCardRequest};

/// Refuses every raise and keeps, in order, the session and wait of each card withdrawn.
#[derive(Default)]
pub(crate) struct WithdrawnCards(Mutex<Vec<(SessionId, UuidTextForm)>>);

impl WithdrawnCards {
    /// The cards withdrawn so far, each by its session and wait.
    pub(crate) fn withdrawn(&self) -> Vec<(SessionId, UuidTextForm)> {
        lock(&self.0).clone()
    }
}

impl ApprovalCardRaiser for WithdrawnCards {
    fn raise(&self, _request: WorkflowApprovalCardRequest) -> BoxFuture<'_, Result<(), PortError>> {
        Box::pin(async { Err(REFUSED_PORT_CALL.into()) })
    }

    fn withdraw(
        &self,
        session_id: SessionId,
        wait_ids: Vec<UuidTextForm>,
    ) -> BoxFuture<'_, Result<Vec<Result<(), PortError>>, PortError>> {
        lock(&self.0).extend(wait_ids.iter().map(|&wait_id| (session_id, wait_id)));
        let answers = wait_ids.iter().map(|_| Ok(())).collect();
        Box::pin(async { Ok(answers) })
    }
}
