//! A message's staged files as Claude Code's streaming input takes them: a picture in a format its
//! image block takes as that block, built from the stored bytes, and any other file as its path in
//! the message's words, which the agent opens itself. A picture past Claude Code's size limit is
//! refused before it is read, in Claude Code's own words.

use std::error::Error;
use std::future::Future;
use std::io;
use std::path::PathBuf;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use futures::future::try_join_all;
use serde::Deserialize;
use serde::de::value::StrDeserializer;
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::session::id::SessionId;

use crate::provider::driver::attachments::{
    AttachmentResolver, ProviderAttachment, compose_attachment_text, resolve_message_attachments,
};
use crate::provider::driver::claude::session::transport::user_message::{
    ClaudePictureMediaType, ClaudePictureSource, ClaudeUserContentBlock,
};

/// Claude Code's default per-picture limit on an image block's base64 text, which it checks before
/// a request and Anthropic's API enforces as its 5 MB per-image limit.
const CLAUDE_PICTURE_BASE64_LIMIT: u64 = 5_242_880;

/// Why a message's files could not be composed into Claude Code's blocks.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ClaudeAttachmentError {
    /// The stored copies could not be bound.
    #[error("the message's attachments could not be bound to their stored copies")]
    Unbound(#[source] Box<dyn Error + Send + Sync>),
    /// A picture is larger than Claude Code takes, in Claude Code's own refusal led by its name.
    #[error(
        "{file_name}: Image base64 size ({base64_size}) exceeds API limit \
         ({CLAUDE_PICTURE_BASE64_LIMIT}). Please resize the image before sending."
    )]
    PictureTooLarge {
        /// The picture's own name.
        file_name: String,
        /// Its size in base64.
        base64_size: u64,
    },
    /// A picture's stored copy could not be read.
    #[error("the picture's stored copy at {} could not be read", .path.display())]
    PictureUnreadable {
        /// The stored copy.
        path: PathBuf,
        /// The system's failure.
        #[source]
        failure: io::Error,
    },
}

/// The content blocks a message's attachments follow its words with, one per attachment in staging
/// order. Fails with the resolver's failure, the file system's when a picture cannot be read, and
/// a refusal in Claude Code's own words, naming the file, for a picture past its limit.
pub(crate) async fn compose_claude_attachment_blocks(
    resolver: &dyn AttachmentResolver,
    session_id: &SessionId,
    artifact_ids: &[ArtifactId],
) -> Result<Vec<ClaudeUserContentBlock>, ClaudeAttachmentError> {
    let attachments = resolve_message_attachments(resolver, session_id, artifact_ids)
        .await
        .map_err(ClaudeAttachmentError::Unbound)?;
    try_join_all(attachments.iter().map(compose_attachment_block)).await
}

// One attachment's block: a picture Claude Code's image block takes as that block, anything else
// as its line of words.
async fn compose_attachment_block(
    attachment: &ProviderAttachment,
) -> Result<ClaudeUserContentBlock, ClaudeAttachmentError> {
    let picture = match attachment {
        ProviderAttachment::Resolved(resolved) => {
            claude_picture_media_type(&resolved.media_type).map(|media_type| (resolved, media_type))
        }
        ProviderAttachment::Unresolved(_) => None,
    };
    let Some((resolved, media_type)) = picture else {
        return Ok(ClaudeUserContentBlock::Text {
            text: compose_attachment_text(attachment),
        });
    };
    let unreadable = |failure| ClaudeAttachmentError::PictureUnreadable {
        path: resolved.path.clone(),
        failure,
    };
    let byte_length = tokio::fs::metadata(&resolved.path)
        .await
        .map_err(unreadable)?
        .len();
    let data = encode_claude_picture(&resolved.file_name, byte_length, async {
        tokio::fs::read(&resolved.path).await.map_err(unreadable)
    })
    .await?;
    Ok(ClaudeUserContentBlock::Image {
        source: ClaudePictureSource::Base64 { media_type, data },
    })
}

// A picture of `byte_length` bytes in base64, its size checked before `read` reads it: base64
// spends four characters on every three bytes, so the size is known from the file's metadata.
async fn encode_claude_picture(
    file_name: &str,
    byte_length: u64,
    read: impl Future<Output = Result<Vec<u8>, ClaudeAttachmentError>>,
) -> Result<String, ClaudeAttachmentError> {
    let base64_size = byte_length.div_ceil(3).saturating_mul(4);
    if base64_size > CLAUDE_PICTURE_BASE64_LIMIT {
        return Err(ClaudeAttachmentError::PictureTooLarge {
            file_name: file_name.to_owned(),
            base64_size,
        });
    }
    Ok(STANDARD.encode(read.await?))
}

// The image block's format for a media type read from a file's bytes, by the names the block
// writes, `None` for one it does not take.
fn claude_picture_media_type(media_type: &str) -> Option<ClaudePictureMediaType> {
    ClaudePictureMediaType::deserialize(StrDeserializer::<serde::de::value::Error>::new(media_type))
        .ok()
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::{ClaudeAttachmentError, claude_picture_media_type, encode_claude_picture};
    use crate::provider::driver::claude::session::transport::user_message::ClaudePictureMediaType;

    // Killed by a media type the image block writes that its read does not take, which would drop
    // every picture of that type, and by taking one the block cannot carry.
    #[test]
    fn a_picture_is_taken_by_each_media_type_the_image_block_writes() {
        for media_type in [
            ClaudePictureMediaType::Jpeg,
            ClaudePictureMediaType::Png,
            ClaudePictureMediaType::Gif,
            ClaudePictureMediaType::Webp,
        ] {
            let name = serde_json::to_value(media_type).expect("a media type serializes");
            let name = name.as_str().expect("a media type is written as text");
            assert_eq!(claude_picture_media_type(name), Some(media_type));
        }
        assert_eq!(claude_picture_media_type("image/bmp"), None);
    }

    // Killed by reading the picture before its size is checked, and by refusing one exactly at the
    // limit.
    #[tokio::test]
    async fn a_picture_past_the_limit_is_refused_before_it_is_read() {
        let is_read = AtomicBool::new(false);

        let refused = encode_claude_picture("cat.png", 3_932_161, async {
            is_read.store(true, Ordering::SeqCst);
            Ok(Vec::new())
        })
        .await;

        assert!(!is_read.load(Ordering::SeqCst));
        assert_eq!(
            refused.map_err(|refusal| refusal.to_string()),
            Err(
                "cat.png: Image base64 size (5242884) exceeds API limit (5242880). Please \
                 resize the image before sending."
                    .to_owned()
            )
        );
        let at_limit = encode_claude_picture("cat.png", 3_932_160, async {
            Ok::<_, ClaudeAttachmentError>(b"cat".to_vec())
        })
        .await;
        assert_eq!(at_limit.ok().as_deref(), Some("Y2F0"));
    }
}
