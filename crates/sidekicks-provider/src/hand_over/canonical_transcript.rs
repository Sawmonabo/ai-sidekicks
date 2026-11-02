//! The canonical transcript: a run's conversation as ordered turns, folded from the session log
//! on every call and kept nowhere, so it cannot disagree with the log. The fold hands each turn
//! opening and segment on as it reads, so a reader may hold the whole run or none of it.
//!
//! - The log gives order, roles and pairing: each row's sequence, type, tool name and tool call
//!   id. The person's words are the `user.message.sent` payload's own `message`; every body the
//!   agent wrote (its replies, its reasoning, a tool call's arguments, a tool's result) is the
//!   row's stored body.
//! - Logged reasoning is the provider's summary, which the person already saw, so it is carried as
//!   plain text.
//! - A row whose body cannot be read keeps its place as an empty segment marked unavailable, never
//!   dropped and never invented, so the hand-over can declare the loss.
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};
use sidekicks_contracts::event::declared_variants::ToolActivityPayload;
use sidekicks_contracts::event::envelope::{
    EventEnvelope, HydratedSessionEvent, HydratedSessionEventContent,
};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::{QueueItemId, UserMessageSentPayload};
use sidekicks_contracts::session::event_cursor::START_OF_LOG_POSITION;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_store::events::session::read::{SessionEventReads, SessionLogReadError};

/// Who wrote a turn. The transcript has no third author.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CanonicalTranscriptRole {
    /// The person.
    User,
    /// The agent.
    Assistant,
}

/// How a tool call ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CanonicalToolResultOutcome {
    /// The tool returned.
    Succeeded,
    /// The tool failed.
    Failed,
}

impl CanonicalToolResultOutcome {
    /// The outcome's word in a rendered tool line: `succeeded` or `failed`.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
        }
    }
}

/// Where a tool result came from. A repaired result is a declared loss, so a reader must be able
/// to tell it from the provider's own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CanonicalToolResultProvenance {
    /// The provider reported it.
    Provider,
    /// The pairing repair made it for a call that has no result of its own.
    Repaired,
}

/// One piece of a turn. Every arm carries `position`, the sequence of the row it came from, so a
/// bound can filter on it; a step that moves a segment keeps its position.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CanonicalTranscriptSegment {
    /// Words: the person's or the agent's, or a tool row with no call id rendered as a tool line.
    Text {
        /// The row's sequence.
        position: u64,
        /// The words; empty when `is_content_unavailable`.
        text: String,
        /// Whether the row's body could not be read; the hand-over owes the matching loss.
        is_content_unavailable: bool,
        /// The queued item a person's message was sent as, where it went through the queue, so
        /// its files can be named; `None` on every other segment.
        queue_item_id: Option<QueueItemId>,
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
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the provider switch's hand-over brief")
)]
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
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the provider switch's hand-over brief")
)]
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
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the provider switch's hand-over brief")
)]
pub(crate) enum TranscriptExportBound {
    /// The whole run.
    Unbounded,
    /// Only the rows at or below this session position.
    AtOrBelow(u64),
}

