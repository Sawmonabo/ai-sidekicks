//! `session_read`'s read of one output by its numbered lines: a body the transcript stores, read
//! part by part, or the text of a message the session took, which its event holds. A page that
//! stops short ends with a cursor naming the line it goes on at and where that line starts, under a
//! tag only this start of the daemon draws, so a cursor is taken only where it starts its line.

use std::ops::ControlFlow;
use std::sync::{Arc, LazyLock};

use sidekicks_agent::tools::session::read::{
    LineRange, no_lines_in_range, no_matching_lines, output_not_found, position_unknown,
};
use sidekicks_agent::tools::session::{PageCursor, more_trailer};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::content::BodyReadOffsetRefused;
use sidekicks_store::database::connection::read_pool::ReadLength;
use sidekicks_store::events::session::read::SessionEventReads;

use super::{READ_PAGE_MAX_BYTES, SessionReading, cut_to_page, message_text_of};
use crate::agent_tools::AgentToolError;

/// The most of one line a read holds: just past a page, so `cut_to_page` still marks a line too
/// long for one without the whole line in memory.
const LINE_KEPT_MAX_BYTES: usize = READ_PAGE_MAX_BYTES + 4;

// A page's `next_cursor` is the line it goes on at, this, the byte offset where that line starts,
// the tag separator and the tag in hex.
const LINE_CURSOR_SEPARATOR: char = '@';
const LINE_CURSOR_TAG_SEPARATOR: char = '.';

// The key every line cursor's tag is drawn under, drawn once a start of the daemon, so a cursor an
// earlier start handed out names no place.
static LINE_CURSOR_KEY: LazyLock<Result<[u8; blake3::KEY_LEN], getrandom::Error>> =
    LazyLock::new(|| {
        let mut key = [0; blake3::KEY_LEN];
        getrandom::fill(&mut key).map(|()| key)
    });

// Where an output's page starts: its line, and the byte offset in the text where that line starts.
struct LineCursor {
    line: u64,
    offset: u64,
}

