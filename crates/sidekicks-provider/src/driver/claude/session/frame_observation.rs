//! The routing facts of one stream frame Claude Code writes on its output: its kind, the helper it
//! came from, a helper's start, move to the background and end, the tool calls a `user` frame's
//! results answer, an assistant message's usage and a turn's own usage, the `system/init`
//! declaration with its MCP servers' readings and a later whole `/` list, the compaction boundary,
//! and a start-up hook's start or end. The frame is untrusted, so it is read once into a struct
//! naming only these members, each leniently: an absent or malformed one reads as absent, and
//! every other member is skipped unread. `modelUsage`, the process's sum over every thread, is
//! never read.

use serde::Deserialize;
use serde_json::Value;
use serde_json::value::RawValue;

use crate::driver::claude::delivery::commands::CLAUDE_HELPER_TASK_TYPE;
use crate::driver::claude::event_normalizer::{
    ClaudeSubagentLifecycleSignal, ClaudeSubagentSignal, compose_claude_wire_frame_kind,
    is_claude_result_frame_kind,
};
use crate::driver::claude::session::transport::declarations::{
    ClaudeCompactionBoundaryObservation, ClaudeCumulativeUsageObservation,
    ClaudeFastModeDeclaration, ClaudeHandshakeDeclaration, ClaudeInboundFrameObservation,
    ClaudeMessageUsageObservation,
};
use crate::driver::claude::tools::normalize_claude_mcp_server_init_census;
use crate::lenient_json::{Lenient, LenientList, lenient_object, read_lenient};
use crate::usage_delta_accountant::UsageAxisCounts;

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
    is_backgrounded: Option<bool>,
    #[serde(default, deserialize_with = "read_lenient")]
    patch: Option<ClaudeTaskPatch>,
    #[serde(default, deserialize_with = "read_lenient")]
    message: Option<ClaudeFrameMessage>,
    #[serde(default, deserialize_with = "read_lenient")]
    usage: Option<ClaudeTokenUsage>,
    #[serde(default, deserialize_with = "read_lenient")]
    commands: Option<LenientList<ClaudeListedCommand>>,
    #[serde(default, deserialize_with = "read_lenient")]
    slash_commands: Option<LenientList<String>>,
    #[serde(default, deserialize_with = "read_lenient")]
    skills: Option<LenientList<String>>,
    #[serde(default, deserialize_with = "read_lenient")]
    terminal_slash_commands: Option<LenientList<String>>,
    #[serde(default, deserialize_with = "read_lenient")]
    capabilities: Option<LenientList<String>>,
    #[serde(rename = "permissionMode", default, deserialize_with = "read_lenient")]
    permission_mode: Option<String>,
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
}

// A message as its frame carries it: an assistant message's id and usage so far, and the blocks
// of either.
#[derive(Deserialize)]
struct ClaudeFrameMessage {
    #[serde(default, deserialize_with = "read_lenient")]
    id: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    usage: Option<ClaudeTokenUsage>,
    #[serde(default, deserialize_with = "read_lenient")]
    content: Option<LenientList<ClaudeResultBlock>>,
}

// A content block, read only for a tool result's call; the result's own content is skipped
// unread, since it can be a whole file.
#[derive(Deserialize)]
struct ClaudeResultBlock {
    #[serde(rename = "type", default, deserialize_with = "read_lenient")]
    block_type: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    tool_use_id: Option<String>,
}

// What a `task_updated` frame changes of its task.
#[derive(Deserialize)]
struct ClaudeTaskPatch {
    #[serde(default, deserialize_with = "read_lenient")]
    is_backgrounded: Option<bool>,
}

// A message's or a turn's token counts, each member as sent.
#[derive(Deserialize)]
#[expect(
    clippy::struct_field_names,
    reason = "the members carry Claude Code's own names"
)]
struct ClaudeTokenUsage {
    #[serde(default)]
    input_tokens: Option<Box<RawValue>>,
    #[serde(default)]
    cache_read_input_tokens: Option<Box<RawValue>>,
    #[serde(default)]
    cache_creation_input_tokens: Option<Box<RawValue>>,
    #[serde(default)]
    output_tokens: Option<Box<RawValue>>,
}

// One entry of a whole `/` list.
#[derive(Deserialize)]
struct ClaudeListedCommand {
    #[serde(default, deserialize_with = "read_lenient")]
    name: Option<String>,
}

lenient_object!(
    ClaudeStreamFrameRead,
    ClaudeFrameMessage,
    ClaudeResultBlock,
    ClaudeTaskPatch,
    ClaudeTokenUsage,
    ClaudeListedCommand
);

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
        let hook_id = non_empty(self.hook_id.clone())?;
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
                Some(ClaudeMessageUsageObservation {
                    message_id: non_empty(message.id.clone())?,
                    counts: read_token_counts(message.usage.as_ref()?)?,
                })
            });
        let commands_changed = (frame_kind == "system/commands_changed")
            .then_some(self.commands.as_ref())
            .flatten()
            .map(|commands| {
                commands
                    .0
                    .iter()
                    .filter_map(|command| non_empty(command.name.clone()))
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
                    .filter_map(|block| non_empty(block.tool_use_id.clone()))
                    .collect()
            })
            .unwrap_or_default();
        let backgrounded_helper_id = (frame_kind == "system/task_updated"
            && self.patch.as_ref().and_then(|patch| patch.is_backgrounded) == Some(true))
        .then(|| non_empty(self.task_id.clone()))
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
        ClaudeInboundFrameObservation {
            subagent_id: non_empty(self.agent_id).or_else(|| non_empty(self.parent_tool_use_id)),
            frame_kind,
            cumulative_usage,
            message_usage,
            commands_changed,
            subagent_lifecycle,
            backgrounded_helper_id,
            answered_call_ids,
            handshake,
            compaction_boundary,
        }
    }

    fn read_handshake(&self) -> ClaudeHandshakeDeclaration {
        ClaudeHandshakeDeclaration {
            fast_mode: ClaudeFastModeDeclaration {
                fast_mode_state: non_empty(self.fast_mode_state.clone()),
                fast_mode_disabled_reason: non_empty(self.fast_mode_disabled_reason.clone()),
            },
            slash_commands: list_of(self.slash_commands.as_ref()),
            skills: list_of(self.skills.as_ref()),
            terminal_slash_commands: list_of(self.terminal_slash_commands.as_ref()),
            capabilities: list_of(self.capabilities.as_ref()),
            permission_mode: non_empty(self.permission_mode.clone()),
            mcp_servers: self
                .mcp_servers
                .as_ref()
                .map(normalize_claude_mcp_server_init_census),
        }
    }

    // A helper's start from its `task_started`, and its end from the `task_notification` of the
    // task the frame names; a background command's task reads as no helper.
    fn read_helper_lifecycle(&self, frame_kind: &str) -> Option<ClaudeSubagentLifecycleSignal> {
        let subagent_id = non_empty(self.task_id.clone())?;
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
            parent_tool_use_id: non_empty(self.tool_use_id.clone()),
            parent_task_id: non_empty(self.parent_task_id.clone()),
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

// One member's count; a member that is no whole count reads as absent.
fn read_count(member: Option<&RawValue>) -> Option<u64> {
    member.and_then(|member| serde_json::from_str::<u64>(member.get()).ok())
}

fn list_of(list: Option<&LenientList<String>>) -> Vec<String> {
    list.map(|list| list.0.clone()).unwrap_or_default()
}

fn non_empty(text: Option<String>) -> Option<String> {
    text.filter(|text| !text.is_empty())
}
