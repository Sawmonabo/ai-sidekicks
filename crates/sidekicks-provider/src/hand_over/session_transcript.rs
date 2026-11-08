//! A session's transcript, every run of it or every run created after a given sequence, the lead's
//! and each helper's, handed to a sink as it is read. Runs come in the order each run's first row,
//! its `agent.run.queued`, is logged; within a run the canonical fold gives the turns. One read
//! pass over the log under one snapshot holds at most one hydrated page, the segment being handed
//! on and the run's calls whose result folds, never the session: each page is folded and handed on
//! before the next is read, a call's last close is read alone when its first is folded, and a body
//! too long for a page is handed on a frame at a time as it is read.

use std::io;
use std::ops::ControlFlow;

use rusqlite::Connection;
use sidekicks_contracts::event::envelope::EventEnvelope;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queued::AgentRunQueuedPayload;
use sidekicks_contracts::session::event_cursor::START_OF_LOG_POSITION;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_store::events::content::codec::{
    BodyStreamError, StoredBodyPlace, out_of_memory_read_failure,
};
use sidekicks_store::events::session::read::tool_call_closes::ToolCallCloses;
use sidekicks_store::events::session::read::{
    HydratedPage, SessionEventFilter, SessionEventReads, SessionLogReadError, UnloadedBodyEvent,
    malformed_body,
};

use crate::hand_over::canonical_transcript::{
    CanonicalTranscriptFoldError, CanonicalTranscriptRole, CanonicalTranscriptSegment,
    TRANSCRIPT_EVENT_TYPES, TurnFold, TurnFoldStep, read_payload, read_run_close,
};

/// Receives a session's transcript in log order: a run's opening before its first turn, a turn's
/// opening before its segments. A run with no segment is never opened. A body too long to load
/// comes as a streamed segment: its head, then the body's frames, which continue the head's text,
/// then its end. Each method's error stops the read and is answered as
/// [`SessionTranscriptError::Sink`].
pub trait SessionTranscriptSink {
    /// What the sink fails with.
    type Error;

    /// A run opens: `number` counts the session's runs in walk order from 1, and `queued` is the
    /// run's creation record, which names its agent and, for a helper, its parent run.
    fn open_run(&mut self, number: u64, queued: &AgentRunQueuedPayload) -> Result<(), Self::Error>;

    /// A turn of `role` opens in the open run.
    fn open_turn(&mut self, role: CanonicalTranscriptRole) -> Result<(), Self::Error>;

    /// The open turn's next segment, whole.
    fn segment(&mut self, segment: CanonicalTranscriptSegment) -> Result<(), Self::Error>;

    /// The open turn's next segment, whose body follows in frames: `head` carries its kind and
    /// the text before the body, which is empty unless the segment is a tool line.
    fn open_streamed_segment(
        &mut self,
        head: CanonicalTranscriptSegment,
    ) -> Result<(), Self::Error>;

    /// The next frame of the streamed segment's body.
    fn body_frame(&mut self, frame: &str) -> Result<(), Self::Error>;

    /// The streamed segment's body ended.
    fn close_streamed_segment(&mut self) -> Result<(), Self::Error>;
}

