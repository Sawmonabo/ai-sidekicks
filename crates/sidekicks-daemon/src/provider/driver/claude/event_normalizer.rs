//! The Claude Code half of the driver's normalize boundary: a pure, total mapping from a pinned
//! stream-json or control-channel frame kind to its event category, the emission route the driver
//! core reads it through, the helper lifecycle signals, and each frame kind's routing family.
//!
//! Left out of the census: the frames the delivery side reads itself (the `assistant` and `user`
//! messages, the `stream_event` frames of a response being written, the `task_*` helper frames,
//! `informational`, `status`, `permission_denied`, the four model switches and the
//! `command_lifecycle` of each message the session was sent), which the router still classifies
//! below; and, so the diagnostic default branch reports them instead of a guessed row,
//! `queued_notification` (daemon-to-CLI, so anomalous inbound), `prompt_suggestion`, and the
//! `set_effort`, `rewind` and `compact` control subtypes.

use std::borrow::Cow;
use std::str::FromStr;

use serde_json::Map;
use sidekicks_contracts::event::envelope::EventCategory;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use strum::{EnumString, IntoStaticStr, VariantArray};

use crate::provider::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, OnceReportedDiagnostics,
};
use crate::provider::event_disposition::{NormalizedEventKind, resolve_adopted_event_target};
use crate::provider::thread_frame_router::{
    ChildThreadAnnouncement, ThreadFrameFamilyClass, ThreadScopedFrameCapability,
};

/// Which channel carried a frame: stdout stream-json, or one half of the control channel. Not a
/// direction: control traffic runs both ways under one frame type.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeWireChannel {
    /// Standard output's stream-json.
    Stream,
    /// A control request.
    ControlRequest,
    /// The answer to a control request.
    ControlResponse,
}

/// The pinned inbound frame-kind census with a settled disposition: the frame `type` joined to its
/// subtype by `/`, read from and written as that text.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, EnumString, IntoStaticStr, VariantArray)]
pub(crate) enum ClaudeWireFrameKind {
    /// `system/init`.
    #[strum(serialize = "system/init")]
    SystemInit,
    /// `system/api_retry`.
    #[strum(serialize = "system/api_retry")]
    SystemApiRetry,
    /// `system/api_error`.
    #[strum(serialize = "system/api_error")]
    SystemApiError,
    /// `system/compact_boundary`.
    #[strum(serialize = "system/compact_boundary")]
    SystemCompactBoundary,
    /// `system/worker_shutting_down`.
    #[strum(serialize = "system/worker_shutting_down")]
    SystemWorkerShuttingDown,
    /// `system/hook_started`.
    #[strum(serialize = "system/hook_started")]
    SystemHookStarted,
    /// `system/hook_progress`.
    #[strum(serialize = "system/hook_progress")]
    SystemHookProgress,
    /// `system/hook_response`.
    #[strum(serialize = "system/hook_response")]
    SystemHookResponse,
    /// `system/notification`.
    #[strum(serialize = "system/notification")]
    SystemNotification,
    /// `system/files_persisted`.
    #[strum(serialize = "system/files_persisted")]
    SystemFilesPersisted,
    /// `system/tool_use_summary`.
    #[strum(serialize = "system/tool_use_summary")]
    SystemToolUseSummary,
    /// `system/memory_recall`.
    #[strum(serialize = "system/memory_recall")]
    SystemMemoryRecall,
    /// `system/local_command_output`.
    #[strum(serialize = "system/local_command_output")]
    SystemLocalCommandOutput,
    /// `system/task_progress`.
    #[strum(serialize = "system/task_progress")]
    SystemTaskProgress,
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
    /// `control_request/can_use_tool`.
    #[strum(serialize = "control_request/can_use_tool")]
    ControlRequestCanUseTool,
    /// `control_request/elicitation`.
    #[strum(serialize = "control_request/elicitation")]
    ControlRequestElicitation,
    /// `control_request/request_user_dialog`.
    #[strum(serialize = "control_request/request_user_dialog")]
    ControlRequestRequestUserDialog,
    /// `control_request/hook_callback`.
    #[strum(serialize = "control_request/hook_callback")]
    ControlRequestHookCallback,
    /// `control_request/mcp_message`.
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
    /// `control_response/success`, answering a daemon request.
    #[strum(serialize = "control_response/success")]
    ControlResponseSuccess,
    /// `control_response/error`, answering a daemon request.
    #[strum(serialize = "control_response/error")]
    ControlResponseError,
}

