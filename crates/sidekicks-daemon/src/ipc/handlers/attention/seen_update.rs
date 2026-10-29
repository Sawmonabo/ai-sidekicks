//! `attention.seen.update`: a session or a workflow run marked seen through its newest event.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::attention::{AttentionSeenUpdate, AttentionSeenUpdateRequest};
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};
use sidekicks_session::attention::service::AttentionService;

/// Registers `attention.seen.update`, refusing a session or workflow run the daemon does not hold.
pub(super) fn register_seen_update(
    builder: &mut MethodRegistryBuilder,
    attention: Arc<AttentionService>,
) -> Result<(), RegistrationError> {
    builder.register::<AttentionSeenUpdate, _>(
        move |request: AttentionSeenUpdateRequest, _context: HandlerContext| {
            let attention = Arc::clone(&attention);
            async move {
                attention.mark_seen(&request.subject).await?;
                Ok(EmptyPayload {})
            }
            .boxed()
        },
    )
}
