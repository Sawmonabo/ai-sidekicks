//! The transcript rows a Codex turn's items become: each tool call's start and end, a file change's
//! patches with their counts, and the pieces of the reasoning, the reply and the plan. A built-in
//! tool is named by its item type, a tool server's or a daemon tool's by the provider's own tool
//! name.

use serde_json::{Map, Value};
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::event::declared_variants::{RunAgentOutputPayload, ToolActivityPayload};
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::provider::driver::codex::delivery::patches::read_codex_patch_files;
use crate::provider::driver::reorder_buffer::{ReorderBufferedEvent, ReorderPairingRole};
use crate::provider::record_readers::{read_count, read_non_empty_string};
use crate::session::run::epochs::DeliveryOperation;
use crate::session::run::inbound::rows::LateAppendableRow;
use crate::session::run::inbound::{DeliveryBinding, InboundDelivery};
use crate::text_cut::cut_to_code_points;
use crate::transcript::whole_patch::stored_patch_files_body;

/// The item type of a command a conversation runs, which can outlive the turn that started it.
pub(crate) const CODEX_COMMAND_ITEM_TYPE: &str = "commandExecution";

/// The item types that are a tool call, each with what its start and its end carry.
const CODEX_TOOL_ITEM_TYPES: [&str; 7] = [
    "commandExecution",
    "fileChange",
    "mcpToolCall",
    "dynamicToolCall",
    "collabAgentToolCall",
    "webSearch",
    "imageView",
];

/// A tool item's end that is a failure rather than a result.
const CODEX_FAILED_ITEM_STATUSES: [&str; 2] = ["failed", "declined"];

/// The run a turn's rows and flags belong to, the agent whose run it is, and the run's binding.
#[derive(Clone, Debug, PartialEq, Eq)]
#[expect(
    clippy::struct_field_names,
    reason = "each member is an id, named for what it identifies"
)]
pub(crate) struct CodexRowRun {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The run.
    pub(crate) run_id: RunId,
    /// The agent whose run it is.
    pub(crate) agent_id: AgentId,
    /// The binding the run's deliveries go on.
    pub(crate) binding_id: RuntimeBindingId,
}

/// A provider operation a row opens or continues, owned until the row is dispatched.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexRowOperation {
    /// The provider's key for the operation: the tool call's item id.
    pub(crate) correlation_key: String,
    /// Whether this is the operation's first delivery.
    pub(crate) is_opening: bool,
}

/// What a row is written as: a row that takes the stamp when late, or a reasoning update.
#[derive(Debug)]
pub(crate) enum CodexRow {
    /// A row the run engine stamps when it is late.
    Late(LateAppendableRow),
    /// A piece of the reasoning, whose text is the row's body.
    Thinking(RunAgentOutputPayload),
}

/// One row bound for the run engine, on the binding its run is attributed on.
#[derive(Debug)]
pub(crate) struct CodexRowDelivery {
    /// The binding.
    pub(crate) binding_id: RuntimeBindingId,
    /// The provider operation, where the row belongs to one.
    pub(crate) operation: Option<CodexRowOperation>,
    /// The row.
    pub(crate) row: CodexRow,
    /// The prose the row carries, stored beside its payload.
    pub(crate) body: Option<String>,
    /// The provider frame the row came from.
    pub(crate) method: &'static str,
}

impl CodexRowDelivery {
    /// The tool call a `tool.invoked` row opens, whose event a reviewer flag points at.
    pub(crate) fn invoked_tool_call_id(&self) -> Option<&str> {
        match &self.row {
            CodexRow::Late(LateAppendableRow::AgentToolCallInvoked(payload)) => {
                payload.tool_call_id.as_ref().map(FreeFormText::as_str)
            }
            CodexRow::Late(_) | CodexRow::Thinking(_) => None,
        }
    }
}

impl CodexRow {
    /// The run engine's delivery the row goes out as on `binding_id`, carrying `body` and
    /// borrowing the key of `operation`.
    pub(crate) fn into_inbound(
        self,
        binding_id: RuntimeBindingId,
        operation: Option<&CodexRowOperation>,
        body: Option<String>,
    ) -> InboundDelivery<'_> {
        let binding = DeliveryBinding {
            binding_id,
            operation: operation.map(|operation| DeliveryOperation {
                correlation_key: &operation.correlation_key,
                is_opening: operation.is_opening,
            }),
        };
        match self {
            Self::Thinking(payload) => InboundDelivery::ThinkingUpdate {
                binding,
                payload,
                content: body.unwrap_or_default(),
            },
            Self::Late(row) => InboundDelivery::SessionRow {
                binding,
                row,
                content: body,
            },
        }
    }
}

/// One row read from an item, with how the reorder buffer pairs it.
pub(crate) type CodexItemRow = ReorderBufferedEvent<CodexRowDelivery>;

