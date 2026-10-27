//! The staged files a message carries, as a driver hands them to its provider: each bound to the
//! stored copy the provider reads, in the order they were staged, and one the daemon could not bind
//! standing in its own place as an unresolved marker, so no file is ever left out unsaid.

use std::error::Error;
use std::path::PathBuf;

use futures::future::BoxFuture;
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::session::id::SessionId;

/// One staged file bound to its stored copy: the absolute path the provider reads, the file's own
/// name, and the media type read from its bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedAttachment {
    /// The attachment's artifact.
    pub artifact_id: ArtifactId,
    /// The stored copy's absolute path.
    pub path: PathBuf,
    /// The file's own name.
    pub file_name: String,
    /// The media type read from the file's bytes.
    pub media_type: String,
}

/// Why an attachment could not be delivered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnresolvedAttachmentCause {
    /// Its manifest went with its payload.
    Deleted,
}

impl UnresolvedAttachmentCause {
    /// What the agent reads in the place of a file that could not be delivered for this cause.
    const fn reason(self) -> &'static str {
        match self {
            Self::Deleted => "it was deleted",
        }
    }
}

/// The marker in the place of an attachment the daemon could not bind to its manifest at delivery,
/// so the list keeps its length and order and the recipient reads why the file is missing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnresolvedAttachmentMarker {
    /// The attachment's artifact.
    pub artifact_id: ArtifactId,
    /// Why it could not be delivered.
    pub cause: UnresolvedAttachmentCause,
}

/// One attachment as a driver hands it to its provider, a bound file or the marker in its place.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProviderAttachment {
    /// A file bound to its stored copy.
    Resolved(ResolvedAttachment),
    /// The marker in the place of a file that could not be bound.
    Unresolved(UnresolvedAttachmentMarker),
}

/// Binds a message's attachments to their stored copies, answering one entry per id in the same
/// order; an id it cannot bind is an unresolved marker in its place. An error when the stored
/// copies could not be read at all. Wired by the daemon.
pub trait AttachmentResolver: Send + Sync {
    /// The attachments `artifact_ids` of a message in `session_id`, one per id in order.
    fn resolve_attachments(
        &self,
        session_id: SessionId,
        artifact_ids: Vec<ArtifactId>,
    ) -> BoxFuture<'_, Result<Vec<ProviderAttachment>, Box<dyn Error + Send + Sync>>>;
}

/// Binds a message's attachments in staging order; one with none asks the resolver nothing. An
/// error is the resolver's own.
pub(crate) async fn resolve_message_attachments(
    resolver: &dyn AttachmentResolver,
    session_id: &SessionId,
    artifact_ids: &[ArtifactId],
) -> Result<Vec<ProviderAttachment>, Box<dyn Error + Send + Sync>> {
    if artifact_ids.is_empty() {
        return Ok(Vec::new());
    }
    resolver
        .resolve_attachments(*session_id, artifact_ids.to_vec())
        .await
}

/// The line an agent reads for a file given to it by its path, which it opens itself, or for one
/// that could not be delivered, naming why.
pub(crate) fn compose_attachment_text(attachment: &ProviderAttachment) -> String {
    match attachment {
        ProviderAttachment::Resolved(resolved) => format!(
            "Attached file {}: {}",
            resolved.file_name,
            resolved.path.to_string_lossy()
        ),
        ProviderAttachment::Unresolved(marker) => format!(
            "Attached file {} was not delivered: {}.",
            marker.artifact_id,
            marker.cause.reason()
        ),
    }
}

/// A message as words alone, for a reader that takes only text: its words, then a line per
/// attachment in staging order.
pub(crate) fn compose_message_text(content: &str, attachments: &[ProviderAttachment]) -> String {
    let mut text = content.to_owned();
    for attachment in attachments {
        text.push('\n');
        text.push_str(&compose_attachment_text(attachment));
    }
    text
}
