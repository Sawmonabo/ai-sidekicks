//! Codex's limits read of one account's home: `account/rateLimits/read` on the home's own
//! service, or on a short-lived one started there for it, never on a service of another home. The
//! read's windows are filed under the account, its reset credits kept on the account's row, and a
//! refused read is told from a lost sign-in by the home's own account read.

use sidekicks_contracts::provider::account::record::{ProviderAccountId, ProviderAuthMode};

use crate::driver::ProviderAccountFolders;
use crate::driver::codex::account::CodexAccountLegs;
use crate::driver::codex::auth_status::{CODEX_AUTH_PROBE_TIMEOUT, read_codex_auth_status};
use crate::driver::codex::rate_limits::{CodexRateLimitFiling, CodexRateLimitRead};
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::contract::account::ProviderObservation;
use crate::driver::contract::error::DriverError;
use crate::driver::session_control::DriverAuthProbeStatus;

/// Reads `provider_account_id`'s limits in `folders`' Codex home. An API-key account has no
/// limits to read, so it answers out of scope with no process started and no request sent. Fails
/// when the account cannot be read from the registry, the service cannot start, the read gets no
/// answer, or its reset credits cannot be kept.
pub(super) async fn observe_codex_limits(
    legs: &CodexAccountLegs,
    provider_account_id: ProviderAccountId,
    folders: ProviderAccountFolders,
) -> Result<ProviderObservation, DriverError> {
    let account = legs
        .accounts
        .read(provider_account_id.clone())
        .await
        .map_err(|error| DriverError::Internal(Box::new(error)))?;
    if account.observed_auth_mode == Some(ProviderAuthMode::ApiKey) {
        return Ok(ProviderObservation::OutOfScope);
    }
    let read = legs
        .act_on_home_service(
            provider_account_id.clone(),
            folders.configuration_folder,
            async |service| read_limits(&legs.rate_limits, service).await,
        )
        .await?;
    let (observation, reset_credits) = match read {
        LimitsRead::Read(read) if read.has_windows => (
            ProviderObservation::Figures,
            Some(read.reset_credits_available),
        ),
        LimitsRead::Read(read) => (
            ProviderObservation::Unanswered,
            Some(read.reset_credits_available),
        ),
        LimitsRead::Refused(observation) => (observation, None),
    };
    if let Some(reset_credits) = reset_credits {
        legs.accounts
            .record_reset_credits(&provider_account_id, reset_credits)
            .await
            .map_err(|error| DriverError::Internal(Box::new(error)))?;
    }
    Ok(observation)
}

// What the read on the home's service answered: its reply, or Codex's refusal as judged by the
// home's own account read.
enum LimitsRead {
    Read(CodexRateLimitRead),
    Refused(ProviderObservation),
}

// Starts `service` where it is not up, reads its account's limits through `rate_limits` and, on
// Codex's refusal, reads the home's sign-in without a refresh: none signed in is a lost sign-in,
// one signed in a refused or throttled read, and an unreadable answer neither.
async fn read_limits(
    rate_limits: &CodexRateLimitFiling,
    service: &CodexService,
) -> Result<LimitsRead, DriverError> {
    service
        .ensure_started(service.dependencies().startup_timeout)
        .await?;
    match rate_limits.read(service).await {
        Ok(read) => Ok(LimitsRead::Read(read)),
        Err(CodexError::ProviderRequest { .. }) => {
            let status = read_codex_auth_status(&*service.connection()?, CODEX_AUTH_PROBE_TIMEOUT)
                .await?
                .status;
            Ok(LimitsRead::Refused(match status {
                DriverAuthProbeStatus::Unauthenticated => ProviderObservation::SignInGone,
                DriverAuthProbeStatus::Authenticated => ProviderObservation::RefusedInBand,
                DriverAuthProbeStatus::Indeterminate => ProviderObservation::Unanswered,
            }))
        }
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests;
