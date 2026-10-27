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

use crate::driver::SessionSpawnContextResolver;
use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::app_server_protocol::GetAccountRateLimitsParams;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::usage_limit_signal::{
    CODEX_ACCOUNT_RATE_LIMITS_READ_METHOD, CodexRateLimitObservation,
    codex_epoch_seconds_to_wire_instant, observe_codex_rate_limit_read,
};
use crate::driver::delivery_dispatch::{DeliveryOrigin, dispatch_delivery};
use crate::port::inbound_dispatch::InboundDispatch;
use crate::port::registration::PortRegistration;
use crate::run::delivery::{InboundDelivery, MachineScopedRow};
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_std::mutex_lock::lock;

/// Reads and files an account's rate-limit readings. A clone files through the same record of what
/// was filed, so a reading one clone filed is not filed again by another.
#[derive(Clone)]
pub(crate) struct CodexRateLimitFiling {
    /// The run engine's dispatch, which files each row.
    dispatch: Arc<dyn InboundDispatch>,
    /// Reads the account's credential generation.
    spawn_contexts: Arc<PortRegistration<Arc<dyn SessionSpawnContextResolver>>>,
    /// What was last filed, shared by every clone. Never held across an await.
    filed: Arc<Mutex<FiledRateLimits>>,
    /// Held per account through each filing, shared by every clone.
    filings: Arc<KeyedLock<ProviderAccountId>>,
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
        dispatch: Arc<dyn InboundDispatch>,
        spawn_contexts: Arc<PortRegistration<Arc<dyn SessionSpawnContextResolver>>>,
    ) -> Self {
        Self {
            dispatch,
            spawn_contexts,
            filed: Arc::default(),
            filings: Arc::new(KeyedLock::new()),
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
    /// the account's last filing; a row the dispatch refused is filed again with the next reading.
    /// A service on the machine's default home names no account, which a row requires, so its
    /// readings stay unfiled, logged once.
    pub(crate) async fn file(&self, service: &CodexService) {
        let Some(provider_account_id) = service.home().provider_account_id.clone() else {
            if !mem::replace(&mut lock(&self.filed).is_unfiled_reading_logged, true) {
                tracing::debug!(
                    "the default home's rate limits name no account, so no usage row is filed"
                );
            }
            return;
        };
        // Held through the filing, so a reading one clone is filing is not filed again by another.
        let _filing = self.filings.acquire(provider_account_id.clone()).await;
        let read = match self.spawn_contexts.require_port() {
            Ok(spawn_contexts) => {
                spawn_contexts
                    .read_credential_generation(provider_account_id.clone())
                    .await
            }
            Err(error) => Err(error.into()),
        };
        let credential_generation = match read {
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
        let changed: Vec<UsageRateLimitUpdatedPayload> = select_changed_codex_rate_limit_rows(
            lock(&self.filed)
                .rows_by_account
                .get(&provider_account_id)
                .map_or(&[], Vec::as_slice),
            &rows,
        )
        .into_iter()
        .cloned()
        .collect();
        let mut answered = Vec::new();
        for row in changed {
            let outcome = Box::pin(dispatch_delivery(
                &*self.dispatch,
                DeliveryOrigin {
                    provider: DESCRIPTOR.provider_id(),
                    provider_account_id: Some(provider_account_id.clone()),
                    raw_wire_type: None,
                },
                InboundDelivery::MachineEvent {
                    row: MachineScopedRow::UsageRateLimitUpdated(row.clone()),
                },
            ))
            .await;
            if outcome.is_some() {
                answered.push(row);
            }
        }
        keep_filed_codex_rate_limit_rows(
            lock(&self.filed)
                .rows_by_account
                .entry(provider_account_id)
                .or_default(),
            rows,
            &answered,
        );
    }
}

// The rows of `rows` that `filed` does not hold as they are: a window whose reading is unchanged
// since it was filed, its credential generation included, is not filed again.
fn select_changed_codex_rate_limit_rows<'r>(
    filed: &[UsageRateLimitUpdatedPayload],
    rows: &'r [UsageRateLimitUpdatedPayload],
) -> Vec<&'r UsageRateLimitUpdatedPayload> {
    rows.iter().filter(|row| !filed.contains(row)).collect()
}

// `filed` then holds each row of `rows` it already held or whose filing `answered` names, so a
// refused row reads as changed again.
fn keep_filed_codex_rate_limit_rows(
    filed: &mut Vec<UsageRateLimitUpdatedPayload>,
    rows: Vec<UsageRateLimitUpdatedPayload>,
    answered: &[UsageRateLimitUpdatedPayload],
) {
    *filed = rows
        .into_iter()
        .filter(|row| filed.contains(row) || answered.contains(row))
        .collect();
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

    use super::{
        UsageRateLimitUpdatedPayload, compose_codex_rate_limit_rows,
        keep_filed_codex_rate_limit_rows, select_changed_codex_rate_limit_rows,
    };
    use crate::driver::codex::usage_limit_signal::{
        CodexRateLimitObservation, observe_codex_rate_limit_read, observe_codex_rate_limit_update,
    };

    // Files the rows of `rows` that changed since `filed`, each answered but the `refused` one;
    // answers the rows filed.
    fn file(
        filed: &mut Vec<UsageRateLimitUpdatedPayload>,
        rows: Vec<UsageRateLimitUpdatedPayload>,
        refused: Option<&UsageRateLimitUpdatedPayload>,
    ) -> Vec<UsageRateLimitUpdatedPayload> {
        let changed: Vec<UsageRateLimitUpdatedPayload> =
            select_changed_codex_rate_limit_rows(filed, &rows)
                .into_iter()
                .cloned()
                .collect();
        let answered: Vec<UsageRateLimitUpdatedPayload> = changed
            .iter()
            .filter(|row| Some(*row) != refused)
            .cloned()
            .collect();
        keep_filed_codex_rate_limit_rows(filed, rows, &answered);
        changed
    }

    // Each reading is merged and composed as the service's are, then compared with what was filed.
    // Killed by filing every window on each reading, and by recording a row as filed before its
    // dispatch answered, so a refused window is not filed again until its reading changes.
    #[test]
    fn only_a_window_whose_reading_changed_or_was_refused_is_filed_again() {
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

        let refused = compose(&read)[1].clone();
        let first = file(&mut filed, compose(&read), Some(&refused));
        let after_refusal = file(&mut filed, compose(&read), None);
        let repeated = file(&mut filed, compose(&read), None);
        let pushed = observe_codex_rate_limit_update(
            read,
            &json!({
                "rateLimits": {
                    "limitId": "codex",
                    "secondary": {"usedPercent": 45, "windowDurationMins": 10_080},
                },
            }),
        );
        let after_push = file(&mut filed, compose(&pushed), None);

        assert_eq!(first.len(), 2);
        assert_eq!(
            after_refusal,
            [refused],
            "only the refused window is filed again"
        );
        assert!(repeated.is_empty(), "{repeated:?}");
        assert_eq!(
            after_push,
            compose(&pushed)[1..],
            "only the secondary window is filed"
        );
        assert_ne!(after_push[0], first[1]);
    }
}
