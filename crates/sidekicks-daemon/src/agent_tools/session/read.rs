//! `session_read`'s handler: another session's last answer, its latest turns or the turns around
//! a search hit, read through the session's transcript windows, or one output or message by line
//! range or by the lines that match a search. A result stops at a page's size and ends with the
//! shared `more_trailer`, whose cursor the next call hands back; a row longer than a page ends with
//! a line naming the id and the cursor its rest reads on under.

pub(crate) mod output;

use std::collections::HashSet;
use std::ops::ControlFlow;

use rusqlite::params;
use serde_json::{Map, Value};
use sidekicks_agent::tools::session::more_trailer;
use sidekicks_agent::tools::session::read::{
    Include, SessionReadArguments, nothing_yet, position_unknown, rest_of_changed_files,
    rest_of_row, typed_in_terminal,
};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::session::event_cursor::{EventCursor, encode_event_cursor};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::content::{TranscriptBodyReadResponse, TranscriptRowContent};
use sidekicks_contracts::transcript::operations::{
    TranscriptReadLimit, TranscriptReadRequest, TranscriptReadResponse,
};
use sidekicks_contracts::transcript::row::TranscriptReadRow;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_session::service::SessionService;
use sidekicks_session::transcript::window::TranscriptReadError;
use sidekicks_store::database::connection::read_pool::ReadLength;
use sidekicks_store::database::schema::SESSION_EVENTS_TABLE;
use sidekicks_store::events::session::read::session_read_bound;

use crate::agent_tools::AgentToolError;
use crate::agent_tools::session::read::output::{LineCursor, LineCursorKey, LinePlace};
use crate::orchestration::session_directory::{
    CallerReference, SessionDirectory, resolve_session_reference,
};

/// The most text one result carries, in UTF-8 bytes, so a read stays a small part of the calling
/// model's context; the rest follows a page at a time.
const READ_PAGE_MAX_BYTES: usize = 64 * 1024;

/// The limit of a transcript window that holds only the row it stands around.
const ONE_ROW: TranscriptReadLimit = TranscriptReadLimit::new(1).expect("one row is a limit");

/// `session_read` for a call `caller` makes, its line cursors drawn under `cursor_key`. Refuses,
/// in the text the model reads, a name the directory does not resolve to one session, a session
/// typed in a terminal, an output, hit or cursor the session does not hold; fails as a read fails.
pub(crate) async fn read_session(
    directory: &SessionDirectory,
    sessions: &SessionService,
    cursor_key: &LineCursorKey,
    caller: &SessionId,
    arguments: SessionReadArguments,
) -> Result<String, AgentToolError> {
    let listing = directory
        .read_entries()
        .await
        .map_err(AgentToolError::failed)?;
    let target = resolve_session_reference(
        &listing.entries,
        &listing.unread,
        caller,
        &arguments.session,
        CallerReference::AnySession,
    )
    .map_err(AgentToolError::Refused)?;
    let name = target.name.clone().unwrap_or_else(|| target.id.clone());
    if target.origin.is_typed_in_terminal() {
        return Err(AgentToolError::Refused(typed_in_terminal(&name)));
    }
    let session_id = SessionId::new(&target.id).map_err(AgentToolError::failed)?;
    let reading = SessionReading {
        directory,
        sessions,
        cursor_key,
        session_id,
        name,
    };
    if let Some(output) = &arguments.output {
        let search = arguments.search.as_ref().map(FreeFormText::as_str);
        return reading
            .read_output(
                output.as_str(),
                arguments.lines,
                search,
                arguments.cursor.as_ref(),
            )
            .await;
    }
    let include: HashSet<Include> = arguments.include.unwrap_or_default().into_iter().collect();
    let shown = ShownRows {
        is_answer_only: arguments.turns.is_none()
            && arguments.around.is_none()
            && include.is_empty(),
        include,
    };
    let (rows, continues_after) = if let Some(cursor) = &arguments.cursor {
        let after = reading.event_cursor(cursor.as_str())?;
        let window = reading
            .read_window(Some(after), None, None, None, cursor.as_str())
            .await?;
        let continues_after = window.has_more.then_some(window.next_cursor).flatten();
        (window.rows, continues_after)
    } else if let Some(around) = &arguments.around {
        let anchor = reading.event_cursor(around.as_str())?;
        let window = reading
            .read_window(None, None, Some(anchor), None, around.as_str())
            .await?;
        (window.rows, None)
    } else {
        let turns = arguments.turns.map_or(1, |turns| {
            usize::try_from(turns.get()).unwrap_or(usize::MAX)
        });
        (reading.read_latest_turns(turns).await?, None)
    };
    if rows.is_empty() {
        return Ok(nothing_yet(&reading.name));
    }
    reading.render(&rows, &shown, continues_after).await
}

