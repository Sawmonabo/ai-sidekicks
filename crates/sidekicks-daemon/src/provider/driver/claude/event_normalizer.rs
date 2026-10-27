//! The Claude Code half of the driver's normalize boundary: the pinned census of stream-json and
//! control-channel frame kinds, each kind's routing family, and the helper lifecycle signals. The
//! stream reader decides each census kind's rows by matching on it.
//!
//! Left out of the census, so the router quarantines and reports them instead of a guessed row:
//! `queued_notification` (daemon-to-CLI, so anomalous inbound), `prompt_suggestion`, and the
//! `set_effort`, `rewind` and `compact` control subtypes. A `result` of a subtype the census does
//! not list, or of none, is no such kind: it still ends its turn, as a failure, and is reported
//! once.

use std::borrow::Cow;
use std::str::FromStr;

use sidekicks_contracts::event::envelope::EventCategory;
use sidekicks_contracts::event::registry::SessionEventType;
use strum::EnumString;

use crate::thread_frame_router::{
    ChildThreadAnnouncement, ThreadFrameFamilyClass, ThreadScopedFrameCapability,
};

/// The pinned inbound frame-kind census: the frame `type` joined to its subtype by `/`, read from
/// that text, and a `result` whose subtype the census does not list.
#[derive(Clone, Debug, PartialEq, Eq, Hash, EnumString)]
pub(crate) enum ClaudeWireFrameKind {
    /// `system/init`.
    #[strum(serialize = "system/init")]
    SystemInit,
    /// `system/api_retry`.
    #[strum(serialize = "system/api_retry")]
    SystemApiRetry,
    /// `system/api_error`: a request error on the retry ladder, read only as the spent signal.
    #[strum(serialize = "system/api_error")]
    SystemApiError,
    /// `system/compact_boundary`: Claude Code compacted its context window; the reader adds no row.
    #[strum(serialize = "system/compact_boundary")]
    SystemCompactBoundary,
    /// `system/worker_shutting_down`.
    #[strum(serialize = "system/worker_shutting_down")]
    SystemWorkerShuttingDown,
    /// `system/hook_started`: a hook began, the daemon's own orchestration; no event.
    #[strum(serialize = "system/hook_started")]
    SystemHookStarted,
    /// `system/hook_progress`: a running hook's progress; no event.
    #[strum(serialize = "system/hook_progress")]
    SystemHookProgress,
    /// `system/hook_response`: a hook's result, which the hook dispatcher takes; no event.
    #[strum(serialize = "system/hook_response")]
    SystemHookResponse,
    /// `system/notification`: a notice `system/informational` already carries; no event.
    #[strum(serialize = "system/notification")]
    SystemNotification,
    /// `system/files_persisted`: a file-write summary the tool rows already carry; no event.
    #[strum(serialize = "system/files_persisted")]
    SystemFilesPersisted,
    /// `system/tool_use_summary`: a summary of tool calls already recorded; no event.
    #[strum(serialize = "system/tool_use_summary")]
    SystemToolUseSummary,
    /// `system/memory_recall`: Claude Code's own memory read; no event.
    #[strum(serialize = "system/memory_recall")]
    SystemMemoryRecall,
    /// `system/local_command_output`: output the tool rows already carry; no event.
    #[strum(serialize = "system/local_command_output")]
    SystemLocalCommandOutput,
    /// `system/task_progress`: a helper's progress; its start, moves and end carry its state.
    #[strum(serialize = "system/task_progress")]
    SystemTaskProgress,
    /// `system/task_started`: a helper began in the lead's stream.
    #[strum(serialize = "system/task_started")]
    SystemTaskStarted,
    /// `system/task_updated`: a helper moved to the background or the foreground.
    #[strum(serialize = "system/task_updated")]
    SystemTaskUpdated,
    /// `system/task_notification`: a helper ended.
    #[strum(serialize = "system/task_notification")]
    SystemTaskNotification,
    /// `system/background_tasks_changed`: the set of background tasks; each helper's own frames
    /// carry its state.
    #[strum(serialize = "system/background_tasks_changed")]
    SystemBackgroundTasksChanged,
    /// `system/informational`.
    #[strum(serialize = "system/informational")]
    SystemInformational,
    /// `system/status`.
    #[strum(serialize = "system/status")]
    SystemStatus,
    /// `system/permission_denied`: a blocked call's words, carried on that call's failure.
    #[strum(serialize = "system/permission_denied")]
    SystemPermissionDenied,
    /// `system/model_fallback`.
    #[strum(serialize = "system/model_fallback")]
    SystemModelFallback,
    /// `system/model_refusal_fallback`.
    #[strum(serialize = "system/model_refusal_fallback")]
    SystemModelRefusalFallback,
    /// `system/model_consent_fallback`.
    #[strum(serialize = "system/model_consent_fallback")]
    SystemModelConsentFallback,
    /// `system/model_refusal_no_fallback`: a refusal no model takes, carried on the turn's end.
    #[strum(serialize = "system/model_refusal_no_fallback")]
    SystemModelRefusalNoFallback,
    /// `assistant`: a message of the agent's reply.
    #[strum(serialize = "assistant")]
    Assistant,
    /// `user`: a tool's result, or the echo of a message the session was sent.
    #[strum(serialize = "user")]
    User,
    /// `stream_event`: a piece of a response being written.
    #[strum(serialize = "stream_event")]
    StreamEvent,
    /// `command_lifecycle`: what became of a message the session was sent.
    #[strum(serialize = "command_lifecycle")]
    CommandLifecycle,
    /// `rate_limit_event`: an account quota snapshot as its own `type`, with no subtype.
    #[strum(serialize = "rate_limit_event")]
    RateLimitEvent,
    /// `result/success`.
    #[strum(serialize = "result/success")]
    ResultSuccess,
    /// `result/error_max_turns`.
    #[strum(serialize = "result/error_max_turns")]
    ResultErrorMaxTurns,
    /// `result/error_max_budget_usd`.
    #[strum(serialize = "result/error_max_budget_usd")]
    ResultErrorMaxBudgetUsd,
    /// `result/error_during_execution`.
    #[strum(serialize = "result/error_during_execution")]
    ResultErrorDuringExecution,
    /// `result/error_max_structured_output_retries`.
    #[strum(serialize = "result/error_max_structured_output_retries")]
    ResultErrorMaxStructuredOutputRetries,
    /// A `result` whose subtype the census does not list, or that carries none: it still ends its
    /// turn, as a failure.
    #[strum(disabled)]
    ResultUnlisted {
        /// The subtype as Claude Code sent it, if any.
        subtype: Option<String>,
    },
    /// `control_request/can_use_tool`.
    #[strum(serialize = "control_request/can_use_tool")]
    ControlRequestCanUseTool,
    /// `control_request/elicitation`.
    #[strum(serialize = "control_request/elicitation")]
    ControlRequestElicitation,
    /// `control_request/request_user_dialog`: a dialog the request path answers.
    #[strum(serialize = "control_request/request_user_dialog")]
    ControlRequestRequestUserDialog,
    /// `control_request/hook_callback`: a hook's call, answered by the hook dispatcher.
    #[strum(serialize = "control_request/hook_callback")]
    ControlRequestHookCallback,
    /// `control_request/mcp_message`: MCP transport between Claude Code and a server.
    #[strum(serialize = "control_request/mcp_message")]
    ControlRequestMcpMessage,
    /// `control_request/mcp_set_servers`.
    #[strum(serialize = "control_request/mcp_set_servers")]
    ControlRequestMcpSetServers,
    /// `control_request/interrupt`.
    #[strum(serialize = "control_request/interrupt")]
    ControlRequestInterrupt,
    /// `control_request/set_permission_mode`.
    #[strum(serialize = "control_request/set_permission_mode")]
    ControlRequestSetPermissionMode,
    /// `control_request/set_model`.
    #[strum(serialize = "control_request/set_model")]
    ControlRequestSetModel,
    /// `control_request/get_usage`.
    #[strum(serialize = "control_request/get_usage")]
    ControlRequestGetUsage,
    /// `control_request/get_context_usage`.
    #[strum(serialize = "control_request/get_context_usage")]
    ControlRequestGetContextUsage,
    /// `control_request/get_session_cost`.
    #[strum(serialize = "control_request/get_session_cost")]
    ControlRequestGetSessionCost,
    /// `control_request/list_models`.
    #[strum(serialize = "control_request/list_models")]
    ControlRequestListModels,
    /// `control_request/get_binary_version`.
    #[strum(serialize = "control_request/get_binary_version")]
    ControlRequestGetBinaryVersion,
    /// `control_request/apply_flag_settings`.
    #[strum(serialize = "control_request/apply_flag_settings")]
    ControlRequestApplyFlagSettings,
    /// `control_request/rewind_files`.
    #[strum(serialize = "control_request/rewind_files")]
    ControlRequestRewindFiles,
    /// `control_response/success`, answering a daemon request; the dispatcher settles the call.
    #[strum(serialize = "control_response/success")]
    ControlResponseSuccess,
    /// `control_response/error`, answering a daemon request; the dispatcher reads the refusal.
    #[strum(serialize = "control_response/error")]
    ControlResponseError,
}

