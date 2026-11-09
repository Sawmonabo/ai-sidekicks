//! The routing facts of one stream frame Claude Code writes on its output: its kind, the helper it
//! came from, a helper's start, move to the background and end, the tool calls a `user` frame's
//! results answer, the `SendMessage` calls and the daemon's own tool calls an assistant frame
//! makes, an assistant message's usage with what prices its request and a result's own usage and
//! cost per model, the `system/init` declaration with its MCP servers' readings and a later whole
//! `/` list, the compaction boundary, and a start-up hook's start or end. The frame is untrusted,
//! so it is read once into a struct naming only these members, each leniently: an absent or
//! malformed one reads as absent, and every other member is skipped unread. A `result`'s cost per
//! model is its `model_usage_since_last_result`, each model's counts and cost since the process's
//! previous result; `modelUsage`, the process's running total, is never read.
use std::fmt;
use std::marker::PhantomData;

use serde::de::{MapAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::Value;
use serde_json::value::RawValue;
use sidekicks_contracts::wire::text::{BoundedText, FreeFormText};

use crate::driver::claude::capabilities::without_larger_window_mark;
use crate::driver::claude::delivery::commands::CLAUDE_HELPER_TASK_TYPE;
use crate::driver::claude::event_normalizer::{
    ClaudeSubagentLifecycleSignal, ClaudeSubagentSignal, compose_claude_wire_frame_kind,
    is_claude_result_frame_kind,
};
use crate::driver::claude::hooks::registration::CLAUDE_MESSAGE_TOOL_NAME;
use crate::driver::claude::session::transport::declarations::{
    ClaudeCompactionBoundaryObservation, ClaudeCumulativeUsageObservation,
    ClaudeFastModeDeclaration, ClaudeHandshakeDeclaration, ClaudeInboundFrameObservation,
    ClaudeMessageRequestFacts, ClaudeMessageUsageObservation, ClaudeModelCost,
};
use crate::driver::claude::tools::normalize_claude_mcp_server_init_census;
use crate::lenient_json::{
    Lenient, LenientElement, LenientList, LenientVisitor, lenient_object, read_lenient,
    skip_other_shapes,
};
use crate::mcp::tool_name::TOOL_SERVER_TOOL_PREFIX;
use crate::record_readers::filter_non_empty;
use crate::tool_server_name::DAEMON_TOOL_SERVER_NAME;
use crate::usage_delta_accountant::UsageAxisCounts;

// The `inference_geo` words that name no region: `global`, and `not_available`, which Claude Code
// sends on most requests and prices at the base rate.
const CLAUDE_NO_REGION_WORDS: [&str; 2] = ["global", "not_available"];

// The hook events whose run Claude Code reports while it starts, which `initialize`'s wait does
// not count.
const CLAUDE_STARTUP_HOOK_EVENTS: [&str; 2] = ["SessionStart", "Setup"];

/// A start-up hook's run as one frame reports it, by the hook's id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeStartupHookChange {
    /// A `SessionStart` or `Setup` hook began.
    Started(String),
    /// A hook ended; it counts only when its start was counted.
    Ended(String),
}

/// One stream frame, read once: what routes it, and what the process's own reader needs.
#[derive(Deserialize)]
pub(crate) struct ClaudeStreamFrameRead {
    #[serde(rename = "type", default, deserialize_with = "read_lenient")]
    frame_type: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    subtype: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    agent_id: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    parent_tool_use_id: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    task_id: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    task_type: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    tool_use_id: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    parent_task_id: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    subagent_type: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    is_backgrounded: Option<bool>,
    #[serde(default, deserialize_with = "read_lenient")]
    patch: Option<ClaudeTaskPatch>,
    #[serde(default, deserialize_with = "read_lenient")]
    message: Option<ClaudeFrameMessage>,
    #[serde(default, deserialize_with = "read_lenient")]
    usage: Option<ClaudeTokenUsage>,
    #[serde(default, deserialize_with = "read_lenient")]
    commands: Option<LenientList<ClaudeChangedCommand>>,
    #[serde(default, deserialize_with = "read_lenient")]
    slash_commands: Option<LenientList<String>>,
    #[serde(default, deserialize_with = "read_lenient")]
    skills: Option<LenientList<String>>,
    #[serde(default, deserialize_with = "read_lenient")]
    terminal_slash_commands: Option<LenientList<String>>,
    #[serde(default, deserialize_with = "read_lenient")]
    capabilities: Option<LenientList<String>>,
    #[serde(default)]
    mcp_servers: Option<Value>,
    #[serde(default, deserialize_with = "read_lenient")]
    fast_mode_state: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    fast_mode_disabled_reason: Option<String>,
    #[serde(default)]
    compact_metadata: Option<Box<RawValue>>,
    #[serde(default, deserialize_with = "read_lenient")]
    hook_id: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    hook_event: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    model_usage_since_last_result: Option<ClaudeModelUsage>,
}

