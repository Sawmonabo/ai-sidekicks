//! The transcript rows a Claude Code message frame carries: an `assistant` frame's thinking, text
//! and tool calls, and a `user` frame's tool results, each a file-changing call's with its patch.
//! The frames are untrusted, so each is read into structs that name only the members read, each
//! member read leniently, and a block that reads as nothing known is left out.

mod helper_calls;

use std::collections::HashMap;
use std::error::Error;
use std::marker::PhantomData;
use std::sync::Arc;

use jiff::Timestamp;
use serde::de::{IgnoredAny, SeqAccess};
use serde::{Deserialize, Deserializer};
use serde_json::value::RawValue;
use sidekicks_contracts::event::declared_variants::{
    ProviderBlock, RunAgentOutputPayload, ToolActivityPayload, ToolCallEndCause,
};
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::run::failure_cause::{RunFailureCause, RunRefusedOrigin};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::list::BoundedVec;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_std::port_registration::PortRegistration;
use sidekicks_store::transcript::whole_patch::{WholePatchFile, omitted_patches_of};

use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::delivery::file_tool_writes::{ClaudeFileTool, ClaudeFileToolWrites};
use crate::driver::claude::delivery::mcp_tasks::ClaudeToolServerTasks;
use crate::driver::claude::delivery::patches::read_claude_patch_file;
use crate::driver::claude::delivery::peer_arrival::{ClaudeMessageOrigin, read_boxed_origin};
use crate::driver::claude::delivery::system::read_provider_words;
use crate::driver::claude::run::routes::ClaudeBoundRun;
use crate::driver::reorder_buffer::ReorderPairingRole;
use crate::lenient_json::{
    Lenient, LenientElement, LenientList, LenientVisitor, lenient_object, read_lenient,
    skip_other_shapes,
};
use crate::port::file_tool_write::FileToolWriteSettled;
use crate::port::tool_traces::{ToolTrace, ToolTraces, record_tool_traces};
use crate::run::delivery::{DeliveryOperation, LateAppendableRow};
use crate::tool_call_arguments::{KeptToolCallArguments, ToolCallArgumentStore};

pub(crate) use self::helper_calls::{ClaudeHelperToolCall, ClaudeHelperToolCalls};

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
    #[serde(rename = "isSynthetic", default, deserialize_with = "read_lenient")]
    is_synthetic: Option<bool>,
    #[serde(rename = "isMeta", default, deserialize_with = "read_lenient")]
    is_meta: Option<bool>,
    // Only whether it is set, and not `null`, is read.
    #[serde(default)]
    parent_tool_use_id: Option<IgnoredAny>,
    // Boxed, so a frame that is no peer message stays small.
    #[serde(default, deserialize_with = "read_boxed_origin")]
    origin: Option<Box<ClaudeMessageOrigin>>,
}

#[derive(Deserialize)]
struct ClaudeMessage {
    #[serde(default, deserialize_with = "read_lenient")]
    id: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    content: Option<ClaudeMessageContent>,
    #[serde(default, deserialize_with = "read_lenient")]
    model: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    stop_reason: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    stop_details: Option<ClaudeStopDetails>,
}

// A message's content: Claude Code writes a message of its own making as one string, any other as
// a list of blocks.
enum ClaudeMessageContent {
    Text(String),
    // The blocks that read, and how many the list held.
    Blocks(Vec<ClaudeContentBlock>, u64),
}

impl<'de> serde::de::Visitor<'de> for LenientVisitor<ClaudeMessageContent> {
    type Value = Option<ClaudeMessageContent>;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("any JSON value")
    }

    fn visit_str<E: serde::de::Error>(self, text: &str) -> Result<Self::Value, E> {
        Ok(Some(ClaudeMessageContent::Text(text.to_owned())))
    }

    // Each block read keeps its index in the list, which a block left out still counts.
    fn visit_seq<A: SeqAccess<'de>>(self, mut blocks: A) -> Result<Self::Value, A::Error> {
        let mut read = Vec::new();
        let mut index = 0;
        while let Some(block) = blocks.next_element::<LenientElement<ClaudeContentBlock>>()? {
            read.extend(block.0.map(|block| ClaudeContentBlock { index, ..block }));
            index += 1;
        }
        Ok(Some(ClaudeMessageContent::Blocks(read, index)))
    }

    skip_other_shapes!(
        visit_bool(bool),
        visit_i64(i64),
        visit_u64(u64),
        visit_f64(f64),
        visit_unit()
    );
    skip_other_shapes!(@map);
}

