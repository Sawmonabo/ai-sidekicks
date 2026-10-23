//! The rows a provider delivery carries into the inbound dispatch: those that take the
//! source-epoch stamp when late, those on a run that take none, and those about the session as a
//! whole, each with the conversion that makes its event.

use sidekicks_contracts::command::AgentCommandEndedPayload;
use sidekicks_contracts::event::declared_variants::{
    AgentOutputPayload, RunAgentOutputPayload, ToolActivityPayload,
};
use sidekicks_contracts::event::envelope::{SourceEpoch, SourcePosition};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::event::usage::{
    AgentRunContextCompactedPayload, AgentTurnReroutedPayload, UsageApiRequestRetriedPayload,
    UsageContextWindowUpdatedPayload, UsageCostUpdatedPayload, UsageTokenCountRecordedPayload,
};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::provider_choice::{
    AgentRunRefusalChoiceRequestedPayload, AgentRunRefusalChoiceResolvedPayload,
    AgentRunUsageCreditsChoiceRequestedPayload, AgentRunUsageCreditsChoiceResolvedPayload,
};
use sidekicks_contracts::run::subagent::SubagentLifecyclePayload;
use sidekicks_contracts::session::controls::events::{
    ApprovalReviewerFlaggedPayload, SessionSideQuestionAnsweredPayload,
};
use sidekicks_contracts::session::events::{
    SessionAdvisorChangedPayload, SessionOutputStyleChangedPayload,
    SessionProviderStatusReportedPayload,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::turn_attribution::EpochPosition;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::database::statement::WriteStatement;
use crate::session::console_state::advisor_model_change_statement;

// Declares the rows a late delivery may carry, each the registered event whose payload takes the
// source-epoch stamp, and the one conversion that stamps a row and makes its event.
macro_rules! late_appendable_rows {
    ($($(#[$doc:meta])* $variant:ident($payload:ty) => $into_event:expr,)+) => {
        /// A provider row this dispatch appends: one of the registered events whose payload takes
        /// the source-epoch stamp, its payload as the producer built it, without the stamp. A
        /// reasoning update is not one: it is its own delivery, since its body is required.
        #[derive(Debug)]
        #[cfg_attr(test, derive(Clone, PartialEq))]
        #[expect(dead_code, reason = "the provider's event delivery builds each row it hands over")]
        pub(crate) enum LateAppendableRow {
            $($(#[$doc])* $variant($payload),)+
        }

        impl LateAppendableRow {
            /// The row's session and its event, stamped with `source`, with the pair it took.
            pub(super) fn into_event(
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
    /// `agent.toolCall.completed`.
    AgentToolCallCompleted(ToolActivityPayload) => SessionEvent::AgentToolCallCompleted,
    /// `agent.toolCall.failed`.
    AgentToolCallFailed(ToolActivityPayload) => SessionEvent::AgentToolCallFailed,
    /// `agent.subagent.started`.
    AgentSubagentStarted(SubagentLifecyclePayload) => SessionEvent::AgentSubagentStarted,
    /// `agent.subagent.completed`.
    AgentSubagentCompleted(SubagentLifecyclePayload) => SessionEvent::AgentSubagentCompleted,
    /// `session.providerStatus.reported`.
    SessionProviderStatusReported(SessionProviderStatusReportedPayload) =>
        SessionEvent::SessionProviderStatusReported,
    /// `agent.command.ended`.
    AgentCommandEnded(AgentCommandEndedPayload) => SessionEvent::AgentCommandEnded,
    /// `usage.tokenCount.recorded`.
    UsageTokenCountRecorded(UsageTokenCountRecordedPayload) =>
        SessionEvent::UsageTokenCountRecorded,
    /// `usage.cost.updated`.
    UsageCostUpdated(UsageCostUpdatedPayload) => SessionEvent::UsageCostUpdated,
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
        #[expect(dead_code, reason = "the provider's event delivery builds each row it hands over")]
        pub(crate) enum UnstampedRow {
            $($(#[$doc])* $variant($payload),)+
        }

        impl UnstampedRow {
            /// The run the row is on.
            pub(super) fn run_id(&self) -> RunId {
                match self {
                    $(Self::$variant(payload) => payload.run_id,)+
                }
            }

            /// The row's session and its event.
            pub(super) fn into_event(self) -> (SessionId, SessionEvent) {
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
/// enters the conversation, and a change of the session's own advisor or output style.
#[derive(Debug)]
#[expect(
    dead_code,
    reason = "the provider's event delivery builds each row it hands over"
)]
pub(crate) enum SessionScopedRow {
    /// `session.sideQuestion.answered`.
    SideQuestionAnswered(SessionSideQuestionAnsweredPayload),
    /// `session.advisor.changed`.
    AdvisorChanged(SessionAdvisorChangedPayload),
    /// `session.outputStyle.changed`.
    OutputStyleChanged(SessionOutputStyleChangedPayload),
}

impl SessionScopedRow {
    /// The row's session, its event and the statements its write commits with it.
    pub(super) fn into_event(self) -> (SessionId, SessionEvent, Vec<WriteStatement>) {
        match self {
            Self::SideQuestionAnswered(payload) => (
                payload.session_id,
                SessionEvent::SessionSideQuestionAnswered(payload),
                Vec::new(),
            ),
            Self::AdvisorChanged(payload) => {
                // The advisor's column is what every later launch reads, so it moves in the
                // event's write.
                let column = advisor_model_change_statement(
                    &payload.session_id,
                    payload.advisor_model.as_ref().map(FreeFormText::as_str),
                    payload.at.as_str(),
                );
                (
                    payload.session_id,
                    SessionEvent::SessionAdvisorChanged(payload),
                    vec![column],
                )
            }
            Self::OutputStyleChanged(payload) => (
                payload.session_id,
                SessionEvent::SessionOutputStyleChanged(payload),
                Vec::new(),
            ),
        }
    }
}

/// Stamps a payload's source pair with `source` and answers the pair it took. Epochs are run-local,
/// so a stamp on a row that names no run fails that row's draft.
pub(super) fn stamp(
    source_epoch: &mut Option<SourceEpoch>,
    source_position: &mut Option<SourcePosition>,
    source: Option<EpochPosition>,
) -> Option<EpochPosition> {
    let source = source?;
    *source_epoch = Some(source.epoch);
    *source_position = Some(source.position);
    Some(source)
}
