//! The canonical transcript: one run's conversation as ordered turns, folded from the session log
//! on every call and kept nowhere, so it cannot disagree with the log.
//!
//! - The log gives order, roles and pairing: each row's sequence, type, tool name and tool call
//!   id. The person's words are the `user.message.sent` payload's own `message`; every body the
//!   agent wrote (its replies, its reasoning, a tool call's arguments, a tool's result) is the
//!   row's stored body.
//! - Logged reasoning is the provider's summary, which the person already saw, so it is carried as
//!   plain text.
//! - A row whose body cannot be read keeps its place as an empty segment marked unavailable, never
//!   dropped and never invented, so the hand-over can declare the loss.
#![cfg_attr(
    not(test),
    expect(dead_code, reason = "the provider switch's hand-over brief")
)]

use serde::de::DeserializeOwned;
use serde_json::{Map, Value};
use sidekicks_contracts::event::declared_variants::ToolActivityPayload;
use sidekicks_contracts::event::envelope::{
    EventEnvelope, HydratedSessionEvent, HydratedSessionEventContent,
};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::UserMessageSentPayload;
use sidekicks_contracts::session::event_cursor::START_OF_LOG_POSITION;
use sidekicks_contracts::session::id::SessionId;

use crate::events::session::read::{SessionEventReads, SessionLogReadError};

/// Who wrote a turn. The transcript has no third author.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CanonicalTranscriptRole {
    /// The person.
    User,
    /// The agent.
    Assistant,
}

/// How a tool call ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CanonicalToolResultOutcome {
    /// The tool returned.
    Succeeded,
    /// The tool failed.
    Failed,
}

impl CanonicalToolResultOutcome {
    /// The outcome's word in a rendered tool line: `succeeded` or `failed`.
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
        }
    }
}

/// Where a tool result came from. A repaired result is a declared loss, so a reader must be able
/// to tell it from the provider's own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CanonicalToolResultProvenance {
    /// The provider reported it.
    Provider,
    /// The pairing repair made it for a call that has no result of its own.
    Repaired,
}

/// One piece of a turn. Every arm carries `position`, the sequence of the row it came from, so a
/// bound can filter on it; a step that moves a segment keeps its position.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CanonicalTranscriptSegment {
    /// Words: the person's or the agent's, or a tool row with no call id rendered as a tool line.
    Text {
        /// The row's sequence.
        position: u64,
        /// The words; empty when `is_content_unavailable`.
        text: String,
        /// Whether the row's body could not be read; the hand-over owes the matching loss.
        is_content_unavailable: bool,
    },
    /// The provider's summary of its reasoning.
    Reasoning {
        /// The row's sequence.
        position: u64,
        /// The summary.
        text: String,
    },
    /// A tool call with its call id.
    ToolCall {
        /// The row's sequence.
        position: u64,
        /// The provider's id of the call, which pairs it with its result.
        tool_call_id: String,
        /// The tool's name.
        tool_name: String,
        /// The arguments as the provider serialized them, since re-encoding them would change
        /// bytes the target may hash or echo; empty when `is_content_unavailable`.
        arguments_json: String,
        /// Whether the arguments could not be read; the call is kept for its id.
        is_content_unavailable: bool,
    },
    /// A tool result with its call id.
    ToolResult {
        /// The row's sequence.
        position: u64,
        /// The id of the call it answers.
        tool_call_id: String,
        /// How the call ended.
        outcome: CanonicalToolResultOutcome,
        /// Where the result came from.
        provenance: CanonicalToolResultProvenance,
        /// The result's body; empty when `is_content_unavailable`.
        text: String,
        /// Whether the body could not be read.
        is_content_unavailable: bool,
    },
}

