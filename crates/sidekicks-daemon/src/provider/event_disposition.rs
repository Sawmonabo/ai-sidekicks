//! How the provider drivers dispose of each normalized event kind: the daemon-side half of the
//! event taxonomy.
//!
//! The drivers normalize both provider wires into a fixed vocabulary of kinds before the taxonomy
//! maps each kind onto a session event type. Every kind has exactly one disposition: an adopted
//! kind names its event type, and every correlated or discarded kind states why beside its arm, so
//! no capability-bearing kind is dropped silently. A provider wire name that differs from its kind
//! is mapped onto the kind in that provider's normalizer; this table names only what a kind
//! becomes.
//!
//! The table covers the normalized kinds only: wire-level channel discards and delta families
//! belong to the normalizers' wire layer, and a wire kind outside the vocabulary is caught by the
//! normalizers' own diagnostic. Being in the table is no license to emit: a normalizer routes a
//! kind to its diagnostic until the owning surface registers the event's payload variant.

use sidekicks_contracts::event::envelope::EventCategory;
use sidekicks_contracts::event::registry::SessionEventType;

/// One kind in the closed normalized vocabulary the provider drivers map their wires into.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum NormalizedEventKind {
    /// The provider's own init report at a run's start.
    #[expect(
        dead_code,
        reason = "the disposition table's vocabulary, for a provider reader that maps its wire \
                  onto it"
    )]
    Init,
    /// A piece of the agent's reply text.
    #[expect(
        dead_code,
        reason = "the disposition table's vocabulary, for a provider reader that maps its wire \
                  onto it"
    )]
    TextDelta,
    /// A tool call's start.
    ToolStart,
    /// A tool call's completion.
    ToolComplete,
    /// A turn's start.
    TurnStart,
    /// A turn's completion.
    TurnComplete,
    /// A provider's permission ask that reaches a person.
    ApprovalRequest,
    /// How a permission ask was answered.
    #[expect(
        dead_code,
        reason = "the disposition table's vocabulary, for a provider reader that maps its wire \
                  onto it"
    )]
    ApprovalResolved,
    /// A structured question to the person.
    UserInputRequest,
    /// The answer to a structured question.
    #[expect(
        dead_code,
        reason = "the disposition table's vocabulary, for a provider reader that maps its wire \
                  onto it"
    )]
    UserInputResolved,
    /// The provider's retry-or-edit choice on a refused turn that names a fallback model.
    #[expect(
        dead_code,
        reason = "the disposition table's vocabulary, for a provider reader that maps its wire \
                  onto it"
    )]
    RefusalChoiceRequest,
    /// The provider's switch-or-credits choice when a turn needs usage credits.
    #[expect(
        dead_code,
        reason = "the disposition table's vocabulary, for a provider reader that maps its wire \
                  onto it"
    )]
    UsageCreditsChoiceRequest,
    /// The provider's coarse status.
    #[expect(
        dead_code,
        reason = "the disposition table's vocabulary, for a provider reader that maps its wire \
                  onto it"
    )]
    SessionStatus,
    /// A token usage reading.
    #[expect(
        dead_code,
        reason = "the disposition table's vocabulary, for a provider reader that maps its wire \
                  onto it"
    )]
    TokenUsage,
    /// A run's failure.
    Error,
    /// A snapshot of the turn's task list.
    #[expect(
        dead_code,
        reason = "the disposition table's vocabulary, for a provider reader that maps its wire \
                  onto it"
    )]
    TodoUpdate,
    /// A task created in the turn's task list.
    #[expect(
        dead_code,
        reason = "the disposition table's vocabulary, for a provider reader that maps its wire \
                  onto it"
    )]
    TaskCreate,
    /// A task in the turn's task list changed.
    #[expect(
        dead_code,
        reason = "the disposition table's vocabulary, for a provider reader that maps its wire \
                  onto it"
    )]
    TaskUpdate,
    /// A generic notice for the person.
    Notification,
    /// A transient retry of a provider call.
    #[expect(
        dead_code,
        reason = "the disposition table's vocabulary, for a provider reader that maps its wire \
                  onto it"
    )]
    ApiRetry,
    /// The provider compacted its context window.
    #[expect(
        dead_code,
        reason = "the disposition table's vocabulary, for a provider reader that maps its wire \
                  onto it"
    )]
    CompactBoundary,
    /// An account's quota snapshot.
    #[expect(
        dead_code,
        reason = "the disposition table's vocabulary, for a provider reader that maps its wire \
                  onto it"
    )]
    RateLimits,
    /// The provider moved the run to another model.
    ModelRerouted,
    /// The session or thread was renamed.
    #[expect(
        dead_code,
        reason = "the disposition table's vocabulary, for a provider reader that maps its wire \
                  onto it"
    )]
    ThreadRenamed,
    /// A streamed content block opened.
    #[expect(
        dead_code,
        reason = "the disposition table's vocabulary, for a provider reader that maps its wire \
                  onto it"
    )]
    ContentBlockStart,
    /// A streamed content block closed.
    #[expect(
        dead_code,
        reason = "the disposition table's vocabulary, for a provider reader that maps its wire \
                  onto it"
    )]
    ContentBlockStop,
    /// A background task ended, with its fuller completion.
    #[expect(
        dead_code,
        reason = "the disposition table's vocabulary, for a provider reader that maps its wire \
                  onto it"
    )]
    BackgroundTaskTerminal,
    /// A background task's notice that is not a lifecycle step.
    #[expect(
        dead_code,
        reason = "the disposition table's vocabulary, for a provider reader that maps its wire \
                  onto it"
    )]
    BackgroundTaskNotification,
    /// A detached child's ending notice, carried into the parent's next turn.
    #[expect(
        dead_code,
        reason = "the disposition table's vocabulary, for a provider reader that maps its wire \
                  onto it"
    )]
    SubagentNotification,
    /// A subagent's lifecycle or a child thread's status.
    SubagentStatus,
    /// A command's exit.
    #[expect(
        dead_code,
        reason = "the disposition table's vocabulary, for a provider reader that maps its wire \
                  onto it"
    )]
    CommandExit,
    /// Input written to a backgrounded terminal.
    #[expect(
        dead_code,
        reason = "the disposition table's vocabulary, for a provider reader that maps its wire \
                  onto it"
    )]
    TerminalInteraction,
    /// The provider's echo of a message the app sent.
    #[expect(
        dead_code,
        reason = "the disposition table's vocabulary, for a provider reader that maps its wire \
                  onto it"
    )]
    UserText,
    /// A file diff.
    #[expect(
        dead_code,
        reason = "the disposition table's vocabulary, for a provider reader that maps its wire \
                  onto it"
    )]
    Diff,
    /// A command's output.
    #[expect(
        dead_code,
        reason = "the disposition table's vocabulary, for a provider reader that maps its wire \
                  onto it"
    )]
    CommandOutput,
    /// The agent's thinking.
    #[expect(
        dead_code,
        reason = "the disposition table's vocabulary, for a provider reader that maps its wire \
                  onto it"
    )]
    Thinking,
    /// A plan proposal.
    #[expect(
        dead_code,
        reason = "the disposition table's vocabulary, for a provider reader that maps its wire \
                  onto it"
    )]
    ProposedPlan,
}

