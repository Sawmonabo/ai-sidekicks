//! `session_read`'s read of one output by its numbered lines: a body the transcript stores, read
//! part by part, the text of a message the session took, which its event holds, or the rest of a
//! tool call's changed files a page cut. A page that stops short ends with a cursor naming the
//! line it goes on at and where in the text it goes on, at the line's start or inside a line longer
//! than a page, under a tag keyed by the tool-server key, so a cursor is taken only where it was
//! handed out, at a later start of the daemon too.

use std::ops::ControlFlow;
use std::sync::Arc;

use sidekicks_agent::tools::secret_key::ToolServerSecretKey;
use sidekicks_agent::tools::session::read::{
    LineRange, no_lines_in_range, no_matching_lines, output_not_found, position_unknown,
};
use sidekicks_agent::tools::session::{PageCursor, more_trailer};
use sidekicks_contracts::event::envelope::EventEnvelope;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::session::event_cursor::encode_event_cursor;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::content::BodyReadOffsetRefused;
use sidekicks_store::credential_store::seed_item::Seed;
use sidekicks_store::database::connection::read_pool::ReadLength;
use sidekicks_store::events::session::read::SessionEventReads;

use super::{
    ONE_ROW, READ_PAGE_MAX_BYTES, SessionReading, changed_files_text, message_text_of, page_cut,
    parts_of,
};
use crate::agent_tools::AgentToolError;

/// The most of one line read without a search a read holds: just past a page, so a line too long
/// for one page is cut there without the whole line in memory.
const LINE_KEPT_MAX_BYTES: usize = READ_PAGE_MAX_BYTES + 4;

// A cursor's text is the line it goes on at, the place's separator, the byte offset where it goes
// on, the tag separator and the tag in hex.
const LINE_CURSOR_TAG_SEPARATOR: char = '.';

// The context the line cursor key is derived from the tool-server key under.
const LINE_CURSOR_KEY_CONTEXT: &str = "ai-sidekicks session_read line cursor tag";

// What a page's text opens with when it goes on with a tool call's changed files.
const CHANGED_FILES_GOING_ON: &str = "changed (cont.): ";

/// The key a line cursor's tag is drawn under: derived from the tool-server key, which the
/// credential store keeps, so a cursor one start of the daemon handed out reads at the next.
pub(crate) struct LineCursorKey(Seed);

impl LineCursorKey {
    /// The cursor key `key` derives.
    pub(crate) fn of(key: &ToolServerSecretKey) -> Self {
        Self(key.derive_key(LINE_CURSOR_KEY_CONTEXT))
    }
}

/// Where in an output's text a cursor goes on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum LinePlace {
    /// Where its line starts.
    Start,
    /// Inside its line, a line longer than a page.
    Inside,
    /// Inside the list of the files a tool call changed.
    ChangedFiles,
}

impl LinePlace {
    // The byte that stands between a cursor's line and offset, and that its tag covers.
    const fn separator(self) -> u8 {
        match self {
            Self::Start => b'@',
            Self::Inside => b'+',
            Self::ChangedFiles => b'~',
        }
    }

    fn of_separator(separator: char) -> Option<Self> {
        [Self::Start, Self::Inside, Self::ChangedFiles]
            .into_iter()
            .find(|place| char::from(place.separator()) == separator)
    }
}

/// Where an output's page goes on: its line, the byte offset in the text and what that offset is.
pub(super) struct LineCursor {
    /// The line, counted from 1.
    pub(super) line: u64,
    /// The byte offset in the text, on a character's boundary.
    pub(super) offset: u64,
    /// Where in the line the offset falls.
    pub(super) place: LinePlace,
}

// One line of a text as `BodyLines` hands it: its number, where its held text starts in the whole
// text, that text, and whether it starts inside the line.
struct BodyLine<'text> {
    number: u64,
    start: u64,
    text: &'text str,
    is_continued: bool,
}