/// One turn: one author's consecutive rows, up to the next change of author or turn start.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CanonicalTranscriptTurn {
    /// The sequence of the row that opened the turn. Later rows folded into the turn keep their
    /// own, higher positions on their segments, so this bounds nothing.
    pub(crate) position: u64,
    /// Who wrote it.
    pub(crate) role: CanonicalTranscriptRole,
    /// Its pieces, in log order; never empty.
    pub(crate) segments: Vec<CanonicalTranscriptSegment>,
}

/// One run's transcript as the fold built it; it never crosses a wire and is never stored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CanonicalTranscriptProjection {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The run.
    pub(crate) run_id: RunId,
    /// The session's head when the fold was taken, 0 for an empty log: a fold taken after an
    /// append anywhere in the session has a higher one.
    pub(crate) built_at_position: u64,
    /// The turns, in log order.
    pub(crate) turns: Vec<CanonicalTranscriptTurn>,
}

/// The bound a fold is taken under. Not an optional position, so a caller that forgets to pass
/// its bound is refused by the compiler rather than handing over the whole conversation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TranscriptExportBound {
    /// The whole run.
    Unbounded,
    /// Only the rows at or below this session position.
    AtOrBelow(u64),
}

impl TranscriptExportBound {
    /// The sequence a bounded read stops before, `None` when every row is read.
    fn before_sequence(self) -> Option<i64> {
        match self {
            Self::Unbounded => None,
            Self::AtOrBelow(position) => i64::try_from(position)
                .ok()
                .and_then(|position| position.checked_add(1)),
        }
    }
}

/// Why a run's transcript could not be folded.
#[derive(Debug, thiserror::Error)]
pub(crate) enum CanonicalTranscriptFoldError {
    /// The session log could not be read.
    #[error(transparent)]
    Read(#[from] SessionLogReadError),
    /// A row's payload does not read as its type's, which only a write outside the append path
    /// can leave.
    #[error(
        "the transcript event at sequence {sequence} does not read as its type's payload, so it \
         was written outside the append path"
    )]
    Payload {
        /// The row's sequence.
        sequence: u64,
        /// Why the payload was refused.
        #[source]
        cause: serde_json::Error,
    },
}

/// Folds run `run_id`'s transcript under `bound` from the session log. It reads only the run's
/// rows of the seven transcript types, at or below the bound, and then the session's head; nothing
/// is kept between calls. Fails when the log cannot be read or a row's payload is not its type's.
pub(crate) fn fold_canonical_transcript<DamagedFrom>(
    reads: &SessionEventReads<'_, DamagedFrom>,
    session_id: &SessionId,
    run_id: &RunId,
    bound: TranscriptExportBound,
) -> Result<CanonicalTranscriptProjection, CanonicalTranscriptFoldError>
where
    DamagedFrom: Fn(&SessionId) -> Option<i64>,
{
    // Rows past the bound would only add segments the bound drops, so the read stops at it.
    let events = reads.read_after_hydrated(
        session_id,
        run_id,
        START_OF_LOG_POSITION,
        TRANSCRIPT_EVENT_TYPES.as_slice(),
        bound.before_sequence(),
    )?;
    // Read after the rows, so the head is at or past every row the fold holds.
    let built_at_position = reads.read_head(session_id)?.map_or(0, |head| {
        u64::try_from(head).expect("a session's read head is never negative")
    });
    let mut fold = TurnFold::default();
    for event in events {
        fold.add(event)?;
    }
    Ok(CanonicalTranscriptProjection {
        session_id: *session_id,
        run_id: *run_id,
        built_at_position,
        turns: fold.into_turns(),
    })
}

/// The event types that add to a transcript. A turn start adds no segment, but it is what keeps
/// two agent turns in a row apart.
#[derive(Clone, Copy)]
enum TranscriptEventKind {
    TurnStarted,
    UserMessage,
    AgentMessage,
    AgentThinking,
    ToolCallInvoked,
    ToolCallCompleted,
    ToolCallFailed,
}

