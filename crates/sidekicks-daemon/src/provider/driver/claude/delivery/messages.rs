//! The transcript rows a Claude Code message frame carries: an `assistant` frame's thinking, text
//! and tool calls, and a `user` frame's tool results, each a file-changing call's with its patch.
//! The frames are untrusted, so each is read into structs that name only the members read, each
//! member read leniently, and a block that reads as nothing known is left out.

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::value::RawValue;
use sidekicks_contracts::event::declared_variants::{RunAgentOutputPayload, ToolActivityPayload};
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use tokio::time::Instant;

use crate::provider::driver::claude::delivery::patches::{
    is_claude_file_changing_tool, read_claude_patch_file,
};
use crate::provider::driver::reorder_buffer::ReorderPairingRole;
use crate::provider::lenient_json::{Lenient, LenientList, lenient_object, read_lenient};
use crate::session::run::epochs::DeliveryOperation;
use crate::session::run::inbound::rows::LateAppendableRow;
use crate::transcript::whole_patch::WholePatchFile;
use sidekicks_contracts::wire::id::mint_uuid_v7;

/// A field of a transcript row, as the event's cap holds it.
type EventText = FreeFormText<EVENT_FIELD_MAX_LEN>;

/// The members of an `assistant` or `user` frame the rows are read from.
#[derive(Deserialize)]
pub(crate) struct ClaudeMessageFrame {
    #[serde(default, deserialize_with = "read_lenient")]
    message: Option<ClaudeMessage>,
    #[serde(default, deserialize_with = "read_lenient")]
    uuid: Option<String>,
    /// Claude Code's structured result of a lone tool result, relayed unread until a patch is read.
    #[serde(default)]
    tool_use_result: Option<Box<RawValue>>,
}

#[derive(Deserialize)]
struct ClaudeMessage {
    #[serde(default, deserialize_with = "read_lenient")]
    id: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    content: Option<LenientList<ClaudeContentBlock>>,
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
    #[expect(
        dead_code,
        reason = "the Claude driver's stream reader writes each row with it"
    )]
    pub(crate) tool_call_id: Option<String>,
    /// Where the row stands in its call's pair.
    #[expect(
        dead_code,
        reason = "the Claude driver's stream reader writes each row with it"
    )]
    pub(crate) pairing_role: ReorderPairingRole,
    /// The row and its stored body.
    pub(crate) row: ClaudeMessageRowKind,
}

impl ClaudeMessageRow {
    /// The provider operation the row belongs to: its tool call, opened by its invocation.
    #[expect(
        dead_code,
        reason = "the Claude driver's stream reader binds each row's operation through it"
    )]
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
    Patch(
        #[expect(
            dead_code,
            reason = "the Claude driver's stream reader writes the change from it"
        )]
        WholePatchFile,
    ),
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
#[expect(
    dead_code,
    reason = "the Claude Code stream reader turns each assistant frame into its rows"
)]
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
            block.id.as_ref().and_then(|id| event_text(id)),
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
/// timed from its start to `now`. A file-changing call's lone result carries its patch.
#[expect(
    dead_code,
    reason = "the Claude Code stream reader turns each user frame into its rows"
)]
pub(crate) fn read_claude_user_rows(
    frame: &ClaudeMessageFrame,
    session_id: SessionId,
    run_id: RunId,
    open_tool_calls: &mut HashMap<String, ClaudeOpenToolCall>,
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
        let text = read_tool_result_text(block.content.as_deref());
        let is_error = block.is_error == Some(true);
        if is_error {
            reading.failed_results.push((call_id.clone(), text.clone()));
        }
        let Some(opened) = open_tool_calls.remove(call_id) else {
            continue;
        };
        let Some(tool_call_id) = event_text(call_id) else {
            continue;
        };
        // Claude Code's structured result rides the frame beside a lone tool result.
        let patch = (!is_error
            && is_lone_result
            && is_claude_file_changing_tool(opened.tool_name.as_str()))
        .then_some(frame.tool_use_result.as_deref())
        .flatten()
        .and_then(|result| serde_json::from_str(result.get()).ok())
        .and_then(|result| read_claude_patch_file(&result));
        let duration_ms = u64::try_from(now.duration_since(opened.started_at).as_millis())
            .ok()
            .and_then(SafeInt::new);
        let activity = tool_activity(
            session_id,
            run_id,
            opened.tool_name,
            tool_call_id,
            duration_ms,
        );
        reading.rows.push(ClaudeMessageRow {
            tool_call_id: Some(call_id.clone()),
            pairing_role: ReorderPairingRole::Completion,
            row: ClaudeMessageRowKind::Session {
                row: if is_error {
                    LateAppendableRow::AgentToolCallFailed(activity)
                } else {
                    LateAppendableRow::AgentToolCallCompleted(activity)
                },
                body: patch.map_or(ClaudeMessageBody::Text(text), ClaudeMessageBody::Patch),
            },
        });
    }
    reading
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
    tool_call_id: EventText,
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
