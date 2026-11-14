//! The line-by-line read of a conversation file every reader of its entries shares: a ceiling on
//! each line, the first line skipped past it logged once, and a lenient parse of each line that is
//! a JSON object. A file is read whole from a byte, or handed in chunk by chunk as it grows.

use std::io;
use std::ops::ControlFlow;
use std::path::{Path, PathBuf};

use tokio::io::{AsyncBufReadExt, AsyncSeekExt, BufReader};

use crate::driver::claude::session::process::CLAUDE_OUTPUT_LINE_MAX_BYTES;
use crate::inbound_json::decode_inbound_json;
use crate::lenient_json::Lenient;

/// One line of a conversation file that read as an entry.
pub(crate) struct ConversationLine<'line, Entry> {
    /// The entry the line holds.
    pub(crate) entry: Entry,
    /// The line's text as it was parsed, without its newline.
    pub(crate) text: &'line str,
    /// Whether the line ends in its newline; the file's last line may not yet, while Claude Code
    /// is still writing it.
    pub(crate) is_terminated: bool,
}

/// A conversation file's lines from a byte, its bytes handed in chunk by chunk as the file is read
/// or grows. A line is read once its newline comes; a line past the ceiling is dropped through its
/// newline without being held, so a file cut mid-write or with no newline never grows the buffer
/// past it, and the first one dropped is logged once, naming the file.
pub(crate) struct ConversationLines {
    file: PathBuf,
    // The bytes of the line whose newline has not come yet.
    pending: Vec<u8>,
    // Whether the bytes handed in belong to a line past the ceiling, dropped through its newline.
    is_skipping: bool,
    is_skip_logged: bool,
    // Where in the file the next bytes handed in start.
    offset: u64,
    // The offset after the last newline handed in.
    end: u64,
}

impl ConversationLines {
    /// The lines of `file` from `offset`, where the first bytes handed in start.
    pub(crate) fn new(file: &Path, offset: u64) -> Self {
        Self {
            file: file.to_path_buf(),
            pending: Vec::new(),
            is_skipping: false,
            is_skip_logged: false,
            offset,
            end: offset,
        }
    }

    /// The offset after the last line handed in through its newline, where a later read starts.
    pub(crate) fn end(&self) -> u64 {
        self.end
    }