impl TranscriptEventKind {
    const ALL: [Self; 7] = [
        Self::TurnStarted,
        Self::UserMessage,
        Self::AgentMessage,
        Self::AgentThinking,
        Self::ToolCallInvoked,
        Self::ToolCallCompleted,
        Self::ToolCallFailed,
    ];

    const fn event_type(self) -> SessionEventType {
        match self {
            Self::TurnStarted => SessionEventType::AgentTurnStarted,
            Self::UserMessage => SessionEventType::UserMessageSent,
            Self::AgentMessage => SessionEventType::AgentMessageSent,
            Self::AgentThinking => SessionEventType::AgentThinkingUpdated,
            Self::ToolCallInvoked => SessionEventType::AgentToolCallInvoked,
            Self::ToolCallCompleted => SessionEventType::AgentToolCallCompleted,
            Self::ToolCallFailed => SessionEventType::AgentToolCallFailed,
        }
    }

    fn of(event_type: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|kind| kind.event_type().as_str() == event_type)
    }
}

/// The wire names of [`TranscriptEventKind::ALL`], the types the fold's read takes.
const TRANSCRIPT_EVENT_TYPES: [&str; TranscriptEventKind::ALL.len()] = {
    let mut names = [""; TranscriptEventKind::ALL.len()];
    let mut index = 0;
    while index < names.len() {
        names[index] = TranscriptEventKind::ALL[index].event_type().as_str();
        index += 1;
    }
    names
};

/// The turns folded so far and the one still open.
#[derive(Default)]
struct TurnFold {
    turns: Vec<CanonicalTranscriptTurn>,
    open_turn: Option<CanonicalTranscriptTurn>,
}

impl TurnFold {
    /// Folds one row of the run into the open turn, or closes it.
    fn add(&mut self, event: HydratedSessionEvent) -> Result<(), CanonicalTranscriptFoldError> {
        let HydratedSessionEvent {
            event:
                EventEnvelope {
                    sequence,
                    event_type,
                    payload,
                    ..
                },
            content,
        } = event;
        let position = sequence.get();
        let kind = TranscriptEventKind::of(event_type.as_str())
            .expect("the fold's read takes only the transcript's event types");
        match kind {
            TranscriptEventKind::TurnStarted => self.close_open_turn(),
            TranscriptEventKind::UserMessage => {
                let message = read_payload::<UserMessageSentPayload>(position, payload)?
                    .message
                    .into_string();
                let segment = (!message.is_empty()).then(|| text_segment(position, message));
                self.append(CanonicalTranscriptRole::User, position, segment);
            }
            TranscriptEventKind::AgentMessage => {
                let segment =
                    written_segment(position, content, |text| text_segment(position, text));
                self.append(CanonicalTranscriptRole::Assistant, position, segment);
            }
            TranscriptEventKind::AgentThinking => {
                let segment = written_segment(position, content, |text| {
                    CanonicalTranscriptSegment::Reasoning { position, text }
                });
                self.append(CanonicalTranscriptRole::Assistant, position, segment);
            }
            TranscriptEventKind::ToolCallInvoked => {
                let tool = read_payload::<ToolActivityPayload>(position, payload)?;
                let segment = tool_call_segment(position, tool, content);
                self.append(CanonicalTranscriptRole::Assistant, position, Some(segment));
            }
            TranscriptEventKind::ToolCallCompleted => {
                let outcome = CanonicalToolResultOutcome::Succeeded;
                self.append_tool_result(position, payload, outcome, content)?;
            }
            TranscriptEventKind::ToolCallFailed => {
                let outcome = CanonicalToolResultOutcome::Failed;
                self.append_tool_result(position, payload, outcome, content)?;
            }
        }
        Ok(())
    }