impl ClaudeWireFrameKind {
    /// Reads `frame_kind`: a census kind, or a `result` of a subtype the census does not list or
    /// of no subtype; `None` for any other unlisted kind, which the router quarantines.
    pub(crate) fn read(frame_kind: &str) -> Option<Self> {
        Self::from_str(frame_kind).ok().or_else(|| {
            if frame_kind == "result" {
                return Some(Self::ResultUnlisted { subtype: None });
            }
            frame_kind
                .strip_prefix("result/")
                .map(|subtype| Self::ResultUnlisted {
                    subtype: Some(subtype.to_owned()),
                })
        })
    }

    /// Whether the kind is a `result`, its subtype listed or not.
    pub(crate) const fn is_result(&self) -> bool {
        matches!(
            self,
            Self::ResultSuccess
                | Self::ResultErrorMaxTurns
                | Self::ResultErrorMaxBudgetUsd
                | Self::ResultErrorDuringExecution
                | Self::ResultErrorMaxStructuredOutputRetries
                | Self::ResultUnlisted { .. }
        )
    }

    // The family the thread-frame router reads the kind as.
    fn routing_family(&self) -> ThreadFrameFamilyClass {
        match self {
            // Connection- and account-scoped, the control channel included (connection-level
            // both ways).
            Self::SystemApiRetry
            | Self::SystemApiError
            | Self::RateLimitEvent
            | Self::SystemInit
            | Self::SystemWorkerShuttingDown
            | Self::ControlRequestCanUseTool
            | Self::ControlRequestElicitation
            | Self::ControlRequestRequestUserDialog
            | Self::ControlRequestHookCallback
            | Self::ControlRequestMcpMessage
            | Self::ControlRequestMcpSetServers
            | Self::ControlRequestInterrupt
            | Self::ControlRequestSetPermissionMode
            | Self::ControlRequestSetModel
            | Self::ControlRequestGetUsage
            | Self::ControlRequestGetContextUsage
            | Self::ControlRequestGetSessionCost
            | Self::ControlRequestListModels
            | Self::ControlRequestGetBinaryVersion
            | Self::ControlRequestApplyFlagSettings
            | Self::ControlRequestRewindFiles
            | Self::ControlResponseSuccess
            | Self::ControlResponseError => ThreadFrameFamilyClass::Connection,
            // Thread-scoped usage: the compaction marker rides the thread it compacts.
            Self::SystemCompactBoundary => ThreadFrameFamilyClass::Thread {
                capability: ThreadScopedFrameCapability::Usage,
            },
            // A helper's start and end; the start is also the router's registration input.
            Self::SystemTaskStarted | Self::SystemTaskNotification => {
                ThreadFrameFamilyClass::Thread {
                    capability: ThreadScopedFrameCapability::Lifecycle,
                }
            }
            // Thread-scoped content: the result frames, the messages and the remaining system
            // subtypes.
            Self::ResultSuccess
            | Self::ResultErrorMaxTurns
            | Self::ResultErrorMaxBudgetUsd
            | Self::ResultErrorDuringExecution
            | Self::ResultErrorMaxStructuredOutputRetries
            | Self::ResultUnlisted { .. }
            | Self::SystemHookStarted
            | Self::SystemHookProgress
            | Self::SystemHookResponse
            | Self::SystemNotification
            | Self::SystemFilesPersisted
            | Self::SystemToolUseSummary
            | Self::SystemMemoryRecall
            | Self::SystemLocalCommandOutput
            | Self::SystemTaskProgress
            | Self::SystemTaskUpdated
            | Self::SystemBackgroundTasksChanged
            | Self::SystemInformational
            | Self::SystemStatus
            | Self::SystemPermissionDenied
            | Self::SystemModelRefusalFallback
            | Self::SystemModelFallback
            | Self::SystemModelConsentFallback
            | Self::SystemModelRefusalNoFallback
            | Self::Assistant
            | Self::StreamEvent
            | Self::User
            | Self::CommandLifecycle => ThreadFrameFamilyClass::Thread {
                capability: ThreadScopedFrameCapability::Content,
            },
        }
    }
}