// One session being read: the directory and store it is read through, the key its line cursors
// are drawn under, its id and the name a result uses.
struct SessionReading<'read> {
    directory: &'read SessionDirectory,
    sessions: &'read SessionService,
    cursor_key: &'read LineCursorKey,
    session_id: SessionId,
    name: String,
}

// Which rows a read shows: the answers alone, or the messages and what `include` names.
struct ShownRows {
    is_answer_only: bool,
    include: HashSet<Include>,
}

// One transcript window's rows, oldest first, and where the read continues.
struct Window {
    rows: Vec<TranscriptReadRow>,
    has_more: bool,
    next_cursor: Option<EventCursor>,
}

// One row's text, and the part of it a read by the row's id serves on past a page's cut.
struct RowPiece {
    text: String,
    served: Option<ServedPart>,
}

// The tail of a row's text that a read by the row's id serves, from `start`, a byte offset in
// the row's text.
struct ServedPart {
    start: usize,
    text: ServedText,
}

// What a read by a row's id serves: the text's lines, or the list of the files a tool call
// changed.
#[derive(Clone, Copy)]
enum ServedText {
    Lines,
    ChangedFiles,
}

// The members a read takes from a row of either arm.
struct RowParts<'row> {
    id: &'row str,
    event_type: &'row str,
    payload: &'row Map<String, Value>,
    content: &'row TranscriptRowContent,
    changed_paths: Vec<&'row str>,
}

fn parts_of(row: &TranscriptReadRow) -> Option<RowParts<'_>> {
    let (id, event_type, payload, content, omitted) = match row {
        TranscriptReadRow::RollbackBoundary(_) => return None,
        TranscriptReadRow::Run(entry) => (
            entry.id.as_str(),
            entry.event_type.as_str(),
            &entry.payload,
            &entry.content,
            entry.omitted_patches.as_ref(),
        ),
        TranscriptReadRow::General(entry) => (
            entry.id.as_str(),
            entry.event_type.as_str(),
            &entry.payload,
            &entry.content,
            entry.omitted_patches.as_ref(),
        ),
    };
    let changed_paths = omitted
        .map(|patches| {
            patches
                .as_slice()
                .iter()
                .map(|patch| patch.path.as_str())
                .collect()
        })
        .unwrap_or_default();
    Some(RowParts {
        id,
        event_type,
        payload,
        content,
        changed_paths,
    })
}

fn row_cursor(row: &TranscriptReadRow) -> &EventCursor {
    match row {
        TranscriptReadRow::RollbackBoundary(boundary) => &boundary.cursor,
        TranscriptReadRow::Run(entry) => &entry.cursor,
        TranscriptReadRow::General(entry) => &entry.cursor,
    }
}

fn is_user_message(row: &TranscriptReadRow) -> bool {
    parts_of(row)
        .is_some_and(|parts| parts.event_type == SessionEventType::UserMessageSent.as_str())
}