/// A frame that normalizes into one event category. `normalized_kind` is `None` for a frame the
/// normalized vocabulary does not name (`worker_shutting_down`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ClaudeNormalizedCategoryEmission {
    /// The frame's census kind.
    pub(crate) frame_kind: ClaudeWireFrameKind,
    /// The channel that carried it.
    pub(crate) channel: ClaudeWireChannel,
    /// The event's category, its type's own.
    pub(crate) category: EventCategory,
    /// The event's type.
    pub(crate) event_type: SessionEventType,
    /// The normalized kind the row names, if any.
    pub(crate) normalized_kind: Option<NormalizedEventKind>,
}

/// A known frame that carries no transcript capability, so it normalizes to no category, with the
/// reason it does not.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ClaudeNotEventedFrameDisposition {
    /// The frame's census kind.
    pub(crate) frame_kind: ClaudeWireFrameKind,
    /// The channel that carried it.
    pub(crate) channel: ClaudeWireChannel,
    /// Why the frame adds no event.
    pub(crate) reason: &'static str,
}

/// The total result of normalizing one census frame kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeFrameNormalization {
    /// The frame becomes an event.
    Normalized(ClaudeNormalizedCategoryEmission),
    /// The frame adds no event.
    NotEvented(ClaudeNotEventedFrameDisposition),
}