impl Lenient for ClaudeMessageContent {
    fn read<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Self>, D::Error> {
        deserializer.deserialize_any(LenientVisitor::<Self>(PhantomData))
    }
}

// What the safety check that refused a message says of it.
#[derive(Deserialize)]
struct ClaudeStopDetails {
    #[serde(default, deserialize_with = "read_lenient")]
    explanation: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    category: Option<String>,
}

// Every member a content block of either frame carries that a row reads, and its index in the
// message's content.
#[derive(Deserialize)]
struct ClaudeContentBlock {
    #[serde(skip)]
    index: u64,
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

/// A tool call the session's lead started and has not yet answered, by its `tool_use_id`, with
/// the run that started it, whose route may be forgotten before a held call ends. Its start is on
/// the wall clock, so an opening rebuilt from the log is timed from its stored time; a clock set
/// back reads as no time taken.
pub(crate) struct ClaudeOpenToolCall {
    tool_name: EventText,
    run: ClaudeBoundRun,
    started_at: Timestamp,
    // The call's arguments as Claude Code sent them, moved off its frame and kept until its trace
    // takes them; none on an opening rebuilt from the session's log.
    arguments: Option<KeptToolCallArguments>,
}

impl ClaudeOpenToolCall {
    /// A call of `tool_name` that `run` started at `started_at`, on the wall clock.
    pub(crate) fn new(tool_name: EventText, run: ClaudeBoundRun, started_at: Timestamp) -> Self {
        Self {
            tool_name,
            run,
            started_at,
            arguments: None,
        }
    }

    /// The trace of this call, `call_id` on `session_id`, closing with the result body `result`
    /// gives, its arguments moved out, so a call is traced once; `None` for a call that holds no
    /// arguments, rebuilt from the log or already traced.
    pub(crate) fn take_trace(
        &mut self,
        session_id: SessionId,
        call_id: &str,
        result: impl FnOnce() -> Box<RawValue>,
    ) -> Option<ClaudeKeptTrace> {
        let arguments = self.arguments.take()?;
        Some(ClaudeKeptTrace {
            session_id,
            call_id: call_id.to_owned(),
            tool_name: self.tool_name.as_str().to_owned(),
            arguments,
            result: result(),
        })
    }

    /// The same opening without its arguments, which stay with this one.
    pub(crate) fn without_arguments(&self) -> Self {
        Self {
            tool_name: self.tool_name.clone(),
            run: self.run.clone(),
            started_at: self.started_at,
            arguments: None,
        }
    }

    /// The run that started the call, and its binding.
    pub(crate) fn run(&self) -> &ClaudeBoundRun {
        &self.run
    }

    /// The called tool's name.
    pub(crate) fn tool_name(&self) -> &EventText {
        &self.tool_name
    }
}

/// How a tool call ended: with its result, or failed, with why when no result came.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeToolCallOutcome {
    /// It answered.
    Completed,
    /// It failed.
    Failed {
        /// Why it ended with no result, where none came.
        end_cause: Option<ToolCallEndCause>,
    },
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

/// The rows of one `user` frame of the lead, the tool calls it answered with an error and the
/// held calls it answered with a stand-in. A result naming a call the lead never started carries
/// no row, since no tool is named.
pub(crate) struct ClaudeUserFrameReading {
    /// The rows.
    pub(crate) rows: Vec<ClaudeMessageRow>,
    /// Each call Claude Code answered with an error, by its id, with the words it sent the model.
    pub(crate) failed_results: Vec<(String, String)>,
    /// Each held call's stand-in result, by the call's id, with the stand-in's words.
    pub(crate) held_stand_ins: Vec<(String, String)>,
    /// The trace of each call the frame answered, while `Record traces` is on.
    pub(crate) traces: Vec<ClaudeKeptTrace>,
    /// Each open file-tool call the frame answered, settled by its result.
    pub(crate) file_tool_writes: Vec<FileToolWriteSettled>,
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

