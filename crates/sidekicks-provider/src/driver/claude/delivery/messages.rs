//! The transcript rows a Claude Code message frame carries: an `assistant` frame's thinking, text
//! and tool calls, and a `user` frame's tool results, each a file-changing call's with its patch.
//! The frames are untrusted, so each is read into structs that name only the members read, each
//! member read leniently, and a block that reads as nothing known is left out.

use std::collections::{HashMap, HashSet};

use serde::Deserialize;
use serde::de::IgnoredAny;
use serde_json::value::RawValue;
use sidekicks_contracts::event::declared_variants::{RunAgentOutputPayload, ToolActivityPayload};
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::run::failure_cause::{RunFailureCause, RunRefusedOrigin};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_store::transcript::whole_patch::WholePatchFile;
use tokio::time::Instant;

use crate::driver::claude::delivery::patches::{
    is_claude_file_changing_tool, read_claude_patch_file,
};
use crate::driver::claude::delivery::system::read_provider_words;
use crate::driver::reorder_buffer::ReorderPairingRole;
use crate::lenient_json::{Lenient, LenientList, lenient_object, read_lenient};
use crate::run::delivery::{DeliveryOperation, LateAppendableRow};

/// A field of a transcript row, as the event's cap holds it.
type EventText = FreeFormText<EVENT_FIELD_MAX_LEN>;

/// The members of an `assistant` or `user` frame the stream reads, the frame parsed once.
#[derive(Deserialize)]
pub(crate) struct ClaudeMessageFrame {
    #[serde(default, deserialize_with = "read_lenient")]
    message: Option<ClaudeMessage>,
    #[serde(default, deserialize_with = "read_lenient")]
    uuid: Option<String>,
    /// Claude Code's structured result of a lone tool result, relayed unread until a patch is read.
    #[serde(default)]
    tool_use_result: Option<Box<RawValue>>,
    #[serde(default, deserialize_with = "read_lenient")]
    error: Option<String>,
    #[serde(rename = "isReplay", default, deserialize_with = "read_lenient")]
    is_replay: Option<bool>,
    // Only whether it is set, and not `null`, is read.
    #[serde(default)]
    parent_tool_use_id: Option<IgnoredAny>,
}

#[derive(Deserialize)]
struct ClaudeMessage {
    #[serde(default, deserialize_with = "read_lenient")]
    id: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    content: Option<LenientList<ClaudeContentBlock>>,
    #[serde(default, deserialize_with = "read_lenient")]
    model: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    stop_reason: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    stop_details: Option<ClaudeStopDetails>,
}

// What the safety check that refused a message says of it.
#[derive(Deserialize)]
struct ClaudeStopDetails {
    #[serde(default, deserialize_with = "read_lenient")]
    explanation: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    category: Option<String>,
}

// Every member a content block of either frame carries that a row reads.
#[derive(Deserialize)]
struct ClaudeContentBlock {
    #[serde(rename = "type", default, deserialize_with = "read_lenient")]
    block_type: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    thinking: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    text: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    id: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    name: Option<String>,
    #[serde(default)]
    input: Option<Box<RawValue>>,
    #[serde(default, deserialize_with = "read_lenient")]
    tool_use_id: Option<String>,
    #[serde(default)]
    content: Option<Box<RawValue>>,
    #[serde(default, deserialize_with = "read_lenient")]
    is_error: Option<bool>,
}

// A text block of a tool result's content list.
#[derive(Deserialize)]
struct ClaudeResultTextBlock {
    #[serde(default, deserialize_with = "read_lenient")]
    text: Option<String>,
}

lenient_object!(
    ClaudeMessageFrame,
    ClaudeMessage,
    ClaudeStopDetails,
    ClaudeContentBlock,
    ClaudeResultTextBlock
);

/// A tool call the session's lead started and has not yet answered, by its `tool_use_id`.
pub(crate) struct ClaudeOpenToolCall {
    tool_name: EventText,
    started_at: Instant,
}

/// One row read off a message frame, with how it pairs in the reorder buffer.
pub(crate) struct ClaudeMessageRow {
    /// The tool call the row belongs to, `None` on a thinking or text row.
    pub(crate) tool_call_id: Option<String>,
    /// Where the row stands in its call's pair.
    pub(crate) pairing_role: ReorderPairingRole,
    /// The row and its stored body.
    pub(crate) row: ClaudeMessageRowKind,
}

impl ClaudeMessageRow {
    /// The provider operation the row belongs to: its tool call, opened by its invocation.
    pub(crate) fn operation(&self) -> Option<DeliveryOperation<'_>> {
        self.tool_call_id
            .as_deref()
            .map(|correlation_key| DeliveryOperation {
                correlation_key,
                is_opening: self.pairing_role == ReorderPairingRole::Initiation,
            })
    }
}

