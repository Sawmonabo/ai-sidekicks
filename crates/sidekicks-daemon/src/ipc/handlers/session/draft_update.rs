//! `session.draft.update`: the session's unsent composer draft, held in the daemon so every device
//! opens the same half-written message. The text replaces the draft held; an empty text clears it,
//! which is how Send clears it.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::session::draft::{
    SessionDraftUpdate, SessionDraftUpdateRequest, SessionDraftUpdateResponse,
};

use crate::ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use crate::session::directory::lookups::SessionWriteError;
use crate::session::draft_store::{SessionDraftError, SessionDraftStore};

/// Registers `session.draft.update` over `drafts`, answering the session and when the draft was
/// stored. Refuses a session the daemon does not hold `session.notFound`, keeping nothing. Fails
/// the start when the method is already registered.
pub(crate) fn register_session_draft_update(
    registry: &mut MethodRegistryBuilder,
    drafts: Arc<SessionDraftStore>,
) -> Result<(), RegistrationError> {
    registry.register::<SessionDraftUpdate, _>(
        move |request: SessionDraftUpdateRequest, _context: HandlerContext| {
            let drafts = Arc::clone(&drafts);
            async move {
                let updated_at = drafts.write(request.session_id, request.text).await?;
                Ok(SessionDraftUpdateResponse {
                    session_id: request.session_id,
                    updated_at,
                })
            }
            .boxed()
        },
    )
}

impl From<SessionWriteError> for HandlerError {
    /// A session the daemon does not hold answers `session.notFound`; a write not kept is a fault
    /// in the daemon.
    fn from(error: SessionWriteError) -> Self {
        match error {
            SessionWriteError::Refused(refusal) => Self::Refused(refusal),
            SessionWriteError::Write(fault) => Self::Internal(Box::new(fault)),
        }
    }
}

impl From<SessionDraftError> for HandlerError {
    /// A store refused for its session answers as that refusal does; a failed read is a fault in
    /// the daemon.
    fn from(error: SessionDraftError) -> Self {
        match error {
            SessionDraftError::Write(write) => write.into(),
            fault @ (SessionDraftError::Database(_) | SessionDraftError::Pool(_)) => {
                Self::Internal(Box::new(fault))
            }
        }
    }
}