impl SessionReading<'_> {
    /// One output's numbered lines: the range or matches asked for, from the cursor's place on.
    /// A line longer than a page is cut there with a cursor inside it, and the lines read on from
    /// one carry `(cont.)`. A search reads each line to its end and hands the page of it that
    /// holds the text, or the cursor at that page where the result has no room left. Refuses a
    /// cursor not handed out for `output`, and an output the session holds neither a body nor a
    /// message under; fails on a cursor's offset inside a character.
    pub(super) async fn read_output(
        &self,
        output: &str,
        lines: Option<LineRange>,
        search: Option<&str>,
        cursor: Option<&PageCursor>,
    ) -> Result<String, AgentToolError> {
        let from = match cursor {
            None => LineCursor {
                line: 1,
                offset: 0,
                place: LinePlace::Start,
            },
            Some(cursor) => self.read_line_cursor(output, cursor.as_str())?,
        };
        if from.place == LinePlace::ChangedFiles {
            return self.read_changed_files(output, from.offset).await;
        }
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
        // Takes one numbered line, or the page of a line that holds the search, answering whether
        // the read goes on.
        let mut each = |line: BodyLine<'_>| {
            let label = line_label(line.number, line.is_continued);
            let piece_length = label.len() + line.text.len();
            if !pieces.is_empty() && length + piece_length > READ_PAGE_MAX_BYTES {
                goes_on_at = Some(LineCursor {
                    line: line.number,
                    offset: line.start,
                    place: if line.is_continued {
                        LinePlace::Inside
                    } else {
                        LinePlace::Start
                    },
                });
                return false;
            }
            if piece_length > READ_PAGE_MAX_BYTES {
                let shown = page_cut(line.text, READ_PAGE_MAX_BYTES - label.len());
                pieces.push(format!("{label}{}", &line.text[..shown]));
                goes_on_at = Some(LineCursor {
                    line: line.number,
                    offset: line.start + byte_count(shown),
                    place: LinePlace::Inside,
                });
                return false;
            }
            length += piece_length;
            pieces.push(format!("{label}{}", line.text));
            true
        };
        let selection = LineSelection {
            first,
            last,
            search,
        };
        let mut body_lines = BodyLines::from_cursor(&from, selection);
        let read = self
            .read_output_parts(output, from.offset, |part| body_lines.take(part, &mut each))
            .await?;
        match read.ok_or_else(not_found)? {
            ControlFlow::Continue(()) => body_lines.finish(&mut each),
            ControlFlow::Break(()) => {}
        }
        if let Some(next) = goes_on_at {
            pieces.push(more_trailer(&self.line_cursor(output, &next)));
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
        let from_start = LineCursor {
            line: 1,
            offset: 0,
            place: LinePlace::Start,
        };
        let mut lines = BodyLines::from_cursor(&from_start, LineSelection::EVERY_LINE);
        let read = self
            .read_output_parts(output, 0, |part| {
                lines.take(part, &mut |_: BodyLine<'_>| true)
            })
            .await?;
        Ok(read.map(|_| lines.count()))
    }

    // The files the tool call `output` changed, from the byte `offset` of their list on, a page at
    // a time. Refused for a row that is no tool call with changed files; fails on an offset past
    // the list or inside a character.
    async fn read_changed_files(
        &self,
        output: &str,
        offset: u64,
    ) -> Result<String, AgentToolError> {
        let not_found = || AgentToolError::Refused(output_not_found(output, &self.name));
        let event = self
            .read_session_event(output)
            .await?
            .ok_or_else(not_found)?;
        let anchor = i64::try_from(event.sequence.get())
            .map_err(AgentToolError::failed)
            .and_then(|sequence| encode_event_cursor(sequence).map_err(AgentToolError::failed))?;
        let position = anchor.as_str().to_owned();
        let window = self
            .read_window(None, None, Some(anchor), Some(ONE_ROW), &position)
            .await?;
        let changed = window
            .rows
            .iter()
            .filter_map(parts_of)
            .find(|parts| parts.id == output)
            .and_then(|parts| changed_files_text(&parts))
            .ok_or_else(not_found)?;
        let rest = usize::try_from(offset)
            .ok()
            .and_then(|start| changed.get(start..))
            .ok_or_else(|| {
                AgentToolError::failed(BodyReadOffsetRefused {
                    offset,
                    body_length: changed.len(),
                })
            })?;
        let room = READ_PAGE_MAX_BYTES - CHANGED_FILES_GOING_ON.len();
        if rest.len() <= room {
            return Ok(format!("{CHANGED_FILES_GOING_ON}{rest}"));
        }
        let shown = rest.floor_char_boundary(room);
        let next = LineCursor {
            line: 1,
            offset: offset + byte_count(shown),
            place: LinePlace::ChangedFiles,
        };
        Ok(format!(
            "{CHANGED_FILES_GOING_ON}{}\n{}",
            &rest[..shown],
            more_trailer(&self.line_cursor(output, &next))
        ))
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
        let message = self.read_session_event(output).await?.filter(|event| {
            event.event_type.0.as_str() == SessionEventType::UserMessageSent.as_str()
        });
        let Some(message) = message else {
            return Ok(None);
        };
        let text = message_text_of(&message.payload);
        let part = usize::try_from(offset)
            .ok()
            .and_then(|start| text.get(start..))
            .ok_or_else(|| {
                AgentToolError::failed(BodyReadOffsetRefused {
                    offset,
                    body_length: text.len(),
                })
            })?;
        Ok(Some(each(part)))
    }

    // The session's event `event_id`; `None` where it holds none.
    async fn read_session_event(
        &self,
        event_id: &str,
    ) -> Result<Option<EventEnvelope>, AgentToolError> {
        let session_id = self.session_id;
        let event_id = event_id.to_owned();
        let read_damaged_from_sequence = Arc::clone(&self.directory.read_damaged_from_sequence);
        self.directory
            .pool
            .read(ReadLength::Short, move |reader| {
                SessionEventReads::new(reader, |session_id: &SessionId| {
                    read_damaged_from_sequence(session_id)
                })
                .read_event(&session_id, &event_id)
                .map_err(AgentToolError::failed)
            })
            .await
    }

    // The tag a cursor at `at` of `output` carries.
    fn line_cursor_tag(&self, output: &str, at: &LineCursor) -> blake3::Hash {
        // Neither id holds a NUL, the place takes one byte and the numbers eight each, so no two
        // cursors hash the same bytes.
        blake3::Hasher::new_keyed(&self.cursor_key.0)
            .update(self.session_id.to_string().as_bytes())
            .update(b"\0")
            .update(output.as_bytes())
            .update(b"\0")
            .update(&[at.place.separator()])
            .update(&at.line.to_le_bytes())
            .update(&at.offset.to_le_bytes())
            .finalize()
    }

    /// The `next_cursor` of a page of `output` that goes on at `next`.
    pub(super) fn line_cursor(&self, output: &str, next: &LineCursor) -> String {
        format!(
            "{}{}{}{LINE_CURSOR_TAG_SEPARATOR}{}",
            next.line,
            char::from(next.place.separator()),
            next.offset,
            self.line_cursor_tag(output, next).to_hex()
        )
    }

    // Where a cursor handed out for `output` goes on; refused for any other text.
    fn read_line_cursor(&self, output: &str, cursor: &str) -> Result<LineCursor, AgentToolError> {
        let refused = || AgentToolError::Refused(position_unknown(cursor, &self.name));
        let (from, tag) = parse_line_cursor(cursor).ok_or_else(refused)?;
        // `blake3::Hash` compares in constant time.
        if self.line_cursor_tag(output, &from) != tag {
            return Err(refused());
        }
        Ok(from)
    }
}

