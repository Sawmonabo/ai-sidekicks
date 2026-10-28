//! The routing facts of one stream frame Claude Code writes on its output: its kind, the helper it
//! came from, a helper's start and end, the turn's cumulative usage, the `system/init` declaration,
//! the compaction boundary, and a start-up hook's start or end. The frame is untrusted, so it is
//! read once into a struct naming only these members, each leniently: an absent or malformed one
//! reads as absent, and every other member is skipped unread.

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::value::RawValue;

use crate::driver::claude::event_normalizer::{
    ClaudeSubagentLifecycleSignal, ClaudeSubagentSignal, compose_claude_wire_frame_kind,
    is_claude_result_frame_kind,
};
use crate::driver::claude::session::transport::declarations::{
    ClaudeCompactionBoundaryObservation, ClaudeCumulativeUsageObservation,
    ClaudeFastModeDeclaration, ClaudeHandshakeDeclaration, ClaudeInboundFrameObservation,
};
use crate::lenient_json::{Lenient, LenientElement, LenientList, lenient_object, read_lenient};
use crate::usage_delta_accountant::UsageAxisCounts;

// The `task_type` of a task that is a helper; a background command is another kind of task.
const CLAUDE_HELPER_TASK_TYPE: &str = "local_agent";

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
    #[serde(rename = "modelUsage", default)]
    model_usage: Option<Box<RawValue>>,
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

// One model's spend on a `result`, each member as sent.
#[derive(Deserialize)]
#[expect(
    clippy::struct_field_names,
    reason = "the members carry Claude Code's own names"
)]
struct ModelUsage {
    #[serde(rename = "inputTokens", default)]
    input_tokens: Option<Box<RawValue>>,
    #[serde(rename = "cacheReadInputTokens", default)]
    cache_read_input_tokens: Option<Box<RawValue>>,
    #[serde(rename = "cacheCreationInputTokens", default)]
    cache_creation_input_tokens: Option<Box<RawValue>>,
    #[serde(rename = "outputTokens", default)]
    output_tokens: Option<Box<RawValue>>,
}

lenient_object!(ClaudeStreamFrameRead, ModelUsage);

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
    /// shown as the lead's.
    pub(crate) fn into_observation(self) -> ClaudeInboundFrameObservation {
        let frame_kind =
            compose_claude_wire_frame_kind(self.frame_type(), self.subtype.as_deref()).into_owned();
        let cumulative_usage = is_claude_result_frame_kind(&frame_kind)
            .then(|| read_result_usage(self.model_usage.as_deref()))
            .flatten()
            .map(|cumulative| ClaudeCumulativeUsageObservation {
                named_turn_id: None,
                cumulative,
                declared_per_turn: None,
            });
        let subagent_lifecycle = self.read_helper_lifecycle(&frame_kind);
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
            subagent_lifecycle,
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
        })
    }
}

// The turn's spend summed over every model it used; `modelUsage` on a `result` is cumulative for
// the process, so the accountant differences one reading from the last.
fn read_result_usage(model_usage: Option<&RawValue>) -> Option<UsageAxisCounts> {
    let per_model: BTreeMap<String, LenientElement<ModelUsage>> =
        serde_json::from_str(model_usage?.get()).ok()?;
    if per_model.is_empty() {
        return None;
    }
    let mut sums = UsageAxisCounts::default();
    for usage in per_model.into_values().filter_map(|element| element.0) {
        add_count(&mut sums.input, usage.input_tokens.as_deref());
        add_count(
            &mut sums.cached_input,
            usage.cache_read_input_tokens.as_deref(),
        );
        add_count(
            &mut sums.cache_write_input,
            usage.cache_creation_input_tokens.as_deref(),
        );
        add_count(&mut sums.output, usage.output_tokens.as_deref());
    }
    Some(sums)
}

// Adds one member's count to its axis; a member that is no whole count is skipped.
fn add_count(axis: &mut Option<u64>, member: Option<&RawValue>) {
    if let Some(count) = member.and_then(|member| serde_json::from_str::<u64>(member.get()).ok()) {
        *axis = Some(axis.unwrap_or(0).saturating_add(count));
    }
}

fn list_of(list: Option<&LenientList<String>>) -> Vec<String> {
    list.map(|list| list.0.clone()).unwrap_or_default()
}

fn non_empty(text: Option<String>) -> Option<String> {
    text.filter(|text| !text.is_empty())
}