impl SessionReading<'_> {
    /// One output's numbered lines: the range or matches asked for, from the cursor's line on,
    /// read from where that line starts. Refuses a cursor this start of the daemon did not hand
    /// out for `output`, and an output the session holds neither a body nor a message under.
    pub(super) async fn read_output(
        &self,
        output: &str,
        lines: Option<LineRange>,
        search: Option<&str>,
        cursor: Option<&PageCursor>,
    ) -> Result<String, AgentToolError> {
        let from = match cursor {
            None => LineCursor { line: 1, offset: 0 },
            Some(cursor) => self.read_line_cursor(output, cursor.as_str())?,
        };
        let not_found = || AgentToolError::Refused(output_not_found(output, &self.name));
        let (first, last) = match lines {
            None => (1, u64::MAX),
            Some(LineRange::Span { first, last }) => (first.get(), last.get()),
            Some(LineRange::Last(count)) => {
                // The range counts back from the end, so the lines are counted in a read before.
                let line_count = self
                    .count_output_lines(output)
                    .await?
                    .ok_or_else(not_found)?;
                (line_count.saturating_sub(count.get()) + 1, line_count)
            }
        };
        let mut pieces: Vec<String> = Vec::new();
        let mut length = 0;
        let mut goes_on_at: Option<LineCursor> = None;
        // Takes one numbered line, answering whether the read goes on.
        let mut each = |number: u64, start: u64, line: &str| {
            if number > last {
                return false;
            }
            if number < first.max(from.line) || search.is_some_and(|search| !line.contains(search))
            {
                return true;
            }
            let piece = format!("{number}: {line}");
            if !pieces.is_empty() && length + piece.len() > READ_PAGE_MAX_BYTES {
                goes_on_at = Some(LineCursor {
                    line: number,
                    offset: start,
                });
                return false;
            }
            length += piece.len();
            pieces.push(cut_to_page(piece));
            true
        };
        let mut body_lines = BodyLines::from_line(from.line, from.offset);
        let read = self
            .read_output_parts(output, from.offset, |part| body_lines.take(part, &mut each))
            .await?;
        match read.ok_or_else(not_found)? {
            ControlFlow::Continue(()) => body_lines.finish(&mut each),
            ControlFlow::Break(()) => {}
        }
        if let Some(next) = goes_on_at {
            pieces.push(more_trailer(&self.line_cursor(output, &next)?));
        }
        if pieces.is_empty() {
            return Ok(match search {
                Some(_) => no_matching_lines(output),
                None => no_lines_in_range(output),
            });
        }
        Ok(pieces.join("\n"))
    }

    // How many lines an output holds, read part by part; `None` for an output the session holds
    // neither a body nor a message under.
    async fn count_output_lines(&self, output: &str) -> Result<Option<u64>, AgentToolError> {
        let mut lines = BodyLines::default();
        let read = self
            .read_output_parts(output, 0, |part| {
                lines.take(part, &mut |_: u64, _: u64, _: &str| true)
            })
            .await?;
        Ok(read.map(|_| lines.count()))
    }

    // Hands an output's text from its byte `offset` to `each` part by part until `each` breaks,
    // answering how the read ended: the body the transcript stores under it, or else the text of
    // the message it is. `None` for an output that is neither.
    async fn read_output_parts(
        &self,
        output: &str,
        offset: u64,
        mut each: impl FnMut(&str) -> ControlFlow<()>,
    ) -> Result<Option<ControlFlow<()>>, AgentToolError> {
        if let Some(flow) = self.read_body_parts(output, offset, &mut each).await? {
            return Ok(Some(flow));
        }
        let Some(message) = self.read_message_text(output).await? else {
            return Ok(None);
        };
        let part = usize::try_from(offset)
            .ok()
            .and_then(|start| message.get(start..))
            .ok_or_else(|| {
                AgentToolError::failed(BodyReadOffsetRefused {
                    offset,
                    body_length: message.len(),
                })
            })?;
        Ok(Some(each(part)))
    }

    // The text of the message the session took as its event `row_id`; `None` for any other event
    // or none.
    async fn read_message_text(&self, row_id: &str) -> Result<Option<String>, AgentToolError> {
        let session_id = self.session_id;
        let row_id = row_id.to_owned();
        let read_damaged_from_sequence = Arc::clone(&self.directory.read_damaged_from_sequence);
        self.directory
            .pool
            .read(ReadLength::Short, move |reader| {
                let event = SessionEventReads::new(reader, |session_id: &SessionId| {
                    read_damaged_from_sequence(session_id)
                })
                .read_event(&session_id, &row_id)
                .map_err(AgentToolError::failed)?;
                Ok(event
                    .filter(|event| {
                        event.event_type.0.as_str() == SessionEventType::UserMessageSent.as_str()
                    })
                    .map(|event| message_text_of(&event.payload).to_owned()))
            })
            .await
    }

    // The tag a cursor at `line` of `output`, starting at `offset`, carries.
    fn line_cursor_tag(
        &self,
        output: &str,
        line: u64,
        offset: u64,
    ) -> Result<blake3::Hash, AgentToolError> {
        let key = (*LINE_CURSOR_KEY)
            .as_ref()
            .map_err(|error| AgentToolError::failed(*error))?;
        // Neither id holds a NUL and the numbers take eight bytes each, so no two cursors hash the
        // same bytes.
        Ok(blake3::Hasher::new_keyed(key)
            .update(self.session_id.to_string().as_bytes())
            .update(b"\0")
            .update(output.as_bytes())
            .update(b"\0")
            .update(&line.to_le_bytes())
            .update(&offset.to_le_bytes())
            .finalize())
    }

    // The `next_cursor` of a page of `output` that goes on at `next`.
    fn line_cursor(&self, output: &str, next: &LineCursor) -> Result<String, AgentToolError> {
        let tag = self.line_cursor_tag(output, next.line, next.offset)?;
        Ok(format!(
            "{}{LINE_CURSOR_SEPARATOR}{}{LINE_CURSOR_TAG_SEPARATOR}{}",
            next.line,
            next.offset,
            tag.to_hex()
        ))
    }

    // Where a cursor this start of the daemon handed out for `output` goes on; refused for any
    // other text.
    fn read_line_cursor(&self, output: &str, cursor: &str) -> Result<LineCursor, AgentToolError> {
        let refused = || AgentToolError::Refused(position_unknown(cursor, &self.name));
        let (from, tag) = parse_line_cursor(cursor).ok_or_else(refused)?;
        // `blake3::Hash` compares in constant time.
        if self.line_cursor_tag(output, from.line, from.offset)? != tag {
            return Err(refused());
        }
        Ok(from)
    }
}