    /// Where a `user` frame's message came from, where Claude Code says.
    pub(crate) fn origin(&self) -> Option<&ClaudeMessageOrigin> {
        self.origin.as_deref()
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

    /// Whether a `user` frame is one Claude Code made up itself, such as a stop hook's feedback.
    pub(crate) fn is_synthetic(&self) -> bool {
        self.is_synthetic == Some(true)
    }

    /// Whether a `user` frame is a meta message Claude Code wrote, such as a deferred goal check's
    /// check-in.
    pub(crate) fn is_meta(&self) -> bool {
        self.is_meta == Some(true)
    }

    /// The message's text: its whole content where Claude Code wrote it as one string, else its
    /// first non-empty text block.
    pub(crate) fn text(&self) -> Option<&str> {
        match self.message.as_ref()?.content.as_ref()? {
            ClaudeMessageContent::Text(text) => Some(text.as_str()),
            ClaudeMessageContent::Blocks(blocks, _) => blocks
                .iter()
                .filter(|block| block.block_type.as_deref() == Some("text"))
                .find_map(|block| block.text.as_deref().filter(|text| !text.is_empty())),
        }
    }

    /// How many blocks the frame's content holds, one where it is a single string.
    pub(crate) fn block_count(&self) -> u64 {
        match self
            .message
            .as_ref()
            .and_then(|message| message.content.as_ref())
        {
            Some(ClaudeMessageContent::Blocks(_, count)) => *count,
            Some(ClaudeMessageContent::Text(_)) => 1,
            None => 0,
        }
    }

    /// The index in the message's content of its last non-empty text block.
    pub(crate) fn last_text_index(&self) -> Option<u64> {
        self.blocks()
            .iter()
            .rev()
            .find(|block| {
                block.block_type.as_deref() == Some("text")
                    && block.text.as_ref().is_some_and(|text| !text.is_empty())
            })
            .map(|block| block.index)
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
        match self
            .message
            .as_ref()
            .and_then(|message| message.content.as_ref())
        {
            Some(ClaudeMessageContent::Blocks(blocks, _)) => blocks,
            Some(ClaudeMessageContent::Text(_)) | None => &[],
        }
    }

    fn blocks_mut(&mut self) -> &mut [ClaudeContentBlock] {
        match self
            .message
            .as_mut()
            .and_then(|message| message.content.as_mut())
        {
            Some(ClaudeMessageContent::Blocks(blocks, _)) => blocks,
            Some(ClaudeMessageContent::Text(_)) | None => &mut [],
        }
    }
}

/// The rows of one `assistant` frame of the lead on `run`: each thinking block's summary and each
/// text block under the message's id, a fresh one where the frame names none, and each tool call
/// as `agent.toolCall.invoked`, which opens the call in `open_tool_calls` on `run` at `now`, its
/// arguments moved off the frame into `arguments` for its trace. A summary or text names its block
/// by its index in the message's content on the message's first response; a streamed block's last
/// piece takes the block the stream named.
pub(crate) fn read_claude_assistant_rows(
    frame: &mut ClaudeMessageFrame,
    session_id: SessionId,
    run: &ClaudeBoundRun,
    open_tool_calls: &mut HashMap<String, ClaudeOpenToolCall>,
    arguments: &ToolCallArgumentStore,
    now: Timestamp,
) -> Vec<ClaudeMessageRow> {
    let run_id = run.run_id;
    let mut rows = Vec::new();
    let provider_message_id = frame
        .provider_message_id()
        .and_then(|id| EventText::new(id.to_owned()).ok())
        .unwrap_or_else(|| {
            EventText::new(mint_uuid_v7().to_string()).expect("a uuid is a field's text")
        });
    let output_payload = |index: u64| RunAgentOutputPayload {
        session_id,
        provider_message_id: provider_message_id.clone(),
        content_type: None,
        run_id,
        provider_block: Some(
            ProviderBlock::new(index, 1).expect("a held block's index is a safe integer"),
        ),
        origin: None,
        source_epoch: None,
        source_position: None,
        content_length: None,
        content_encoding: None,
    };
    for block in frame.blocks_mut() {
        let block_type = block.block_type.as_deref();
        // A redacted block carries no text, so it has no row.
        if block_type == Some("thinking")
            && let Some(thinking) = block.thinking.as_ref().filter(|text| !text.is_empty())
        {
            rows.push(unpaired(ClaudeMessageRowKind::Thinking {
                payload: output_payload(block.index),
                content: thinking.clone(),
            }));
            continue;
        }
        if block_type == Some("text")
            && let Some(text) = block.text.as_ref().filter(|text| !text.is_empty())
        {
            rows.push(unpaired(ClaudeMessageRowKind::Session {
                row: LateAppendableRow::AgentMessageSent(output_payload(block.index)),
                body: ClaudeMessageBody::Text(text.clone()),
            }));
            continue;
        }
        if !is_tool_call_block(block) {
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
        let input = block
            .input
            .as_deref()
            .map_or("{}", RawValue::get)
            .to_owned();
        let mut opened = ClaudeOpenToolCall::new(tool_name.clone(), run.clone(), now);
        opened.arguments = Some(arguments.keep(take_raw_value(&mut block.input)));
        open_tool_calls.insert(call_id.clone(), opened);
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
                body: ClaudeMessageBody::Text(input),
            },
        });
    }
    rows
}