/// A message frame's row: a thinking summary, which takes its own drop-when-full append, or a
/// row that takes the stamp when late, with its body.
pub(crate) enum ClaudeMessageRowKind {
    /// An assistant's thinking summary and its text.
    Thinking {
        /// The row's payload, without the stamp.
        payload: RunAgentOutputPayload,
        /// The summary.
        content: String,
    },
    /// A message, a tool call or a tool result.
    Session {
        /// The row.
        row: LateAppendableRow,
        /// Its stored body.
        body: ClaudeMessageBody,
    },
}

/// A row's stored body: text, or a file-changing call's whole patch, which the patch read pages.
pub(crate) enum ClaudeMessageBody {
    /// The message's text, the call's input as JSON, or the result's words.
    Text(String),
    /// The change the call made.
    Patch(WholePatchFile),
}

/// The rows of one `user` frame of the lead and the tool calls it answered with an error. A
/// result naming a call the lead never started carries no row, since no tool is named.
pub(crate) struct ClaudeUserFrameReading {
    /// The rows.
    pub(crate) rows: Vec<ClaudeMessageRow>,
    /// Each call Claude Code answered with an error, by its id, with the words it sent the model.
    pub(crate) failed_results: Vec<(String, String)>,
}

impl ClaudeMessageFrame {
    /// The id of the message an `assistant` frame is a piece of: its `message.id`, shared by every
    /// frame of that message, else the frame's own `uuid`, as Claude Code keys a message with none.
    pub(crate) fn provider_message_id(&self) -> Option<&str> {
        self.message
            .as_ref()
            .and_then(|message| message.id.as_deref())
            .filter(|id| !id.is_empty())
            .or_else(|| self.uuid.as_deref().filter(|uuid| !uuid.is_empty()))
    }

    /// The frame's own `uuid`, where it carries one.
    pub(crate) fn uuid(&self) -> Option<&str> {
        self.uuid.as_deref().filter(|uuid| !uuid.is_empty())
    }

    /// Each tool call the frame starts: its id, its tool's name and its input, unread.
    pub(crate) fn tool_uses(&self) -> impl Iterator<Item = (&str, &str, Option<&RawValue>)> {
        self.blocks().iter().filter_map(|block| {
            if block.block_type.as_deref() != Some("tool_use") {
                return None;
            }
            Some((
                block.id.as_deref().filter(|id| !id.is_empty())?,
                block.name.as_deref()?,
                block.input.as_deref(),
            ))
        })
    }

    /// Each tool result the frame carries: the call it answers and whether Claude Code marked it
    /// an error.
    pub(crate) fn tool_results(&self) -> impl Iterator<Item = (&str, bool)> {
        self.blocks().iter().filter_map(|block| {
            if block.block_type.as_deref() != Some("tool_result") {
                return None;
            }
            Some((
                block.tool_use_id.as_deref().filter(|id| !id.is_empty())?,
                block.is_error == Some(true),
            ))
        })
    }

    /// The error an `assistant` frame names, where Claude Code set one.
    pub(crate) fn error(&self) -> Option<&str> {
        self.error.as_deref().filter(|error| !error.is_empty())
    }

    /// Whether a `user` frame is Claude Code's echo of a message it took off its input: a replay
    /// that answers no helper's call, since a helper's replay was never handed to it.
    pub(crate) fn is_taken_echo(&self) -> bool {
        self.is_replay == Some(true) && self.parent_tool_use_id.is_none()
    }

    /// The refusal an `assistant` frame's message ends on (`stop_reason` `refusal`), with the
    /// model that refused and its check's category and explanation; Claude Code sends it whether
    /// or not a `model_refusal_no_fallback` frame follows.
    pub(crate) fn refusal(&self) -> Option<RunFailureCause> {
        let message = self.message.as_ref()?;
        if message.stop_reason.as_deref() != Some("refusal") {
            return None;
        }
        let model = message.model.as_deref().filter(|model| !model.is_empty())?;
        let details = message.stop_details.as_ref();
        let detail = |read: fn(&ClaudeStopDetails) -> Option<&String>| {
            details
                .and_then(read)
                .map(String::as_str)
                .filter(|text| !text.is_empty())
        };
        Some(RunFailureCause::Refused {
            origin: RunRefusedOrigin::Provider,
            model: FreeFormText::new(model.to_owned()).ok()?,
            sentence: None,
            explanation: detail(|details| details.explanation.as_ref())
                .and_then(read_provider_words),
            safety_category: detail(|details| details.category.as_ref())
                .and_then(|category| FreeFormText::new(category.to_owned()).ok()),
        })
    }