/// The row type a streamed or finished piece of prose is written as.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CodexProseRowType {
    /// A reply, a review's report or a plan: `agent.message.sent`.
    Message,
    /// The reasoning: `agent.thinking.updated`.
    Thinking,
}

/// The prose a finished item carries and the row it is written as.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexItemProse {
    /// The row type.
    pub(crate) row_type: CodexProseRowType,
    /// The whole text.
    pub(crate) text: String,
}

/// Whether an item is one of the tool calls a turn's rows show.
pub(crate) fn is_codex_tool_item(item: &Map<String, Value>) -> bool {
    item_type(item).is_some_and(|item_type| CODEX_TOOL_ITEM_TYPES.contains(&item_type))
}

/// The item's `type`, when it carries one as text.
pub(crate) fn item_type(item: &Map<String, Value>) -> Option<&str> {
    item.get("type").and_then(Value::as_str)
}

/// The item an `item/started` or `item/completed` frame carries.
pub(crate) fn read_codex_frame_item(params: &Map<String, Value>) -> Option<&Map<String, Value>> {
    params.get("item").and_then(Value::as_object)
}

/// The row a tool item's start becomes, opening the call's operation; `None` for an item with no
/// id the transcript can hold.
pub(crate) fn read_codex_tool_start_row(
    item: &Map<String, Value>,
    run: &CodexRowRun,
    method: &'static str,
) -> Option<CodexItemRow> {
    let tool_call_id = read_non_empty_string(item, "id")?;
    let payload = tool_activity(item, run, tool_call_id, None)?;
    Some(ReorderBufferedEvent {
        tool_call_id: Some(tool_call_id.to_owned()),
        pairing_role: ReorderPairingRole::Initiation,
        event: CodexRowDelivery {
            binding_id: run.binding_id.clone(),
            operation: Some(CodexRowOperation {
                correlation_key: tool_call_id.to_owned(),
                is_opening: true,
            }),
            row: CodexRow::Late(LateAppendableRow::AgentToolCallInvoked(payload)),
            body: read_invocation_body(item),
            method,
        },
    })
}

/// The row a completed tool item becomes, its result or its failure; any other item adds none.
/// The duration is Codex's own, else the span between `started_at_ms` and `completed_at_ms`.
pub(crate) fn read_codex_item_completed_row(
    item: &Map<String, Value>,
    run: &CodexRowRun,
    method: &'static str,
    started_at_ms: Option<u64>,
    completed_at_ms: Option<u64>,
) -> Option<CodexItemRow> {
    let item_id = read_non_empty_string(item, "id")?;
    if !is_codex_tool_item(item) {
        return None;
    }
    let status = item.get("status").and_then(Value::as_str);
    let is_failed = status.is_some_and(|status| CODEX_FAILED_ITEM_STATUSES.contains(&status));
    let duration_ms = read_count(item, "durationMs").or_else(|| {
        started_at_ms
            .zip(completed_at_ms)
            .map(|(started, completed)| completed.saturating_sub(started))
    });
    let payload = tool_activity(item, run, item_id, duration_ms)?;
    let result = read_result_body(item);
    let (row, body) = if is_failed {
        (
            LateAppendableRow::AgentToolCallFailed(payload),
            result.or_else(|| status.map(str::to_owned)),
        )
    } else {
        (LateAppendableRow::AgentToolCallCompleted(payload), result)
    };
    Some(ReorderBufferedEvent {
        tool_call_id: Some(item_id.to_owned()),
        pairing_role: ReorderPairingRole::Completion,
        event: CodexRowDelivery {
            binding_id: run.binding_id.clone(),
            operation: Some(CodexRowOperation {
                correlation_key: item_id.to_owned(),
                is_opening: false,
            }),
            row: CodexRow::Late(row),
            body,
            method,
        },
    })
}

/// The prose a finished item carries and the row it is written as: a reply, a review's report or
/// a plan as a message, the reasoning as a thinking update; `None` for any other item.
pub(crate) fn read_codex_item_prose(item: &Map<String, Value>) -> Option<CodexItemProse> {
    let message = |member: &str| {
        item.get(member)
            .and_then(Value::as_str)
            .map(|text| CodexItemProse {
                row_type: CodexProseRowType::Message,
                text: text.to_owned(),
            })
    };
    match item_type(item)? {
        "reasoning" => Some(CodexItemProse {
            row_type: CodexProseRowType::Thinking,
            text: read_reasoning_text(item).unwrap_or_default(),
        }),
        "agentMessage" | "plan" => message("text"),
        "exitedReviewMode" => message("review"),
        _ => None,
    }
}