/// The tool results one `user` frame carries, each as `agent.toolCall.completed` or, when Claude
/// Code marks it an error, `agent.toolCall.failed`, closing its call in `open_tool_calls` and
/// timed from its start to `now` and closed on the run that started it. A file-changing call's
/// lone result carries its patch. A call `tool_server_tasks` holds stays open: its result is a
/// stand-in, kept with its words, and the real one comes later. While `is_tracing`, a closed call
/// that holds its arguments is traced with the result's content as Claude Code sent it. Each call
/// open in `file_tool_writes` settles by its result.
pub(crate) fn read_claude_user_rows(
    frame: &ClaudeMessageFrame,
    session_id: SessionId,
    open_tool_calls: &mut HashMap<String, ClaudeOpenToolCall>,
    tool_server_tasks: &ClaudeToolServerTasks,
    file_tool_writes: &mut ClaudeFileToolWrites,
    now: Timestamp,
    is_tracing: bool,
) -> ClaudeUserFrameReading {
    let mut reading = ClaudeUserFrameReading {
        rows: Vec::new(),
        failed_results: Vec::new(),
        held_stand_ins: Vec::new(),
        traces: Vec::new(),
        file_tool_writes: Vec::new(),
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
        if tool_server_tasks.holds_call(call_id) {
            reading.held_stand_ins.push((call_id.clone(), text));
            continue;
        }
        let is_error = block.is_error == Some(true);
        if is_error {
            reading.failed_results.push((call_id.clone(), text.clone()));
        }
        let opened = open_tool_calls.remove(call_id);
        let is_file_change = opened
            .as_ref()
            .is_some_and(|opened| ClaudeFileTool::of(opened.tool_name.as_str()).is_some());
        // Claude Code's structured result rides the frame beside a lone tool result, read once
        // for the patch and the file tool's write.
        let reads_structured_result =
            !is_error && is_lone_result && (is_file_change || file_tool_writes.is_open(call_id));
        let tool_use_result: Option<serde_json::Value> = if reads_structured_result {
            frame
                .tool_use_result
                .as_deref()
                .and_then(|result| serde_json::from_str(result.get()).ok())
        } else {
            None
        };
        reading
            .file_tool_writes
            .extend(file_tool_writes.settle_result(
                session_id,
                call_id,
                is_error,
                is_lone_result,
                tool_use_result.as_ref(),
            ));
        let Some(mut opened) = opened else {
            continue;
        };
        let patch = is_file_change
            .then_some(tool_use_result.as_ref())
            .flatten()
            .and_then(read_claude_patch_file);
        if is_tracing
            && let Some(trace) = opened.take_trace(session_id, call_id, || {
                read_raw_value(block.content.as_deref())
            })
        {
            reading.traces.push(trace);
        }
        let closed = ClaudeToolCallClose {
            session_id,
            is_error,
            body: patch.map_or(ClaudeMessageBody::Text(text), ClaudeMessageBody::Patch),
        };
        reading
            .rows
            .extend(close_claude_tool_call(opened, call_id, closed, now));
    }
    reading
}

/// How one tool call closes in its session, failed or completed, with its stored body.
pub(crate) struct ClaudeToolCallClose {
    /// The session.
    pub(crate) session_id: SessionId,
    /// Whether the call failed.
    pub(crate) is_error: bool,
    /// The result's words or patch.
    pub(crate) body: ClaudeMessageBody,
}

