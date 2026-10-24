//! The Codex half of the driver's normalize boundary: every method the Codex service sends that the
//! daemon reads, with how the thread-frame router scopes it and what the driver does with it. A row
//! that emits names the session event it becomes; a row that reads states what reads it. It parses
//! no payload and touches no session state.
//!
//! Every other notification of the service's schema is opted out at `initialize`, so the service
//! never sends it; that list is the schema's notifications less this table's. A method outside the
//! table, or an opted-out notification that arrives anyway, is reported as a diagnostic once per
//! method on the connection, never dropped silently; a server request outside the table is
//! refused at the connection.

use std::collections::HashMap;
use std::sync::LazyLock;

use serde::Deserialize;
use serde_json::Map;
use sidekicks_contracts::event::envelope::EventCategory;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use strum::VariantArray;

use super::app_server_protocol::SERVER_NOTIFICATION_METHODS;
use crate::provider::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, OnceReportedDiagnostics,
};
use crate::provider::event_disposition::{NormalizedEventKind, resolve_adopted_event_target};
use crate::provider::inbound_json::decode_inbound_json;
use crate::provider::thread_frame_router::{
    ChildThreadAnnouncement, ThreadFrameFamilyClass, ThreadScopedFrameCapability,
};

/// The `thread/started` method: the thread-frame router's registration input.
pub(crate) const CODEX_THREAD_STARTED_METHOD: &str = "thread/started";

/// The `thread/tokenUsage/updated` method, metered by the usage accountant.
pub(crate) const CODEX_THREAD_TOKEN_USAGE_METHOD: &str = "thread/tokenUsage/updated";

/// The `turn/started` method, which opens a turn's boundary.
pub(crate) const CODEX_TURN_STARTED_METHOD: &str = "turn/started";

/// The `turn/completed` method, the terminal signal for a session and its children; no frame
/// announces a thread's end.
pub(crate) const CODEX_TURN_COMPLETED_METHOD: &str = "turn/completed";

/// The `item/started` method, which names its turn; a run's output speed settles on the first.
pub(crate) const CODEX_ITEM_STARTED_METHOD: &str = "item/started";

/// The `item/completed` method: the end of one step of a turn.
pub(crate) const CODEX_ITEM_COMPLETED_METHOD: &str = "item/completed";

/// Sent when a conversation's status changes, `idle` at each turn's end.
pub(crate) const CODEX_THREAD_STATUS_CHANGED_METHOD: &str = "thread/status/changed";

/// What every item frame's method starts with.
pub(crate) const CODEX_ITEM_METHOD_PREFIX: &str = "item/";

/// The `thread/compacted` method, which settles a compaction the person asked for.
pub(crate) const CODEX_THREAD_COMPACTED_METHOD: &str = "thread/compacted";

/// The `skills/changed` method, on which the held command list is read again.
pub(crate) const CODEX_SKILLS_CHANGED_METHOD: &str = "skills/changed";

/// The `thread/settings/updated` method, which declares the thread's output speed.
pub(crate) const CODEX_THREAD_SETTINGS_UPDATED_METHOD: &str = "thread/settings/updated";

/// Which root a frame arrives on: a server request must be answered, a notification is not.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CodexFrameRoot {
    /// A request the service sends the daemon, which waits for its answer.
    ServerRequest,
    /// A notification the service sends the daemon.
    ServerNotification,
}