// A `result`'s `model_usage_since_last_result`: each model's entry that reads as an object, in the
// frame's order.
struct ClaudeModelUsage(Vec<(String, ClaudeModelUsageEntry)>);

// One model's entry: its counts, its cost and that cost's basis.
#[derive(Deserialize)]
struct ClaudeModelUsageEntry {
    #[serde(rename = "inputTokens", default)]
    input_tokens: Option<Box<RawValue>>,
    #[serde(rename = "cacheReadInputTokens", default)]
    cache_read_input_tokens: Option<Box<RawValue>>,
    #[serde(rename = "cacheCreationInputTokens", default)]
    cache_creation_input_tokens: Option<Box<RawValue>>,
    #[serde(rename = "outputTokens", default)]
    output_tokens: Option<Box<RawValue>>,
    #[serde(rename = "webSearchRequests", default)]
    web_search_requests: Option<Box<RawValue>>,
    #[serde(rename = "costUSD", default, deserialize_with = "read_lenient")]
    cost_usd: Option<f64>,
    #[serde(rename = "costBasis", default, deserialize_with = "read_lenient")]
    cost_basis: Option<String>,
}

// A message as its frame carries it: an assistant message's id, model and usage so far, and the
// blocks of either.
#[derive(Deserialize)]
struct ClaudeFrameMessage {
    #[serde(default, deserialize_with = "read_lenient")]
    id: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    model: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    usage: Option<ClaudeTokenUsage>,
    #[serde(default, deserialize_with = "read_lenient")]
    content: Option<LenientList<ClaudeContentBlock>>,
}

// A content block, read only for a tool call's id and tool and a tool result's call; the result's
// own content and the call's input are skipped unread, since either can be a whole file.
#[derive(Deserialize)]
struct ClaudeContentBlock {
    #[serde(rename = "type", default, deserialize_with = "read_lenient")]
    block_type: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    id: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    name: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    tool_use_id: Option<String>,
}

// What a `task_updated` frame changes of its task.
#[derive(Deserialize)]
struct ClaudeTaskPatch {
    #[serde(default, deserialize_with = "read_lenient")]
    is_backgrounded: Option<bool>,
}

// A message's or a turn's token counts, each member as sent, and what prices a message's request.
#[derive(Deserialize)]
struct ClaudeTokenUsage {
    #[serde(default)]
    input_tokens: Option<Box<RawValue>>,
    #[serde(default)]
    cache_read_input_tokens: Option<Box<RawValue>>,
    #[serde(default)]
    cache_creation_input_tokens: Option<Box<RawValue>>,
    #[serde(default)]
    output_tokens: Option<Box<RawValue>>,
    #[serde(default, deserialize_with = "read_lenient")]
    speed: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    inference_geo: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    cache_creation: Option<ClaudeCacheCreation>,
    #[serde(default, deserialize_with = "read_lenient")]
    server_tool_use: Option<ClaudeServerToolUse>,
}

// The cache write by lifetime, read only for its longer-lifetime part.
#[derive(Deserialize)]
struct ClaudeCacheCreation {
    #[serde(default)]
    ephemeral_1h_input_tokens: Option<Box<RawValue>>,
}

// The server tools a message ran, read only for its web searches.
#[derive(Deserialize)]
struct ClaudeServerToolUse {
    #[serde(default)]
    web_search_requests: Option<Box<RawValue>>,
}

