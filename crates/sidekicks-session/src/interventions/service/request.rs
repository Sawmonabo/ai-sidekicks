//! What the service reads off a person's request.

use serde::Serialize;
use sidekicks_contracts::provider::driver::methods::{
    PROVIDER_WIRE_REASON_MAX_LEN, PROVIDER_WIRE_TOKEN_MAX_LEN,
};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::{
    AgentRunInterveneRequest, InterruptInterventionRecord, InterventionInterruptRequest,
    InterventionType, PersonInterruptRecord,
};
use sidekicks_contracts::turn::ProviderTurnId;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_provider::driver::run_control::InterruptPendingChoice;

use crate::interventions::interrupt_queue::InterruptChoice;

/// The type of intervention `request` asks for.
pub(super) fn intervention_type_of(request: &AgentRunInterveneRequest) -> InterventionType {
    match request {
        AgentRunInterveneRequest::Interrupt(_) => InterventionType::Interrupt,
        AgentRunInterveneRequest::FasterModelRetry { .. } => InterventionType::FasterModelRetry,
    }
}

/// The run version `request` was decided against and its idempotency key.
pub(super) fn request_guards(request: &AgentRunInterveneRequest) -> (SafeInt<0>, &ClientUuid) {
    match request {
        AgentRunInterveneRequest::Interrupt(interrupt) => {
            let (_run_id, expected_run_version, key) = interrupt_keys(interrupt);
            (expected_run_version, key)
        }
        AgentRunInterveneRequest::FasterModelRetry {
            expected_run_version,
            client_idempotency_key,
            ..
        } => (*expected_run_version, client_idempotency_key),
    }
}

/// The run `interrupt` targets, the version it was decided against and its idempotency key.
pub(super) fn interrupt_keys(
    interrupt: &InterventionInterruptRequest,
) -> (RunId, SafeInt<0>, &ClientUuid) {
    match interrupt {
        InterventionInterruptRequest::NextTurn {
            target_run_id,
            expected_run_version,
            client_idempotency_key,
            ..
        }
        | InterventionInterruptRequest::ReturnToDraft {
            target_run_id,
            expected_run_version,
            client_idempotency_key,
            ..
        } => (
            *target_run_id,
            *expected_run_version,
            client_idempotency_key,
        ),
    }
}

/// The person's reason for `interrupt`.
pub(super) fn interrupt_reason(
    interrupt: &InterventionInterruptRequest,
) -> Option<&FreeFormText<PROVIDER_WIRE_REASON_MAX_LEN>> {
    match interrupt {
        InterventionInterruptRequest::NextTurn { reason, .. }
        | InterventionInterruptRequest::ReturnToDraft { reason, .. } => reason.as_ref(),
    }
}

/// The person's choice for the waiting messages, as `interrupt` asks for it.
pub(super) fn interrupt_choice_of(interrupt: &InterventionInterruptRequest) -> InterruptChoice {
    match interrupt {
        InterventionInterruptRequest::NextTurn { deliver_first, .. } => InterruptChoice {
            pending: InterruptPendingChoice::NextTurn,
            deliver_first: *deliver_first,
        },
        InterventionInterruptRequest::ReturnToDraft { .. } => InterruptChoice {
            pending: InterruptPendingChoice::ReturnToDraft,
            deliver_first: None,
        },
    }
}

// A faster-model retry's own fields as its row stores them.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RetryRecord<'request> {
    expected_turn_id: &'request ProviderTurnId,
    model: &'request FreeFormText<PROVIDER_WIRE_TOKEN_MAX_LEN>,
}

/// The type's own fields as the row stores them, from typed records whose field order is fixed,
/// so a retry under the same key compares equal as text exactly when it asks for the same
/// thing.
pub(super) fn stored_payload_of(request: &AgentRunInterveneRequest) -> String {
    let serialized = match request {
        AgentRunInterveneRequest::Interrupt(InterventionInterruptRequest::NextTurn {
            deliver_first,
            reason,
            ..
        }) => serde_json::to_string(&InterruptInterventionRecord::Person(
            PersonInterruptRecord::NextTurn {
                deliver_first: *deliver_first,
                reason: reason.clone(),
                limit: None,
            },
        )),
        AgentRunInterveneRequest::Interrupt(InterventionInterruptRequest::ReturnToDraft {
            reason,
            ..
        }) => serde_json::to_string(&InterruptInterventionRecord::Person(
            PersonInterruptRecord::ReturnToDraft {
                deliver_first: None,
                reason: reason.clone(),
                limit: None,
            },
        )),
        AgentRunInterveneRequest::FasterModelRetry {
            expected_turn_id,
            model,
            ..
        } => serde_json::to_string(&RetryRecord {
            expected_turn_id,
            model,
        }),
    };
    serialized.expect("an intervention's record serializes")
}
