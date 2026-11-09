//! `session_read`'s handler: another session's last answer, its latest turns or the turns around
//! a search hit, read through the session's transcript windows, or one tool output by line range
//! or by the lines that match a search. A result stops at a page's size and ends with the shared
//! `more_trailer`, whose cursor the next call hands back.

use std::collections::HashSet;
use std::ops::ControlFlow;

use rusqlite::params;
use serde_json::{Map, Value};
use sidekicks_agent::tools::session::read::{
    Include, LineRange, SessionReadArguments, no_lines_in_range, no_matching_lines, nothing_yet,
    output_not_found, position_unknown, rest_of_row, typed_in_terminal,
};
use sidekicks_agent::tools::session::{PageCursor, more_trailer};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::session::event_cursor::{EventCursor, encode_event_cursor};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::content::{TranscriptBodyReadResponse, TranscriptRowContent};
use sidekicks_contracts::transcript::operations::{TranscriptReadRequest, TranscriptReadResponse};
use sidekicks_contracts::transcript::row::TranscriptReadRow;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_session::service::SessionService;
use sidekicks_session::transcript::window::TranscriptReadError;
use sidekicks_store::database::connection::read_pool::ReadLength;
use sidekicks_store::database::schema::SESSION_EVENTS_TABLE;
use sidekicks_store::events::session::read::session_read_bound;

use crate::agent_tools::AgentToolError;
use crate::orchestration::session_directory::{
    CallerReference, SessionDirectory, resolve_session_reference,
};

/// The most text one result carries, in UTF-8 bytes, so a read stays a small part of the calling
/// model's context; the rest follows a page at a time.
const READ_PAGE_MAX_BYTES: usize = 64 * 1024;

/// The most of one body line a read holds: just past a page, so `cut_to_page` still marks a line
/// too long for one without the whole line in memory.
const LINE_KEPT_MAX_BYTES: usize = READ_PAGE_MAX_BYTES + 4;

/// `session_read` for a call `caller` makes. Refuses, in the text the model reads, a name the
/// directory does not resolve to one session, a session typed in a terminal, an output, hit or
/// cursor the session does not hold; fails as a read fails.
pub(crate) async fn read_session(
    directory: &SessionDirectory,
    sessions: &SessionService,
    caller: &SessionId,
    arguments: SessionReadArguments,
) -> Result<String, AgentToolError> {
    let entries = directory
        .read_entries()
        .await
        .map_err(AgentToolError::failed)?;
    let target = resolve_session_reference(
        &entries,
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
        sessions,
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
            .read_window(Some(after), None, None, cursor.as_str())
            .await?;
        let continues_after = window.has_more.then_some(window.next_cursor).flatten();
        (window.rows, continues_after)
    } else if let Some(around) = &arguments.around {
        let anchor = reading.event_cursor(around.as_str())?;
        let window = reading
            .read_window(None, None, Some(anchor), around.as_str())
            .await?;
        (window.rows, None)
    } else {
        let turns = arguments.turns.map_or(1, |turns| {
            usize::try_from(turns.get()).unwrap_or(usize::MAX)
        });
        (reading.read_latest_turns(directory, turns).await?, None)
    };
    if rows.is_empty() {
        return Ok(nothing_yet(&reading.name));
    }
    reading.render(&rows, &shown, continues_after).await
}