/// What the driver does with one method.
#[derive(Clone, Copy, Debug)]
enum CodexFrameReading {
    /// Emits the session event the normalized kind is adopted onto.
    Emits(NormalizedEventKind),
    /// Emits this session event, which no normalized kind names.
    EmitsEvent(SessionEventType),
    /// Read for the driver's own state or the daemon's log, never an event; says what reads it.
    Reads(&'static str),
}

/// One row of the table: the frame's root, its routing family and its reading.
#[derive(Clone, Copy, Debug)]
struct CodexFrameRow {
    root: CodexFrameRoot,
    family: ThreadFrameFamilyClass,
    reading: CodexFrameReading,
}

const CONNECTION: ThreadFrameFamilyClass = ThreadFrameFamilyClass::Connection;
const LIFECYCLE: ThreadFrameFamilyClass = ThreadFrameFamilyClass::Thread {
    capability: ThreadScopedFrameCapability::Lifecycle,
};
const CONTENT: ThreadFrameFamilyClass = ThreadFrameFamilyClass::Thread {
    capability: ThreadScopedFrameCapability::Content,
};
const USAGE: ThreadFrameFamilyClass = ThreadFrameFamilyClass::Thread {
    capability: ThreadScopedFrameCapability::Usage,
};
const ASK: ThreadFrameFamilyClass = ThreadFrameFamilyClass::Thread {
    capability: ThreadScopedFrameCapability::InteractiveRequest,
};

const VOICE_CALL_READING: &str = "a voice call's frames, routed by thread to that session's call";
const STREAMED_PROSE_READING: &str = "the item's prose, streamed as stored pieces of its message";
const AUTH_RECOVERY_READING: &str = "Codex recovering its own sign-in, written to the daemon's log";

/// Every method the daemon reads from the Codex service, one variant each.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, VariantArray)]
pub(crate) enum CodexInboundMethod {
    ItemToolCall,
    ItemToolRequestUserInput,
    McpServerElicitationRequest,
    ItemCommandExecutionRequestApproval,
    ItemFileChangeRequestApproval,
    ItemPermissionsRequestApproval,
    ExecCommandApproval,
    ApplyPatchApproval,
    AttestationGenerate,
    AccountChatgptAuthTokensRefresh,
    ThreadStarted,
    TurnStarted,
    TurnCompleted,
    Error,
    ItemStarted,
    ItemCompleted,
    ModelRerouted,
    ModelSafetyBufferingUpdated,
    TurnPlanUpdated,
    ThreadSettingsUpdated,
    ThreadTokenUsageUpdated,
    ThreadCompacted,
    ThreadClosed,
    ThreadStatusChanged,
    ServerRequestResolved,
    SkillsChanged,
    ThreadGoalUpdated,
    ThreadGoalCleared,
    AccountRateLimitsUpdated,
    GuardianWarning,
    AutoApprovalReviewStrictReviewRequired,
    ItemAutoApprovalReviewCompleted,
    Warning,
    DeprecationNotice,
    ConfigWarning,
    TurnModerationMetadata,
    ModelVerification,
    ModelProviderAuthRecoveryStarted,
    ModelProviderAuthRecoveryCompleted,
    WindowsWorldWritableWarning,
    ThreadRealtimeStarted,
    ThreadRealtimeItemAdded,
    ThreadRealtimeItemStarted,
    ThreadRealtimeItemTranscriptDelta,
    ThreadRealtimeItemCompleted,
    ThreadRealtimeTranscriptDelta,
    ThreadRealtimeTranscriptDone,
    ThreadRealtimeOutputAudioDelta,
    ThreadRealtimeSdp,
    ThreadRealtimeError,
    ThreadRealtimeClosed,
    ItemAgentMessageDelta,
    ItemPlanDelta,
    ItemReasoningSummaryTextDelta,
    ItemReasoningSummaryPartAdded,
    ItemReasoningTextDelta,
    ItemCommandExecutionOutputDelta,
}

// Each method by its text, built once; the key is untrusted text from the service.
static CODEX_INBOUND_METHOD_BY_TEXT: LazyLock<HashMap<&'static str, CodexInboundMethod>> =
    LazyLock::new(|| {
        CodexInboundMethod::VARIANTS
            .iter()
            .map(|inbound_method| (inbound_method.method(), *inbound_method))
            .collect()
    });

impl CodexInboundMethod {
    fn from_method(method: &str) -> Option<Self> {
        CODEX_INBOUND_METHOD_BY_TEXT.get(method).copied()
    }