/// The census key of a frame's `type` and subtype; with no subtype it is the bare `type`, which
/// the router quarantines unless the census lists it or it is a `result`. Both inputs are
/// untrusted.
pub(crate) fn compose_claude_wire_frame_kind<'frame>(
    frame_type: &'frame str,
    subtype: Option<&str>,
) -> Cow<'frame, str> {
    match subtype {
        Some(subtype) => Cow::Owned(format!("{frame_type}/{subtype}")),
        None => Cow::Borrowed(frame_type),
    }
}

/// Claude Code's question tool, by its name on the wire.
pub(crate) const CLAUDE_QUESTION_TOOL_NAME: &str = "AskUserQuestion";

/// The tool Claude Code asks to leave plan mode through, carrying the plan, by its wire name.
pub(crate) const CLAUDE_PLAN_EXIT_TOOL_NAME: &str = "ExitPlanMode";

/// Which helper lifecycle signal a frame is read as: a helper's `task_started` frame is its
/// `SubagentStart`, its `task_notification` frame its `SubagentStop`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeSubagentSignal {
    /// A helper began in the lead's stream.
    SubagentStart,
    /// A helper ended.
    SubagentStop,
}

/// One Claude helper lifecycle signal, as the driver core read it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ClaudeSubagentLifecycleSignal {
    /// Whether the helper started or stopped.
    pub(crate) signal: ClaudeSubagentSignal,
    /// The helper's `task_id`, which its own frames and hook callbacks carry as `agent_id`.
    pub(crate) subagent_id: String,
    /// The helper-tool call's `tool_use_id` that started the helper, copied verbatim.
    pub(crate) parent_tool_use_id: Option<String>,
    /// The `task_id` of the helper whose agent launched this one, when a helper did.
    pub(crate) parent_task_id: Option<String>,
}

