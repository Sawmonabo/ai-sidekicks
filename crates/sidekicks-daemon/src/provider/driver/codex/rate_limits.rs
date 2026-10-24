//! The account's rate-limit readings as the daemon files them: a complete read at each start and
//! reconnect of a service, kept as the service's readings, and every reading, read or pushed,
//! filed as one `usage.rateLimit.updated` row per window under the machine's sentinel session with
//! the account's credential generation, so a reading from before a sign-in again reads as stale.

use std::sync::Arc;

use serde_json::Value;
use sidekicks_contracts::event::usage::UsageRateLimitUpdatedPayload;
use sidekicks_contracts::provider::account::record::{CredentialGeneration, ProviderAccountId};
use sidekicks_contracts::wire::integer::SafeSignedInt;
use sidekicks_contracts::wire::number::Number;
use sidekicks_contracts::wire::text::BoundedText;

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

/// Reads and files an account's rate-limit readings.
pub(crate) struct CodexRateLimitFiling {
    /// The run engine's dispatch, which files each row.
    pub(crate) dispatch: Arc<RunInboundDispatch>,
    /// Reads the account's credential generation.
    pub(crate) spawn_contexts: Arc<dyn SessionSpawnContextResolver>,
}

impl CodexRateLimitFiling {
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

    /// Files `service`'s readings as they stand, one row per window. A service on the machine's
    /// default home names no account, which a row requires, so its readings stay unfiled.
    pub(crate) async fn file(&self, service: &CodexService) {
        let Some(provider_account_id) = service.home().provider_account_id.clone() else {
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
        for row in rows {
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