// One entry of the whole `/` list a `system/commands_changed` frame carries.
#[derive(Deserialize)]
struct ClaudeChangedCommand {
    #[serde(default, deserialize_with = "read_lenient")]
    name: Option<String>,
}

lenient_object!(
    ClaudeStreamFrameRead,
    ClaudeFrameMessage,
    ClaudeContentBlock,
    ClaudeTaskPatch,
    ClaudeTokenUsage,
    ClaudeCacheCreation,
    ClaudeServerToolUse,
    ClaudeChangedCommand,
    ClaudeModelUsageEntry
);

impl<'de> Visitor<'de> for LenientVisitor<ClaudeModelUsage> {
    type Value = Option<ClaudeModelUsage>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("any JSON value")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut entries = Vec::new();
        while let Some((model, entry)) =
            map.next_entry::<String, LenientElement<ClaudeModelUsageEntry>>()?
        {
            entries.extend(entry.0.map(|entry| (model, entry)));
        }
        Ok(Some(ClaudeModelUsage(entries)))
    }

    skip_other_shapes!(
        visit_bool(bool),
        visit_str(&str),
        visit_i64(i64),
        visit_u64(u64),
        visit_f64(f64),
        visit_unit()
    );
    skip_other_shapes!(@seq);
}

impl Lenient for ClaudeModelUsage {
    fn read<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Self>, D::Error> {
        deserializer.deserialize_any(LenientVisitor::<Self>(PhantomData))
    }
}

impl ClaudeStreamFrameRead {
    /// Reads one output line's text; `None` when it is not a JSON object, which is no frame.
    pub(crate) fn read(text: &str) -> Option<Self> {
        let mut deserializer = serde_json::Deserializer::from_str(text);
        <Self as Lenient>::read(&mut deserializer)
            .ok()
            .flatten()
            .filter(|_| deserializer.end().is_ok())
    }

    /// The frame's `type`, empty when it names none.
    pub(crate) fn frame_type(&self) -> &str {
        self.frame_type.as_deref().unwrap_or_default()
    }

    /// The start-up hook run the frame reports, if it reports one.
    pub(crate) fn startup_hook_change(&self) -> Option<ClaudeStartupHookChange> {
        if self.frame_type() != "system" {
            return None;
        }
        let hook_id = filter_non_empty(self.hook_id.clone())?;
        match self.subtype.as_deref() {
            Some("hook_started")
                if self
                    .hook_event
                    .as_deref()
                    .is_some_and(|event| CLAUDE_STARTUP_HOOK_EVENTS.contains(&event)) =>
            {
                Some(ClaudeStartupHookChange::Started(hook_id))
            }
            Some("hook_response") => Some(ClaudeStartupHookChange::Ended(hook_id)),
            Some(_) | None => None,
        }
    }

