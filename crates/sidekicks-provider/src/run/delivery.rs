//! What a provider driver hands the run engine's inbound dispatch, on a binding in its delivery
//! order or about a session or the machine on none, and what the dispatch did with it: the
//! deliveries, the provider operation each belongs to, the marker a provider reports on a live run,
//! and the rows a delivery carries, those that take the source-epoch stamp when late, those on a
//! run that take none, and those about the session as a whole or the machine, each with the
//! conversion that makes its event. A run's row that lands after its run, on that run's own
//! binding, is its own delivery.

use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::command::AgentCommandEndedPayload;
use sidekicks_contracts::event::declared_variants::{
    AgentOutputPayload, RunAgentOutputPayload, ToolActivityPayload, ToolCallBackgroundedPayload,
    ToolCallFailedPayload,
};
use sidekicks_contracts::event::envelope::{
    DAEMON_SCOPE_SENTINEL_SESSION_ID, SourceEpoch, SourcePosition,
};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::event::usage::{
    AgentRunContextCompactedPayload, AgentTurnReroutedPayload, UsageApiRequestRetriedPayload,
    UsageContextWindowUpdatedPayload, UsageCostUpdatedPayload, UsageRateLimitUpdatedPayload,
    UsageTokenCountRecordedPayload,
};
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::provider::driver::methods::{
    PROVIDER_WIRE_HANDLE_MAX_LEN, PROVIDER_WIRE_TOKEN_MAX_LEN,
};
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::provider_choice::{
    AgentRunRefusalChoiceRequestedPayload, AgentRunRefusalChoiceResolvedPayload,
    AgentRunUsageCreditsChoiceRequestedPayload, AgentRunUsageCreditsChoiceResolvedPayload,
};
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::run::subagent::{SubagentId, SubagentLifecyclePayload};
use sidekicks_contracts::session::controls::events::{
    ApprovalReviewerFlaggedPayload, RunSafetyBufferingUpdatedPayload, SessionNoticePostedPayload,
    SessionSideQuestionAnsweredPayload,
};
use sidekicks_contracts::session::events::{
    SessionAdvisorChangedPayload, SessionOutputStyleChangedPayload,
    SessionProviderStatusReportedPayload,
};
use sidekicks_contracts::session::goal::{SessionGoalClearedPayload, SessionGoalUpdatedPayload};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::turn_attribution::EpochPosition;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::list::BoundedVec;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::run::state_entry::RunStateReport;
use crate::run::turn_end::ProviderTurnEnd;

/// The provider-side operation a delivery belongs to (a tool call, a message item, an artifact),
/// by the key the provider correlates its deliveries with. The first delivery of every operation
/// is passed as its opening; a later one that finds no opening held is read as one evicted.
#[derive(Clone, Copy, Debug)]
pub struct DeliveryOperation<'key> {
    /// The provider's key for the operation.
    pub correlation_key: &'key str,
    /// Whether this is the operation's first delivery.
    pub is_opening: bool,
}

/// The helper a child run is for, as its provider names it at its start.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChildRunSubagent {
    /// The provider's own id for the helper.
    pub subagent_id: SubagentId,
    /// The provider's id for the helper that launched it, as the provider gave it; `None` for one
    /// the lead launched.
    pub parent_subagent_id: Option<SubagentId>,
    /// The name its provider gave it, where the provider names helpers.
    pub name: Option<FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>>,
    /// The role its provider started it in.
    pub role: Option<FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>>,
    /// Its path in its provider's tree, where the provider keeps one.
    pub provider_path: Option<FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>>,
    /// The model its provider started it on, where the start names one.
    pub model_id: Option<ProviderToken>,
    /// The reasoning effort its provider started it at, in the provider's own word, where the start
    /// names one.
    pub effort: Option<ProviderToken>,
    /// The provider's call that started this run of the helper, where the provider names one.
    pub start_call_id: Option<ToolCallId>,
}