    // The method's text as the service's schema spells it.
    const fn method(self) -> &'static str {
        match self {
            Self::ItemToolCall => "item/tool/call",
            Self::ItemToolRequestUserInput => "item/tool/requestUserInput",
            Self::McpServerElicitationRequest => "mcpServer/elicitation/request",
            Self::ItemCommandExecutionRequestApproval => "item/commandExecution/requestApproval",
            Self::ItemFileChangeRequestApproval => "item/fileChange/requestApproval",
            Self::ItemPermissionsRequestApproval => "item/permissions/requestApproval",
            Self::ExecCommandApproval => "execCommandApproval",
            Self::ApplyPatchApproval => "applyPatchApproval",
            Self::AttestationGenerate => "attestation/generate",
            Self::AccountChatgptAuthTokensRefresh => "account/chatgptAuthTokens/refresh",
            Self::ThreadStarted => CODEX_THREAD_STARTED_METHOD,
            Self::TurnStarted => CODEX_TURN_STARTED_METHOD,
            Self::TurnCompleted => CODEX_TURN_COMPLETED_METHOD,
            Self::Error => "error",
            Self::ItemStarted => CODEX_ITEM_STARTED_METHOD,
            Self::ItemCompleted => CODEX_ITEM_COMPLETED_METHOD,
            Self::ModelRerouted => "model/rerouted",
            Self::ModelSafetyBufferingUpdated => "model/safetyBuffering/updated",
            Self::TurnPlanUpdated => "turn/plan/updated",
            Self::ThreadSettingsUpdated => CODEX_THREAD_SETTINGS_UPDATED_METHOD,
            Self::ThreadTokenUsageUpdated => CODEX_THREAD_TOKEN_USAGE_METHOD,
            Self::ThreadCompacted => CODEX_THREAD_COMPACTED_METHOD,
            Self::ThreadClosed => "thread/closed",
            Self::ThreadStatusChanged => CODEX_THREAD_STATUS_CHANGED_METHOD,
            Self::ServerRequestResolved => "serverRequest/resolved",
            Self::SkillsChanged => CODEX_SKILLS_CHANGED_METHOD,
            Self::ThreadGoalUpdated => "thread/goal/updated",
            Self::ThreadGoalCleared => "thread/goal/cleared",
            Self::AccountRateLimitsUpdated => "account/rateLimits/updated",
            Self::GuardianWarning => "guardianWarning",
            Self::AutoApprovalReviewStrictReviewRequired => {
                "autoApprovalReview/strictReviewRequired"
            }
            Self::ItemAutoApprovalReviewCompleted => "item/autoApprovalReview/completed",
            Self::Warning => "warning",
            Self::DeprecationNotice => "deprecationNotice",
            Self::ConfigWarning => "configWarning",
            Self::TurnModerationMetadata => "turn/moderationMetadata",
            Self::ModelVerification => "model/verification",
            Self::ModelProviderAuthRecoveryStarted => "modelProvider/authRecoveryStarted",
            Self::ModelProviderAuthRecoveryCompleted => "modelProvider/authRecoveryCompleted",
            Self::WindowsWorldWritableWarning => "windows/worldWritableWarning",
            Self::ThreadRealtimeStarted => "thread/realtime/started",
            Self::ThreadRealtimeItemAdded => "thread/realtime/itemAdded",
            Self::ThreadRealtimeItemStarted => "thread/realtime/item/started",
            Self::ThreadRealtimeItemTranscriptDelta => "thread/realtime/item/transcript/delta",
            Self::ThreadRealtimeItemCompleted => "thread/realtime/item/completed",
            Self::ThreadRealtimeTranscriptDelta => "thread/realtime/transcript/delta",
            Self::ThreadRealtimeTranscriptDone => "thread/realtime/transcript/done",
            Self::ThreadRealtimeOutputAudioDelta => "thread/realtime/outputAudio/delta",
            Self::ThreadRealtimeSdp => "thread/realtime/sdp",
            Self::ThreadRealtimeError => "thread/realtime/error",
            Self::ThreadRealtimeClosed => "thread/realtime/closed",
            Self::ItemAgentMessageDelta => "item/agentMessage/delta",
            Self::ItemPlanDelta => "item/plan/delta",
            Self::ItemReasoningSummaryTextDelta => "item/reasoning/summaryTextDelta",
            Self::ItemReasoningSummaryPartAdded => "item/reasoning/summaryPartAdded",
            Self::ItemReasoningTextDelta => "item/reasoning/textDelta",
            Self::ItemCommandExecutionOutputDelta => "item/commandExecution/outputDelta",
        }
    }

