//! The files staged for a session's next message, as `session.read` lays them into the session's
//! record.

use std::error::Error;

use futures::future::BoxFuture;
use sidekicks_contracts::session::draft::SessionAttachmentSummary;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_ipc::registry::HandlerError;

/// Reads the files staged for a session's next message, answered by the staged-attachments store.
pub trait StagedAttachments: Send + Sync {
    /// The files staged for `session_id`, in the order they were staged. Fails with
    /// [`StagedAttachmentsError`] when the store cannot read them.
    fn read(
        &self,
        session_id: &SessionId,
    ) -> BoxFuture<'_, Result<Vec<SessionAttachmentSummary>, StagedAttachmentsError>>;
}

/// Why the files staged for a session could not be read.
#[derive(Debug, thiserror::Error)]
#[error("the files staged for a session could not be read")]
pub struct StagedAttachmentsError(#[source] pub(crate) Box<dyn Error + Send + Sync>);

impl From<StagedAttachmentsError> for HandlerError {
    /// A staged-files read that failed is a fault in the daemon.
    fn from(error: StagedAttachmentsError) -> Self {
        Self::Internal(Box::new(error))
    }
}