// The place and the tag a cursor's text names; `None` for text that names none.
fn parse_line_cursor(cursor: &str) -> Option<(LineCursor, blake3::Hash)> {
    let at = cursor.find(|character: char| LinePlace::of_separator(character).is_some())?;
    let place = LinePlace::of_separator(cursor[at..].chars().next()?)?;
    // Every separator is one ASCII byte.
    let (offset, tag) = cursor[at + 1..].split_once(LINE_CURSOR_TAG_SEPARATOR)?;
    let from = LineCursor {
        line: cursor[..at].parse().ok().filter(|&line| line > 0)?,
        offset: offset.parse().ok()?,
        place,
    };
    Some((from, blake3::Hash::from_hex(tag).ok()?))
}

// A length in bytes as an offset into a text.
fn byte_count(length: usize) -> u64 {
    u64::try_from(length).expect("a length fits 64 bits")
}

// The label a numbered line, or a page read on from inside it, opens with.
fn line_label(number: u64, is_continued: bool) -> String {
    if is_continued {
        format!("{number} (cont.): ")
    } else {
        format!("{number}: ")
    }
}

// Which of a text's lines a read hands on: those from `first` to `last`, and with `search` only
// the page of a line that holds it.
#[derive(Clone, Copy)]
struct LineSelection<'search> {
    first: u64,
    last: u64,
    search: Option<&'search str>,
}