    fn row(self) -> CodexFrameRow {
        use CodexFrameReading::{Emits, EmitsEvent, Reads};
        match self {
            // Server requests. The approval methods, `execCommandApproval` and `applyPatchApproval`
            // among them, are the approval card; a question and a tool server's question are the
            // questions card, Codex's own approval of a tool-server call splitting off by its kind;
            // `item/tool/call` is a daemon tool's call.
            Self::ItemToolCall => request(ASK, Emits(NormalizedEventKind::ToolStart)),
            Self::ItemToolRequestUserInput | Self::McpServerElicitationRequest => {
                request(ASK, Emits(NormalizedEventKind::UserInputRequest))
            }
            Self::ItemCommandExecutionRequestApproval
            | Self::ItemFileChangeRequestApproval
            | Self::ItemPermissionsRequestApproval
            | Self::ExecCommandApproval
            | Self::ApplyPatchApproval => request(ASK, Emits(NormalizedEventKind::ApprovalRequest)),
            Self::AttestationGenerate => request(
                CONNECTION,
                Reads("declined at negotiation, so it is refused on the transport"),
            ),
            Self::AccountChatgptAuthTokensRefresh => request(
                CONNECTION,
                Reads(
                    "credential brokering the driver does not do, so it is refused on the \
                     transport",
                ),
            ),

            // A turn's life and its items.
            Self::ThreadStarted => {
                notification(LIFECYCLE, Emits(NormalizedEventKind::SubagentStatus))
            }
            Self::TurnStarted => notification(LIFECYCLE, Emits(NormalizedEventKind::TurnStart)),
            Self::TurnCompleted => {
                notification(LIFECYCLE, Emits(NormalizedEventKind::TurnComplete))
            }
            Self::Error => notification(LIFECYCLE, Emits(NormalizedEventKind::Error)),
            Self::ItemStarted => notification(CONTENT, Emits(NormalizedEventKind::ToolStart)),
            Self::ItemCompleted => notification(CONTENT, Emits(NormalizedEventKind::ToolComplete)),
            Self::ModelRerouted => notification(CONTENT, Emits(NormalizedEventKind::ModelRerouted)),
            Self::ModelSafetyBufferingUpdated => notification(
                LIFECYCLE,
                Reads("Codex's safety hold on a turn, shown live on the run's state stream"),
            ),
            Self::TurnPlanUpdated => notification(CONTENT, Reads("the turn's live task list")),
            Self::ThreadSettingsUpdated => notification(
                CONTENT,
                Reads("the thread's declared output speed and each run's settled one"),
            ),
            Self::ThreadTokenUsageUpdated => {
                notification(USAGE, Reads("metered by the usage accountant"))
            }
            Self::ThreadCompacted => {
                notification(USAGE, Reads("settles a compaction the person asked for"))
            }
            Self::ThreadClosed => notification(
                LIFECYCLE,
                Reads(
                    "the service unloaded the conversation, which a move to another service \
                     waits for",
                ),
            ),
            Self::ThreadStatusChanged => notification(
                LIFECYCLE,
                Reads(
                    "a conversation gone idle, at which one a session moved off reads its \
                     running commands again",
                ),
            ),
            Self::ServerRequestResolved => notification(
                ASK,
                Reads("Codex settled a request itself, so its held answer is let go"),
            ),
            Self::SkillsChanged => {
                notification(CONNECTION, Reads("the held command list is read again"))
            }
            Self::ThreadGoalUpdated => {
                notification(CONTENT, EmitsEvent(SessionEventType::SessionGoalUpdated))
            }
            Self::ThreadGoalCleared => {
                notification(CONTENT, EmitsEvent(SessionEventType::SessionGoalCleared))
            }
            Self::AccountRateLimitsUpdated => notification(
                CONNECTION,
                Reads("the account's latest usage-limit reading, read when a turn fails"),
            ),

            // Codex's own reviewer.
            Self::GuardianWarning | Self::AutoApprovalReviewStrictReviewRequired => notification(
                CONTENT,
                EmitsEvent(SessionEventType::ApprovalReviewerFlagged),
            ),
            Self::ItemAutoApprovalReviewCompleted => notification(
                CONTENT,
                EmitsEvent(SessionEventType::ApprovalReviewerDenied),
            ),

            // Notices: a warning and a deprecation are the provider's own warning, a config
            // warning a setting Codex ignored.
            Self::Warning | Self::DeprecationNotice | Self::ConfigWarning => {
                notification(CONNECTION, Emits(NormalizedEventKind::Notification))
            }
            Self::TurnModerationMetadata => notification(
                CONTENT,
                Reads("a moderation hint with no words, written to the daemon's log only"),
            ),
            Self::ModelVerification => notification(
                CONTENT,
                Reads("a notice no screen draws, written to the daemon's log"),
            ),
            Self::ModelProviderAuthRecoveryStarted | Self::ModelProviderAuthRecoveryCompleted => {
                notification(CONNECTION, Reads(AUTH_RECOVERY_READING))
            }
            Self::WindowsWorldWritableWarning => notification(
                CONNECTION,
                Reads("a Windows folder warning, written to the daemon's log"),
            ),

            // A voice call.
            Self::ThreadRealtimeStarted
            | Self::ThreadRealtimeItemAdded
            | Self::ThreadRealtimeItemStarted
            | Self::ThreadRealtimeItemTranscriptDelta
            | Self::ThreadRealtimeItemCompleted
            | Self::ThreadRealtimeTranscriptDelta
            | Self::ThreadRealtimeTranscriptDone
            | Self::ThreadRealtimeOutputAudioDelta
            | Self::ThreadRealtimeSdp
            | Self::ThreadRealtimeError
            | Self::ThreadRealtimeClosed => notification(CONTENT, Reads(VOICE_CALL_READING)),

            // Streamed pieces of what a completed item carries whole: the reply, its reasoning and
            // a plan stream as stored pieces of their message, a command's output to the
            // running-commands stream.
            Self::ItemAgentMessageDelta
            | Self::ItemPlanDelta
            | Self::ItemReasoningSummaryTextDelta
            | Self::ItemReasoningSummaryPartAdded
            | Self::ItemReasoningTextDelta => notification(CONTENT, Reads(STREAMED_PROSE_READING)),
            Self::ItemCommandExecutionOutputDelta => notification(
                CONTENT,
                Reads("a running command's live output, published to the running-commands stream"),
            ),
        }
    }
}