// One session being read: the store it is read through, its id and the name a result uses.
struct SessionReading<'read> {
    sessions: &'read SessionService,
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

    // One window of the session's rows; a position the session does not hold is refused naming
    // `position`, the text the model passed.
    async fn read_window(
        &self,
        after_cursor: Option<EventCursor>,
        before_cursor: Option<EventCursor>,
        around_cursor: Option<EventCursor>,
        position: &str,
    ) -> Result<Window, AgentToolError> {
        let request = TranscriptReadRequest {
            session_id: self.session_id,
            after_cursor,
            before_cursor,
            around_cursor,
            limit: None,
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
        directory: &SessionDirectory,
        turns: usize,
    ) -> Result<Vec<TranscriptReadRow>, AgentToolError> {
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
                .read_window(None, Some(cursor), None, &position)
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
                if !pieces.is_empty() && length + piece.len() > READ_PAGE_MAX_BYTES {
                    let cursor = taken.map_or("", |cursor| cursor.as_str());
                    pieces.push(more_trailer(cursor));
                    return Ok(pieces.join("\n"));
                }
                length += piece.len();
                let is_over_page = piece.len() > READ_PAGE_MAX_BYTES;
                pieces.push(cut_to_page(piece));
                if is_over_page {
                    // A row no page holds goes on by its lines, read under its own id.
                    pieces.push(rest_of_row(parts.id));
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

    // One row's text, or `None` for a row the read does not show.
    async fn piece_of(
        &self,
        parts: &RowParts<'_>,
        shown: &ShownRows,
    ) -> Result<Option<String>, AgentToolError> {
        let event_type = parts.event_type;
        let includes = |include| shown.include.contains(&include);
        if event_type == SessionEventType::AgentMessageSent.as_str() {
            let body = self.body_of(parts).await?;
            return Ok(Some(format!("answer: {}", body.unwrap_or_default())));
        }
        if shown.is_answer_only {
            return Ok(None);
        }
        if event_type == SessionEventType::UserMessageSent.as_str() {
            let message = parts
                .payload
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or_default();
            return Ok(Some(format!("message: {message}")));
        }
        if event_type == SessionEventType::AgentToolCallInvoked.as_str() && includes(Include::Tools)
        {
            let tool = parts
                .payload
                .get("toolName")
                .and_then(Value::as_str)
                .unwrap_or_default();
            return Ok(Some(match parts.content {
                TranscriptRowContent::Available { body, .. } => {
                    format!("tool {tool}: {}", body.as_str())
                }
                TranscriptRowContent::Large { .. } | TranscriptRowContent::Unavailable { .. } => {
                    format!("tool {tool}")
                }
            }));
        }
        let is_tool_end = event_type == SessionEventType::AgentToolCallCompleted.as_str()
            || event_type == SessionEventType::AgentToolCallFailed.as_str();
        if !is_tool_end {
            return Ok(None);
        }
        let mut lines = Vec::new();
        if includes(Include::Outputs) {
            lines.push(match parts.content {
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
            });
        }
        if includes(Include::Changes) {
            let mut paths = parts.changed_paths.clone();
            let inline_files = match parts.content {
                TranscriptRowContent::Available { body, .. } => changed_files_of(body.as_str()),
                TranscriptRowContent::Large { .. } | TranscriptRowContent::Unavailable { .. } => {
                    Vec::new()
                }
            };
            paths.extend(inline_files.iter().map(String::as_str));
            if !paths.is_empty() {
                lines.push(format!("changed: {}", paths.join(", ")));
            }
        }
        Ok((!lines.is_empty()).then(|| lines.join("\n")))
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
                    .read_body_parts(parts.id, |part| {
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

    // Hands a row's body to `each` part by part until `each` breaks, answering how the read
    // ended; `None` for a row the session does not hold or one with no body.
    async fn read_body_parts(
        &self,
        row_id: &str,
        mut each: impl FnMut(&str) -> ControlFlow<()>,
    ) -> Result<Option<ControlFlow<()>>, AgentToolError> {
        let mut offset = 0;
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

    // How many lines a row's body holds, read part by part; `None` for a row the session does not
    // hold or one with no body.
    async fn count_body_lines(&self, row_id: &str) -> Result<Option<u64>, AgentToolError> {
        let mut lines = BodyLines::default();
        let read = self
            .read_body_parts(row_id, |part| lines.take(part, &mut |_: u64, _: &str| true))
            .await?;
        Ok(read.map(|_| lines.count()))
    }

    // One output's numbered lines: the range or matches asked for, from the cursor's line on.
    async fn read_output(
        &self,
        output: &str,
        lines: Option<LineRange>,
        search: Option<&str>,
        cursor: Option<&PageCursor>,
    ) -> Result<String, AgentToolError> {
        let from_line: u64 = match cursor {
            None => 1,
            Some(cursor) => cursor.as_str().parse().map_err(|_not_a_line| {
                AgentToolError::Refused(position_unknown(cursor.as_str(), &self.name))
            })?,
        };
        let not_found = || AgentToolError::Refused(output_not_found(output, &self.name));
        let (first, last) = match lines {
            None => (1, u64::MAX),
            Some(LineRange::Span { first, last }) => (first.get(), last.get()),
            Some(LineRange::Last(count)) => {
                // The range counts back from the end, so the lines are counted in a read before.
                let line_count = self.count_body_lines(output).await?.ok_or_else(not_found)?;
                (line_count.saturating_sub(count.get()) + 1, line_count)
            }
        };
        let mut pieces: Vec<String> = Vec::new();
        let mut length = 0;
        // Takes one numbered line, answering whether the read goes on.
        let mut each = |number: u64, line: &str| {
            if number > last {
                return false;
            }
            if number < first.max(from_line) || search.is_some_and(|search| !line.contains(search))
            {
                return true;
            }
            let piece = format!("{number}: {line}");
            if !pieces.is_empty() && length + piece.len() > READ_PAGE_MAX_BYTES {
                pieces.push(more_trailer(&number.to_string()));
                return false;
            }
            length += piece.len();
            pieces.push(cut_to_page(piece));
            true
        };
        let mut body_lines = BodyLines::default();
        let read = self
            .read_body_parts(output, |part| body_lines.take(part, &mut each))
            .await?;
        match read.ok_or_else(not_found)? {
            ControlFlow::Continue(()) => body_lines.finish(&mut each),
            ControlFlow::Break(()) => {}
        }
        if pieces.is_empty() {
            return Ok(match search {
                Some(_) => no_matching_lines(output),
                None => no_lines_in_range(output),
            });
        }
        Ok(pieces.join("\n"))
    }
}

// A body's numbered lines as it is read part by part, split where `str::lines` splits it, each
// held only up to `LINE_KEPT_MAX_BYTES`.
#[derive(Default)]
struct BodyLines {
    ended: u64,
    line: String,
}

impl BodyLines {
    // Takes the body's next part, handing each line it ends to `each` with its number until
    // `each` answers that the read stops.
    fn take(&mut self, part: &str, each: &mut impl FnMut(u64, &str) -> bool) -> ControlFlow<()> {
        let mut segments = part.split('\n').peekable();
        while let Some(segment) = segments.next() {
            self.keep(segment);
            if segments.peek().is_none() {
                break;
            }
            self.ended += 1;
            let is_reading_on = each(
                self.ended,
                self.line.strip_suffix('\r').unwrap_or(&self.line),
            );
            self.line.clear();
            if !is_reading_on {
                return ControlFlow::Break(());
            }
        }
        ControlFlow::Continue(())
    }

    // Hands `each` the body's last line where no newline ends it.
    fn finish(&mut self, each: &mut impl FnMut(u64, &str) -> bool) {
        if !self.line.is_empty() {
            self.ended += 1;
            // The body's last line, so whether `each` would read on changes nothing.
            each(self.ended, &self.line);
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

// A piece longer than a page alone, cut there on a character's boundary.
fn cut_to_page(mut piece: String) -> String {
    if piece.len() > READ_PAGE_MAX_BYTES {
        let mut cut = READ_PAGE_MAX_BYTES;
        while !piece.is_char_boundary(cut) {
            cut -= 1;
        }
        piece.truncate(cut);
        piece.push('…');
    }
    piece
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
mod tests {
    use std::sync::Arc;

    use futures::FutureExt as _;
    use serde_json::json;
    use sidekicks_agent::tools::session::SessionReference;
    use sidekicks_agent::tools::session::errors::{SharedNameHolder, shared_name};
    use sidekicks_agent::tools::session::read::{SessionReadArguments, rest_of_row};
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_contracts::wire::instant::WireInstant;
    use sidekicks_provider::driver::PROVIDERS;
    use sidekicks_provider::driver::contract::{MockProviderDriver, ProviderDriver};
    use sidekicks_provider::driver::test_registry::registry_of_first_providers;
    use sidekicks_session::service::{SESSION_SERVICE_STATEMENT_CAPACITY, SessionService};
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::schema::session_directory::insert_session_row;
    use sidekicks_store::database::writer::test_file::{
        TestDatabase, insert_lead, insert_test_event, test_run_id, test_session_id,
    };
    use sidekicks_store::events::test_log::AT;

    use super::{READ_PAGE_MAX_BYTES, read_session};
    use crate::agent_tools::AgentToolError;
    use crate::daemon::schema::schema_parts;
    use crate::orchestration::session_directory::SessionDirectory;

    // A database holding this machine's row.
    fn database_of_this_machine() -> (TestDatabase, rusqlite::Connection) {
        let database = TestDatabase::new(schema_parts());
        let reader = database.opener()().expect("the test creates its database");
        reader
            .execute(
                "INSERT INTO local_machine (singleton, machine_id, owner_user_id, name, minted_at)
                 VALUES (1, ?1, ?2, 'this Mac', ?3)",
                [
                    mint_uuid_v7().to_string(),
                    mint_uuid_v7().to_string(),
                    WireInstant::now().as_str().to_owned(),
                ],
            )
            .expect("the test records this machine");
        (database, reader)
    }

    // The directory and the session store over `database`, its one provider holding no session
    // typed in a terminal.
    fn directory_and_sessions(database: &TestDatabase) -> (SessionDirectory, SessionService) {
        let mut driver = MockProviderDriver::new();
        driver
            .expect_list_terminal_sessions()
            .returning(|| async { Ok(Vec::new()) }.boxed());
        driver
            .expect_list_standalone_terminal_sessions()
            .returning(|| async { Ok(Vec::new()) }.boxed());
        let pool = Arc::new(DatabaseReadPool::new(
            database.path(),
            SESSION_SERVICE_STATEMENT_CAPACITY,
        ));
        let directory = SessionDirectory {
            pool: Arc::clone(&pool),
            providers: Arc::new(registry_of_first_providers(vec![
                Arc::new(driver) as Arc<dyn ProviderDriver>
            ])),
            read_damaged_from_sequence: Arc::new(|_: &SessionId| None),
        };
        let sessions = SessionService::new(
            pool,
            Arc::new(|_: &SessionId| None),
            Arc::new(|_: &ProviderId| None),
        );
        (directory, sessions)
    }

    // A name two sessions share is refused with both holders before any transcript is read.
    // Killed by reading the first session the name matches.
    #[tokio::test]
    async fn session_read_on_an_ambiguous_name_answers_the_choices_and_reads_nothing() {
        let (database, reader) = database_of_this_machine();
        let caller: SessionId = test_session_id();
        let builders: [SessionId; 2] = [test_session_id(), test_session_id()];
        for builder in builders {
            insert_session_row(&reader, builder.text().as_str(), Some("builder"), None);
            insert_lead(&database, builder, PROVIDERS[0].id);
        }
        let (directory, sessions) = directory_and_sessions(&database);
        let arguments = SessionReadArguments {
            session: SessionReference::new("builder".to_owned()).expect("a valid reference"),
            turns: None,
            around: None,
            include: None,
            output: None,
            lines: None,
            search: None,
            cursor: None,
        };

        let refused = read_session(&directory, &sessions, &caller, arguments).await;
        let Err(AgentToolError::Refused(text)) = refused else {
            panic!("a shared name is refused, never read");
        };
        let [first, second] = builders.map(|builder| builder.to_string());
        assert_eq!(
            text,
            shared_name(
                "builder",
                &[
                    SharedNameHolder {
                        name: "builder",
                        id: &first,
                        project: "no project",
                    },
                    SharedNameHolder {
                        name: "builder",
                        id: &second,
                        project: "no project",
                    },
                ],
            )
        );
    }

    // An answer longer than a page is cut there with a line naming the id its rest reads under,
    // and that read walks the whole body by lines, page by page, as it was written. Killed by an
    // over-page row with no such line, and by a line split wrongly where the body's parts meet.
    #[tokio::test]
    async fn an_answer_past_a_page_reads_on_by_its_lines() {
        let (database, reader) = database_of_this_machine();
        let caller: SessionId = test_session_id();
        let builder: SessionId = test_session_id();
        insert_session_row(&reader, builder.text().as_str(), Some("builder"), None);
        insert_lead(&database, builder, PROVIDERS[0].id);
        let lines: Vec<String> = (1..=20_000).map(|line| format!("line {line:05}")).collect();
        let body = lines.join("\n");
        insert_test_event(
            &reader,
            builder,
            json!({
                "type": "agent.message.sent",
                "payload": {
                    "sessionId": builder,
                    "runId": test_run_id(),
                    "providerMessageId": "m1",
                },
            }),
            Some(&body),
            AT,
        );
        let (directory, sessions) = directory_and_sessions(&database);
        let read = |arguments: serde_json::Value| {
            let arguments: SessionReadArguments =
                serde_json::from_value(arguments).expect("the test's arguments parse");
            read_session(&directory, &sessions, &caller, arguments)
        };

        let answer = read(json!({"session": "builder"}))
            .await
            .expect("the answer reads");
        let (shown, rest) = answer
            .rsplit_once('\n')
            .expect("a cut answer ends with a line");
        assert!(shown.starts_with("answer: line 00001\nline 00002\n"));
        assert!(shown.len() <= READ_PAGE_MAX_BYTES + '…'.len_utf8());
        let output = rest
            .split('"')
            .nth(1)
            .expect("the line names the answer's id");
        assert_eq!(rest, rest_of_row(output));

        let mut read_lines: Vec<String> = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let mut arguments = json!({"session": "builder", "output": output, "lines": "1-20000"});
            if let Some(cursor) = &cursor {
                arguments["cursor"] = json!(cursor);
            }
            let page = read(arguments).await.expect("a page of lines reads");
            cursor = None;
            for line in page.lines() {
                match line.strip_prefix("More: next_cursor \"") {
                    Some(next) => cursor = Some(next.trim_end_matches('"').to_owned()),
                    None => read_lines.push(line.to_owned()),
                }
            }
            if cursor.is_none() {
                break;
            }
        }
        let numbered: Vec<String> = (1_u64..)
            .zip(&lines)
            .map(|(number, line)| format!("{number}: {line}"))
            .collect();
        assert_eq!(read_lines, numbered);

        let last = read(json!({"session": "builder", "output": output, "lines": "-2"}))
            .await
            .expect("the last lines read");
        assert_eq!(last, "19999: line 19999\n20000: line 20000");
    }
}