    fn append_tool_result(
        &mut self,
        position: u64,
        payload: Map<String, Value>,
        outcome: CanonicalToolResultOutcome,
        content: HydratedSessionEventContent,
    ) -> Result<(), CanonicalTranscriptFoldError> {
        let tool = read_payload::<ToolActivityPayload>(position, payload)?;
        let segment = tool_result_segment(position, tool, outcome, content);
        self.append(CanonicalTranscriptRole::Assistant, position, Some(segment));
        Ok(())
    }

    /// Adds `segment` to the open turn, opening one at `position` when none is open. A change of
    /// author closes the open turn even when the row adds nothing: an empty row is still a turn
    /// boundary, so the agent turns on either side of an empty message stay two turns.
    fn append(
        &mut self,
        role: CanonicalTranscriptRole,
        position: u64,
        segment: Option<CanonicalTranscriptSegment>,
    ) {
        if self
            .open_turn
            .as_ref()
            .is_some_and(|turn| turn.role != role)
        {
            self.close_open_turn();
        }
        let Some(segment) = segment else {
            return;
        };
        self.open_turn
            .get_or_insert_with(|| CanonicalTranscriptTurn {
                position,
                role,
                segments: Vec::new(),
            })
            .segments
            .push(segment);
    }

    fn close_open_turn(&mut self) {
        self.turns.extend(self.open_turn.take());
    }

    fn into_turns(mut self) -> Vec<CanonicalTranscriptTurn> {
        self.close_open_turn();
        self.turns
    }
}

/// `payload` read as its type's, `sequence` naming the row when it does not read.
fn read_payload<Payload: DeserializeOwned>(
    sequence: u64,
    payload: Map<String, Value>,
) -> Result<Payload, CanonicalTranscriptFoldError> {
    serde_json::from_value(Value::Object(payload))
        .map_err(|cause| CanonicalTranscriptFoldError::Payload { sequence, cause })
}

/// The row's stored body, `None` when it cannot be read. A cut body is taken as stored.
fn body_of(content: HydratedSessionEventContent) -> Option<String> {
    match content {
        HydratedSessionEventContent::Available { body, .. } => Some(body),
        HydratedSessionEventContent::Unavailable { .. } => None,
    }
}

fn text_segment(position: u64, text: String) -> CanonicalTranscriptSegment {
    CanonicalTranscriptSegment::Text {
        position,
        text,
        is_content_unavailable: false,
    }
}

fn unavailable_text_segment(position: u64) -> CanonicalTranscriptSegment {
    CanonicalTranscriptSegment::Text {
        position,
        text: String::new(),
        is_content_unavailable: true,
    }
}

/// The segment of a row whose body the agent wrote: none for an empty body, an empty text marked
/// unavailable for one that cannot be read, else `into_segment` of the body.
fn written_segment(
    position: u64,
    content: HydratedSessionEventContent,
    into_segment: impl FnOnce(String) -> CanonicalTranscriptSegment,
) -> Option<CanonicalTranscriptSegment> {
    match body_of(content) {
        None => Some(unavailable_text_segment(position)),
        Some(body) => (!body.is_empty()).then(|| into_segment(body)),
    }
}

/// A tool call's segment. A call with no call id cannot pair with a result, so it is carried as a
/// tool line of text rather than dropped; an id is never made up for it.
fn tool_call_segment(
    position: u64,
    tool: ToolActivityPayload,
    content: HydratedSessionEventContent,
) -> CanonicalTranscriptSegment {
    let arguments_json = body_of(content);
    let Some(tool_call_id) = tool.tool_call_id else {
        return arguments_json.map_or_else(
            || unavailable_text_segment(position),
            |arguments_json| {
                let heading = format!("[tool call {}]", tool.tool_name.as_str());
                text_segment(position, tool_line(heading, &arguments_json))
            },
        );
    };
    CanonicalTranscriptSegment::ToolCall {
        position,
        tool_call_id: tool_call_id.into_string(),
        tool_name: tool.tool_name.into_string(),
        is_content_unavailable: arguments_json.is_none(),
        arguments_json: arguments_json.unwrap_or_default(),
    }
}

