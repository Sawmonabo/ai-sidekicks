//! A damaged session's two recovery actions: `session.recovery.continue`, `Continue from here`,
//! and `session.recovery.delete`, `Delete session`.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_contracts::session::methods::{
    SessionRecoveryContinue, SessionRecoveryDelete, SessionTargetRequest,
};

use crate::ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};
use crate::recovery::damaged_history::DamagedHistory;

/// Registers the two recovery actions, refusing a session the daemon does not hold
/// `session.notFound` and one the action does not fit `session.recovery.refused`. Fails the start
/// when either is already registered.
pub(crate) fn register_session_recovery_methods(
    registry: &mut MethodRegistryBuilder,
    damaged_history: Arc<DamagedHistory>,
) -> Result<(), RegistrationError> {
    let continuing = Arc::clone(&damaged_history);
    registry.register::<SessionRecoveryContinue, _>(
        move |request: SessionTargetRequest, _context: HandlerContext| {
            let damaged_history = Arc::clone(&continuing);
            async move {
                damaged_history
                    .continue_from_last_good_point(request.session_id)
                    .await?;
                Ok(EmptyPayload {})
            }
            .boxed()
        },
    )?;
    registry.register::<SessionRecoveryDelete, _>(
        move |request: SessionTargetRequest, _context: HandlerContext| {
            let damaged_history = Arc::clone(&damaged_history);
            async move {
                damaged_history
                    .delete_damaged_session(request.session_id)
                    .await?;
                Ok(EmptyPayload {})
            }
            .boxed()
        },
    )
}