// The line, its start and the tag a cursor's text names; `None` for text that names none.
fn parse_line_cursor(cursor: &str) -> Option<(LineCursor, blake3::Hash)> {
    let (line, rest) = cursor.split_once(LINE_CURSOR_SEPARATOR)?;
    let (offset, tag) = rest.split_once(LINE_CURSOR_TAG_SEPARATOR)?;
    let from = LineCursor {
        line: line.parse().ok().filter(|&line| line > 0)?,
        offset: offset.parse().ok()?,
    };
    Some((from, blake3::Hash::from_hex(tag).ok()?))
}

// A text's numbered lines as it is read part by part, split where `str::lines` splits it, each held
// only up to `LINE_KEPT_MAX_BYTES`, with where each starts in the text.
#[derive(Default)]
struct BodyLines {
    ended: u64,
    line: String,
    // The text's bytes taken so far, from its start.
    taken: u64,
    // Where the line being read starts in the text.
    line_start: u64,
}

impl BodyLines {
    // The lines of a text read from `offset`, where its line `line` starts.
    fn from_line(line: u64, offset: u64) -> Self {
        Self {
            ended: line - 1,
            line: String::new(),
            taken: offset,
            line_start: offset,
        }
    }

    // Takes the text's next part, handing each line it ends to `each` with its number and where
    // it starts until `each` answers that the read stops.
    fn take(
        &mut self,
        part: &str,
        each: &mut impl FnMut(u64, u64, &str) -> bool,
    ) -> ControlFlow<()> {
        let mut segments = part.split('\n').peekable();
        while let Some(segment) = segments.next() {
            self.keep(segment);
            self.taken += u64::try_from(segment.len()).expect("a part's length fits 64 bits");
            if segments.peek().is_none() {
                break;
            }
            // The line feed ending the line.
            self.taken += 1;
            self.ended += 1;
            let is_reading_on = each(
                self.ended,
                self.line_start,
                self.line.strip_suffix('\r').unwrap_or(&self.line),
            );
            self.line.clear();
            self.line_start = self.taken;
            if !is_reading_on {
                return ControlFlow::Break(());
            }
        }
        ControlFlow::Continue(())
    }

    // Hands `each` the text's last line where no newline ends it.
    fn finish(&mut self, each: &mut impl FnMut(u64, u64, &str) -> bool) {
        if !self.line.is_empty() {
            self.ended += 1;
            // The text's last line, so whether `each` would read on changes nothing.
            each(self.ended, self.line_start, &self.line);
        }
    }

    // How many lines the parts taken so far hold.
    fn count(&self) -> u64 {
        self.ended + u64::from(!self.line.is_empty())
    }

    // Adds `segment` to the line being read, up to the most a line keeps.
    fn keep(&mut self, segment: &str) {
        let mut end = LINE_KEPT_MAX_BYTES
            .saturating_sub(self.line.len())
            .min(segment.len());
        while !segment.is_char_boundary(end) {
            end -= 1;
        }
        self.line.push_str(&segment[..end]);
    }
}
