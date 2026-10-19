//! The states an intervention reaches, as the events that record them and the answers that
//! report them.

use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::provider::driver::methods::PROVIDER_WIRE_HANDLE_MAX_LEN;
use sidekicks_contracts::run::events::{
    AgentInterventionAcceptedPayload, AgentInterventionAcceptedState,
    AgentInterventionAppliedPayload, AgentInterventionAppliedState,
    AgentInterventionDegradedPayload, AgentInterventionDegradedState,
    AgentInterventionExpiredPayload, AgentInterventionExpiredState, AgentInterventionFailedPayload,
    AgentInterventionFailedState, AgentInterventionRejectedPayload, AgentInterventionRejectedState,
    AgentInterventionRequestedPayload, AgentInterventionRequestedState,
};
use sidekicks_contracts::run::intervention::{
    AgentRunInterveneResponse, InterventionId, InterventionType,
};
use sidekicks_contracts::wire::text::FreeFormText;

use super::InterventionTarget;
use crate::events::session::appender::{SessionEventDraft, SessionEventDraftError};
use crate::session::run::read::{RunRead, safe_run_version};

/// A state an intervention reached, with the reason a rejected or failed one carries.
pub(in crate::interventions) enum ReachedState {
    /// Asked for.
    Requested,
    /// Taken by the daemon.
    Accepted,
    /// Carried out as asked.
    Applied,
    /// Carried out through a fallback.
    Degraded,
    /// Outdated before it could apply.
    Expired,
    /// Refused, with why.
    Rejected(FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>),
    /// Its dispatch threw, never completed or was never sent, with why.
    Failed(FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>),
}

/// The draft of the event that records `target` reaching `state`. Fails when the event breaks a
/// check of its type.
pub(in crate::interventions) fn draft(
    target: &InterventionTarget,
    state: &ReachedState,
) -> Result<SessionEventDraft, SessionEventDraftError> {
    let InterventionTarget {
        session_id,
        intervention_id,
        target_run_id,
        intervention_type,
        actor,
    } = target.clone();
    macro_rules! payload {
        ($payload:ident, $state:ident $(, $extra:ident: $value:expr)?) => {
            $payload {
                session_id,
                intervention_id,
                target_run_id,
                intervention_type,
                state: $state::Value,
                actor,
                $($extra: $value)?
            }
        };
    }
    let event = match state {
        ReachedState::Requested => SessionEvent::AgentInterventionRequested(payload!(
            AgentInterventionRequestedPayload,
            AgentInterventionRequestedState
        )),
        ReachedState::Accepted => SessionEvent::AgentInterventionAccepted(payload!(
            AgentInterventionAcceptedPayload,
            AgentInterventionAcceptedState
        )),
        ReachedState::Applied => SessionEvent::AgentInterventionApplied(payload!(
            AgentInterventionAppliedPayload,
            AgentInterventionAppliedState
        )),
        ReachedState::Degraded => SessionEvent::AgentInterventionDegraded(payload!(
            AgentInterventionDegradedPayload,
            AgentInterventionDegradedState
        )),
        ReachedState::Expired => SessionEvent::AgentInterventionExpired(payload!(
            AgentInterventionExpiredPayload,
            AgentInterventionExpiredState
        )),
        ReachedState::Rejected(_) => SessionEvent::AgentInterventionRejected(payload!(
            AgentInterventionRejectedPayload,
            AgentInterventionRejectedState
        )),
        ReachedState::Failed(reason) => SessionEvent::AgentInterventionFailed(payload!(
            AgentInterventionFailedPayload,
            AgentInterventionFailedState,
            failure_reason: reason.clone()
        )),
    };
    SessionEventDraft::of_session(session_id, &event)
}

/// The answer for `state` reached by an intervention on `run`.
pub(super) fn response(
    intervention_id: InterventionId,
    intervention_type: InterventionType,
    run: &RunRead,
    state: &ReachedState,
) -> AgentRunInterveneResponse {
    let run_version = safe_run_version(run.version);
    macro_rules! plain {
        ($arm:ident) => {
            AgentRunInterveneResponse::$arm {
                intervention_id,
                intervention_type,
                run_version,
                rejection_reason: None,
                failure_reason: None,
            }
        };
    }
    match state {
        ReachedState::Requested => plain!(Requested),
        ReachedState::Accepted => plain!(Accepted),
        ReachedState::Applied => plain!(Applied),
        ReachedState::Degraded => plain!(Degraded),
        ReachedState::Expired => plain!(Expired),
        ReachedState::Rejected(reason) => AgentRunInterveneResponse::Rejected {
            intervention_id,
            intervention_type,
            run_version,
            rejection_reason: reason.clone(),
            failure_reason: None,
        },
        ReachedState::Failed(reason) => AgentRunInterveneResponse::Failed {
            intervention_id,
            intervention_type,
            run_version,
            failure_reason: reason.clone(),
            rejection_reason: None,
        },
    }
}
