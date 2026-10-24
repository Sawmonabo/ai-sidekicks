//! The account's rate-limit readings as the daemon files them: a complete read at each start and
//! reconnect of a service, kept as the service's readings, and each window whose reading changed,
//! read or pushed, filed as one `usage.rateLimit.updated` row under the machine's sentinel session
//! with the account's credential generation, so a reading from before a sign-in again reads as
//! stale.

use std::collections::HashMap;
use std::mem;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use sidekicks_contracts::event::usage::UsageRateLimitUpdatedPayload;
use sidekicks_contracts::provider::account::record::{CredentialGeneration, ProviderAccountId};
use sidekicks_contracts::wire::integer::SafeSignedInt;
use sidekicks_contracts::wire::number::Number;
use sidekicks_contracts::wire::text::BoundedText;

use crate::mutex_lock::lock;
use crate::provider::driver::SessionSpawnContextResolver;
use crate::provider::driver::codex::DESCRIPTOR;
use crate::provider::driver::codex::app_server_protocol::GetAccountRateLimitsParams;
use crate::provider::driver::codex::service::supervisor::CodexService;
use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::codex::usage_limit_signal::{
    CODEX_ACCOUNT_RATE_LIMITS_READ_METHOD, CodexRateLimitObservation,
    codex_epoch_seconds_to_wire_instant, observe_codex_rate_limit_read,
};
use crate::provider::driver::delivery_dispatch::{DeliveryOrigin, dispatch_delivery};
use crate::session::run::inbound::rows::MachineScopedRow;
use crate::session::run::inbound::{InboundDelivery, RunInboundDispatch};

/// Reads and files an account's rate-limit readings. A clone files through the same record of what
/// was filed, so a reading one clone filed is not filed again by another.
#[derive(Clone)]
pub(crate) struct CodexRateLimitFiling {
    /// The run engine's dispatch, which files each row.
    dispatch: Arc<RunInboundDispatch>,
    /// Reads the account's credential generation.
    spawn_contexts: Arc<dyn SessionSpawnContextResolver>,
    /// What was last filed, shared by every clone.
    filed: Arc<Mutex<FiledRateLimits>>,
}

// The rows last filed for each account, and whether a reading with no account to file under was
// logged.
#[derive(Default)]
struct FiledRateLimits {
    rows_by_account: HashMap<ProviderAccountId, Vec<UsageRateLimitUpdatedPayload>>,
    is_unfiled_reading_logged: bool,
}

impl CodexRateLimitFiling {
    /// A filing through `dispatch` with the credential generations `spawn_contexts` reads, having
    /// filed nothing yet.
    pub(crate) fn new(
        dispatch: Arc<RunInboundDispatch>,
        spawn_contexts: Arc<dyn SessionSpawnContextResolver>,
    ) -> Self {
        Self {
            dispatch,
            spawn_contexts,
            filed: Arc::default(),
        }
    }

    /// Reads the account's rate limits whole on `service`, keeps them as its readings and files
    /// them. Fails as the read fails, the readings then left as they were.
    pub(crate) async fn read(&self, service: &CodexService) -> Result<(), CodexError> {
        let reply = service
            .connection()?
            .request(
                CODEX_ACCOUNT_RATE_LIMITS_READ_METHOD,
                // The reset-credit details cost Codex a second lookup the rows never carry.
                &GetAccountRateLimitsParams {
                    exclude_reset_credit_details: Some(true),
                    supports_luna_reserve: None,
                },
            )
            .await?;
        let reply: Value =
            serde_json::from_str(reply.get()).map_err(|error| CodexError::Transport {
                detail: "The Codex app-server \"account/rateLimits/read\" response could not be \
                         read."
                    .to_owned(),
                cause: Some(Box::new(error)),
            })?;
        service.store_rate_limit_read(observe_codex_rate_limit_read(&reply));
        self.file(service).await;
        Ok(())
    }