const fn request(family: ThreadFrameFamilyClass, reading: CodexFrameReading) -> CodexFrameRow {
    CodexFrameRow {
        root: CodexFrameRoot::ServerRequest,
        family,
        reading,
    }
}

const fn notification(family: ThreadFrameFamilyClass, reading: CodexFrameReading) -> CodexFrameRow {
    CodexFrameRow {
        root: CodexFrameRoot::ServerNotification,
        family,
        reading,
    }
}

/// Every notification the service is asked never to send, sent as `optOutNotificationMethods` at
/// `initialize`: the service schema's notifications, in its order, less every one the table reads.
pub(crate) static CODEX_OPT_OUT_NOTIFICATION_METHODS: LazyLock<Vec<&'static str>> =
    LazyLock::new(|| {
        SERVER_NOTIFICATION_METHODS
            .iter()
            .copied()
            .filter(|method| !is_read_notification(method))
            .collect()
    });

// Whether the table holds `method` as a notification it reads.
fn is_read_notification(method: &str) -> bool {
    CodexInboundMethod::from_method(method).is_some_and(|inbound_method| {
        inbound_method.row().root == CodexFrameRoot::ServerNotification
    })
}

/// A frame that becomes one session event. `normalized_kind` is `None` for an event no
/// normalized kind names (a goal's change, Codex's own reviewer).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct CodexEventEmission {
    /// The root the frame arrived on.
    pub(crate) root: CodexFrameRoot,
    /// The event's category, its type's own.
    pub(crate) category: EventCategory,
    /// The event's type.
    pub(crate) event_type: SessionEventType,
    /// The normalized kind the row names, if any.
    pub(crate) normalized_kind: Option<NormalizedEventKind>,
}

/// A frame the driver reads for its own state or the daemon's log, which becomes no event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct CodexReadFrameDisposition {
    /// The root the frame arrived on.
    pub(crate) root: CodexFrameRoot,
    /// What reads it.
    pub(crate) reason: &'static str,
}

/// A frame's event, its reading, or the diagnostic it was routed to.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum CodexFrameEmissionRoute {
    /// The frame becomes an event.
    Emit(CodexEventEmission),
    /// The frame is read and becomes no event.
    Read(CodexReadFrameDisposition),
    /// The frame went to the diagnostic branch, which logged this record unless its method was
    /// already reported on the connection.
    Diagnostic(DriverDiagnosticRecord),
}