/// Why a session's transcript could not be handed on whole.
#[derive(Debug, thiserror::Error)]
pub enum SessionTranscriptError<SinkError> {
    /// The log could not be read or a row did not read as its type's.
    #[error(transparent)]
    Fold(#[from] CanonicalTranscriptFoldError),
    /// The sink refused a piece.
    #[error("the session transcript's sink refused a piece")]
    Sink(#[source] SinkError),
}

impl<SinkError> From<SessionLogReadError> for SessionTranscriptError<SinkError> {
    fn from(error: SessionLogReadError) -> Self {
        Self::Fold(error.into())
    }
}

/// Hands session `session_id`'s transcript to `sink`, read on `connection` under one snapshot:
/// the whole of it, or with `after_sequence` only the runs created after that sequence;
/// `read_damaged_from_sequence` answers where a damaged session's reads stop. Fails when the log
/// cannot be read, a row is not its type's, or the sink refuses a piece, having handed on what
/// came before.
pub fn stream_session_transcript<DamagedFrom, Sink>(
    connection: &Connection,
    read_damaged_from_sequence: DamagedFrom,
    session_id: &SessionId,
    after_sequence: Option<i64>,
    sink: &mut Sink,
) -> Result<(), SessionTranscriptError<Sink::Error>>
where
    DamagedFrom: Fn(&SessionId) -> Option<i64>,
    Sink: SessionTranscriptSink,
{
    let reads = SessionEventReads::new(connection, read_damaged_from_sequence);
    // One snapshot for the whole walk, so a body a page names is still there when it is read.
    let snapshot = reads.snapshot().map_err(SessionLogReadError::from)?;
    walk_session(
        &SessionLogPages {
            reads: &reads,
            connection,
        },
        session_id,
        after_sequence.unwrap_or(START_OF_LOG_POSITION),
        sink,
    )?;
    snapshot.commit().map_err(SessionLogReadError::from)?;
    Ok(())
}

/// The reads the walk makes, the seam a test wraps to watch what it holds.
trait TranscriptPageSource {
    /// The session's next run creation record after `after_position`, `None` past the last.
    fn read_next_run(
        &self,
        session_id: &SessionId,
        after_position: i64,
    ) -> Result<Option<EventEnvelope>, SessionLogReadError>;

    /// Run `run_id`'s next hydrated page of transcript rows after `after_position`.
    fn read_run_page(
        &self,
        session_id: &SessionId,
        run_id: &RunId,
        after_position: i64,
    ) -> Result<HydratedPage, SessionLogReadError>;

    /// Run `run_id`'s calls with a stand-in or several closes, over the whole run.
    fn read_run_tool_call_closes(
        &self,
        session_id: &SessionId,
        run_id: &RunId,
    ) -> Result<Vec<ToolCallCloses>, SessionLogReadError>;

    /// Run `run_id`'s close at `sequence` as a one-row page.
    fn read_run_close(
        &self,
        session_id: &SessionId,
        run_id: &RunId,
        sequence: i64,
    ) -> Result<HydratedPage, SessionLogReadError>;

    /// Hands the body stored at `place` to `each` a frame at a time, as
    /// [`StoredBodyPlace::stream`] does.
    fn stream_body<Stop>(
        &self,
        place: &StoredBodyPlace,
        each: impl FnMut(&str) -> io::Result<ControlFlow<Stop>>,
    ) -> Result<ControlFlow<Stop>, BodyStreamError>;
}

/// The page source over the session log.
struct SessionLogPages<'reads, 'reader, DamagedFrom> {
    reads: &'reads SessionEventReads<'reader, DamagedFrom>,
    connection: &'reader Connection,
}

impl<DamagedFrom> TranscriptPageSource for SessionLogPages<'_, '_, DamagedFrom>
where
    DamagedFrom: Fn(&SessionId) -> Option<i64>,
{
    fn read_next_run(
        &self,
        session_id: &SessionId,
        after_position: i64,
    ) -> Result<Option<EventEnvelope>, SessionLogReadError> {
        let run_queued = [SessionEventType::AgentRunQueued.as_str()];
        let filter = SessionEventFilter {
            event_types: Some(run_queued.as_slice()),
            before_sequence: None,
            is_sparse: true,
        };
        Ok(self
            .reads
            .read_after(session_id, after_position, 1, filter)?
            .pop())
    }

    fn read_run_page(
        &self,
        session_id: &SessionId,
        run_id: &RunId,
        after_position: i64,
    ) -> Result<HydratedPage, SessionLogReadError> {
        self.reads.read_run_page_hydrated(
            session_id,
            run_id,
            after_position,
            TRANSCRIPT_EVENT_TYPES.as_slice(),
            None,
        )
    }

    fn read_run_tool_call_closes(
        &self,
        session_id: &SessionId,
        run_id: &RunId,
    ) -> Result<Vec<ToolCallCloses>, SessionLogReadError> {
        self.reads
            .read_run_tool_call_closes(session_id, run_id, None)
    }

    fn read_run_close(
        &self,
        session_id: &SessionId,
        run_id: &RunId,
        sequence: i64,
    ) -> Result<HydratedPage, SessionLogReadError> {
        read_run_close(self.reads, session_id, run_id, sequence)
    }

    fn stream_body<Stop>(
        &self,
        place: &StoredBodyPlace,
        each: impl FnMut(&str) -> io::Result<ControlFlow<Stop>>,
    ) -> Result<ControlFlow<Stop>, BodyStreamError> {
        place.stream(self.connection, each)
    }
}

/// Walks every run of the session whose creation record is logged after `after_position`, in the
/// order those records are logged.
fn walk_session<Sink: SessionTranscriptSink>(
    pages: &impl TranscriptPageSource,
    session_id: &SessionId,
    mut after_position: i64,
    sink: &mut Sink,
) -> Result<(), SessionTranscriptError<Sink::Error>> {
    let mut number = 0;
    while let Some(queued_row) = pages.read_next_run(session_id, after_position)? {
        after_position = i64::from(queued_row.sequence);
        number += 1;
        let queued: AgentRunQueuedPayload =
            read_payload(queued_row.sequence.get(), &queued_row.payload)?;
        walk_run(pages, session_id, number, &queued, sink)?;
    }
    Ok(())
}

/// Folds one run a hydrated page at a time, handing each piece to `sink` before the next page is
/// read, and opening the run only at its first turn. A call's first close is folded as its last,
/// read alone.
fn walk_run<Sink: SessionTranscriptSink>(
    pages: &impl TranscriptPageSource,
    session_id: &SessionId,
    number: u64,
    queued: &AgentRunQueuedPayload,
    sink: &mut Sink,
) -> Result<(), SessionTranscriptError<Sink::Error>> {
    let run_id = queued.run_id();
    let mut fold = TurnFold::new(pages.read_run_tool_call_closes(session_id, &run_id)?);
    let mut run = RunPieces {
        sink,
        number,
        queued,
        is_open: false,
    };
    let mut after_position = START_OF_LOG_POSITION;
    loop {
        let page = pages.read_run_page(session_id, &run_id, after_position)?;
        let Some(last) = page.last_sequence() else {
            return Ok(());
        };
        after_position = last;
        for event in page.events {
            let Some(last_close) = fold.last_close_for(&event.event) else {
                fold.add(event, &mut |step| run.hand_on(step))?;
                continue;
            };
            let close = pages.read_run_close(session_id, &run_id, last_close)?;
            fold_close(pages, &mut fold, &mut run, &event.event, close)?;
        }
        let Some(unloaded) = page.oversized else {
            continue;
        };
        match fold.last_close_for(&unloaded.event) {
            Some(last_close) => {
                let close = pages.read_run_close(session_id, &run_id, last_close)?;
                fold_close(pages, &mut fold, &mut run, &unloaded.event, close)?;
            }
            None => stream_row(pages, &mut fold, &mut run, &unloaded.event, &unloaded)?,
        }
    }
}

/// A run's pieces as they reach the sink: the run opens at its first turn.
struct RunPieces<'walk, Sink> {
    sink: &'walk mut Sink,
    number: u64,
    queued: &'walk AgentRunQueuedPayload,
    is_open: bool,
}

impl<Sink: SessionTranscriptSink> RunPieces<'_, Sink> {
    /// Hands one step of the fold to the sink, opening the run before its first turn.
    fn hand_on(&mut self, step: TurnFoldStep) -> Result<(), SessionTranscriptError<Sink::Error>> {
        match step {
            TurnFoldStep::TurnOpened { role, .. } => {
                if !self.is_open {
                    self.is_open = true;
                    self.sink
                        .open_run(self.number, self.queued)
                        .map_err(SessionTranscriptError::Sink)?;
                }
                self.sink
                    .open_turn(role)
                    .map_err(SessionTranscriptError::Sink)
            }
            TurnFoldStep::Segment(segment) => self
                .sink
                .segment(segment)
                .map_err(SessionTranscriptError::Sink),
        }
    }
}