/// What a normalized kind becomes. Fan-out by outcome (`agent.toolCall.failed`,
/// `approval.rejected`, `agent.subagent.completed`) is the normalizer's business; an adopted kind
/// names its primary target.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EventKindDisposition {
    /// Becomes an event of this type.
    Adopt(SessionEventType),
    /// Folds into an existing row by its correlation id and adds no event.
    Correlate,
    /// Is consumed transiently and adds no event.
    Discard,
}

impl NormalizedEventKind {
    #[expect(
        clippy::match_same_arms,
        reason = "each discarded kind keeps its own arm beside the reason it is discarded"
    )]
    const fn disposition(self) -> EventKindDisposition {
        use EventKindDisposition::{Adopt, Correlate, Discard};
        match self {
            // The daemon's own run state changes are never mapped from a provider's init.
            Self::Init => Adopt(SessionEventType::AgentRunProviderInitialized),
            Self::TextDelta | Self::ProposedPlan => Adopt(SessionEventType::AgentMessageSent),
            Self::ToolStart | Self::TerminalInteraction => {
                Adopt(SessionEventType::AgentToolCallInvoked)
            }
            // A tool's completion fans to `agent.toolCall.failed` when the tool failed.
            Self::ToolComplete
            | Self::BackgroundTaskNotification
            | Self::CommandExit
            | Self::Diff
            | Self::CommandOutput => Adopt(SessionEventType::AgentToolCallCompleted),
            Self::TurnStart => Adopt(SessionEventType::AgentTurnStarted),
            // The turn's own end; whether it ends the run is the run engine's to write beside it.
            Self::TurnComplete => Adopt(SessionEventType::AgentTurnCompleted),
            // Recorded once as the approval it opens; an ask the daemon answers itself appends
            // nothing, since the tool row is the record.
            Self::ApprovalRequest => Adopt(SessionEventType::ApprovalRequested),
            // Fans by outcome to `approval.rejected` or `approval.canceled`.
            Self::ApprovalResolved => Adopt(SessionEventType::ApprovalApproved),
            Self::UserInputRequest => Adopt(SessionEventType::QuestionAsked),
            // The answer is recorded as the person's own `user.message.sent` by the call that
            // answered the question; its delivery to the provider is kept in the service log only.
            Self::UserInputResolved => Discard,
            // Its answer is appended by the daemon when it answers and is no kind.
            Self::RefusalChoiceRequest => Adopt(SessionEventType::AgentRunRefusalChoiceRequested),
            Self::UsageCreditsChoiceRequest => {
                Adopt(SessionEventType::AgentRunUsageCreditsChoiceRequested)
            }
            // It never drives a session state change, so none is made up from it.
            Self::SessionStatus => Adopt(SessionEventType::SessionProviderStatusReported),
            Self::TokenUsage => Adopt(SessionEventType::UsageTokenCountRecorded),
            Self::Error => Adopt(SessionEventType::AgentRunFailed),
            // Each feeds the turn's live task list, served while the turn runs; never stored and
            // never a tool row, because the task list is never a row in the transcript.
            Self::TodoUpdate | Self::TaskCreate | Self::TaskUpdate => Discard,
            Self::Notification => Adopt(SessionEventType::SessionNoticePosted),
            Self::ApiRetry => Adopt(SessionEventType::UsageApiRequestRetried),
            // The provider's compaction, apart from the daemon's own event compaction.
            Self::CompactBoundary => Adopt(SessionEventType::AgentRunContextCompacted),
            Self::RateLimits => Adopt(SessionEventType::UsageRateLimitUpdated),
            Self::ModelRerouted => Adopt(SessionEventType::AgentTurnRerouted),
            Self::ThreadRenamed => Adopt(SessionEventType::SessionRenamed),
            // Streaming boundaries around a text piece, which carries the content that lasts.
            Self::ContentBlockStart | Self::ContentBlockStop => Discard,
            // A background task's ending never replaces its tool's own completion row.
            Self::BackgroundTaskTerminal | Self::SubagentNotification => {
                Adopt(SessionEventType::AgentSubagentCompleted)
            }
            // Fans to `agent.subagent.completed`.
            Self::SubagentStatus => Adopt(SessionEventType::AgentSubagentStarted),
            // An echo confirms delivery and folds into that message's `user.message.sent` row.
            Self::UserText => Correlate,
            Self::Thinking => Adopt(SessionEventType::AgentThinkingUpdated),
        }
    }
}

/// The session event a normalizer row emits: its category and its registered type.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct AdoptedEventTarget {
    /// The event's category, the one its type belongs to.
    pub(crate) category: EventCategory,
    /// The event's type.
    pub(crate) event_type: SessionEventType,
}

/// The target the table adopts `kind` onto, for a normalizer row that names that kind; `None` for
/// a kind the table correlates or discards, which a row that emits one must treat as its own
/// defect.
pub(crate) const fn resolve_adopted_event_target(
    kind: NormalizedEventKind,
) -> Option<AdoptedEventTarget> {
    match kind.disposition() {
        EventKindDisposition::Adopt(event_type) => Some(AdoptedEventTarget {
            category: event_type.category(),
            event_type,
        }),
        EventKindDisposition::Correlate | EventKindDisposition::Discard => None,
    }
}
