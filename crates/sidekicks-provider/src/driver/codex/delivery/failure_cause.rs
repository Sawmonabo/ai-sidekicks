//! Why a Codex turn that failed failed, as the run's failure cause names it: a turn too long for
//! the model's window, whose message goes back to the composer; a spent plan allowance only when
//! Codex failed the turn on its usage limit and the account's readings show it spent; spent
//! retries when the arm is an upstream rate limit, which Codex gives up on only after its own
//! retries, or when Codex retried the turn before giving up; and no flex capacity for a turn sent
//! on the flex speed. A spent allowance is filed under the account the conversation ran on and its
//! credential generation as the turn's end is read, in frame order.

use std::sync::Arc;

use sidekicks_contracts::provider::account::record::CredentialGeneration;
use sidekicks_contracts::provider::driver::methods::PROVIDER_WIRE_HANDLE_MAX_LEN;
use sidekicks_contracts::provider::driver::usage_limit::ProviderUsageLimitCause;
use sidekicks_contracts::run::failure_cause::{ProviderFailureOrigin, RunFailureCause};
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_std::port_registration::PortRegistration;

use crate::driver::ProviderAccountReader;
use crate::driver::codex::session::state::CodexSessionRecord;
use crate::driver::codex::usage_limit_signal::classify_codex_usage_limit_signal;

/// The error arm Codex ends a turn with when the turn is too long for the model's window.
pub(crate) const CODEX_CONTEXT_WINDOW_EXCEEDED_ERROR: &str = "contextWindowExceeded";

/// The arm Codex fails a turn with once the account's usage limit is reached.
pub(crate) const CODEX_USAGE_LIMIT_EXCEEDED_ERROR: &str = "usageLimitExceeded";

/// The arm of an upstream rate limit, which Codex gives up on only after its own retries.
pub(crate) const CODEX_RATE_LIMIT_EXCEEDED_ERROR: &str = "rateLimitExceeded";

/// The arm Codex fails a turn with when the flex service tier has no capacity; it does not retry.
const CODEX_FLEX_UNAVAILABLE_ERROR: &str = "flexUnavailable";