    /// Hands each line `chunk`, the file's next bytes, completes and that reads as an `Entry` to
    /// `visit` until it breaks, answering whether it broke. The bytes before `from` are skipped
    /// unread, with any line begun before them.
    pub(crate) fn take<Entry: Lenient>(
        &mut self,
        chunk: &[u8],
        from: u64,
        mut visit: impl FnMut(ConversationLine<'_, Entry>) -> ControlFlow<()>,
    ) -> ControlFlow<()> {
        let skipped = usize::try_from(from.saturating_sub(self.offset))
            .unwrap_or(usize::MAX)
            .min(chunk.len());
        if skipped > 0 {
            // A line begun before the skip cannot be read whole.
            self.pending.clear();
            self.is_skipping = false;
            self.offset += skipped as u64;
        }
        let mut rest = &chunk[skipped..];
        while let Some(newline) = memchr::memchr(b'\n', rest) {
            let (line, after) = (&rest[..newline], &rest[newline + 1..]);
            rest = after;
            self.offset += newline as u64 + 1;
            self.end = self.offset;
            self.hold(line);
            if std::mem::take(&mut self.is_skipping) {
                continue;
            }
            let flow = read_line(&self.pending, true, &mut visit);
            self.pending.clear();
            if flow.is_break() {
                return flow;
            }
        }
        self.hold(rest);
        self.offset += rest.len() as u64;
        ControlFlow::Continue(())
    }

    /// Hands the last line, one its newline has not ended, to `visit` where it reads as an
    /// `Entry`; called once every byte of the file was handed in.
    pub(crate) fn finish<Entry: Lenient>(
        &mut self,
        visit: impl FnMut(ConversationLine<'_, Entry>) -> ControlFlow<()>,
    ) {
        if !self.is_skipping && !self.pending.is_empty() {
            let _last = read_line(&self.pending, false, visit);
        }
    }

    // Holds `bytes` as the next of the line being read, dropping the line once it passes the
    // ceiling.
    fn hold(&mut self, bytes: &[u8]) {
        if self.is_skipping {
            return;
        }
        if self.pending.len() + bytes.len() <= CLAUDE_OUTPUT_LINE_MAX_BYTES {
            self.pending.extend_from_slice(bytes);
            return;
        }
        self.pending.clear();
        self.is_skipping = true;
        if !self.is_skip_logged {
            self.is_skip_logged = true;
            tracing::warn!(
                file = %self.file.display(),
                "a line of a Claude Code conversation file passed the line ceiling, so it was \
                 skipped"
            );
        }
    }
}

/// Hands each line of `file` from byte `from` that reads as an `Entry` to `visit` until it breaks,
/// and answers the offset after the last line read through its newline, where the next read
/// starts; the file's last line is handed in even before its newline comes. Fails as the file
/// cannot be read.
pub(crate) async fn read_conversation_lines<Entry: Lenient>(
    mut file: tokio::fs::File,
    path: &Path,
    from: u64,
    mut visit: impl FnMut(ConversationLine<'_, Entry>) -> ControlFlow<()>,
) -> io::Result<u64> {
    file.seek(io::SeekFrom::Start(from)).await?;
    let mut reader = BufReader::new(file);
    let mut lines = ConversationLines::new(path, from);
    loop {
        let chunk = reader.fill_buf().await?;
        if chunk.is_empty() {
            lines.finish(&mut visit);
            return Ok(lines.end());
        }
        let length = chunk.len();
        if lines.take(chunk, from, &mut visit).is_break() {
            return Ok(lines.end());
        }
        reader.consume(length);
    }
}

/// Hands `line` to `visit` where it is one JSON object reading as an `Entry`.
pub(super) fn read_line<Entry: Lenient>(
    line: &[u8],
    is_terminated: bool,
    mut visit: impl FnMut(ConversationLine<'_, Entry>) -> ControlFlow<()>,
) -> ControlFlow<()> {
    let text = decode_inbound_json(line);
    let mut deserializer = serde_json::Deserializer::from_str(&text);
    let Ok(Some(entry)) =
        Entry::read(&mut deserializer).and_then(|entry| deserializer.end().map(|()| entry))
    else {
        return ControlFlow::Continue(());
    };
    visit(ConversationLine {
        entry,
        text: &text,
        is_terminated,
    })
}

#[cfg(test)]
mod tests {
    use std::ops::ControlFlow;

    use serde::Deserialize;
    use serde_json::json;

    use super::read_conversation_lines;
    use crate::driver::claude::session::process::CLAUDE_OUTPUT_LINE_MAX_BYTES;
    use crate::lenient_json::{lenient_object, read_lenient};

    #[derive(Deserialize)]
    struct UuidEntry {
        #[serde(default, deserialize_with = "read_lenient")]
        uuid: Option<String>,
    }

    lenient_object!(UuidEntry);

    // Killed by reading a line whole however long it is (the ceiling dropped): the entry past it
    // would be read. Killed too by an `end` that stops before the line dropped, which would read it
    // again, by losing the entry after it, and by an `end` past a last line whose newline has not
    // landed, which would lose that line once its newline lands.
    #[tokio::test]
    async fn a_line_past_the_ceiling_is_dropped_and_the_lines_after_it_still_read() {
        let folder = tempfile::tempdir().expect("a scratch folder");
        let path = folder.path().join("conversation.jsonl");
        let too_long = json!({"uuid": "too-long", "pad": "x".repeat(CLAUDE_OUTPUT_LINE_MAX_BYTES)});
        let kept = format!("{too_long}\n{}\n", json!({"uuid": "kept"}));
        std::fs::write(&path, format!("{kept}{}", json!({"uuid": "unended"})))
            .expect("the conversation is written");
        let file = tokio::fs::File::open(&path)
            .await
            .expect("the conversation opens");
        let mut read = Vec::new();

        let end = read_conversation_lines::<UuidEntry>(file, &path, 0, |line| {
            read.push((line.entry.uuid, line.is_terminated));
            ControlFlow::Continue(())
        })
        .await
        .expect("the conversation reads");

        assert_eq!(
            read,
            vec![
                (Some("kept".to_owned()), true),
                (Some("unended".to_owned()), false)
            ]
        );
        assert_eq!(end, kept.len() as u64);
    }
}