impl ClaudeWireFrameKind {
    // The census row of each kind. A `result` frame does not end the read loop (trailing events
    // can follow), so no row is terminal for the stream.
    fn normalization(self) -> ClaudeFrameNormalization {
        use ClaudeWireChannel::{ControlRequest, ControlResponse, Stream};
        match self {
            // A forward marker only: `agent.run.*` transitions stay daemon-emitted, never derived
            // from init.
            Self::SystemInit => self.normalized(Stream, NormalizedEventKind::Init),
            // `system/api_error` maps onto the retry kind; the typed-error members are carried
            // verbatim by the payload layer, since a string census cannot prove the set closed.
            Self::SystemApiRetry | Self::SystemApiError => {
                self.normalized(Stream, NormalizedEventKind::ApiRetry)
            }
            // The wire's `rate_limit_event` becomes the account quota snapshot kind, the preferred
            // carrier because it is pushed, with no round trip on the experimental `get_usage`.
            Self::RateLimitEvent => self.normalized(Stream, NormalizedEventKind::RateLimits),
            // Provider context-window compaction, apart from the daemon's own event compaction.
            Self::SystemCompactBoundary => {
                self.normalized(Stream, NormalizedEventKind::CompactBoundary)
            }
            // Wire-layer, no normalized kind. Assumed on the system channel; on another it misses
            // this row and reaches the diagnostic default branch.
            Self::SystemWorkerShuttingDown => ClaudeFrameNormalization::Normalized(self.emission(
                Stream,
                SessionEventType::AgentRunWorkerShuttingDown,
                None,
            )),
            Self::SystemHookStarted => self.not_evented(
                Stream,
                "hook-lifecycle progress; hook execution is daemon-internal orchestration, not a \
                 capability the transcript or audit log records",
            ),
            Self::SystemHookProgress => self.not_evented(
                Stream,
                "intra-hook progress; same daemon-internal-orchestration reason",
            ),
            Self::SystemHookResponse => self.not_evented(
                Stream,
                "hook result consumed by the hook dispatcher, not a transcript capability",
            ),
            Self::SystemNotification => self.not_evented(
                Stream,
                "distinct from the `notification` kind, which Codex feeds; the user-facing-notice \
                 capability is already carried there — this Claude system subtype is redundant \
                 transport noise",
            ),
            Self::SystemFilesPersisted => self.not_evented(
                Stream,
                "file-write summary; the adopted `diff` / `command_output` kinds plus \
                 `artifactPublication` already carry the file-change capability",
            ),
            Self::SystemToolUseSummary => self.not_evented(
                Stream,
                "aggregate over the adopted `tool_start` / `tool_complete` kinds; no new \
                 capability",
            ),
            Self::SystemMemoryRecall => self.not_evented(
                Stream,
                "provider-internal memory-retrieval signal; no capability the transcript or audit \
                 log records",
            ),
            Self::SystemLocalCommandOutput => self.not_evented(
                Stream,
                "superseded by the adopted `command_output` kind; the local variant carries no \
                 additional capability",
            ),
            Self::SystemTaskProgress => self.not_evented(
                Stream,
                "intra-task progress; `task_updated` and `task_notification` carry a helper's \
                 state, and the task and to-do lists stay with Claude Code",
            ),
            Self::ResultSuccess => self.normalized(Stream, NormalizedEventKind::TurnComplete),
            Self::ResultErrorMaxTurns
            | Self::ResultErrorMaxBudgetUsd
            | Self::ResultErrorDuringExecution
            | Self::ResultErrorMaxStructuredOutputRetries => {
                self.normalized(Stream, NormalizedEventKind::Error)
            }
            // Only `can_use_tool` and `elicitation` are asks aimed at the person; the other control
            // requests are answered by the driver's control dispatcher or never sent. A permission
            // ask is recorded once as the approval it opens; the question tool also arrives here,
            // and the delivery side splits it off by tool name.
            Self::ControlRequestCanUseTool => {
                self.normalized(ControlRequest, NormalizedEventKind::ApprovalRequest)
            }
            // An MCP elicitation, recorded as the same question record the question tool yields.
            Self::ControlRequestElicitation => {
                self.normalized(ControlRequest, NormalizedEventKind::UserInputRequest)
            }
            Self::ControlRequestRequestUserDialog => self.not_evented(
                ControlRequest,
                "a host-rendered dialog, sent only for a kind the host declared at `initialize`; \
                 the CLI fails closed on any other. The daemon's two kinds are \
                 `refusal_fallback_prompt` and `fable_overage_consent_prompt`, recorded as \
                 `agent.run.refusalChoice.requested` and \
                 `agent.run.usageCreditsChoice.requested`, and neither arrives until the driver \
                 declares them. `auto_mode_server_fallback` stays undeclared, its words reaching \
                 the working line as a provider warning, and `auto_mode_outside_reads` never \
                 reaches a headless host",
            ),
            Self::ControlRequestHookCallback => self.not_evented(
                ControlRequest,
                "hook family, disposed `discard`: hook-lifecycle, daemon-internal orchestration, \
                 not a capability the transcript or audit log records",
            ),
            Self::ControlRequestMcpMessage => self.not_evented(
                ControlRequest,
                "MCP transport passthrough between the CLI and a configured server; the daemon's \
                 own MCP governance surface events its decisions (`mcp.*`), so relaying the \
                 transport frame would double-record events the daemon already audits",
            ),
            // The CLI answers it though the census leaves it out; it dispatches, and the daemon
            // sends it.
            Self::ControlRequestMcpSetServers => self.not_evented(
                ControlRequest,
                "daemon-originated live server-set reconcile; the driver's control dispatcher owns \
                 the round trip and the resulting server-set change is already evented by the \
                 daemon's MCP governance surface",
            ),
            Self::ControlRequestInterrupt => self.not_evented(
                ControlRequest,
                "daemon-originated control request; the intervention that caused it is already \
                 evented by the daemon's intervention surface, and the driver's control dispatcher \
                 owns the request/response round trip",
            ),
            Self::ControlRequestSetPermissionMode => self.not_evented(
                ControlRequest,
                "daemon-originated control request; execution posture is daemon-owned and evented \
                 when the daemon applies it, so relaying the request would double-record a \
                 mutation the daemon authored",
            ),
            Self::ControlRequestSetModel => self.not_evented(
                ControlRequest,
                "daemon-originated control request; the agent-configuration change it carries is \
                 evented by the daemon that applied it, not by the wire frame that requested it",
            ),
            Self::ControlRequestGetUsage => self.not_evented(
                ControlRequest,
                "daemon-originated read of the experimental usage surface; its ANSWER is what \
                 carries telemetry, and the push carrier `rate_limit_event` is the preferred \
                 source where both are available",
            ),
            Self::ControlRequestGetContextUsage => self.not_evented(
                ControlRequest,
                "daemon-originated read; the request carries no observation, and the \
                 context-window telemetry its answer yields reaches the transcript through the \
                 driver's own usage emission",
            ),
            Self::ControlRequestGetSessionCost => self.not_evented(
                ControlRequest,
                "daemon-originated read; cost reaches the transcript through the driver's \
                 `usage.cost.updated` emission, never through the request that polled for it",
            ),
            Self::ControlRequestListModels => self.not_evented(
                ControlRequest,
                "daemon-originated capability discovery; a discovery read is not a transcript \
                 capability",
            ),
            Self::ControlRequestGetBinaryVersion => self.not_evented(
                ControlRequest,
                "daemon-originated version read; the reported CLI version is persisted on the \
                 binding record at the driver write seam, not evented",
            ),
            Self::ControlRequestApplyFlagSettings => self.not_evented(
                ControlRequest,
                "daemon-originated settings push; the daemon authored the settings and its typed \
                 refusal is classified by the control dispatcher, so neither half is a provider \
                 observation",
            ),
            Self::ControlRequestRewindFiles => self.not_evented(
                ControlRequest,
                "daemon-originated file-side rewind; the rollback that drove it is evented by the \
                 daemon's intervention surface, and a cloud-hosted session refuses this subtype \
                 outright, which is a dispatcher classification rather than a transcript row",
            ),
            // The answers to daemon requests, correlated by `request_id`; the error arm is
            // `{ type: "control_response", response: { subtype: "error", request_id, error } }`.
            Self::ControlResponseSuccess => self.not_evented(
                ControlResponse,
                "answer to a daemon-originated control request, correlated by `request_id`; the \
                 control dispatcher resolves the pending call and whatever the answer authorizes \
                 is evented by the surface that acted on it",
            ),
            Self::ControlResponseError => self.not_evented(
                ControlResponse,
                "typed control-channel refusal, correlated by `request_id`; every control request \
                 is feature-detected at call time by classifying this arm, which makes it a \
                 capability signal for the dispatcher rather than a transcript row",
            ),
        }
    }