/// The runtime binding a delivery arrived on, and the provider operation it belongs to, where it
/// has one.
#[derive(Debug)]
pub struct DeliveryBinding<'key> {
    /// The binding.
    pub binding_id: RuntimeBindingId,
    /// The provider operation.
    pub operation: Option<DeliveryOperation<'key>>,
}

/// One delivery a provider driver hands the run engine, on its binding and in that binding's
/// delivery order, or about the session as a whole on no binding.
#[derive(Debug)]
pub enum InboundDelivery<'key> {
    /// The binding opened its next turn.
    TurnBoundary {
        /// The binding.
        binding_id: RuntimeBindingId,
    },
    /// The provider took the message `message_id` into turn `turn_number` of the binding's run,
    /// at this point in the binding's delivery order: a steer, or a turn's later opening message.
    TurnSteered {
        /// The binding.
        binding_id: RuntimeBindingId,
        /// The turn the message joined, within its run.
        turn_number: SafeInt<1>,
        /// The queue item whose message the provider took.
        message_id: QueueItemId,
        /// Whether the provider's conversation cut cannot fall between the message and the turn's
        /// opening: a message the provider took together with the opening, or any message on a
        /// provider whose cut lands only at turns.
        is_cut_with_opening: bool,
    },
    /// The provider moved a run.
    RunLifecycle {
        /// Where it arrived.
        binding: DeliveryBinding<'key>,
        /// The move.
        change: RunStateReport,
        /// The end of the turn the move ends, where the provider's end frame reported one.
        turn_end: Option<ProviderTurnEnd>,
        /// Whether this is the provider's end of a turn the daemon's own interrupt stopped, which
        /// the daemon may have written first; refused then, it is absorbed with no diagnostic.
        is_daemon_interrupt_end: bool,
    },
    /// The provider started a turn itself with messages it kept from the interrupted `run_id`'s
    /// turn, which continues that run.
    RunContinued {
        /// Where it arrived.
        binding: DeliveryBinding<'key>,
        /// The interrupted run.
        run_id: RunId,
    },
    /// The provider started a subagent beneath `parent_run_id`.
    ChildRun {
        /// Where it arrived.
        binding: DeliveryBinding<'key>,
        /// The run the subagent starts under.
        parent_run_id: RunId,
        /// The subagent, as its provider names it.
        subagent: ChildRunSubagent,
    },
    /// The provider's call that started the child run `child_run_id` reached the daemon after the
    /// run did; the run moves under `parent_run_id`.
    ChildRunParentCorrected {
        /// Where it arrived.
        binding: DeliveryBinding<'key>,
        /// The child run that moves.
        child_run_id: RunId,
        /// The run whose call started it.
        parent_run_id: RunId,
    },
    /// A marker the provider reported on a live run.
    RunMarker {
        /// Where it arrived.
        binding: DeliveryBinding<'key>,
        /// The marker.
        marker: RunMarker,
    },
    /// A state the run's stream shows live and nothing stores.
    LiveRunState {
        /// Where it arrived.
        binding: DeliveryBinding<'key>,
        /// The state.
        state: RunSafetyBufferingUpdatedPayload,
    },
    /// An assistant's reasoning on a run, appended whole with its body.
    ThinkingUpdate {
        /// Where it arrived.
        binding: DeliveryBinding<'key>,
        /// The update's payload, without the stamp.
        payload: RunAgentOutputPayload,
        /// The reasoning text, stored beside the payload.
        content: String,
    },
    /// A notice about the session `session_id`, on no binding.
    SessionNotice {
        /// The session the notice names.
        session_id: SessionId,
        /// The notice.
        notice: SessionNoticePostedPayload,
    },
    /// A row about the session as a whole, on no binding.
    SessionEvent {
        /// The row.
        row: SessionScopedRow,
    },
    /// A row about the machine, on no binding and in no session.
    MachineEvent {
        /// The row.
        row: MachineScopedRow,
    },
    /// The provider asked the person's permission.
    PermissionAsk {
        /// Where it arrived.
        binding: DeliveryBinding<'key>,
    },
    /// A row that takes the stamp when it is late.
    SessionRow {
        /// Where it arrived.
        binding: DeliveryBinding<'key>,
        /// The row.
        row: LateAppendableRow,
        /// The prose of a body-bearing row, stored beside its payload.
        content: Option<String>,
    },
    /// A row of a run that may land after the run's cursor moved on, on that run's own binding:
    /// appended as it is and never stamped, unless its tool call opened in a turn an undo cut,
    /// which absorbs it.
    AfterRunRow {
        /// The binding of the row's run, which names the delivery in a diagnostic.
        binding_id: RuntimeBindingId,
        /// The row.
        row: LateAppendableRow,
        /// The prose of a body-bearing row, stored beside its payload; `None` for a row with none.
        content: Option<String>,
    },
    /// A row on a run that takes no stamp.
    UnstampedRow {
        /// Where it arrived.
        binding: DeliveryBinding<'key>,
        /// The row.
        row: UnstampedRow,
    },
}