/// The driver core's entry point onto the table for the frame whose method is `method`, for the
/// account `provider_account_id` names. Never fails: a method outside the table, or an opted-out
/// notification that arrived anyway, is routed to a diagnostic logged once per method on the
/// connection `reports` belongs to, never forced into an event or dropped.
pub(crate) fn resolve_codex_frame_emission_route(
    method: &str,
    provider_account_id: Option<ProviderAccountId>,
    reports: &mut OnceReportedDiagnostics,
) -> CodexFrameEmissionRoute {
    let Some(inbound_method) = CodexInboundMethod::from_method(method) else {
        let disposition_reason = if SERVER_NOTIFICATION_METHODS.contains(&method) {
            "a notification the connection opted out of arrived anyway; routed to the daemon \
             diagnostic branch, never silently dropped"
        } else {
            "wire method outside the Codex inbound table; routed to the daemon diagnostic branch, \
             never silently dropped and never forced into an event"
        };
        let record = DriverDiagnosticRecord {
            provider: super::DESCRIPTOR.provider_id(),
            provider_account_id,
            kind: DriverDiagnosticKind::UnmappedWireKind,
            raw_wire_type: Some(method.to_owned()),
            disposition_reason: disposition_reason.to_owned(),
            details: Map::new(),
        };
        reports.report(&record);
        return CodexFrameEmissionRoute::Diagnostic(record);
    };
    let row = inbound_method.row();
    match row.reading {
        CodexFrameReading::Emits(normalized_kind) => {
            let target = resolve_adopted_event_target(normalized_kind)
                .expect("every normalized kind the table names is adopted onto an event type");
            CodexFrameEmissionRoute::Emit(CodexEventEmission {
                root: row.root,
                category: target.category,
                event_type: target.event_type,
                normalized_kind: Some(normalized_kind),
            })
        }
        CodexFrameReading::EmitsEvent(event_type) => {
            CodexFrameEmissionRoute::Emit(CodexEventEmission {
                root: row.root,
                category: event_type.category(),
                event_type,
                normalized_kind: None,
            })
        }
        CodexFrameReading::Reads(reason) => {
            CodexFrameEmissionRoute::Read(CodexReadFrameDisposition {
                root: row.root,
                reason,
            })
        }
    }
}

/// The method's routing family for the thread-frame router: a connection-scoped family needs no
/// thread identity, a thread-scoped one demands one, and a method outside the table is `Unknown`,
/// never presumed connection-scoped.
pub(crate) fn classify_codex_frame_family_for_routing(method: &str) -> ThreadFrameFamilyClass {
    CodexInboundMethod::from_method(method).map_or(ThreadFrameFamilyClass::Unknown, |inbound| {
        inbound.row().family
    })
}

/// The value Codex puts in an elicitation's `_meta.codex_approval_kind` when the elicitation is its
/// own approval of a tool-server call rather than the server's question.
const CODEX_TOOL_CALL_APPROVAL_KIND: &str = "mcp_tool_call";

// The one member of an elicitation's params the approval check reads.
#[derive(Deserialize)]
struct ElicitationParams {
    #[serde(rename = "_meta")]
    meta: Option<ElicitationMeta>,
}

#[derive(Deserialize)]
struct ElicitationMeta {
    codex_approval_kind: Option<String>,
}

/// Whether an elicitation, its params given as the service sent their JSON text, is Codex's own
/// approval of a tool-server call. Params that do not read as an object with that kind answer
/// `false`, so the elicitation reaches the person as the server's question.
pub(crate) fn is_codex_tool_call_approval_elicitation(params_json: &[u8]) -> bool {
    let params_text = decode_inbound_json(params_json);
    serde_json::from_str::<ElicitationParams>(&params_text).is_ok_and(|params| {
        params
            .meta
            .and_then(|meta| meta.codex_approval_kind)
            .is_some_and(|kind| kind == CODEX_TOOL_CALL_APPROVAL_KIND)
    })
}

/// The thread source kinds that mark a provider-attributed subagent child, whose spend attributes
/// to that subagent. The other kind, `subAgentCompact`, is a compaction thread whose spend
/// attributes to the parent run.
const CODEX_SUBAGENT_ATTRIBUTED_THREAD_SOURCE_KINDS: &[&str] = &[
    "subAgent",
    "subAgentReview",
    "subAgentThreadSpawn",
    "subAgentOther",
];