    /// The observation the session routes the frame by. A helper's own frames carry its id as
    /// `agent_id`, the id its `task_started` registered; a frame that names only
    /// `parent_tool_use_id` names no registered helper, so it is held and then refused, never
    /// shown as the lead's. A `result`'s usage reading is its turn's own `usage`, which is the
    /// process's whole spend only for a process that runs one turn; routing folds it into the
    /// thread's sum of its messages.
    pub(crate) fn into_observation(self) -> ClaudeInboundFrameObservation {
        let frame_kind =
            compose_claude_wire_frame_kind(self.frame_type(), self.subtype.as_deref()).into_owned();
        let cumulative_usage = is_claude_result_frame_kind(&frame_kind)
            .then(|| self.usage.as_ref().and_then(read_token_counts))
            .flatten()
            .map(|cumulative| ClaudeCumulativeUsageObservation {
                named_turn_id: None,
                cumulative,
                declared_per_turn: None,
            });
        let message_usage = (frame_kind == "assistant")
            .then_some(self.message.as_ref())
            .flatten()
            .and_then(|message| {
                let usage = message.usage.as_ref()?;
                Some(ClaudeMessageUsageObservation {
                    message_id: filter_non_empty(message.id.clone())?,
                    counts: read_token_counts(usage)?,
                    request: read_request_facts(message.model.as_deref(), usage),
                })
            });
        let commands_changed = (frame_kind == "system/commands_changed")
            .then_some(self.commands.as_ref())
            .flatten()
            .map(|commands| {
                commands
                    .0
                    .iter()
                    .filter_map(|command| filter_non_empty(command.name.clone()))
                    .collect()
            });
        let subagent_lifecycle = self.read_helper_lifecycle(&frame_kind);
        let answered_call_ids = (frame_kind == "user")
            .then(|| self.message.as_ref()?.content.as_ref())
            .flatten()
            .map(|content| {
                content
                    .0
                    .iter()
                    .filter(|block| block.block_type.as_deref() == Some("tool_result"))
                    .filter_map(|block| filter_non_empty(block.tool_use_id.clone()))
                    .collect()
            })
            .unwrap_or_default();
        let message_call_ids =
            self.tool_call_ids(&frame_kind, |name| name == CLAUDE_MESSAGE_TOOL_NAME);
        let daemon_tool_call_ids = self.tool_call_ids(&frame_kind, |name| {
            name.strip_prefix(TOOL_SERVER_TOOL_PREFIX)
                .and_then(|rest| rest.strip_prefix(DAEMON_TOOL_SERVER_NAME))
                .is_some_and(|tool| tool.starts_with("__"))
        });
        let backgrounded_helper_id = (frame_kind == "system/task_updated"
            && self.patch.as_ref().and_then(|patch| patch.is_backgrounded) == Some(true))
        .then(|| filter_non_empty(self.task_id.clone()))
        .flatten();
        let handshake = (frame_kind == "system/init").then(|| self.read_handshake());
        let compaction_boundary = (frame_kind == "system/compact_boundary"
            && self
                .compact_metadata
                .as_deref()
                .is_some_and(|metadata| metadata.get().starts_with('{')))
        .then_some(ClaudeCompactionBoundaryObservation {
            boundary_position: None,
        });
        let model_costs = is_claude_result_frame_kind(&frame_kind)
            .then_some(self.model_usage_since_last_result)
            .flatten()
            .map(|usage| usage.0.into_iter().filter_map(read_model_cost).collect());
        ClaudeInboundFrameObservation {
            subagent_id: filter_non_empty(self.agent_id)
                .or_else(|| filter_non_empty(self.parent_tool_use_id)),
            frame_kind,
            cumulative_usage,
            message_usage,
            commands_changed,
            subagent_lifecycle,
            backgrounded_helper_id,
            answered_call_ids,
            message_call_ids,
            daemon_tool_call_ids,
            handshake,
            compaction_boundary,
            model_costs,
        }
    }

    // The ids of the tool calls an assistant frame makes to a tool whose name `is_named` takes.
    fn tool_call_ids(&self, frame_kind: &str, is_named: impl Fn(&str) -> bool) -> Vec<String> {
        (frame_kind == "assistant")
            .then(|| self.message.as_ref()?.content.as_ref())
            .flatten()
            .map(|content| {
                content
                    .0
                    .iter()
                    .filter(|block| {
                        block.block_type.as_deref() == Some("tool_use")
                            && block.name.as_deref().is_some_and(&is_named)
                    })
                    .filter_map(|block| filter_non_empty(block.id.clone()))
                    .collect()
            })
            .unwrap_or_default()
    }

    fn read_handshake(&self) -> ClaudeHandshakeDeclaration {
        ClaudeHandshakeDeclaration {
            fast_mode: ClaudeFastModeDeclaration {
                fast_mode_state: filter_non_empty(self.fast_mode_state.clone()),
                fast_mode_disabled_reason: filter_non_empty(self.fast_mode_disabled_reason.clone()),
            },
            slash_commands: list_of(self.slash_commands.as_ref()),
            skills: list_of(self.skills.as_ref()),
            terminal_slash_commands: list_of(self.terminal_slash_commands.as_ref()),
            capabilities: list_of(self.capabilities.as_ref()),
            mcp_servers: self
                .mcp_servers
                .as_ref()
                .map(normalize_claude_mcp_server_init_census),
        }
    }