impl InboundDelivery<'_> {
    /// The delivery's kind as a diagnostic names it.
    pub(crate) fn kind_name(&self) -> &'static str {
        match self {
            Self::TurnBoundary { .. } => "turnBoundary",
            Self::TurnSteered { .. } => "turnSteered",
            Self::RunLifecycle { .. } => "runLifecycle",
            Self::RunContinued { .. } => "runContinued",
            Self::ChildRun { .. } => "childRun",
            Self::ChildRunParentCorrected { .. } => "childRunParentCorrected",
            Self::RunMarker { .. } => "runMarker",
            Self::LiveRunState { .. } => "liveRunState",
            Self::ThinkingUpdate { .. } => "thinkingUpdate",
            Self::SessionNotice { .. } => "sessionNotice",
            Self::SessionEvent { .. } => "sessionEvent",
            Self::MachineEvent { .. } => "machineEvent",
            Self::PermissionAsk { .. } => "permissionAsk",
            Self::SessionRow { .. } => "sessionRow",
            Self::AfterRunRow { .. } => "afterRunRow",
            Self::UnstampedRow { .. } => "unstampedRow",
        }
    }
}

/// Why a delivery was absorbed: it came from before an undo's cut, its run had already ended, or
/// it reported a pause or a turn under way that a resume had already moved past.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LateEventAbsorbReason {
    /// From the execution before an undo's cut.
    BeforeCut,
    /// For a run that had already ended.
    RunEnded,
    /// A late `paused` or `running` report on a run a resume had already set running.
    RunResumed,
}

/// What the dispatch did with a delivery. `AskAdmitted` is a permission ask of the current
/// execution, which the caller hands to the approval pipeline; `ChildRunStarted` carries the
/// child's new run, which the caller keeps for the subagent's later deliveries, and
/// `ChildRunRefused` the run of a subagent the daemon refused and ended, which the caller stops;
/// an appended row carries the id of the event written for it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum InboundOutcome {
    /// The binding's next turn opened.
    TurnOpened,
    /// The run moved, into the state the move left it in.
    Transitioned {
        /// The run's state after the move.
        state: RunState,
    },
    /// The subagent's run started.
    ChildRunStarted {
        /// Its run.
        run_id: RunId,
    },
    /// The subagent's run was refused at its setup and ended `failed`, the subagent still running
    /// in its provider.
    ChildRunRefused {
        /// Its ended run.
        run_id: RunId,
        /// Why its setup refused it.
        reason: RunSetupRefusal,
    },
    /// The live state went to the run's state stream.
    Published,
    /// The permission ask belongs to the current execution.
    AskAdmitted,
    /// The row was appended as it came.
    Appended {
        /// The event written.
        event_id: FreeFormText<EVENT_FIELD_MAX_LEN>,
    },
    /// The row was appended stamped as possibly late.
    AppendedStamped {
        /// The event written.
        event_id: FreeFormText<EVENT_FIELD_MAX_LEN>,
        /// The pair it was stamped with.
        source: EpochPosition,
    },
    /// Nothing was written.
    Absorbed {
        /// Why.
        reason: LateEventAbsorbReason,
    },
    /// Nothing was written and the run's position did not move: the message the provider took
    /// into the turn is not one the person sent, such as an answer the daemon wrote into it.
    NotSentByPerson,
}