    /// Claude Code's structured result of the frame's one tool result, where it carries one.
    pub(crate) fn tool_use_result(&self) -> Option<&RawValue> {
        let mut results = self.tool_results();
        match (results.next(), results.next()) {
            (Some(_), None) => self.tool_use_result.as_deref(),
            (Some(_), Some(_)) | (None, _) => None,
        }
    }

    fn blocks(&self) -> &[ClaudeContentBlock] {
        self.message
            .as_ref()
            .and_then(|message| message.content.as_ref())
            .map_or(&[], |content| &content.0)
    }
}

/// The rows of one `assistant` frame of the lead: each thinking block's summary and each text
/// block under the message's id, a fresh one where the frame names none, and each tool call as
/// `agent.toolCall.invoked`, which opens the call in `open_tool_calls` at `now`.
pub(crate) fn read_claude_assistant_rows(
    frame: &ClaudeMessageFrame,
    session_id: SessionId,
    run_id: RunId,
    open_tool_calls: &mut HashMap<String, ClaudeOpenToolCall>,
    now: Instant,
) -> Vec<ClaudeMessageRow> {
    let mut rows = Vec::new();
    let provider_message_id = frame
        .provider_message_id()
        .and_then(|id| EventText::new(id.to_owned()).ok())
        .unwrap_or_else(|| {
            EventText::new(mint_uuid_v7().to_string()).expect("a uuid is a field's text")
        });
    let output_payload = || RunAgentOutputPayload {
        session_id,
        provider_message_id: provider_message_id.clone(),
        content_type: None,
        run_id,
        provider_block: None,
        origin: None,
        source_epoch: None,
        source_position: None,
        content_length: None,
        content_truncated: None,
        content_encoding: None,
    };
    for block in frame.blocks() {
        let block_type = block.block_type.as_deref();
        // A redacted block carries no text, so it has no row.
        if block_type == Some("thinking")
            && let Some(thinking) = block.thinking.as_ref().filter(|text| !text.is_empty())
        {
            rows.push(unpaired(ClaudeMessageRowKind::Thinking {
                payload: output_payload(),
                content: thinking.clone(),
            }));
            continue;
        }
        if block_type == Some("text")
            && let Some(text) = block.text.as_ref().filter(|text| !text.is_empty())
        {
            rows.push(unpaired(ClaudeMessageRowKind::Session {
                row: LateAppendableRow::AgentMessageSent(output_payload()),
                body: ClaudeMessageBody::Text(text.clone()),
            }));
            continue;
        }
        // An advisor call arrives as Claude Code's own server tool call; both are tool calls.
        if !matches!(block_type, Some("tool_use" | "server_tool_use")) {
            continue;
        }
        let (Some(tool_call_id), Some(tool_name)) = (
            block
                .id
                .as_ref()
                .and_then(|id| ToolCallId::new(id.clone()).ok()),
            block.name.as_ref().and_then(|name| event_text(name)),
        ) else {
            continue;
        };
        let call_id = tool_call_id.as_str().to_owned();
        open_tool_calls.insert(
            call_id.clone(),
            ClaudeOpenToolCall {
                tool_name: tool_name.clone(),
                started_at: now,
            },
        );
        let input = block.input.as_ref().map_or("{}", |input| input.get());
        rows.push(ClaudeMessageRow {
            tool_call_id: Some(call_id),
            pairing_role: ReorderPairingRole::Initiation,
            row: ClaudeMessageRowKind::Session {
                row: LateAppendableRow::AgentToolCallInvoked(tool_activity(
                    session_id,
                    run_id,
                    tool_name,
                    tool_call_id,
                    None,
                )),
                body: ClaudeMessageBody::Text(input.to_owned()),
            },
        });
    }
    rows
}

