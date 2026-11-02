//! The line-by-line read of a conversation file every reader of its entries shares: one buffer, a
//! ceiling on each line, and a lenient parse of each line that is a JSON object.

use std::io;
use std::ops::ControlFlow;
use std::path::Path;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncSeekExt, BufReader};

use crate::driver::claude::session::process::CLAUDE_OUTPUT_LINE_MAX_BYTES;
use crate::inbound_json::decode_inbound_json;
use crate::lenient_json::Lenient;

/// One line of a conversation file that read as an entry.
pub(crate) struct ConversationLine<Entry> {
    /// The entry the line holds.
    pub(crate) entry: Entry,
    /// Whether the line ends in its newline; the file's last line may not yet, while Claude Code
    /// is still writing it.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the goal classification's read of the conversation file"
        )
    )]
    pub(crate) is_terminated: bool,
}

/// Hands each line of `file` from byte `from` that reads as an `Entry` to `visit` until it breaks,
/// reusing one buffer, and answers the offset after the last line read through its newline, where
/// the next read starts. A line past the ceiling is skipped unread, so a file cut mid-write or with
/// no newline never grows the buffer past it; the first one skipped is logged once, `path` naming
/// the file. Fails as the file cannot be read.
pub(crate) async fn read_conversation_lines<Entry: Lenient>(
    mut file: tokio::fs::File,
    path: &Path,
    from: u64,
    mut visit: impl FnMut(ConversationLine<Entry>) -> ControlFlow<()>,
) -> io::Result<u64> {
    file.seek(io::SeekFrom::Start(from)).await?;
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    let mut offset = from;
    let mut end = from;
    let mut line_number: u64 = 0;
    let mut is_skip_logged = false;
    loop {
        line.clear();
        line_number += 1;
        let read = (&mut reader)
            .take(CONVERSATION_LINE_READ_LIMIT)
            .read_until(b'\n', &mut line)
            .await?;
        if read == 0 {
            return Ok(end);
        }
        offset += read as u64;
        if line.len() > CLAUDE_OUTPUT_LINE_MAX_BYTES && line.last() != Some(&b'\n') {
            let (skipped, is_terminated) = skip_to_next_line(&mut reader).await?;
            offset += skipped;
            if is_terminated {
                end = offset;
            }
            if !is_skip_logged {
                is_skip_logged = true;
                tracing::warn!(
                    file = %path.display(),
                    from,
                    line_number,
                    "a line of a Claude Code conversation file passed the line ceiling, so it \
                     was skipped"
                );
            }
            continue;
        }
        let is_terminated = line.last() == Some(&b'\n');
        if is_terminated {
            end = offset;
        }
        let text = decode_inbound_json(&line);
        let mut deserializer = serde_json::Deserializer::from_str(&text);
        let Ok(Some(entry)) =
            Entry::read(&mut deserializer).and_then(|entry| deserializer.end().map(|()| entry))
        else {
            continue;
        };
        if visit(ConversationLine {
            entry,
            is_terminated,
        })
        .is_break()
        {
            return Ok(end);
        }
    }
}

// One past the ceiling, so a line that reaches it without its newline reads as over it.
const CONVERSATION_LINE_READ_LIMIT: u64 = CLAUDE_OUTPUT_LINE_MAX_BYTES as u64 + 1;

// Consumes the rest of the line being read, through its newline or to the end of the file, and
// answers how many bytes it consumed and whether it reached the newline.
async fn skip_to_next_line(reader: &mut BufReader<tokio::fs::File>) -> io::Result<(u64, bool)> {
    let mut skipped: u64 = 0;
    loop {
        let buffered = reader.fill_buf().await?;
        if buffered.is_empty() {
            return Ok((skipped, false));
        }
        if let Some(newline) = memchr::memchr(b'\n', buffered) {
            reader.consume(newline + 1);
            return Ok((skipped + newline as u64 + 1, true));
        }
        let length = buffered.len();
        reader.consume(length);
        skipped += length as u64;
    }
}