/// Why the daemon refused a run at its setup, in the refusing gate's own words as the run's
/// failure cause records them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunSetupRefusal {
    /// The refusal's cause, such as a writable root that no longer resolves.
    pub cause: String,
    /// Whether the session's permission level cannot run, its posture rejected, rather than any
    /// other setup failure.
    pub is_posture_rejection: bool,
}

impl InboundOutcome {
    /// The id of the event a delivery was written as; `None` where nothing was written.
    pub fn event_id(&self) -> Option<&FreeFormText<EVENT_FIELD_MAX_LEN>> {
        match self {
            Self::Appended { event_id } | Self::AppendedStamped { event_id, .. } => Some(event_id),
            Self::TurnOpened
            | Self::Transitioned { .. }
            | Self::ChildRunStarted { .. }
            | Self::ChildRunRefused { .. }
            | Self::Published
            | Self::AskAdmitted
            | Self::Absorbed { .. }
            | Self::NotSentByPerson => None,
        }
    }
}

/// A marker a provider reports on a live run, which changes no state; the engine reads the run's
/// session and version when it records it. A turn's start is no marker: the engine numbers it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RunMarker {
    /// The provider process reported its start for the run (`agent.run.providerInitialized`).
    ProviderInitialized {
        /// The run.
        run_id: RunId,
        /// The provider.
        provider: ProviderId,
        /// The model it runs, where it named one.
        model: Option<FreeFormText<PROVIDER_WIRE_TOKEN_MAX_LEN>>,
    },
    /// The provider said its worker is shutting down mid-run (`agent.run.workerShuttingDown`).
    WorkerShuttingDown {
        /// The run.
        run_id: RunId,
        /// The provider's reason, where it sent one.
        reason: Option<FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>>,
    },
}

impl RunMarker {
    /// The run the marker is on.
    pub fn run_id(&self) -> RunId {
        match self {
            Self::ProviderInitialized { run_id, .. } | Self::WorkerShuttingDown { run_id, .. } => {
                *run_id
            }
        }
    }
}