// The row that closes `opened`, the call `call_id`, on the run that started it, timed from its
// start to `now`, a completion carrying a patch naming its file in `omittedPatches`; `None` for an
// id no row can carry.
fn close_claude_tool_call(
    opened: ClaudeOpenToolCall,
    call_id: &str,
    closed: ClaudeToolCallClose,
    now: Timestamp,
) -> Option<ClaudeMessageRow> {
    let outcome = if closed.is_error {
        ClaudeToolCallOutcome::Failed { end_cause: None }
    } else {
        ClaudeToolCallOutcome::Completed
    };
    let mut row = close_opened_call(opened, call_id, closed.session_id, outcome, now)?;
    if let (LateAppendableRow::AgentToolCallCompleted(activity), ClaudeMessageBody::Patch(file)) =
        (&mut row, &closed.body)
    {
        activity.omitted_patches = BoundedVec::new(omitted_patches_of(std::slice::from_ref(file)));
    }
    Some(ClaudeMessageRow {
        tool_call_id: Some(call_id.to_owned()),
        pairing_role: ReorderPairingRole::Completion,
        row: ClaudeMessageRowKind::Session {
            row,
            body: closed.body,
        },
    })
}

/// The row that closes `opened`, the call `call_id`, on the run that started it with `outcome`,
/// timed from its start to `now` and carrying no body; `None` for an id no row can carry.
pub(crate) fn close_opened_call(
    opened: ClaudeOpenToolCall,
    call_id: &str,
    session_id: SessionId,
    outcome: ClaudeToolCallOutcome,
    now: Timestamp,
) -> Option<LateAppendableRow> {
    let tool_call_id = ToolCallId::new(call_id.to_owned()).ok()?;
    let duration_ms = u64::try_from(now.duration_since(opened.started_at).as_millis().max(0))
        .ok()
        .and_then(SafeInt::new);
    let activity = tool_activity(
        session_id,
        opened.run().run_id,
        opened.tool_name,
        tool_call_id,
        duration_ms,
    );
    Some(match outcome {
        ClaudeToolCallOutcome::Completed => LateAppendableRow::AgentToolCallCompleted(activity),
        ClaudeToolCallOutcome::Failed { end_cause } => {
            LateAppendableRow::AgentToolCallFailed(activity.into_failed(end_cause))
        }
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
        content_encoding: None,
    }
}

// Whether a content block starts a tool call: an advisor call arrives as Claude Code's own server
// tool call, and both are tool calls.
fn is_tool_call_block(block: &ClaudeContentBlock) -> bool {
    matches!(
        block.block_type.as_deref(),
        Some("tool_use" | "server_tool_use")
    )
}

/// A call's trace whose arguments are still kept, in memory or on disk, until it is recorded.
pub(crate) struct ClaudeKeptTrace {
    session_id: SessionId,
    call_id: String,
    tool_name: String,
    arguments: KeptToolCallArguments,
    result: Box<RawValue>,
}

impl ClaudeKeptTrace {
    // The trace, its arguments read back; `None`, logged, for arguments the disk cannot give back.
    async fn read(self) -> Option<ToolTrace> {
        let arguments = self
            .arguments
            .read()
            .await
            .inspect_err(|error| {
                tracing::warn!(
                    session_id = %self.session_id,
                    tool_use_id = %self.call_id,
                    error = error as &(dyn Error + 'static),
                    "a Claude Code tool call's arguments could not be read back from disk, so the \
                     call is not traced"
                );
            })
            .ok()?;
        Some(ToolTrace {
            session_id: self.session_id,
            provider: DESCRIPTOR.provider_id(),
            tool_call_id: self.call_id,
            tool_name: self.tool_name,
            arguments,
            result: self.result,
        })
    }
}

/// Records each of `traces` in order through `tool_traces`, its arguments read back first; one
/// whose arguments the disk cannot give back is logged and not recorded.
pub(crate) async fn record_claude_traces(
    tool_traces: &PortRegistration<Arc<dyn ToolTraces>>,
    traces: impl IntoIterator<Item = ClaudeKeptTrace>,
) {
    let mut read = Vec::new();
    for trace in traces {
        read.extend(trace.read().await);
    }
    record_tool_traces(tool_traces, read).await;
}

// A member the frame carried, word for word; `null` where the frame left it out.
fn read_raw_value(member: Option<&RawValue>) -> Box<RawValue> {
    member.unwrap_or(RawValue::NULL).to_owned()
}

// A member moved off the frame, word for word; `null` where the frame left it out.
fn take_raw_value(member: &mut Option<Box<RawValue>>) -> Box<RawValue> {
    member.take().unwrap_or_else(|| RawValue::NULL.to_owned())
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

#[cfg(test)]
mod tests;