impl SessionReading<'_> {
    // A cursor or hit id the model handed back, refused when it is no position at all.
    fn event_cursor(&self, text: &str) -> Result<EventCursor, AgentToolError> {
        EventCursor::new(text.to_owned())
            .ok_or_else(|| AgentToolError::Refused(position_unknown(text, &self.name)))
    }

    // One window of the session's rows, of at most `limit` rows where it names one; a position the
    // session does not hold is refused naming `position`, the text the model passed.
    async fn read_window(
        &self,
        after_cursor: Option<EventCursor>,
        before_cursor: Option<EventCursor>,
        around_cursor: Option<EventCursor>,
        limit: Option<TranscriptReadLimit>,
        position: &str,
    ) -> Result<Window, AgentToolError> {
        let request = TranscriptReadRequest {
            session_id: self.session_id,
            after_cursor,
            before_cursor,
            around_cursor,
            limit,
        };
        let response = self
            .sessions
            .read_transcript_window(request)
            .await
            .map_err(|error| {
                if matches!(
                    error,
                    TranscriptReadError::CursorUnresolvable(_) | TranscriptReadError::Refused(_)
                ) {
                    AgentToolError::Refused(position_unknown(position, &self.name))
                } else {
                    AgentToolError::failed(error)
                }
            })?;
        Ok(match response {
            TranscriptReadResponse::Continuing(page) => Window {
                rows: page.entries.into_vec(),
                has_more: true,
                next_cursor: Some(page.next_cursor),
            },
            TranscriptReadResponse::Terminal(page) => Window {
                rows: page.entries.into_vec(),
                has_more: false,
                next_cursor: page.next_cursor,
            },
        })
    }

    // The rows of the session's latest `turns` turns, each turn starting at a message the session
    // took, read backward from its newest readable event one window at a time.
    async fn read_latest_turns(
        &self,
        turns: usize,
    ) -> Result<Vec<TranscriptReadRow>, AgentToolError> {
        let directory = self.directory;
        let bound = session_read_bound(
            |session_id: &SessionId| (directory.read_damaged_from_sequence)(session_id),
            &self.session_id,
            None,
        );
        let session_id = self.session_id.to_string();
        let head: Option<i64> = directory
            .pool
            .read(ReadLength::Short, move |reader| {
                reader
                    .query_row(
                        &format!(
                            "SELECT MAX(sequence) FROM {SESSION_EVENTS_TABLE}
                              WHERE session_id = ?1 AND sequence < ?2"
                        ),
                        params![session_id, bound],
                        |row| row.get(0),
                    )
                    .map_err(AgentToolError::from)
            })
            .await?;
        let Some(head) = head else {
            return Ok(Vec::new());
        };
        let mut before = Some(encode_event_cursor(head).map_err(AgentToolError::failed)?);
        let mut rows: Vec<TranscriptReadRow> = Vec::new();
        while let Some(cursor) = before.take() {
            let position = cursor.as_str().to_owned();
            let window = self
                .read_window(None, Some(cursor), None, None, &position)
                .await?;
            let mut older = window.rows;
            older.append(&mut rows);
            rows = older;
            if rows.iter().filter(|row| is_user_message(row)).count() >= turns {
                break;
            }
            if window.has_more {
                before = window.next_cursor;
            }
        }
        let starts: Vec<usize> = rows
            .iter()
            .enumerate()
            .filter(|(_, row)| is_user_message(row))
            .map(|(index, _)| index)
            .collect();
        let first = starts
            .len()
            .checked_sub(turns)
            .map_or(0, |start| starts[start]);
        Ok(rows.split_off(first))
    }

    // The rows `shown` keeps as text, cut at a page's size with the cursor of the last row taken;
    // `continues_after` names where a window that holds more goes on.
    async fn render(
        &self,
        rows: &[TranscriptReadRow],
        shown: &ShownRows,
        continues_after: Option<EventCursor>,
    ) -> Result<String, AgentToolError> {
        let mut pieces: Vec<String> = Vec::new();
        let mut length = 0;
        let mut taken: Option<&EventCursor> = None;
        for row in rows {
            let Some(parts) = parts_of(row) else {
                taken = Some(row_cursor(row));
                continue;
            };
            if let Some(piece) = self.piece_of(&parts, shown).await? {
                if !pieces.is_empty() && length + piece.text.len() > READ_PAGE_MAX_BYTES {
                    let cursor = taken.map_or("", |cursor| cursor.as_str());
                    pieces.push(more_trailer(cursor));
                    return Ok(pieces.join("\n"));
                }
                length += piece.text.len();
                if piece.text.len() > READ_PAGE_MAX_BYTES {
                    // A row no page holds goes on under its own id from where the page cut it.
                    let cut = page_cut(&piece.text, READ_PAGE_MAX_BYTES);
                    let rest = self.rest_of_cut_row(parts.id, &piece, cut);
                    let mut text = piece.text;
                    text.truncate(cut);
                    pieces.push(text);
                    pieces.extend(rest);
                } else {
                    pieces.push(piece.text);
                }
            }
            taken = Some(row_cursor(row));
        }
        if let Some(cursor) = continues_after {
            pieces.push(more_trailer(cursor.as_str()));
        }
        if pieces.is_empty() {
            return Ok(nothing_yet(&self.name));
        }
        Ok(pieces.join("\n"))
    }

    // The line that ends `piece`, the row `output`'s text cut at its byte `cut`: the id and the
    // cursor its served part reads on under. `None` for a row with no served part, which no row
    // longer than a page is, since the parts it shows inline stay under a page.
    fn rest_of_cut_row(&self, output: &str, piece: &RowPiece, cut: usize) -> Option<String> {
        let served = piece.served.as_ref()?;
        let text = &piece.text[served.start..];
        // A cut before the served part reads it from its start.
        let offset = cut.saturating_sub(served.start);
        let byte_offset = |offset: usize| u64::try_from(offset).expect("an offset fits 64 bits");
        Some(match served.text {
            ServedText::ChangedFiles => rest_of_changed_files(
                output,
                &self.line_cursor(
                    output,
                    &LineCursor {
                        line: 1,
                        offset: byte_offset(offset),
                        place: LinePlace::ChangedFiles,
                    },
                ),
            ),
            ServedText::Lines => {
                let line = 1 + byte_offset(text[..offset].matches('\n').count());
                let is_at_line_start = offset == 0 || text[..offset].ends_with('\n');
                // A cut at a line's end goes on at the next line's start; `page_cut` never cuts
                // inside a line ending's `\r\n`.
                let next = if text[offset..].starts_with('\n') {
                    LineCursor {
                        line: line + 1,
                        offset: byte_offset(offset + 1),
                        place: LinePlace::Start,
                    }
                } else {
                    LineCursor {
                        line,
                        offset: byte_offset(offset),
                        place: if is_at_line_start {
                            LinePlace::Start
                        } else {
                            LinePlace::Inside
                        },
                    }
                };
                rest_of_row(output, line, &self.line_cursor(output, &next))
            }
        })
    }

    // One row's text, or `None` for a row the read does not show.
    async fn piece_of(
        &self,
        parts: &RowParts<'_>,
        shown: &ShownRows,
    ) -> Result<Option<RowPiece>, AgentToolError> {
        let event_type = parts.event_type;
        let includes = |include| shown.include.contains(&include);
        // A text that opens with `label`, its rest served by its lines.
        let lines_after = |label: &str, rest: &str| RowPiece {
            text: format!("{label}{rest}"),
            served: Some(ServedPart {
                start: label.len(),
                text: ServedText::Lines,
            }),
        };
        if event_type == SessionEventType::AgentMessageSent.as_str() {
            let body = self.body_of(parts).await?;
            return Ok(Some(lines_after("answer: ", &body.unwrap_or_default())));
        }
        if shown.is_answer_only {
            return Ok(None);
        }
        if event_type == SessionEventType::UserMessageSent.as_str() {
            return Ok(Some(lines_after(
                "message: ",
                message_text_of(parts.payload),
            )));
        }
        if event_type == SessionEventType::AgentToolCallInvoked.as_str() && includes(Include::Tools)
        {
            let tool = parts
                .payload
                .get("toolName")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let text = match parts.content {
                TranscriptRowContent::Available { body, .. } => {
                    format!("tool {tool}: {}", body.as_str())
                }
                TranscriptRowContent::Large { .. } | TranscriptRowContent::Unavailable { .. } => {
                    format!("tool {tool}")
                }
            };
            return Ok(Some(RowPiece { text, served: None }));
        }
        let is_tool_end = event_type == SessionEventType::AgentToolCallCompleted.as_str()
            || event_type == SessionEventType::AgentToolCallFailed.as_str();
        if !is_tool_end {
            return Ok(None);
        }
        let mut text = if includes(Include::Outputs) {
            match parts.content {
                TranscriptRowContent::Available { body, .. } => {
                    format!("output {}: {}", parts.id, body.as_str())
                }
                TranscriptRowContent::Large { content_length } => format!(
                    "output {}: {} bytes, read it with output \"{}\"",
                    parts.id,
                    content_length.get(),
                    parts.id
                ),
                TranscriptRowContent::Unavailable { .. } => format!("output {}", parts.id),
            }
        } else {
            String::new()
        };
        let mut served = None;
        if includes(Include::Changes)
            && let Some(changed) = changed_files_text(parts)
        {
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str("changed: ");
            served = Some(ServedPart {
                start: text.len(),
                text: ServedText::ChangedFiles,
            });
            text.push_str(&changed);
        }
        Ok((!text.is_empty()).then_some(RowPiece { text, served }))
    }

    // A row's body as far as a page shows it: the one its row carries, or a large one read part
    // by part until it runs past a page.
    async fn body_of(&self, parts: &RowParts<'_>) -> Result<Option<String>, AgentToolError> {
        match parts.content {
            TranscriptRowContent::Available { body, .. } => Ok(Some(body.as_str().to_owned())),
            TranscriptRowContent::Unavailable { .. } => Ok(None),
            TranscriptRowContent::Large { .. } => {
                let mut body = String::new();
                let read = self
                    .read_body_parts(parts.id, 0, |part| {
                        body.push_str(part);
                        if body.len() > READ_PAGE_MAX_BYTES {
                            ControlFlow::Break(())
                        } else {
                            ControlFlow::Continue(())
                        }
                    })
                    .await?;
                Ok(read.map(|_| body))
            }
        }
    }

    // Hands a row's body from its byte `offset` to `each` part by part until `each` breaks,
    // answering how the read ended; `None` for a row the session does not hold or one with no
    // body.
    async fn read_body_parts(
        &self,
        row_id: &str,
        mut offset: u64,
        mut each: impl FnMut(&str) -> ControlFlow<()>,
    ) -> Result<Option<ControlFlow<()>>, AgentToolError> {
        loop {
            let part = self
                .sessions
                .read_row_body(self.session_id, row_id.to_owned(), offset)
                .await
                .map_err(AgentToolError::failed)?;
            match part {
                None | Some(TranscriptBodyReadResponse::Unavailable { .. }) => return Ok(None),
                Some(TranscriptBodyReadResponse::Available {
                    body: part,
                    next_offset,
                    ..
                }) => {
                    let flow = each(part.as_str());
                    match (flow, next_offset) {
                        (ControlFlow::Continue(()), Some(next)) => offset = next.get(),
                        (flow, _) => return Ok(Some(flow)),
                    }
                }
            }
        }
    }
}