// Declares the rows a late delivery may carry, each the registered event whose payload takes the
// source-epoch stamp, and the one conversion that stamps a row and makes its event.
macro_rules! late_appendable_rows {
    ($($(#[$doc:meta])* $variant:ident($payload:ty) => $into_event:expr,)+) => {
        /// A provider row a late delivery carries: one of the registered events whose payload
        /// takes the source-epoch stamp, its payload as the producer built it, without the stamp.
        /// A reasoning update is not one: it is its own delivery, since its body is required.
        #[derive(Debug)]
        #[cfg_attr(any(test, feature = "test-support"), derive(Clone, PartialEq))]
        pub enum LateAppendableRow {
            $($(#[$doc])* $variant($payload),)+
        }

        impl LateAppendableRow {
            /// The row's session and its event, stamped with `source`, with the pair it took.
            pub fn into_event(
                self,
                source: Option<EpochPosition>,
            ) -> (SessionId, SessionEvent, Option<EpochPosition>) {
                match self {
                    $(Self::$variant(mut payload) => {
                        let stamped =
                            stamp(&mut payload.source_epoch, &mut payload.source_position, source);
                        (payload.session_id, ($into_event)(payload), stamped)
                    })+
                }
            }
        }
    };
}

late_appendable_rows! {
    /// `agent.message.sent` of a run.
    AgentMessageSent(RunAgentOutputPayload) =>
        |payload| SessionEvent::AgentMessageSent(AgentOutputPayload::Run(payload)),
    /// `agent.toolCall.invoked`.
    AgentToolCallInvoked(ToolActivityPayload) => SessionEvent::AgentToolCallInvoked,
    /// `agent.toolCall.backgrounded`.
    AgentToolCallBackgrounded(ToolCallBackgroundedPayload) =>
        SessionEvent::AgentToolCallBackgrounded,
    /// `agent.toolCall.completed`.
    AgentToolCallCompleted(ToolActivityPayload) => SessionEvent::AgentToolCallCompleted,
    /// `agent.toolCall.failed`.
    AgentToolCallFailed(ToolCallFailedPayload) => SessionEvent::AgentToolCallFailed,
    /// `agent.subagent.started`.
    AgentSubagentStarted(SubagentLifecyclePayload) => SessionEvent::AgentSubagentStarted,
    /// `agent.subagent.completed`.
    AgentSubagentCompleted(SubagentLifecyclePayload) => SessionEvent::AgentSubagentCompleted,
    /// `session.providerStatus.reported`.
    SessionProviderStatusReported(SessionProviderStatusReportedPayload) =>
        SessionEvent::SessionProviderStatusReported,
    /// `agent.command.ended`.
    AgentCommandEnded(AgentCommandEndedPayload) => SessionEvent::AgentCommandEnded,
    /// `usage.tokenCount.recorded`, boxed since its selectors make it the largest row.
    UsageTokenCountRecorded(Box<UsageTokenCountRecordedPayload>) =>
        |payload: Box<_>| SessionEvent::UsageTokenCountRecorded(*payload),
    /// `usage.contextWindow.updated`.
    UsageContextWindowUpdated(UsageContextWindowUpdatedPayload) =>
        SessionEvent::UsageContextWindowUpdated,
    /// `usage.apiRequest.retried`.
    UsageApiRequestRetried(UsageApiRequestRetriedPayload) => SessionEvent::UsageApiRequestRetried,
    /// `agent.run.context.compacted`.
    AgentRunContextCompacted(AgentRunContextCompactedPayload) =>
        SessionEvent::AgentRunContextCompacted,
    /// `agent.turn.rerouted`.
    AgentTurnRerouted(AgentTurnReroutedPayload) => SessionEvent::AgentTurnRerouted,
}

// Declares the rows on a run that take no stamp, each named as its event, with the run it is on
// and the conversion that makes its event.
macro_rules! unstamped_rows {
    ($($(#[$doc:meta])* $variant:ident($payload:ty),)+) => {
        /// A provider row on a run that takes no stamp, because it asks the person something,
        /// records how the provider or its driver settled a choice without the person, or flags
        /// the run: from before a cut it is absorbed, otherwise appended as it is. A settlement's
        /// run move is its own delivery.
        #[derive(Debug)]
        pub enum UnstampedRow {
            $($(#[$doc])* $variant($payload),)+
        }

        impl UnstampedRow {
            /// The run the row is on.
            pub fn run_id(&self) -> RunId {
                match self {
                    $(Self::$variant(payload) => payload.run_id,)+
                }
            }

            /// The row's session and its event.
            pub fn into_event(self) -> (SessionId, SessionEvent) {
                match self {
                    $(Self::$variant(payload) => {
                        (payload.session_id, SessionEvent::$variant(payload))
                    })+
                }
            }
        }
    };
}

unstamped_rows! {
    /// `approval.reviewer.flagged`.
    ApprovalReviewerFlagged(ApprovalReviewerFlaggedPayload),
    /// `agent.run.refusalChoice.requested`.
    AgentRunRefusalChoiceRequested(AgentRunRefusalChoiceRequestedPayload),
    /// `agent.run.refusalChoice.resolved`.
    AgentRunRefusalChoiceResolved(AgentRunRefusalChoiceResolvedPayload),
    /// `agent.run.usageCreditsChoice.requested`.
    AgentRunUsageCreditsChoiceRequested(AgentRunUsageCreditsChoiceRequestedPayload),
    /// `agent.run.usageCreditsChoice.resolved`.
    AgentRunUsageCreditsChoiceResolved(AgentRunUsageCreditsChoiceResolvedPayload),
}

/// A row about the session as a whole, on no binding: a side question's answer, which never
/// enters the conversation, and its usage, which no run counts, a priced request's costs, which
/// may come after its run's binding closed, a change of the session's own advisor or output
/// style, and a change of an agent's goal, which outlives any one run.
#[derive(Debug)]
pub enum SessionScopedRow {
    /// `session.sideQuestion.answered`.
    SideQuestionAnswered(SessionSideQuestionAnsweredPayload),
    /// `usage.tokenCount.recorded` of a side question, naming no run, boxed since its selectors
    /// make it the largest row.
    UsageTokenCountRecorded(Box<UsageTokenCountRecordedPayload>),
    /// Every `usage.cost.updated` of one priced request, one per account its rows were charged
    /// to, in order, all on one session and written together or not at all.
    UsageCostUpdated(BoundedVec<UsageCostUpdatedPayload, 1, { usize::MAX }>),
    /// `session.advisor.changed`.
    AdvisorChanged(SessionAdvisorChangedPayload),
    /// `session.outputStyle.changed`.
    OutputStyleChanged(SessionOutputStyleChangedPayload),
    /// `session.goal.updated`.
    GoalUpdated(SessionGoalUpdatedPayload),
    /// `session.goal.cleared`.
    GoalCleared(SessionGoalClearedPayload),
}

impl SessionScopedRow {
    /// The row's session, the events written before its last in the same write, in order, and
    /// its last event.
    pub fn into_events(self) -> (SessionId, Vec<SessionEvent>, SessionEvent) {
        match self {
            Self::SideQuestionAnswered(payload) => (
                payload.session_id,
                Vec::new(),
                SessionEvent::SessionSideQuestionAnswered(payload),
            ),
            Self::UsageTokenCountRecorded(payload) => (
                payload.session_id,
                Vec::new(),
                SessionEvent::UsageTokenCountRecorded(*payload),
            ),
            Self::UsageCostUpdated(costs) => {
                let session_id = costs.as_slice()[0].session_id;
                let mut costs = costs.into_vec();
                let last = costs.pop().expect("a request's costs hold at least one");
                let preceding = costs
                    .into_iter()
                    .map(SessionEvent::UsageCostUpdated)
                    .collect();
                (session_id, preceding, SessionEvent::UsageCostUpdated(last))
            }
            Self::AdvisorChanged(payload) => (
                payload.session_id,
                Vec::new(),
                SessionEvent::SessionAdvisorChanged(payload),
            ),
            Self::OutputStyleChanged(payload) => (
                payload.session_id,
                Vec::new(),
                SessionEvent::SessionOutputStyleChanged(payload),
            ),
            Self::GoalUpdated(payload) => (
                payload.session_id,
                Vec::new(),
                SessionEvent::SessionGoalUpdated(payload),
            ),
            Self::GoalCleared(payload) => (
                payload.session_id,
                Vec::new(),
                SessionEvent::SessionGoalCleared(payload),
            ),
        }
    }
}

/// A row about the machine rather than a session, on no binding: an account's quota reading, which
/// carries the account's credential generation and is filed under the machine's sentinel session.
#[derive(Debug)]
pub enum MachineScopedRow {
    /// `usage.rateLimit.updated`.
    UsageRateLimitUpdated(UsageRateLimitUpdatedPayload),
}

impl MachineScopedRow {
    /// The sentinel session the row is filed under, and its event.
    pub fn into_event(self) -> (SessionId, SessionEvent) {
        match self {
            Self::UsageRateLimitUpdated(payload) => (
                *DAEMON_SCOPE_SENTINEL_SESSION_ID,
                SessionEvent::UsageRateLimitUpdated(payload),
            ),
        }
    }
}

/// Stamps a payload's source pair with `source` and answers the pair it took; a payload that
/// carries its own pair, where its provider named the run position it belongs to, keeps it. Epochs
/// are run-local, so a stamp on a row that names no run fails that row's draft.
pub fn stamp(
    source_epoch: &mut Option<SourceEpoch>,
    source_position: &mut Option<SourcePosition>,
    source: Option<EpochPosition>,
) -> Option<EpochPosition> {
    if let (Some(epoch), Some(position)) = (*source_epoch, *source_position) {
        return Some(EpochPosition { epoch, position });
    }
    let source = source?;
    *source_epoch = Some(source.epoch);
    *source_position = Some(source.position);
    Some(source)
}