/// A helper lifecycle signal as its event and, for a start, the router's announcement.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ClaudeSubagentLifecycleNormalization {
    /// The event's category, its type's own.
    pub(crate) category: EventCategory,
    /// `agent.subagent.started` or `agent.subagent.completed`.
    pub(crate) event_type: SessionEventType,
    /// The helper's id.
    pub(crate) subagent_id: String,
    /// The helper-tool call that started it, if known.
    pub(crate) parent_tool_use_id: Option<String>,
    /// For a start, the router announcement: its parent the launching helper while that one is
    /// registered, else the session's own thread, and none for a start with no helper-tool call,
    /// which the router refuses; `None` for a stop.
    pub(crate) announcement: Option<ChildThreadAnnouncement>,
}

/// Normalizes one helper lifecycle signal into `agent.subagent.started` or
/// `agent.subagent.completed` and, for a start, the router announcement. Claude Code has no thread
/// id member, so the helper's id is the child thread's id; `is_registered_helper` answers whether
/// the router still holds a helper, since a parent that ended or is untracked reads as no parent.
pub(crate) fn normalize_claude_subagent_lifecycle(
    lifecycle_signal: ClaudeSubagentLifecycleSignal,
    session_thread_id: &str,
    is_registered_helper: impl Fn(&str) -> bool,
) -> ClaudeSubagentLifecycleNormalization {
    let ClaudeSubagentLifecycleSignal {
        signal,
        subagent_id,
        parent_tool_use_id,
        parent_task_id,
    } = lifecycle_signal;
    let (event_type, announcement) = match signal {
        ClaudeSubagentSignal::SubagentStart => {
            let declared_parent_thread_id = parent_tool_use_id.is_some().then(|| {
                parent_task_id
                    .filter(|parent_task_id| is_registered_helper(parent_task_id))
                    .unwrap_or_else(|| session_thread_id.to_owned())
            });
            (
                SessionEventType::AgentSubagentStarted,
                Some(ChildThreadAnnouncement {
                    child_thread_id: subagent_id.clone(),
                    declared_parent_thread_id,
                    subagent_id: Some(subagent_id.clone()),
                }),
            )
        }
        ClaudeSubagentSignal::SubagentStop => (SessionEventType::AgentSubagentCompleted, None),
    };
    ClaudeSubagentLifecycleNormalization {
        category: event_type.category(),
        event_type,
        subagent_id,
        parent_tool_use_id,
        announcement,
    }
}