/// One piece of an item's prose as its row, keyed by the item it came from; `None` for an item id
/// the transcript cannot hold.
pub(crate) fn compose_codex_prose_piece(
    run: &CodexRowRun,
    item_id: &str,
    row_type: CodexProseRowType,
    piece: String,
    method: &'static str,
) -> Option<CodexItemRow> {
    let payload = RunAgentOutputPayload {
        session_id: run.session_id,
        provider_message_id: event_text(item_id)?,
        content_type: None,
        content_length: None,
        content_truncated: None,
        run_id: run.run_id,
        origin: None,
        source_epoch: None,
        source_position: None,
    };
    let row = match row_type {
        CodexProseRowType::Message => CodexRow::Late(LateAppendableRow::AgentMessageSent(payload)),
        CodexProseRowType::Thinking => CodexRow::Thinking(payload),
    };
    Some(ReorderBufferedEvent {
        tool_call_id: None,
        pairing_role: ReorderPairingRole::Unpaired,
        event: CodexRowDelivery {
            binding_id: run.binding_id.clone(),
            operation: None,
            row,
            body: Some(piece),
            method,
        },
    })
}

/// Text an event field holds, cut to the field's cap; `None` for text that is blank or holds NUL.
pub(crate) fn event_text(text: &str) -> Option<FreeFormText<EVENT_FIELD_MAX_LEN>> {
    FreeFormText::new(cut_to_code_points(text, EVENT_FIELD_MAX_LEN).to_owned()).ok()
}

fn tool_activity(
    item: &Map<String, Value>,
    run: &CodexRowRun,
    tool_call_id: &str,
    duration_ms: Option<u64>,
) -> Option<ToolActivityPayload> {
    Some(ToolActivityPayload {
        session_id: run.session_id,
        run_id: run.run_id,
        tool_name: event_text(read_tool_name(item))?,
        tool_call_id: Some(event_text(tool_call_id)?),
        duration_ms: duration_ms.and_then(SafeInt::new),
        content_length: None,
        content_truncated: None,
        source_epoch: None,
        source_position: None,
    })
}

// A tool server's, a daemon tool's or a helper tool's own name, else the item's type.
fn read_tool_name(item: &Map<String, Value>) -> &str {
    let item_type = item_type(item).unwrap_or_default();
    match item_type {
        "mcpToolCall" | "dynamicToolCall" | "collabAgentToolCall" => {
            read_non_empty_string(item, "tool").unwrap_or(item_type)
        }
        _ => item_type,
    }
}

// A member as the row's prose: text as it is, any other value as its JSON, none when absent.
fn stringify(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::Null => None,
        Value::String(text) => Some(text.clone()),
        other @ (Value::Bool(_) | Value::Number(_) | Value::Array(_) | Value::Object(_)) => {
            Some(other.to_string())
        }
    }
}

// What a tool call's start shows: the command, the files, or the arguments it was called with.
fn read_invocation_body(item: &Map<String, Value>) -> Option<String> {
    match item_type(item)? {
        "commandExecution" => stringify(item.get("command")),
        "fileChange" => {
            let paths: Vec<String> = read_codex_patch_files(item)
                .iter()
                .map(|file| file.path().as_str().to_owned())
                .collect();
            Some(Value::from(paths).to_string())
        }
        "webSearch" => stringify(item.get("query")),
        "imageView" => stringify(item.get("path")),
        "collabAgentToolCall" => stringify(item.get("prompt")),
        _ => stringify(item.get("arguments")),
    }
}

// What a tool call's end shows: the output, the patches in the shape the patch read answers, or
// the result or error the tool returned.
fn read_result_body(item: &Map<String, Value>) -> Option<String> {
    match item_type(item)? {
        "commandExecution" => stringify(item.get("aggregatedOutput")),
        "fileChange" => Some(stored_patch_files_body(&read_codex_patch_files(item))),
        "mcpToolCall" => stringify(
            item.get("error")
                .filter(|error| !error.is_null())
                .or_else(|| item.get("result")),
        ),
        "dynamicToolCall" => stringify(item.get("contentItems")),
        _ => None,
    }
}

// The reasoning's text: its summaries, which are what the model gives, else its raw parts.
fn read_reasoning_text(item: &Map<String, Value>) -> Option<String> {
    ["summary", "content"].into_iter().find_map(|member| {
        let parts: Vec<&str> = item
            .get(member)?
            .as_array()?
            .iter()
            .filter_map(Value::as_str)
            .filter(|part| !part.is_empty())
            .collect();
        (!parts.is_empty()).then(|| parts.join("\n\n"))
    })
}

/// A run on a fresh session, agent and binding, for a test's rows.
#[cfg(test)]
pub(crate) fn test_row_run() -> CodexRowRun {
    use sidekicks_contracts::wire::id::mint_uuid_v7;

    CodexRowRun {
        session_id: SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id"),
        run_id: RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id"),
        agent_id: AgentId::try_from(mint_uuid_v7()).expect("a minted UUID is an agent id"),
        binding_id: RuntimeBindingId::new(mint_uuid_v7().to_string())
            .expect("a UUID is a binding id"),
    }
}