    // A helper's start from its `task_started`, and its end from the `task_notification` of the
    // task the frame names; a background command's task reads as no helper.
    fn read_helper_lifecycle(&self, frame_kind: &str) -> Option<ClaudeSubagentLifecycleSignal> {
        let subagent_id = filter_non_empty(self.task_id.clone())?;
        let signal = match frame_kind {
            "system/task_started" if self.task_type.as_deref() == Some(CLAUDE_HELPER_TASK_TYPE) => {
                ClaudeSubagentSignal::SubagentStart
            }
            "system/task_notification" => ClaudeSubagentSignal::SubagentStop,
            _ => return None,
        };
        Some(ClaudeSubagentLifecycleSignal {
            signal,
            subagent_id,
            parent_tool_use_id: filter_non_empty(self.tool_use_id.clone()),
            parent_task_id: filter_non_empty(self.parent_task_id.clone()),
            subagent_type: (signal == ClaudeSubagentSignal::SubagentStart)
                .then(|| filter_non_empty(self.subagent_type.clone()))
                .flatten(),
            is_foreground: self.is_backgrounded == Some(false),
        })
    }
}

// The counts a message's or a turn's `usage` carries; `None` where it carries none.
fn read_token_counts(usage: &ClaudeTokenUsage) -> Option<UsageAxisCounts> {
    let counts = UsageAxisCounts {
        input: read_count(usage.input_tokens.as_deref()),
        cached_input: read_count(usage.cache_read_input_tokens.as_deref()),
        cache_write_input: read_count(usage.cache_creation_input_tokens.as_deref()),
        output: read_count(usage.output_tokens.as_deref()),
        reasoning_output: None,
        total: None,
    };
    (counts != UsageAxisCounts::default()).then_some(counts)
}

// What prices a message's request: its model without the larger-window mark, its speed as given,
// its region where it names one other than `global` or `not_available`, and its longer-lifetime
// cache write and web searches so far. A text that does not fit its type reads as absent.
fn read_request_facts(model: Option<&str>, usage: &ClaudeTokenUsage) -> ClaudeMessageRequestFacts {
    ClaudeMessageRequestFacts {
        model_id: model
            .and_then(|model| FreeFormText::new(without_larger_window_mark(model).to_owned()).ok()),
        speed: usage.speed.clone().and_then(BoundedText::new),
        processing_region: usage
            .inference_geo
            .clone()
            .filter(|region| !CLAUDE_NO_REGION_WORDS.contains(&region.as_str()))
            .and_then(BoundedText::new),
        cache_write_extended_tokens: usage.cache_creation.as_ref().and_then(|cache_creation| {
            read_count(cache_creation.ephemeral_1h_input_tokens.as_deref())
        }),
        web_search_requests: usage
            .server_tool_use
            .as_ref()
            .and_then(|server_tool_use| read_count(server_tool_use.web_search_requests.as_deref())),
    }
}

// One model's counts and cost, at the model as the stream reads its messages' model, without the
// larger-window mark; `None` for a model id that does not fit.
fn read_model_cost((model, entry): (String, ClaudeModelUsageEntry)) -> Option<ClaudeModelCost> {
    Some(ClaudeModelCost {
        model_id: FreeFormText::new(without_larger_window_mark(&model).to_owned()).ok()?,
        counts: UsageAxisCounts {
            input: read_count(entry.input_tokens.as_deref()),
            cached_input: read_count(entry.cache_read_input_tokens.as_deref()),
            cache_write_input: read_count(entry.cache_creation_input_tokens.as_deref()),
            output: read_count(entry.output_tokens.as_deref()),
            reasoning_output: None,
            total: None,
        },
        web_search_requests: read_count(entry.web_search_requests.as_deref()),
        cost_usd: entry.cost_usd,
        cost_basis: entry.cost_basis,
    })
}

// One member's count; a member that is no whole count reads as absent.
fn read_count(member: Option<&RawValue>) -> Option<u64> {
    member.and_then(|member| serde_json::from_str::<u64>(member.get()).ok())
}

fn list_of(list: Option<&LenientList<String>>) -> Vec<String> {
    list.map(|list| list.0.clone()).unwrap_or_default()
}