/// Classifies a frame kind's family for the thread-frame router; an unlisted kind is `Unknown`,
/// never presumed connection-scoped. `carries_cumulative_usage` is required so no caller forgets
/// it and drops a child's usage: a thread-scoped frame carrying a cumulative token reading is a
/// usage frame, since such readings ride content frames and no kind is reserved for usage.
pub(crate) fn classify_claude_frame_family_for_routing(
    frame_kind: &str,
    carries_cumulative_usage: bool,
) -> ThreadFrameFamilyClass {
    let kind_class = classify_claude_frame_kind_for_routing(frame_kind);
    if carries_cumulative_usage && matches!(kind_class, ThreadFrameFamilyClass::Thread { .. }) {
        return ThreadFrameFamilyClass::Thread {
            capability: ThreadScopedFrameCapability::Usage,
        };
    }
    kind_class
}

// A census kind's family; an unlisted kind is `Unknown`, but for a `result`.
fn classify_claude_frame_kind_for_routing(frame_kind: &str) -> ThreadFrameFamilyClass {
    ClaudeWireFrameKind::read(frame_kind).map_or(ThreadFrameFamilyClass::Unknown, |kind| {
        kind.routing_family()
    })
}

/// Whether `frame_kind` is a `result`, its subtype listed or not.
pub(crate) fn is_claude_result_frame_kind(frame_kind: &str) -> bool {
    ClaudeWireFrameKind::read(frame_kind).is_some_and(|kind| kind.is_result())
}

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::{
        ClaudeSubagentLifecycleSignal, ClaudeSubagentSignal, normalize_claude_subagent_lifecycle,
    };

    #[rstest]
    #[case::no_helper_call_declares_no_parent(None, None, &["h1"], None)]
    #[case::a_top_level_helper_sits_under_the_session(Some("t1"), None, &["h1"], Some("session"))]
    #[case::a_nested_helper_sits_under_its_launcher(Some("t1"), Some("h1"), &["h1"], Some("h1"))]
    #[case::a_launcher_the_router_released_reads_as_none(
        Some("t1"),
        Some("h1"),
        &[],
        Some("session")
    )]
    fn a_helper_start_declares_the_parent_its_linkage_names(
        #[case] parent_tool_use_id: Option<&str>,
        #[case] parent_task_id: Option<&str>,
        #[case] registered_helpers: &[&str],
        #[case] declared_parent: Option<&str>,
    ) {
        let normalization = normalize_claude_subagent_lifecycle(
            ClaudeSubagentLifecycleSignal {
                signal: ClaudeSubagentSignal::SubagentStart,
                subagent_id: "h2".to_owned(),
                parent_tool_use_id: parent_tool_use_id.map(str::to_owned),
                parent_task_id: parent_task_id.map(str::to_owned),
            },
            "session",
            |task_id| registered_helpers.contains(&task_id),
        );

        let announcement = normalization.announcement.expect("a start is announced");
        assert_eq!(
            announcement.declared_parent_thread_id.as_deref(),
            declared_parent
        );
    }
}