    /// Files `service`'s readings as they stand, one row per window whose reading changed since
    /// the account's last filing. A service on the machine's default home names no account, which
    /// a row requires, so its readings stay unfiled, logged once.
    pub(crate) async fn file(&self, service: &CodexService) {
        let Some(provider_account_id) = service.home().provider_account_id.clone() else {
            if !mem::replace(&mut lock(&self.filed).is_unfiled_reading_logged, true) {
                tracing::debug!(
                    "the default home's rate limits name no account, so no usage row is filed"
                );
            }
            return;
        };
        let credential_generation = match self
            .spawn_contexts
            .read_credential_generation(provider_account_id.clone())
            .await
        {
            Ok(generation) => generation,
            Err(error) => {
                tracing::warn!(
                    error = &*error as &(dyn std::error::Error + 'static),
                    "the account's credential generation could not be read for its rate limits"
                );
                return;
            }
        };
        let rows = compose_codex_rate_limit_rows(
            &service.rate_limit_observation(),
            &provider_account_id,
            credential_generation,
        );
        let changed = take_changed_codex_rate_limit_rows(
            lock(&self.filed)
                .rows_by_account
                .entry(provider_account_id.clone())
                .or_default(),
            rows,
        );
        for row in changed {
            Box::pin(dispatch_delivery(
                &self.dispatch,
                DeliveryOrigin {
                    provider: DESCRIPTOR.provider_id(),
                    provider_account_id: Some(provider_account_id.clone()),
                    raw_wire_type: None,
                },
                InboundDelivery::MachineEvent {
                    row: MachineScopedRow::UsageRateLimitUpdated(row),
                },
            ))
            .await;
        }
    }
}

// The rows of `rows` that `filed` does not hold as they are, `filed` then holding `rows`: a window
// whose reading is unchanged since it was filed, its credential generation included, is not filed
// again.
fn take_changed_codex_rate_limit_rows(
    filed: &mut Vec<UsageRateLimitUpdatedPayload>,
    rows: Vec<UsageRateLimitUpdatedPayload>,
) -> Vec<UsageRateLimitUpdatedPayload> {
    let changed = rows
        .iter()
        .filter(|row| !filed.contains(row))
        .cloned()
        .collect();
    *filed = rows;
    changed
}

// One row per window that names its length and its share used; `resetsAt` in seconds, as Codex
// sends it.
fn compose_codex_rate_limit_rows(
    observation: &CodexRateLimitObservation,
    provider_account_id: &ProviderAccountId,
    credential_generation: CredentialGeneration,
) -> Vec<UsageRateLimitUpdatedPayload> {
    observation
        .windows()
        .filter_map(|(limit_id, window)| {
            let window_mins = window
                .get("windowDurationMins")
                .and_then(Value::as_i64)
                .and_then(SafeSignedInt::new)?;
            let used_percent = window
                .get("usedPercent")
                .and_then(Value::as_f64)
                .and_then(Number::new)?;
            Some(UsageRateLimitUpdatedPayload {
                provider: DESCRIPTOR.provider_id(),
                provider_account_id: provider_account_id.clone(),
                credential_generation,
                limit_id: BoundedText::new(limit_id.to_owned()),
                window_mins,
                used_percent,
                resets_at: window
                    .get("resetsAt")
                    .and_then(Value::as_f64)
                    .and_then(codex_epoch_seconds_to_wire_instant),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use sidekicks_contracts::provider::account::record::{CredentialGeneration, ProviderAccountId};

    use super::{compose_codex_rate_limit_rows, take_changed_codex_rate_limit_rows};
    use crate::provider::driver::codex::usage_limit_signal::{
        CodexRateLimitObservation, observe_codex_rate_limit_read, observe_codex_rate_limit_update,
    };

    // Each reading is merged and composed as the service's are, then compared with what was filed.
    // Killed by filing every window on each reading.
    #[test]
    fn only_a_window_whose_reading_changed_is_filed_again() {
        let account = ProviderAccountId::new("account-1".to_owned()).expect("an account id");
        let generation: CredentialGeneration =
            serde_json::from_value(json!(1)).expect("1 is a credential generation");
        let read = observe_codex_rate_limit_read(&json!({
            "rateLimits": {
                "limitId": "codex",
                "primary": {
                    "usedPercent": 10,
                    "windowDurationMins": 300,
                    "resetsAt": 1_800_000_000,
                },
                "secondary": {"usedPercent": 40, "windowDurationMins": 10_080},
            },
        }));
        let compose = |observation: &CodexRateLimitObservation| {
            compose_codex_rate_limit_rows(observation, &account, generation)
        };
        let mut filed = Vec::new();

        let first = take_changed_codex_rate_limit_rows(&mut filed, compose(&read));
        let repeated = take_changed_codex_rate_limit_rows(&mut filed, compose(&read));
        let pushed = observe_codex_rate_limit_update(
            read,
            &json!({
                "rateLimits": {
                    "limitId": "codex",
                    "secondary": {"usedPercent": 45, "windowDurationMins": 10_080},
                },
            }),
        );
        let after_push = take_changed_codex_rate_limit_rows(&mut filed, compose(&pushed));

        assert_eq!(first.len(), 2);
        assert!(repeated.is_empty(), "{repeated:?}");
        assert_eq!(
            after_push,
            compose(&pushed)[1..],
            "only the secondary window is filed"
        );
        assert_ne!(after_push[0], first[1]);
    }
}