impl LineSelection<'_> {
    // Every line, whole.
    const EVERY_LINE: Self = Self {
        first: 1,
        last: u64::MAX,
        search: None,
    };
}

// A text's numbered lines as it is read part by part, split where `str::lines` splits it, with
// where each starts in the text, handed as `LineSelection` selects them. A line longer than
// `LINE_KEPT_MAX_BYTES` is handed once that much of it is held and the rest of it is passed over.
// A searched line is held a page at a time, with the bytes a match opening on that page can run on
// into, and its first page that holds the search is handed; the rest of it is passed over. So a
// read holds no more of a line than a page and the search's length.
struct BodyLines<'search> {
    ended: u64,
    line: String,
    // The text's bytes taken so far, from its start.
    taken: u64,
    // Where the held text of the line being read starts in the text.
    line_start: u64,
    // Whether the held text starts inside its line, where a cursor or a passed page goes on.
    is_continued: bool,
    // Whether the line being read was handed already or is not selected, its rest passed over to
    // its end.
    is_handed: bool,
    // The search the line being read is tested against: none for a line read on from inside it,
    // whose opening was shown.
    searched: Option<&'search str>,
    selection: LineSelection<'search>,
}

impl<'search> BodyLines<'search> {
    // The lines `selection` selects of a text read from the cursor's offset, which falls in its
    // line.
    fn from_cursor(from: &LineCursor, selection: LineSelection<'search>) -> Self {
        let mut lines = Self {
            ended: from.line - 1,
            line: String::new(),
            taken: from.offset,
            line_start: from.offset,
            is_continued: from.place == LinePlace::Inside,
            is_handed: false,
            searched: None,
            selection,
        };
        lines.open_line();
        lines
    }