/// Folds `close`, the one-row page of the last close of the call `first` first closes, at
/// `first`'s place, its body whole or a frame at a time.
fn fold_close<Sink: SessionTranscriptSink>(
    pages: &impl TranscriptPageSource,
    fold: &mut TurnFold,
    run: &mut RunPieces<'_, Sink>,
    first: &EventEnvelope,
    close: HydratedPage,
) -> Result<(), SessionTranscriptError<Sink::Error>> {
    let HydratedPage {
        mut events,
        oversized,
    } = close;
    if let Some(last) = events.pop() {
        return fold.add_in_place_of(first, last, &mut |step| run.hand_on(step));
    }
    let unloaded =
        oversized.expect("the snapshot holds the close the run's read of its calls named");
    stream_row(pages, fold, run, first, &unloaded)
}

/// Folds `unloaded`, a row too long for a page, at `place`'s position, handing its body on a
/// frame at a time as it is read.
fn stream_row<Sink: SessionTranscriptSink>(
    pages: &impl TranscriptPageSource,
    fold: &mut TurnFold,
    run: &mut RunPieces<'_, Sink>,
    place: &EventEnvelope,
    unloaded: &UnloadedBodyEvent,
) -> Result<(), SessionTranscriptError<Sink::Error>> {
    let Some(head) = fold.add_streamed(place, &unloaded.event, &mut |step| run.hand_on(step))?
    else {
        return Ok(());
    };
    let sink = &mut *run.sink;
    sink.open_streamed_segment(head)
        .map_err(SessionTranscriptError::Sink)?;
    for piece in &unloaded.pieces {
        let streamed = pages.stream_body(piece, |frame| {
            Ok(match sink.body_frame(frame) {
                Ok(()) => ControlFlow::Continue(()),
                Err(refused) => ControlFlow::Break(refused),
            })
        });
        match streamed {
            Ok(ControlFlow::Continue(())) => {}
            Ok(ControlFlow::Break(refused)) => {
                return Err(SessionTranscriptError::Sink(refused));
            }
            Err(BodyStreamError::Read(refused)) => {
                return Err(SessionLogReadError::from(refused).into());
            }
            Err(BodyStreamError::OutOfMemory) => {
                return Err(SessionLogReadError::from(out_of_memory_read_failure()).into());
            }
            Err(damaged @ (BodyStreamError::Damaged(_) | BodyStreamError::Write(_))) => {
                let malformed = malformed_body(&unloaded.event, damaged);
                return Err(SessionLogReadError::from(malformed).into());
            }
        }
    }
    sink.close_streamed_segment()
        .map_err(SessionTranscriptError::Sink)
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::convert::Infallible;
    use std::io;
    use std::ops::ControlFlow;

    use serde_json::json;
    use sidekicks_contracts::event::envelope::EventEnvelope;
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::run::queued::AgentRunQueuedPayload;
    use sidekicks_contracts::session::event_cursor::START_OF_LOG_POSITION;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_store::events::content::codec::{BodyStreamError, StoredBodyPlace};
    use sidekicks_store::events::session::read::tool_call_closes::ToolCallCloses;
    use sidekicks_store::events::session::read::{
        HYDRATED_PAGE_TEXT_BYTES, HydratedPage, SessionEventReads, SessionLogReadError,
    };
    use sidekicks_store::events::test_log::{AT, SessionTestLog};

    use super::{SessionLogPages, SessionTranscriptSink, TranscriptPageSource, walk_session};
    use crate::driver::schema::schema_parts;
    use crate::hand_over::canonical_transcript::{
        CanonicalToolResultOutcome, CanonicalToolResultProvenance, CanonicalTranscriptRole,
        CanonicalTranscriptSegment,
    };

    /// The log's pages, counting each run page read, so a piece can be stamped with the page it
    /// was handed on under.
    struct CountedPages<'pages, Pages> {
        pages: Pages,
        pages_read: &'pages Cell<usize>,
    }

    impl<Pages: TranscriptPageSource> TranscriptPageSource for CountedPages<'_, Pages> {
        fn read_next_run(
            &self,
            session_id: &SessionId,
            after_position: i64,
        ) -> Result<Option<EventEnvelope>, SessionLogReadError> {
            self.pages.read_next_run(session_id, after_position)
        }

        fn read_run_page(
            &self,
            session_id: &SessionId,
            run_id: &RunId,
            after_position: i64,
        ) -> Result<HydratedPage, SessionLogReadError> {
            self.pages_read.set(self.pages_read.get() + 1);
            self.pages.read_run_page(session_id, run_id, after_position)
        }

        fn read_run_tool_call_closes(
            &self,
            session_id: &SessionId,
            run_id: &RunId,
        ) -> Result<Vec<ToolCallCloses>, SessionLogReadError> {
            self.pages.read_run_tool_call_closes(session_id, run_id)
        }

        fn read_run_close(
            &self,
            session_id: &SessionId,
            run_id: &RunId,
            sequence: i64,
        ) -> Result<HydratedPage, SessionLogReadError> {
            self.pages.read_run_close(session_id, run_id, sequence)
        }

        fn stream_body<Stop>(
            &self,
            place: &StoredBodyPlace,
            each: impl FnMut(&str) -> io::Result<ControlFlow<Stop>>,
        ) -> Result<ControlFlow<Stop>, BodyStreamError> {
            self.pages.stream_body(place, each)
        }
    }

    /// What the sink was handed.
    #[derive(Debug, PartialEq, Eq)]
    enum Piece {
        /// A run, by its number and its parent run where it is a helper.
        Run(u64, Option<RunId>),
        Turn(CanonicalTranscriptRole),
        Segment(CanonicalTranscriptSegment),
        /// A streamed segment's head.
        Streamed(CanonicalTranscriptSegment),
        /// A streamed segment's end.
        StreamedEnd,
    }

    /// Records each piece with the count of run pages read when it was handed on, and a streamed
    /// body's text and frame count apart.
    struct RecordingSink<'pages> {
        pages_read: &'pages Cell<usize>,
        pieces: Vec<(usize, Piece)>,
        streamed_body: String,
        streamed_frames: usize,
    }

    impl RecordingSink<'_> {
        fn record(&mut self, piece: Piece) {
            self.pieces.push((self.pages_read.get(), piece));
        }
    }

    impl SessionTranscriptSink for RecordingSink<'_> {
        type Error = Infallible;

        fn open_run(
            &mut self,
            number: u64,
            queued: &AgentRunQueuedPayload,
        ) -> Result<(), Infallible> {
            self.record(Piece::Run(number, queued.parent_run_id()));
            Ok(())
        }

        fn open_turn(&mut self, role: CanonicalTranscriptRole) -> Result<(), Infallible> {
            self.record(Piece::Turn(role));
            Ok(())
        }

        fn segment(&mut self, segment: CanonicalTranscriptSegment) -> Result<(), Infallible> {
            self.record(Piece::Segment(segment));
            Ok(())
        }

        fn open_streamed_segment(
            &mut self,
            head: CanonicalTranscriptSegment,
        ) -> Result<(), Infallible> {
            self.record(Piece::Streamed(head));
            Ok(())
        }

        fn body_frame(&mut self, frame: &str) -> Result<(), Infallible> {
            self.streamed_frames += 1;
            self.streamed_body.push_str(frame);
            Ok(())
        }

        fn close_streamed_segment(&mut self) -> Result<(), Infallible> {
            self.record(Piece::StreamedEnd);
            Ok(())
        }
    }

    fn run_queued(log: &SessionTestLog, run_id: RunId, parent_run_id: Option<RunId>) {
        let mut payload = json!({
            "sessionId": log.session_id,
            "runId": run_id,
            "runVersion": 0,
            "newState": "queued",
            "agentId": mint_uuid_v7().to_string(),
            "admittedProviderAccountId": "account-1",
        });
        if let Some(parent_run_id) = parent_run_id {
            payload["parentRunId"] = json!(parent_run_id);
            payload["reachedBy"] = json!("providerSubagent");
        }
        log.write(
            json!({ "type": "agent.run.queued", "payload": payload }),
            None,
        );
    }

    fn position(sequence: i64) -> u64 {
        u64::try_from(sequence).expect("a sequence is not negative")
    }

    fn text(sequence: i64, text: &str) -> CanonicalTranscriptSegment {
        CanonicalTranscriptSegment::Text {
            position: position(sequence),
            text: text.to_owned(),
            is_content_unavailable: false,
            queue_item_id: None,
        }
    }

    // Killed by a walk that reads only the session's first run, and by one that reads a run's
    // pages, or the session's, before handing any piece on, or loads an oversized body whole.
    #[test]
    fn every_run_is_handed_on_in_log_order_a_page_at_a_time() {
        let log = SessionTestLog::new(schema_parts());
        let lead = log.run_id;
        let helper = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        run_queued(&log, lead, None);
        let (asked, _) = log.write(
            json!({
                "type": "user.message.sent",
                "payload": {
                    "sessionId": log.session_id,
                    "runId": lead,
                    "actor": "person",
                    "message": "Plan the change",
                },
            }),
            None,
        );
        let (planning, _) = log.piece("agent.message.sent", lead, "m1", None, "Planning.", AT);
        run_queued(&log, helper, Some(lead));
        let (call, _) = log.write(
            json!({
                "type": "agent.toolCall.invoked",
                "payload": {
                    "sessionId": log.session_id,
                    "runId": helper,
                    "toolName": "read",
                    "toolCallId": "call-1",
                },
            }),
            Some(r#"{"path":"a.rs"}"#),
        );
        // A result longer than a page's text, logged before the lead's last reply.
        let result_body = "0123456789abcdef".repeat(
            usize::try_from(HYDRATED_PAGE_TEXT_BYTES).expect("a page's text fits") / 16 + 1024,
        );
        let (result, _) = log.tool_completion(helper, "call-1", None, Some(&result_body));
        let (done, _) = log.piece("agent.message.sent", lead, "m2", None, "Done.", AT);

        let reader = log.reader();
        let reads = SessionEventReads::new(&reader, |_: &SessionId| None);
        let pages_read = Cell::new(0);
        let pages = CountedPages {
            pages: SessionLogPages {
                reads: &reads,
                connection: &reader,
            },
            pages_read: &pages_read,
        };
        let mut sink = RecordingSink {
            pages_read: &pages_read,
            pieces: Vec::new(),
            streamed_body: String::new(),
            streamed_frames: 0,
        };
        walk_session(&pages, &log.session_id, START_OF_LOG_POSITION, &mut sink)
            .expect("the session's transcript reads");

        assert!(
            sink.streamed_frames > 1,
            "the oversized body comes a frame at a time"
        );
        assert_eq!(sink.streamed_body, result_body);
        // The lead's run reads its one page and an empty one; the helper's reads the call's page,
        // then the oversized result's, then an empty one.
        assert_eq!(
            sink.pieces,
            [
                (1, Piece::Run(1, None)),
                (1, Piece::Turn(CanonicalTranscriptRole::User)),
                (1, Piece::Segment(text(asked, "Plan the change"))),
                (1, Piece::Turn(CanonicalTranscriptRole::Assistant)),
                (1, Piece::Segment(text(planning, "Planning."))),
                (1, Piece::Segment(text(done, "Done."))),
                (3, Piece::Run(2, Some(lead))),
                (3, Piece::Turn(CanonicalTranscriptRole::Assistant)),
                (
                    3,
                    Piece::Segment(CanonicalTranscriptSegment::ToolCall {
                        position: position(call),
                        tool_call_id: "call-1".to_owned(),
                        tool_name: "read".to_owned(),
                        arguments_json: r#"{"path":"a.rs"}"#.to_owned(),
                        is_content_unavailable: false,
                    })
                ),
                (
                    4,
                    Piece::Streamed(CanonicalTranscriptSegment::ToolResult {
                        position: position(result),
                        tool_call_id: "call-1".to_owned(),
                        outcome: CanonicalToolResultOutcome::Succeeded,
                        provenance: CanonicalToolResultProvenance::Provider,
                        end_cause: None,
                        text: String::new(),
                        is_content_unavailable: false,
                    })
                ),
                (4, Piece::StreamedEnd),
            ]
        );
        assert_eq!(pages_read.get(), 5);
    }

    // Killed by the stream left in log order, which hands on the stand-in and both closes as
    // three results.
    #[test]
    fn the_transcript_file_folds_a_held_call_as_the_brief_does() {
        let log = SessionTestLog::new(schema_parts());
        run_queued(&log, log.run_id, None);
        let invoked = log.tool_row("agent.toolCall.invoked", "call-1", &json!({}), Some("{}"));
        log.tool_row(
            "agent.toolCall.backgrounded",
            "call-1",
            &json!({ "taskId": "t1", "survivesRestart": false }),
            Some("Moved to the background as task t1"),
        );
        let failed = log.tool_row(
            "agent.toolCall.failed",
            "call-1",
            &json!({ "endCause": "stopped" }),
            None,
        );
        log.tool_row(
            "agent.toolCall.completed",
            "call-1",
            &json!({}),
            Some("done"),
        );

        let reader = log.reader();
        let reads = SessionEventReads::new(&reader, |_: &SessionId| None);
        let pages_read = Cell::new(0);
        let pages = CountedPages {
            pages: SessionLogPages {
                reads: &reads,
                connection: &reader,
            },
            pages_read: &pages_read,
        };
        let mut sink = RecordingSink {
            pages_read: &pages_read,
            pieces: Vec::new(),
            streamed_body: String::new(),
            streamed_frames: 0,
        };
        walk_session(&pages, &log.session_id, START_OF_LOG_POSITION, &mut sink)
            .expect("the session's transcript reads");

        let pieces: Vec<Piece> = sink.pieces.into_iter().map(|(_, piece)| piece).collect();
        assert_eq!(
            pieces,
            [
                Piece::Run(1, None),
                Piece::Turn(CanonicalTranscriptRole::Assistant),
                Piece::Segment(CanonicalTranscriptSegment::ToolCall {
                    position: position(invoked),
                    tool_call_id: "call-1".to_owned(),
                    tool_name: "bash".to_owned(),
                    arguments_json: "{}".to_owned(),
                    is_content_unavailable: false,
                }),
                Piece::Segment(CanonicalTranscriptSegment::ToolResult {
                    position: position(failed),
                    tool_call_id: "call-1".to_owned(),
                    outcome: CanonicalToolResultOutcome::Succeeded,
                    provenance: CanonicalToolResultProvenance::Provider,
                    end_cause: None,
                    text: "done".to_owned(),
                    is_content_unavailable: false,
                }),
            ]
        );
    }
}
