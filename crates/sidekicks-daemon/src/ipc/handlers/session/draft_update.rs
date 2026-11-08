//! `session.draft.update`: the session's unsent composer draft, held in the daemon so every device
//! opens the same half-written message. The draft, its words and extras, replaces the one held when
//! the save was typed over its current revision; an empty draft clears it, which is how Send clears
//! it.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::session::draft::{SessionDraftUpdate, SessionDraftUpdateRequest};
use sidekicks_ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};
use sidekicks_session::draft_store::SessionDraftStore;

/// Registers `session.draft.update`, refusing a session the daemon does not hold
/// `session.notFound` and a save over a newer draft `session.draft.revisionStale`, keeping nothing.
/// Fails the start when the method is already registered.
pub(crate) fn register_session_draft_update(
    registry: &mut MethodRegistryBuilder,
    drafts: Arc<SessionDraftStore>,
) -> Result<(), RegistrationError> {
    registry.register::<SessionDraftUpdate, _>(
        move |request: SessionDraftUpdateRequest, _context: HandlerContext| {
            let drafts = Arc::clone(&drafts);
            async move {
                Ok(drafts
                    .write(request.session_id, request.draft, request.expected_revision)
                    .await?)
            }
            .boxed()
        },
    )
}