    // Takes the text's next part, handing each selected line, or page of a searched line, to
    // `each` until `each` answers that the read stops or the lines selected are passed.
    fn take(&mut self, part: &str, each: &mut impl FnMut(BodyLine<'_>) -> bool) -> ControlFlow<()> {
        let mut segments = part.split('\n').peekable();
        while let Some(segment) = segments.next() {
            if self.ended >= self.selection.last {
                return ControlFlow::Break(());
            }
            self.taken += byte_count(segment.len());
            let is_ended = segments.peek().is_some();
            if !self.is_handed {
                let is_reading_on = match self.searched {
                    Some(search) => self.search_in(search, segment, is_ended, each),
                    None => self.hold(segment, is_ended, each),
                };
                if !is_reading_on {
                    return ControlFlow::Break(());
                }
            }
            if !is_ended {
                break;
            }
            // The line feed ending the line.
            self.taken += 1;
            self.ended += 1;
            self.line.clear();
            self.line_start = self.taken;
            self.is_continued = false;
            self.open_line();
        }
        ControlFlow::Continue(())
    }

    // Hands `each` the text's last line, or its page that holds the search, where no newline
    // ends it.
    fn finish(&mut self, each: &mut impl FnMut(BodyLine<'_>) -> bool) {
        if self.is_handed || self.line.is_empty() || self.ended >= self.selection.last {
            return;
        }
        // The text's last line, so whether `each` would read on changes nothing.
        match self.searched {
            Some(search) => self.search_last_pages(search, each),
            None => each(self.held(false)),
        };
    }

    // How many lines the parts taken so far hold.
    fn count(&self) -> u64 {
        self.ended + u64::from(!self.line.is_empty() || self.is_handed)
    }

    // Sets how the line now being read is read: passed over before the first line selected, and
    // tested against the search unless it is read on from inside.
    fn open_line(&mut self) {
        self.is_handed = self.ended + 1 < self.selection.first;
        self.searched = self.selection.search.filter(|_| !self.is_continued);
    }

    // Adds `segment` to the line being read and hands the line once it ends or once more of it is
    // held than a line keeps, answering whether the read goes on.
    fn hold(
        &mut self,
        segment: &str,
        is_ended: bool,
        each: &mut impl FnMut(BodyLine<'_>) -> bool,
    ) -> bool {
        let is_whole = self.keep(segment);
        if is_whole && !is_ended {
            return true;
        }
        self.is_handed = true;
        each(self.held(is_whole))
    }

    // Adds `segment` to the searched line, page by page: a page held whole, with the bytes a match
    // opening on it can run on into, is handed where it holds the search and let go otherwise.
    // Answers whether the read goes on.
    fn search_in(
        &mut self,
        search: &str,
        segment: &str,
        is_ended: bool,
        each: &mut impl FnMut(BodyLine<'_>) -> bool,
    ) -> bool {
        let mut rest = segment;
        loop {
            let room = self.page_room();
            // Up to three bytes past the page and the search: once the next character no longer
            // fits, every match opening on the page is held whole.
            let held_max = room + search.len() + 3;
            let taken = rest.floor_char_boundary(held_max.saturating_sub(self.line.len()));
            self.line.push_str(&rest[..taken]);
            rest = &rest[taken..];
            if rest.is_empty() {
                break;
            }
            let cut = page_cut(&self.line, room);
            if self.line.find(search).is_some_and(|at| at < cut) {
                self.is_handed = true;
                return each(self.held(false));
            }
            self.pass_page(cut);
        }
        if !is_ended {
            return true;
        }
        // The line ending's carriage return, which no page shows.
        if self.line.ends_with('\r') {
            self.line.pop();
        }
        self.search_last_pages(search, each)
    }

    // Tests the searched line's held text, its last, page by page and hands the first page that
    // holds the search, answering whether the read goes on.
    fn search_last_pages(
        &mut self,
        search: &str,
        each: &mut impl FnMut(BodyLine<'_>) -> bool,
    ) -> bool {
        loop {
            let room = self.page_room();
            let cut = if self.line.len() > room {
                page_cut(&self.line, room)
            } else {
                self.line.len()
            };
            if self.line.find(search).is_some_and(|at| at < cut) {
                self.is_handed = true;
                return each(self.held(false));
            }
            if cut == self.line.len() {
                return true;
            }
            self.pass_page(cut);
        }
    }

    // How many bytes of the held text the page it opens shows past its label.
    fn page_room(&self) -> usize {
        READ_PAGE_MAX_BYTES - line_label(self.ended + 1, self.is_continued).len()
    }

    // Lets go of the held text's first page, `cut` bytes, the next page opening inside the line.
    fn pass_page(&mut self, cut: usize) {
        self.line.drain(..cut);
        self.line_start += byte_count(cut);
        self.is_continued = true;
    }

    // The line being read as far as it is held, its carriage return dropped where a line feed
    // ended it.
    fn held(&self, is_ended: bool) -> BodyLine<'_> {
        let text = if is_ended {
            self.line.strip_suffix('\r').unwrap_or(&self.line)
        } else {
            &self.line
        };
        BodyLine {
            number: self.ended + 1,
            start: self.line_start,
            text,
            is_continued: self.is_continued,
        }
    }

    // Adds `segment` to the line being read, up to the most a line keeps, answering whether all
    // of it fit.
    fn keep(&mut self, segment: &str) -> bool {
        let room = LINE_KEPT_MAX_BYTES - self.line.len();
        if segment.len() <= room {
            self.line.push_str(segment);
            return true;
        }
        self.line
            .push_str(&segment[..segment.floor_char_boundary(room)]);
        false
    }
}