/// A tool result's segment; one with no call id is carried as a tool line, as a call is.
fn tool_result_segment(
    position: u64,
    tool: ToolActivityPayload,
    outcome: CanonicalToolResultOutcome,
    content: HydratedSessionEventContent,
) -> CanonicalTranscriptSegment {
    let body = body_of(content);
    let Some(tool_call_id) = tool.tool_call_id else {
        return body.map_or_else(
            || unavailable_text_segment(position),
            |body| {
                let heading = format!("[tool result {}]", outcome.as_str());
                text_segment(position, tool_line(heading, &body))
            },
        );
    };
    CanonicalTranscriptSegment::ToolResult {
        position,
        tool_call_id: tool_call_id.into_string(),
        outcome,
        provenance: CanonicalToolResultProvenance::Provider,
        is_content_unavailable: body.is_none(),
        text: body.unwrap_or_default(),
    }
}

/// A tool row with no call id as visible text, its heading then its body, so it reads as a tool
/// line and never as words the agent wrote.
fn tool_line(mut heading: String, body: &str) -> String {
    if !body.is_empty() {
        heading.push(' ');
        heading.push_str(body);
    }
    heading
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use rusqlite::Connection;
    use serde_json::json;
    use sidekicks_contracts::event::session::SessionEvent;
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::session::id::SessionId;

    use super::{
        CanonicalToolResultOutcome, CanonicalToolResultProvenance, CanonicalTranscriptRole,
        CanonicalTranscriptSegment, CanonicalTranscriptTurn, TranscriptExportBound,
        fold_canonical_transcript,
    };
    use crate::database::writer::test_file::{TestDatabase, test_envelope, test_session_id};
    use crate::events::content::codec::BodyEncoder;
    use crate::events::session::insert::{SessionEventRow, insert_session_event, monotonic_ns_now};
    use crate::events::session::read::SessionEventReads;
    use crate::transcript::test_log::TranscriptTestLog;
    use sidekicks_contracts::wire::id::mint_uuid_v7;

    /// Appends `event` to `session_id`'s log through the row write, with `body` as its stored
    /// body.
    fn append(
        writer: &Connection,
        session_id: &SessionId,
        event: serde_json::Value,
        body: Option<&str>,
    ) {
        let event: SessionEvent =
            serde_json::from_value(event).expect("the test writes a well-formed event");
        let mut envelope = test_envelope(*session_id, &event);
        let content_payload = body.map(|body| {
            envelope
                .describe_content(body.to_owned())
                .expect("the event carries a body")
        });
        let row = SessionEventRow {
            payload: serde_json::to_string(envelope.payload()).expect("a JSON object serializes"),
            envelope: Arc::new(envelope),
            monotonic_ns: monotonic_ns_now(),
            content_payload,
        };
        insert_session_event(writer, &mut BodyEncoder::new(), &row)
            .expect("the test writes its row");
    }

    #[test]
    fn a_turn_whose_body_cannot_be_read_keeps_its_place_and_another_run_stays_out() {
        let database = TestDatabase::new();
        let writer = database.opener()().expect("the test creates its database");
        let session_id = test_session_id();
        let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        let agent_message = json!({
            "type": "agent.message.sent",
            "payload": { "sessionId": session_id, "runId": run_id, "providerMessageId": "m" },
        });
        let user_message = json!({
            "type": "user.message.sent",
            "payload": {
                "sessionId": session_id,
                "runId": run_id,
                "actor": "person",
                "message": "Fix the build",
            },
        });
        let turn_ended = json!({
            "type": "agent.turn.completed",
            "payload": {
                "sessionId": session_id,
                "runId": run_id,
                "runVersion": 1,
                "turnNumber": 1,
            },
        });
        let turn_started = json!({
            "type": "agent.turn.started",
            "payload": {
                "sessionId": session_id,
                "runId": run_id,
                "runVersion": 1,
                "turnNumber": 2,
            },
        });
        append(&writer, &session_id, user_message, None);
        append(
            &writer,
            &session_id,
            agent_message.clone(),
            Some("Looking."),
        );
        append(&writer, &session_id, turn_ended, None);
        append(&writer, &session_id, turn_started, None);
        append(&writer, &session_id, agent_message, None);
        // Another run's message in the same session stays out of this run's transcript.
        let other_run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        let other_run_message = json!({
            "type": "user.message.sent",
            "payload": {
                "sessionId": session_id,
                "runId": other_run_id,
                "actor": "person",
                "message": "Another run",
            },
        });
        append(&writer, &session_id, other_run_message, None);

        let reader = database.reader();
        let reads = SessionEventReads::new(&reader, |_: &SessionId| None);
        let projection = fold_canonical_transcript(
            &reads,
            &session_id,
            &run_id,
            TranscriptExportBound::AtOrBelow(5),
        )
        .expect("the run's transcript folds");

        let text =
            |position, text: &str, is_content_unavailable| CanonicalTranscriptSegment::Text {
                position,
                text: text.to_owned(),
                is_content_unavailable,
            };
        assert_eq!(projection.built_at_position, 5);
        assert_eq!(
            projection.turns,
            [
                CanonicalTranscriptTurn {
                    position: 0,
                    role: CanonicalTranscriptRole::User,
                    segments: vec![text(0, "Fix the build", false)],
                },
                CanonicalTranscriptTurn {
                    position: 1,
                    role: CanonicalTranscriptRole::Assistant,
                    segments: vec![text(1, "Looking.", false)],
                },
                CanonicalTranscriptTurn {
                    position: 4,
                    role: CanonicalTranscriptRole::Assistant,
                    segments: vec![text(4, "", true)],
                },
            ]
        );
    }

    // Killed by a reply's pieces or a completion's patched files folded as rows of their own,
    // which would hand a provider a reply cut where the wire cut it or a result once per file.
    #[test]
    fn a_row_stored_in_pieces_folds_as_one_segment_with_its_whole_body() {
        let log = TranscriptTestLog::new();
        let (reply, _) = log.reply("m1", Some(0), "Hello, ");
        log.reply("m1", Some(0), "world.");
        let files = json!([
            { "path": "/repo/a.rs", "unavailable": "absent" },
            { "path": "/repo/b.rs", "unavailable": "absent" },
        ]);
        let body = json!({ "files": files }).to_string();
        let (completion, _) = log.tool_completion(
            log.run_id,
            "call-1",
            Some(json!([{ "path": "/repo/a.rs", "size": 0 }, { "path": "/repo/b.rs", "size": 0 }])),
            Some(&body),
        );

        let reader = log.reader();
        let reads = SessionEventReads::new(&reader, |_: &SessionId| None);
        let projection = fold_canonical_transcript(
            &reads,
            &log.session_id,
            &log.run_id,
            TranscriptExportBound::Unbounded,
        )
        .expect("the run's transcript folds");

        let position = |sequence: i64| u64::try_from(sequence).expect("a sequence is not negative");
        assert_eq!(
            projection.turns,
            [CanonicalTranscriptTurn {
                position: position(reply),
                role: CanonicalTranscriptRole::Assistant,
                segments: vec![
                    CanonicalTranscriptSegment::Text {
                        position: position(reply),
                        text: "Hello, world.".to_owned(),
                        is_content_unavailable: false,
                    },
                    CanonicalTranscriptSegment::ToolResult {
                        position: position(completion),
                        tool_call_id: "call-1".to_owned(),
                        outcome: CanonicalToolResultOutcome::Succeeded,
                        provenance: CanonicalToolResultProvenance::Provider,
                        text: body,
                        is_content_unavailable: false,
                    },
                ],
            }]
        );
    }
}