    fn normalized(
        self,
        channel: ClaudeWireChannel,
        normalized_kind: NormalizedEventKind,
    ) -> ClaudeFrameNormalization {
        let target = resolve_adopted_event_target(normalized_kind)
            .expect("every normalized kind the census names is adopted onto an event type");
        ClaudeFrameNormalization::Normalized(self.emission(
            channel,
            target.event_type,
            Some(normalized_kind),
        ))
    }

    fn emission(
        self,
        channel: ClaudeWireChannel,
        event_type: SessionEventType,
        normalized_kind: Option<NormalizedEventKind>,
    ) -> ClaudeNormalizedCategoryEmission {
        ClaudeNormalizedCategoryEmission {
            frame_kind: self,
            channel,
            category: event_type.category(),
            event_type,
            normalized_kind,
        }
    }

    fn not_evented(
        self,
        channel: ClaudeWireChannel,
        reason: &'static str,
    ) -> ClaudeFrameNormalization {
        ClaudeFrameNormalization::NotEvented(ClaudeNotEventedFrameDisposition {
            frame_kind: self,
            channel,
            reason,
        })
    }
}

/// The census key of a frame's `type` and subtype; with no subtype it is the bare `type`, which
/// reaches the diagnostic default branch unless the census lists it. Both inputs are untrusted.
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

/// A census frame's emission, its not-evented disposition, or the diagnostic it was routed to.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum ClaudeFrameEmissionRoute {
    /// The frame becomes an event.
    Emit(ClaudeNormalizedCategoryEmission),
    /// The frame adds no event.
    NotEvented(ClaudeNotEventedFrameDisposition),
    /// The frame went to the diagnostic default branch, which logged this record unless its kind
    /// was already reported on the connection.
    Diagnostic(DriverDiagnosticRecord),
}

/// The driver core's entry point onto the census, for the account `provider_account_id` names.
/// Never fails: a kind outside the census is routed to a diagnostic, logged once per kind on the
/// connection `reports` belongs to, never forced into an envelope or dropped.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the Claude stream reader routes each frame the delivery side leaves through it"
    )
)]
pub(crate) fn resolve_claude_frame_emission_route(
    frame_kind: &str,
    provider_account_id: Option<ProviderAccountId>,
    reports: &mut OnceReportedDiagnostics,
) -> ClaudeFrameEmissionRoute {
    let Ok(census_kind) = ClaudeWireFrameKind::from_str(frame_kind) else {
        let record = DriverDiagnosticRecord {
            provider: super::DESCRIPTOR.provider_id(),
            provider_account_id,
            kind: DriverDiagnosticKind::UnmappedWireKind,
            raw_wire_type: Some(frame_kind.to_owned()),
            disposition_reason: "wire kind outside the pinned Claude inbound census; routed to \
                                 the daemon diagnostic default branch, never silently dropped \
                                 and never forced into an envelope"
                .to_owned(),
            details: Map::new(),
        };
        reports.report(&record);
        return ClaudeFrameEmissionRoute::Diagnostic(record);
    };
    match census_kind.normalization() {
        ClaudeFrameNormalization::NotEvented(disposition) => {
            ClaudeFrameEmissionRoute::NotEvented(disposition)
        }
        ClaudeFrameNormalization::Normalized(emission) => ClaudeFrameEmissionRoute::Emit(emission),
    }
}

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