/// The cause of the turn `turn_id`'s failure on Codex's error arm `error_kind`; `None` when no
/// cause is known. A spent allowance names `record`'s account, never the one its service carries,
/// with that account's credential generation read through `provider_accounts`; when it cannot be
/// read the failure is logged and the turn ends on the ordinary failure path.
pub(crate) async fn read_codex_turn_failure_cause(
    record: &CodexSessionRecord,
    turn_id: &str,
    error_kind: Option<&str>,
    provider_accounts: &PortRegistration<Arc<dyn ProviderAccountReader>>,
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
            // The readings as they stand at this frame, taken before the generation read awaits.
            let observation = record.service.rate_limit_observation();
            match read_conversation_credential_generation(record, provider_accounts).await {
                Ok(credential_generation) => {
                    if let Some(signal) = classify_codex_usage_limit_signal(
                        &observation,
                        record.provider_account_id.clone(),
                        credential_generation,
                    ) {
                        return Some(match signal.cause {
                            ProviderUsageLimitCause::PlanAllowanceExhausted => {
                                RunFailureCause::PlanAllowanceExhausted {
                                    origin,
                                    provider_account_id: signal.provider_account_id,
                                    credential_generation: signal.credential_generation,
                                    reset_boundary: signal.reset_boundary,
                                }
                            }
                        });
                    }
                }
                Err(error) => {
                    tracing::warn!(
                        error = &*error as &(dyn std::error::Error + 'static),
                        "the codex account's credential generation could not be read, so its \
                         usage limit is not filed"
                    );
                }
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

// The current credential generation of the account `record`'s conversation runs on.
async fn read_conversation_credential_generation(
    record: &CodexSessionRecord,
    provider_accounts: &PortRegistration<Arc<dyn ProviderAccountReader>>,
) -> Result<CredentialGeneration, Box<dyn std::error::Error + Send + Sync>> {
    provider_accounts
        .require_port()?
        .read_credential_generation(record.provider_account_id.clone())
        .await
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

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Arc;

    use futures::FutureExt as _;
    use futures::future::BoxFuture;
    use serde_json::{Value, json};
    use sidekicks_contracts::provider::account::record::{CredentialGeneration, ProviderAccountId};
    use sidekicks_contracts::provider::driver::usage_limit::ProviderUsageLimitResetBoundary;
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_contracts::run::failure_cause::{ProviderFailureOrigin, RunFailureCause};
    use sidekicks_contracts::wire::instant::WireInstant;
    use sidekicks_std::port_registration::PortRegistration;

    use super::{CODEX_USAGE_LIMIT_EXCEEDED_ERROR, read_codex_turn_failure_cause};
    use crate::driver::codex::service::supervisor::test_service::{
        start_scripted_codex_service, start_scripted_terminal_service,
    };
    use crate::driver::codex::session::test_fixture::TestCodexSession;
    use crate::driver::codex::usage_limit_signal::{
        observe_codex_rate_limit_read, observe_codex_rate_limit_update,
    };
    use crate::driver::{
        AccountFoldersError, CurrentProviderAccount, ProviderAccountFolders, ProviderAccountReader,
    };
    use crate::runtime_binding::test_store::test_provider_account_id;

    // Each account's credential generation, as the accounts store holds it.
    struct AccountGenerations(HashMap<ProviderAccountId, CredentialGeneration>);

    impl ProviderAccountReader for AccountGenerations {
        fn resolve_account_folders(
            &self,
            _provider_account_id: ProviderAccountId,
        ) -> BoxFuture<'_, Result<ProviderAccountFolders, AccountFoldersError>> {
            async { Err(AccountFoldersError::NotFound) }.boxed()
        }

        fn current_account(
            &self,
            _provider_id: ProviderId,
        ) -> BoxFuture<'_, Result<CurrentProviderAccount, Box<dyn std::error::Error + Send + Sync>>>
        {
            async { Ok(CurrentProviderAccount::NoneCurrent) }.boxed()
        }

        fn read_credential_generation(
            &self,
            provider_account_id: ProviderAccountId,
        ) -> BoxFuture<'_, Result<CredentialGeneration, Box<dyn std::error::Error + Send + Sync>>>
        {
            let generation = self.0.get(&provider_account_id).copied();
            async move { generation.ok_or_else(|| "no such account".into()) }.boxed()
        }
    }

    fn account(id: &str) -> ProviderAccountId {
        ProviderAccountId::new(id.to_owned()).unwrap()
    }

    fn generation(value: u64) -> CredentialGeneration {
        serde_json::from_value(json!(value)).unwrap()
    }

    // A machine with two accounts: `account-a` at generation 2, and `account-1`, the account of
    // the scripted service's home, at generation 5.
    fn two_accounts() -> PortRegistration<Arc<dyn ProviderAccountReader>> {
        let provider_accounts = PortRegistration::new("provider accounts");
        let generations = HashMap::from([
            (account("account-a"), generation(2)),
            (test_provider_account_id(), generation(5)),
        ]);
        provider_accounts
            .register(Arc::new(AccountGenerations(generations)) as Arc<dyn ProviderAccountReader>)
            .unwrap();
        provider_accounts
    }

    fn limit_reached_on_account_a(resets_at: &str) -> RunFailureCause {
        RunFailureCause::PlanAllowanceExhausted {
            origin: ProviderFailureOrigin::Value,
            provider_account_id: account("account-a"),
            credential_generation: generation(2),
            reset_boundary: Some(ProviderUsageLimitResetBoundary {
                resets_at: serde_json::from_value::<WireInstant>(Value::from(resets_at)).unwrap(),
            }),
        }
    }

    #[tokio::test]
    async fn a_usage_limit_reached_on_one_of_two_accounts_carries_that_account_and_generation() {
        // The service's home names no account, so only the conversation can name the limit's.
        let mut session = TestCodexSession::start_on(start_scripted_terminal_service()).await;
        session.task.record.provider_account_id = account("account-a");
        session
            .scripted
            .service
            .store_rate_limit_read(observe_codex_rate_limit_read(&json!({"rateLimits": {
                "rateLimitReachedType": "rate_limit_reached",
                "primary": {"usedPercent": 100, "resetsAt": 1_700_000_000}
            }})));

        let cause = read_codex_turn_failure_cause(
            &session.task.record,
            "turn-1",
            Some(CODEX_USAGE_LIMIT_EXCEEDED_ERROR),
            &two_accounts(),
        )
        .await;

        assert_eq!(
            cause,
            Some(limit_reached_on_account_a("2023-11-14T22:13:20.000Z"))
        );
    }

    #[tokio::test]
    async fn a_usage_limit_push_from_the_last_turn_read_after_a_switch_is_never_filed_under_the_new_account()
     {
        // The service now carries `account-1`; the conversation whose turn met the limit ran on
        // `account-a`, and the push saying so is read only now.
        let mut session = TestCodexSession::start_on(start_scripted_codex_service()).await;
        session.task.record.provider_account_id = account("account-a");
        let read = observe_codex_rate_limit_read(&json!({"rateLimits": {
            "primary": {"usedPercent": 80, "resetsAt": 1_700_000_000}
        }}));
        let pushed = observe_codex_rate_limit_update(
            read,
            &json!({"rateLimits": {
                "rateLimitReachedType": "rate_limit_reached",
                "primary": {"usedPercent": 100, "resetsAt": 1_700_100_000}
            }}),
        );
        session.scripted.service.store_rate_limit_read(pushed);

        let cause = read_codex_turn_failure_cause(
            &session.task.record,
            "turn-1",
            Some(CODEX_USAGE_LIMIT_EXCEEDED_ERROR),
            &two_accounts(),
        )
        .await;

        assert_eq!(
            cause,
            Some(limit_reached_on_account_a("2023-11-16T02:00:00.000Z"))
        );
    }
}