#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the provider switch's hand-over brief")
)]
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
pub enum CanonicalTranscriptFoldError {
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
/// rows of the seven transcript types, at or below the bound, and then the session's head, all in
/// one read transaction; nothing is kept between calls. Fails when the log cannot be read or a
/// row's payload is not its type's.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the provider switch's hand-over brief")
)]
pub(crate) fn fold_canonical_transcript<DamagedFrom>(
    reads: &SessionEventReads<'_, DamagedFrom>,
    session_id: &SessionId,
    run_id: &RunId,
    bound: TranscriptExportBound,
) -> Result<CanonicalTranscriptProjection, CanonicalTranscriptFoldError>
where
    DamagedFrom: Fn(&SessionId) -> Option<i64>,
{
    // One snapshot from the first page to the head, so a body a page names is still there when
    // it is read and the head is the one the rows were read under.
    let snapshot = reads.snapshot().map_err(SessionLogReadError::from)?;
    let mut fold = TurnFold::default();
    let mut turns: Vec<CanonicalTranscriptTurn> = Vec::new();
    let mut collect = |step| {
        match step {
            TurnFoldStep::TurnOpened { role, position } => turns.push(CanonicalTranscriptTurn {
                position,
                role,
                segments: Vec::new(),
            }),
            TurnFoldStep::Segment(segment) => turns
                .last_mut()
                .expect("the fold opens a turn before its first segment")
                .segments
                .push(segment),
        }
        Ok::<_, CanonicalTranscriptFoldError>(())
    };
    let mut after_position = START_OF_LOG_POSITION;
    // Rows past the bound would only add segments the bound drops, so the read stops at it. Each
    // page is folded before the next is read, so only the turns hold every row's text.
    loop {
        let page = reads.read_run_page_hydrated(
            session_id,
            run_id,
            after_position,
            TRANSCRIPT_EVENT_TYPES.as_slice(),
            bound.before_sequence(),
        )?;
        let Some(last) = page.last_sequence() else {
            break;
        };
        after_position = last;
        for event in page.events {
            fold.add(event, &mut collect)?;
        }
        if let Some(unloaded) = page.oversized {
            fold.add(reads.load_body(unloaded)?, &mut collect)?;
        }
    }
    // Read after the rows, so the head is at or past every row the fold holds.
    let built_at_position = reads.read_head(session_id)?.map_or(0, |head| {
        u64::try_from(head).expect("a session's read head is never negative")
    });
    snapshot.commit().map_err(SessionLogReadError::from)?;
    Ok(CanonicalTranscriptProjection {
        session_id: *session_id,
        run_id: *run_id,
        built_at_position,
        turns,
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

    fn of(event_type: &str) -> Self {
        Self::ALL
            .into_iter()
            .find(|kind| kind.event_type().as_str() == event_type)
            .expect("the fold's read takes only the transcript's event types")
    }
}

/// The wire names of [`TranscriptEventKind::ALL`], the types the fold's read takes.
pub(crate) const TRANSCRIPT_EVENT_TYPES: [&str; TranscriptEventKind::ALL.len()] = {
    let mut names = [""; TranscriptEventKind::ALL.len()];
    let mut index = 0;
    while index < names.len() {
        names[index] = TranscriptEventKind::ALL[index].event_type().as_str();
        index += 1;
    }
    names
};

/// What the fold hands on as it reads: a turn opening, then each of its segments, in log order. A
/// turn ends where the next one opens or the run's rows end.
pub(crate) enum TurnFoldStep {
    /// A turn opened at the row at `position`.
    TurnOpened {
        /// Who writes it.
        role: CanonicalTranscriptRole,
        /// The sequence of the row that opened it.
        position: u64,
    },
    /// The open turn's next segment.
    Segment(CanonicalTranscriptSegment),
}

/// One run's turn boundaries as its rows are folded: it holds only the open turn's author, and
/// hands each turn opening and each segment on as its row is read.
#[derive(Default)]
pub(crate) struct TurnFold {
    open_role: Option<CanonicalTranscriptRole>,
}

/// A row's stored body as the fold meets it.
enum RowBody {
    /// Loaded whole.
    Whole(String),
    /// Not readable.
    Unavailable,
    /// Too long to load; its reader hands it on a frame at a time after the segment's head.
    Streamed,
}

impl RowBody {
    fn of(content: HydratedSessionEventContent) -> Self {
        match content {
            HydratedSessionEventContent::Available { body, .. } => Self::Whole(body),
            HydratedSessionEventContent::Unavailable { .. } => Self::Unavailable,
        }
    }

    /// The text a segment starts with: the whole body, empty for one handed on later, `None` for
    /// one that cannot be read.
    fn into_head(self) -> Option<String> {
        match self {
            Self::Whole(body) => Some(body),
            Self::Streamed => Some(String::new()),
            Self::Unavailable => None,
        }
    }
}

/// What one row does to the fold.
enum RowFold {
    /// A turn start: the open turn ends.
    CloseTurn,
    /// A row of `role`, adding `segment` where it has one.
    Append {
        role: CanonicalTranscriptRole,
        segment: Option<CanonicalTranscriptSegment>,
        /// Whether the segment's text is the row's stored body, which a streamed row continues.
        is_body: bool,
    },
}

impl TurnFold {
    /// Folds one row of the run, its body loaded, handing on what it opens and adds. Fails with
    /// what `emit` fails with, or when the row's payload is not its type's.
    pub(crate) fn add<Error>(
        &mut self,
        event: HydratedSessionEvent,
        emit: &mut impl FnMut(TurnFoldStep) -> Result<(), Error>,
    ) -> Result<(), Error>
    where
        Error: From<CanonicalTranscriptFoldError>,
    {
        let HydratedSessionEvent { event, content } = event;
        let position = event.sequence.get();
        let row = read_row(position, &event, RowBody::of(content))?;
        if let Some(segment) = self.enter(row, position, emit)? {
            emit(TurnFoldStep::Segment(segment))?;
        }
        Ok(())
    }

    /// Folds one row whose body is too long to load, handing on the turn it opens. Answers the
    /// segment the body continues, its text the part before the body, for its reader to hand on
    /// with the body's frames; `None` when the row's segment takes no body and was handed on
    /// whole. Fails as [`TurnFold::add`] does.
    pub(crate) fn add_streamed<Error>(
        &mut self,
        event: &EventEnvelope,
        emit: &mut impl FnMut(TurnFoldStep) -> Result<(), Error>,
    ) -> Result<Option<CanonicalTranscriptSegment>, Error>
    where
        Error: From<CanonicalTranscriptFoldError>,
    {
        let position = event.sequence.get();
        let row = read_row(position, event, RowBody::Streamed)?;
        let is_body = matches!(row, RowFold::Append { is_body: true, .. });
        let segment = self.enter(row, position, emit)?;
        if is_body {
            return Ok(segment);
        }
        if let Some(segment) = segment {
            emit(TurnFoldStep::Segment(segment))?;
        }
        Ok(None)
    }

    /// Applies `row` to the turn boundaries: a turn start or a change of author ends the open
    /// turn, even when the row adds nothing, so the agent turns on either side of an empty message
    /// stay two turns; a row with a segment and no open turn opens one at `position`. Answers the
    /// segment to add.
    fn enter<Error>(
        &mut self,
        row: RowFold,
        position: u64,
        emit: &mut impl FnMut(TurnFoldStep) -> Result<(), Error>,
    ) -> Result<Option<CanonicalTranscriptSegment>, Error> {
        let (role, segment) = match row {
            RowFold::CloseTurn => {
                self.open_role = None;
                return Ok(None);
            }
            RowFold::Append { role, segment, .. } => (role, segment),
        };
        if self.open_role.is_some_and(|open_role| open_role != role) {
            self.open_role = None;
        }
        let Some(segment) = segment else {
            return Ok(None);
        };
        if self.open_role.is_none() {
            self.open_role = Some(role);
            emit(TurnFoldStep::TurnOpened { role, position })?;
        }
        Ok(Some(segment))
    }
}

/// What the row at `position` adds, its body `body`. Fails when its payload is not its type's.
fn read_row(
    position: u64,
    event: &EventEnvelope,
    body: RowBody,
) -> Result<RowFold, CanonicalTranscriptFoldError> {
    let assistant = |segment, is_body| RowFold::Append {
        role: CanonicalTranscriptRole::Assistant,
        segment,
        is_body,
    };
    Ok(match TranscriptEventKind::of(event.event_type.as_str()) {
        TranscriptEventKind::TurnStarted => RowFold::CloseTurn,
        TranscriptEventKind::UserMessage => {
            let sent = read_payload::<UserMessageSentPayload>(position, &event.payload)?;
            RowFold::Append {
                role: CanonicalTranscriptRole::User,
                segment: Some(CanonicalTranscriptSegment::Text {
                    position,
                    text: sent.message.into_string(),
                    is_content_unavailable: false,
                    queue_item_id: sent.queue_item_id,
                }),
                is_body: false,
            }
        }
        TranscriptEventKind::AgentMessage => assistant(
            written_segment(position, body, |text| text_segment(position, text)),
            true,
        ),
        TranscriptEventKind::AgentThinking => assistant(
            written_segment(position, body, |text| {
                CanonicalTranscriptSegment::Reasoning { position, text }
            }),
            true,
        ),
        TranscriptEventKind::ToolCallInvoked => {
            let tool = read_payload::<ToolActivityPayload>(position, &event.payload)?;
            assistant(Some(tool_call_segment(position, tool, body)), true)
        }
        TranscriptEventKind::ToolCallCompleted => {
            let tool = read_payload::<ToolActivityPayload>(position, &event.payload)?;
            let outcome = CanonicalToolResultOutcome::Succeeded;
            assistant(
                Some(tool_result_segment(position, tool, outcome, body)),
                true,
            )
        }
        TranscriptEventKind::ToolCallFailed => {
            let tool = read_payload::<ToolActivityPayload>(position, &event.payload)?;
            let outcome = CanonicalToolResultOutcome::Failed;
            assistant(
                Some(tool_result_segment(position, tool, outcome, body)),
                true,
            )
        }
    })
}

/// `payload` read as its type's, `sequence` naming the row when it does not read.
pub(crate) fn read_payload<Payload: DeserializeOwned>(
    sequence: u64,
    payload: &Map<String, Value>,
) -> Result<Payload, CanonicalTranscriptFoldError> {
    Payload::deserialize(payload)
        .map_err(|cause| CanonicalTranscriptFoldError::Payload { sequence, cause })
}

fn text_segment(position: u64, text: String) -> CanonicalTranscriptSegment {
    CanonicalTranscriptSegment::Text {
        position,
        text,
        is_content_unavailable: false,
        queue_item_id: None,
    }
}

fn unavailable_text_segment(position: u64) -> CanonicalTranscriptSegment {
    CanonicalTranscriptSegment::Text {
        position,
        text: String::new(),
        is_content_unavailable: true,
        queue_item_id: None,
    }
}

/// The segment of a row whose body the agent wrote: none for an empty body, an empty text marked
/// unavailable for one that cannot be read, else `into_segment` of the body.
fn written_segment(
    position: u64,
    body: RowBody,
    into_segment: impl FnOnce(String) -> CanonicalTranscriptSegment,
) -> Option<CanonicalTranscriptSegment> {
    match body {
        RowBody::Unavailable => Some(unavailable_text_segment(position)),
        RowBody::Whole(body) => (!body.is_empty()).then(|| into_segment(body)),
        RowBody::Streamed => Some(into_segment(String::new())),
    }
}

/// A tool call's segment. A call with no call id cannot pair with a result, so it is carried as a
/// tool line of text rather than dropped; an id is never made up for it.
fn tool_call_segment(
    position: u64,
    tool: ToolActivityPayload,
    body: RowBody,
) -> CanonicalTranscriptSegment {
    let is_streamed = matches!(body, RowBody::Streamed);
    let arguments_json = body.into_head();
    let Some(tool_call_id) = tool.tool_call_id else {
        return arguments_json.map_or_else(
            || unavailable_text_segment(position),
            |arguments_json| {
                let heading = format!("[tool call {}]", tool.tool_name.as_str());
                text_segment(position, tool_line(heading, &arguments_json, is_streamed))
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
    body: RowBody,
) -> CanonicalTranscriptSegment {
    let is_streamed = matches!(body, RowBody::Streamed);
    let body = body.into_head();
    let Some(tool_call_id) = tool.tool_call_id else {
        return body.map_or_else(
            || unavailable_text_segment(position),
            |body| {
                let heading = format!("[tool result {}]", outcome.as_str());
                text_segment(position, tool_line(heading, &body, is_streamed))
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
/// line and never as words the agent wrote. A body handed on later still takes its separating
/// space.
fn tool_line(mut heading: String, body: &str, is_streamed: bool) -> String {
    if is_streamed || !body.is_empty() {
        heading.push(' ');
        heading.push_str(body);
    }
    heading
}

#[cfg(test)]
mod tests;