/// The router's announcement of the child thread a `thread/started` notification names, from its
/// thread id, the parent thread it declares and its thread source kind. The child's thread id
/// doubles as the subagent identity on a subagent-attributed kind; any other kind, a compaction
/// child or one a newer service adds, has none, so its spend attributes to the parent run.
pub(crate) fn derive_codex_child_thread_announcement(
    thread_id: String,
    parent_thread_id: Option<String>,
    thread_source_kind: &str,
) -> ChildThreadAnnouncement {
    let subagent_id = CODEX_SUBAGENT_ATTRIBUTED_THREAD_SOURCE_KINDS
        .contains(&thread_source_kind)
        .then(|| thread_id.clone());
    ChildThreadAnnouncement {
        child_thread_id: thread_id,
        declared_parent_thread_id: parent_thread_id,
        subagent_id,
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use strum::VariantArray;

    use super::{
        CODEX_OPT_OUT_NOTIFICATION_METHODS, CodexFrameEmissionRoute, CodexFrameRoot,
        CodexInboundMethod, resolve_codex_frame_emission_route,
    };
    use crate::provider::driver::codex::vendored_schema::vendored_schema_file;
    use crate::provider::driver::diagnostics::{OnceReportedDiagnostics, RecordedEvents};

    // The notification names of the vendored service schema, in its order.
    fn bundle_notification_methods() -> Vec<String> {
        vendored_schema_file("ServerNotification.json")["oneOf"]
            .as_array()
            .expect("the notification schema is a union")
            .iter()
            .map(|arm| {
                arm["properties"]["method"]["enum"][0]
                    .as_str()
                    .expect("each arm names its method")
                    .to_owned()
            })
            .collect()
    }

    #[test]
    fn the_opt_out_list_is_the_schemas_notifications_less_the_ones_read() {
        let schema_methods = bundle_notification_methods();
        let read_notifications: Vec<&str> = CodexInboundMethod::VARIANTS
            .iter()
            .filter(|inbound| inbound.row().root == CodexFrameRoot::ServerNotification)
            .map(|inbound| inbound.method())
            .collect();
        for method in &read_notifications {
            assert!(
                schema_methods
                    .iter()
                    .any(|schema_method| schema_method == method),
                "the table reads {method}, which the schema does not name"
            );
        }

        let expected: Vec<&str> = schema_methods
            .iter()
            .map(String::as_str)
            .filter(|method| !read_notifications.contains(method))
            .collect();
        assert_eq!(*CODEX_OPT_OUT_NOTIFICATION_METHODS, expected);
        assert!(CODEX_OPT_OUT_NOTIFICATION_METHODS.contains(&"thread/readState/changed"));
        // No opted-out method is one a row emits or reads.
        for method in CODEX_OPT_OUT_NOTIFICATION_METHODS.iter() {
            assert_eq!(CodexInboundMethod::from_method(method), None, "{method}");
        }
    }

    #[rstest]
    #[case::outside_the_table("thread/brandNew", "outside the Codex inbound table")]
    #[case::opted_out("thread/archived", "opted out of arrived anyway")]
    fn an_unmapped_notification_is_reported_once_per_method(
        #[case] method: &str,
        #[case] reason: &str,
    ) {
        let recorded = RecordedEvents::default();
        let mut reports = OnceReportedDiagnostics::default();
        let mut routes = Vec::new();
        recorded.record_during(|| {
            routes.push(resolve_codex_frame_emission_route(
                method,
                None,
                &mut reports,
            ));
            routes.push(resolve_codex_frame_emission_route(
                method,
                None,
                &mut reports,
            ));
        });

        assert!(
            routes
                .iter()
                .all(|route| matches!(route, CodexFrameEmissionRoute::Diagnostic(_))),
            "{routes:?}"
        );
        assert_eq!(
            recorded.field_on("driver.normalize.unmappedWireKind", "raw_wire_type"),
            [method]
        );
        let reasons = recorded.field_on("driver.normalize.unmappedWireKind", "disposition_reason");
        assert!(
            reasons.iter().all(|logged| logged.contains(reason)),
            "{reasons:?}"
        );
    }
}
