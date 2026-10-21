//! Why a Codex turn that failed failed, as the run's failure cause names it: a turn too long for the
//! model's window, whose message goes back to the composer; a spent plan allowance only when Codex
//! failed the turn on its usage limit and the account's readings show it spent; spent retries when
//! the arm is an upstream rate limit, which Codex gives up on only after its own retries, or when
//! Codex retried the turn before giving up; and no flex capacity for a turn sent on the flex speed.

use sidekicks_contracts::provider::driver::methods::PROVIDER_WIRE_HANDLE_MAX_LEN;
use sidekicks_contracts::provider::driver::usage_limit::ProviderUsageLimitCause;
use sidekicks_contracts::run::failure_cause::{ProviderFailureOrigin, RunFailureCause};
use sidekicks_contracts::wire::text::FreeFormText;

use crate::provider::driver::codex::session::state::CodexSessionRecord;
use crate::provider::driver::codex::usage_limit_signal::classify_codex_usage_limit_signal;

/// The error arm Codex ends a turn with when the turn is too long for the model's window.
pub(crate) const CODEX_CONTEXT_WINDOW_EXCEEDED_ERROR: &str = "contextWindowExceeded";

/// The arm Codex fails a turn with once the account's usage limit is reached.
const CODEX_USAGE_LIMIT_EXCEEDED_ERROR: &str = "usageLimitExceeded";

/// The arm of an upstream rate limit, which Codex gives up on only after its own retries.
const CODEX_RATE_LIMIT_EXCEEDED_ERROR: &str = "rateLimitExceeded";

/// The arm Codex fails a turn with when the flex service tier has no capacity; it does not retry.
const CODEX_FLEX_UNAVAILABLE_ERROR: &str = "flexUnavailable";

/// The cause of the turn `turn_id`'s failure on Codex's error arm `error_kind`; `None` when no
/// cause is known.
pub(crate) fn read_codex_turn_failure_cause(
    record: &CodexSessionRecord,
    turn_id: &str,
    error_kind: Option<&str>,
) -> Option<RunFailureCause> {
    let origin = ProviderFailureOrigin::Value;
    match error_kind {
        // The person's message that opened the turn goes back to the composer; with none known
        // the failure carries no cause rather than one that returns nothing.
        Some(CODEX_CONTEXT_WINDOW_EXCEEDED_ERROR) => {
            return read_turn_message_id(record, turn_id).map(|returned_message_id| {
                RunFailureCause::ContextWindowExceeded {
                    origin,
                    returned_message_id,
                }
            });
        }
        Some(CODEX_FLEX_UNAVAILABLE_ERROR) => {
            return Some(RunFailureCause::FlexCapacityUnavailable { origin });
        }
        Some(CODEX_USAGE_LIMIT_EXCEEDED_ERROR) => {
            let observation = record.service.rate_limit_observation();
            if let Some(signal) = classify_codex_usage_limit_signal(&observation) {
                return Some(match signal.cause {
                    ProviderUsageLimitCause::PlanAllowanceExhausted => {
                        RunFailureCause::PlanAllowanceExhausted {
                            origin,
                            reset_boundary: signal.reset_boundary,
                        }
                    }
                });
            }
        }
        _ => {}
    }
    let memory = &record.delivery;
    let is_retries_exhausted = error_kind == Some(CODEX_RATE_LIMIT_EXCEEDED_ERROR)
        || (memory.final_error_by_turn_id.contains_key(turn_id)
            && memory.retried_turn_ids.contains(turn_id));
    is_retries_exhausted.then_some(RunFailureCause::RetriesExhausted { origin })
}

// The id of the person's message that opened a turn, or `None` when the turn had none.
fn read_turn_message_id(
    record: &CodexSessionRecord,
    turn_id: &str,
) -> Option<FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>> {
    record
        .turn_id_by_client_message_id
        .iter()
        .find(|(_, message_turn_id)| *message_turn_id == turn_id)
        .and_then(|(client_message_id, _)| FreeFormText::new(client_message_id.clone()).ok())
}