/// The tool results one `user` frame carries, each as `agent.toolCall.completed` or, when Claude
/// Code marks it an error, `agent.toolCall.failed`, closing its call in `open_tool_calls` and
/// timed from its start to `now`. A file-changing call's lone result carries its patch. A call in
/// `held_calls` stays open: its result is a stand-in, and the real one comes later.
pub(crate) fn read_claude_user_rows(
    frame: &ClaudeMessageFrame,
    session_id: SessionId,
    run_id: RunId,
    open_tool_calls: &mut HashMap<String, ClaudeOpenToolCall>,
    held_calls: &HashSet<String>,
    now: Instant,
) -> ClaudeUserFrameReading {
    let mut reading = ClaudeUserFrameReading {
        rows: Vec::new(),
        failed_results: Vec::new(),
    };
    let results: Vec<&ClaudeContentBlock> = frame
        .blocks()
        .iter()
        .filter(|block| block.block_type.as_deref() == Some("tool_result"))
        .collect();
    let is_lone_result = results.len() == 1;
    for block in results {
        let Some(call_id) = block.tool_use_id.as_ref().filter(|id| !id.is_empty()) else {
            continue;
        };
        if held_calls.contains(call_id) {
            continue;
        }
        let text = read_tool_result_text(block.content.as_deref());
        let is_error = block.is_error == Some(true);
        if is_error {
            reading.failed_results.push((call_id.clone(), text.clone()));
        }
        // Claude Code's structured result rides the frame beside a lone tool result.
        let is_file_change = open_tool_calls
            .get(call_id)
            .is_some_and(|opened| is_claude_file_changing_tool(opened.tool_name.as_str()));
        let patch = (!is_error && is_lone_result && is_file_change)
            .then_some(frame.tool_use_result.as_deref())
            .flatten()
            .and_then(|result| serde_json::from_str(result.get()).ok())
            .and_then(|result| read_claude_patch_file(&result));
        let closed = ClaudeToolCallClose {
            session_id,
            run_id,
            is_error,
            body: patch.map_or(ClaudeMessageBody::Text(text), ClaudeMessageBody::Patch),
        };
        reading.rows.extend(close_claude_tool_call(
            open_tool_calls,
            call_id,
            closed,
            now,
        ));
    }
    reading
}

/// How one tool call closes: on its session's run, failed or completed, with its stored body.
pub(crate) struct ClaudeToolCallClose {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The run the call is on.
    pub(crate) run_id: RunId,
    /// Whether the call failed.
    pub(crate) is_error: bool,
    /// The result's words or patch.
    pub(crate) body: ClaudeMessageBody,
}

/// The row that closes the open call `call_id`, removing it from `open_tool_calls` and timing it
/// from its start to `now`; `None` for a call not open, or an id no row can carry.
pub(crate) fn close_claude_tool_call(
    open_tool_calls: &mut HashMap<String, ClaudeOpenToolCall>,
    call_id: &str,
    closed: ClaudeToolCallClose,
    now: Instant,
) -> Option<ClaudeMessageRow> {
    let opened = open_tool_calls.remove(call_id)?;
    let tool_call_id = ToolCallId::new(call_id.to_owned()).ok()?;
    let duration_ms = u64::try_from(now.duration_since(opened.started_at).as_millis())
        .ok()
        .and_then(SafeInt::new);
    let activity = tool_activity(
        closed.session_id,
        closed.run_id,
        opened.tool_name,
        tool_call_id,
        duration_ms,
    );
    Some(ClaudeMessageRow {
        tool_call_id: Some(call_id.to_owned()),
        pairing_role: ReorderPairingRole::Completion,
        row: ClaudeMessageRowKind::Session {
            row: if closed.is_error {
                LateAppendableRow::AgentToolCallFailed(activity)
            } else {
                LateAppendableRow::AgentToolCallCompleted(activity)
            },
            body: closed.body,
        },
    })
}

fn unpaired(row: ClaudeMessageRowKind) -> ClaudeMessageRow {
    ClaudeMessageRow {
        tool_call_id: None,
        pairing_role: ReorderPairingRole::Unpaired,
        row,
    }
}

// A provider's id or name as a row's field; one the field cannot hold reads as absent.
fn event_text(text: &str) -> Option<EventText> {
    EventText::new(text.to_owned()).ok()
}

fn tool_activity(
    session_id: SessionId,
    run_id: RunId,
    tool_name: EventText,
    tool_call_id: ToolCallId,
    duration_ms: Option<SafeInt<0>>,
) -> ToolActivityPayload {
    ToolActivityPayload {
        session_id,
        run_id,
        tool_name,
        tool_call_id: Some(tool_call_id),
        duration_ms,
        omitted_patches: None,
        source_epoch: None,
        source_position: None,
        content_length: None,
        content_truncated: None,
        content_encoding: None,
    }
}

// A tool result's content is a string or a list of blocks, whose text blocks are joined.
fn read_tool_result_text(content: Option<&RawValue>) -> String {
    let Some(content) = content else {
        return String::new();
    };
    if let Ok(text) = serde_json::from_str::<String>(content.get()) {
        return text;
    }
    // A list nested past the reader's depth reads as no text, as any other shape does.
    LenientList::<ClaudeResultTextBlock>::read(&mut serde_json::Deserializer::from_str(
        content.get(),
    ))
    .ok()
    .flatten()
    .map(|blocks| {
        blocks
            .0
            .into_iter()
            .filter_map(|block| block.text)
            .collect::<Vec<_>>()
            .join("\n")
    })
    .unwrap_or_default()
}