// Where a page with `room` bytes cuts `text`, which runs past it: on a character's boundary, and
// before the character ahead of a carriage return the cut would fall at or just after, so a line
// ending's `\r\n` stays whole on the next page and that page never opens on an empty rest.
fn page_cut(text: &str, room: usize) -> usize {
    let mut cut = text.floor_char_boundary(room);
    if text[..cut].ends_with('\r') && text[cut..].starts_with('\n') {
        cut -= 1;
    }
    if text[cut..].starts_with('\r') {
        cut = text.floor_char_boundary(cut.saturating_sub(1));
    }
    cut
}

// The text of a message the session took, from its event's payload.
fn message_text_of(payload: &Map<String, Value>) -> &str {
    payload
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

// The files a tool call's row says it changed, as one list: the ones its row leaves out, then the
// ones a file list it carries whole names; `None` for a row that names none.
fn changed_files_text(parts: &RowParts<'_>) -> Option<String> {
    let mut paths = parts.changed_paths.clone();
    let inline_files = match parts.content {
        TranscriptRowContent::Available { body, .. } => changed_files_of(body.as_str()),
        TranscriptRowContent::Large { .. } | TranscriptRowContent::Unavailable { .. } => Vec::new(),
    };
    paths.extend(inline_files.iter().map(String::as_str));
    (!paths.is_empty()).then(|| paths.join(", "))
}

// The paths of a tool completion's file list a row carries whole: `{"files": [{"path": …}]}`.
fn changed_files_of(body: &str) -> Vec<String> {
    let Ok(Value::Object(list)) = serde_json::from_str::<Value>(body) else {
        return Vec::new();
    };
    list.get("files")
        .and_then(Value::as_array)
        .map(|files| {
            files
                .iter()
                .filter_map(|file| file.get("path").and_then(Value::as_str))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests;