fn classify_claude_frame_kind_for_routing(frame_kind: &str) -> ThreadFrameFamilyClass {
    match frame_kind {
        // Connection- and account-scoped, the control channel included (connection-level both
        // ways).
        "system/api_retry"
        | "system/api_error"
        | "rate_limit_event"
        | "system/init"
        | "system/worker_shutting_down"
        | "control_request/can_use_tool"
        | "control_request/elicitation"
        | "control_request/request_user_dialog"
        | "control_request/hook_callback"
        | "control_request/mcp_message"
        | "control_request/mcp_set_servers"
        | "control_request/interrupt"
        | "control_request/set_permission_mode"
        | "control_request/set_model"
        | "control_request/get_usage"
        | "control_request/get_context_usage"
        | "control_request/get_session_cost"
        | "control_request/list_models"
        | "control_request/get_binary_version"
        | "control_request/apply_flag_settings"
        | "control_request/rewind_files"
        | "control_response/success"
        | "control_response/error" => ThreadFrameFamilyClass::Connection,
        // Thread-scoped usage: the compaction marker rides the thread it compacts.
        "system/compact_boundary" => ThreadFrameFamilyClass::Thread {
            capability: ThreadScopedFrameCapability::Usage,
        },
        // A helper's start and end; the start is also the router's registration input.
        "system/task_started" | "system/task_notification" => ThreadFrameFamilyClass::Thread {
            capability: ThreadScopedFrameCapability::Lifecycle,
        },
        // Thread-scoped content: the result frames and the remaining system subtypes.
        "result/success"
        | "result/error_max_turns"
        | "result/error_max_budget_usd"
        | "result/error_during_execution"
        | "result/error_max_structured_output_retries"
        | "system/hook_started"
        | "system/hook_progress"
        | "system/hook_response"
        | "system/notification"
        | "system/files_persisted"
        | "system/tool_use_summary"
        | "system/memory_recall"
        | "system/local_command_output"
        | "system/task_progress"
        | "system/task_updated"
        | "system/background_tasks_changed"
        | "system/informational"
        | "system/status"
        | "system/permission_denied"
        | "system/model_refusal_fallback"
        | "system/model_fallback"
        | "system/model_consent_fallback"
        | "system/model_refusal_no_fallback"
        | "assistant"
        | "stream_event"
        | "user"
        | "command_lifecycle" => ThreadFrameFamilyClass::Thread {
            capability: ThreadScopedFrameCapability::Content,
        },
        _ => ThreadFrameFamilyClass::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use sidekicks_contracts::event::registry::SessionEventType;

    use super::{
        ClaudeFrameEmissionRoute, ClaudeSubagentLifecycleSignal, ClaudeSubagentSignal,
        normalize_claude_subagent_lifecycle, resolve_claude_frame_emission_route,
    };
    use crate::provider::driver::diagnostics::{
        DriverDiagnosticKind, OnceReportedDiagnostics, RecordedEvents,
    };

    #[test]
    fn an_unknown_kind_routes_to_a_logged_diagnostic() {
        let recorded = RecordedEvents::default();
        let mut route = None;
        recorded.record_during(|| {
            route = Some(resolve_claude_frame_emission_route(
                "system/brand_new",
                None,
                &mut OnceReportedDiagnostics::default(),
            ));
        });

        let Some(ClaudeFrameEmissionRoute::Diagnostic(record)) = route else {
            panic!("an unknown kind routes to a diagnostic, got {route:?}");
        };
        assert_eq!(record.kind, DriverDiagnosticKind::UnmappedWireKind);
        assert_eq!(record.raw_wire_type.as_deref(), Some("system/brand_new"));
        assert_eq!(
            recorded.field_on("driver.normalize.unmappedWireKind", "raw_wire_type"),
            ["system/brand_new"]
        );
    }

    #[rstest]
    #[case::success("result/success", SessionEventType::AgentTurnCompleted)]
    #[case::error_during_execution(
        "result/error_during_execution",
        SessionEventType::AgentRunFailed
    )]
    fn a_result_frame_emits_its_ending_event(
        #[case] frame_kind: &str,
        #[case] event_type: SessionEventType,
    ) {
        let route = resolve_claude_frame_emission_route(
            frame_kind,
            None,
            &mut OnceReportedDiagnostics::default(),
        );

        let ClaudeFrameEmissionRoute::Emit(emission) = route else {
            panic!("a result frame emits, got {route:?}");
        };
        assert_eq!(emission.event_type, event_type);
    }

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
