//! A stopped conversation's new title: the `custom-title` entry Claude Code's own rename appends to
//! the conversation file, the last of which names the conversation.

use std::io;
use std::path::Path;

use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

/// Appends a `custom-title` entry naming `provider_session_id`'s conversation `title` to its
/// conversation file, on a line of its own. Fails as the file cannot be opened or written.
pub(crate) async fn append_claude_custom_title(
    file: &Path,
    provider_session_id: &str,
    title: &str,
) -> io::Result<()> {
    let mut entry = json!({
        "type": "custom-title",
        "customTitle": title,
        "sessionId": provider_session_id,
    })
    .to_string();
    entry.push('\n');
    let mut conversation = tokio::fs::OpenOptions::new()
        .read(true)
        .append(true)
        .open(file)
        .await?;
    // A file whose last line was cut short gets a line break first, so the entry stands alone.
    let length = conversation.metadata().await?.len();
    if length > 0 {
        let mut last = [0_u8];
        conversation.seek(io::SeekFrom::Start(length - 1)).await?;
        conversation.read_exact(&mut last).await?;
        if last[0] != b'\n' {
            entry.insert(0, '\n');
        }
    }
    conversation.write_all(entry.as_bytes()).await?;
    conversation.flush().await
}
