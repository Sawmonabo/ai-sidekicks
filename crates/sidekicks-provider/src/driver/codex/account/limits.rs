//! Codex's limits read of one account's home: `account/rateLimits/read` on the home's own
//! service, or on a short-lived one started there for it, never on a service of another home. The
//! read's windows are filed under the account and its reset credits kept on the account's row. A
//! read that answers no figures reads as a lost sign-in when the home's own account read finds none
//! signed in, or when it needed a renewal (an expired access token) and left the home's `auth.json`
//! unchanged, twice in a row.

use std::path::Path;

use jiff::Timestamp;
use sidekicks_contracts::provider::account::record::{ProviderAccountId, ProviderAuthMode};
use sidekicks_std::mutex_lock::lock;

use crate::driver::ProviderAccountFolders;
use crate::driver::codex::account::CodexAccountLegs;
use crate::driver::codex::account::auth_file::{CodexAuthFile, read_codex_auth_file};
use crate::driver::codex::auth_status::{CODEX_AUTH_PROBE_TIMEOUT, read_codex_auth_status};
use crate::driver::codex::rate_limits::{CodexRateLimitFiling, CodexRateLimitRead};
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::contract::account::ProviderObservation;
use crate::driver::contract::error::DriverError;
use crate::driver::session_control::DriverAuthProbeStatus;

/// Dead renewals in a row that read as a lost sign-in.
const DEAD_RENEWALS_FOR_SIGN_IN_GONE: u8 = 2;

/// Reads `provider_account_id`'s limits in `folders`' Codex home. An API-key account has no
/// limits to read, so it answers out of scope with no process started and no request sent. The
/// sign-in reads as gone when the home's account read finds none signed in, or on the second read
/// in a row that needed a renewal and left the home's `auth.json` unchanged. Fails when the
/// account cannot be read from the registry, the home's `auth.json` cannot be read, the service
/// cannot start, the read gets no answer, or its reset credits cannot be kept.
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
    let codex_home = folders.configuration_folder;
    let before = read_codex_auth_file(&codex_home)
        .await
        .map_err(|error| DriverError::Internal(Box::new(error)))?;
    let read = legs
        .act_on_home_service(
            provider_account_id.clone(),
            codex_home.clone(),
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
    match observation {
        ProviderObservation::Figures => {
            lock(&legs.dead_renewals).remove(&provider_account_id);
            Ok(observation)
        }
        ProviderObservation::RefusedInBand | ProviderObservation::Unanswered => {
            judge_renewal(legs, provider_account_id, &codex_home, before, observation).await
        }
        ProviderObservation::SignInRefusedBeforeAnswer
        | ProviderObservation::SignInGone
        | ProviderObservation::OutOfScope => Ok(observation),
    }
}

// Counts a read that answered no figures as a dead renewal when the access token in `before` had
// expired and the home's `auth.json` is unchanged after it, answering a lost sign-in at the count's
// second. A file absent before or after, or changed, clears the count; a read that needed no
// renewal leaves it.
async fn judge_renewal(
    legs: &CodexAccountLegs,
    provider_account_id: ProviderAccountId,
    codex_home: &Path,
    before: Option<CodexAuthFile>,
    observation: ProviderObservation,
) -> Result<ProviderObservation, DriverError> {
    let Some(before) = before else {
        lock(&legs.dead_renewals).remove(&provider_account_id);
        return Ok(observation);
    };
    let needed_renewal = before
        .access_token_expiry
        .is_some_and(|expiry| expiry <= Timestamp::now());
    if !needed_renewal {
        return Ok(observation);
    }
    let after = read_codex_auth_file(codex_home)
        .await
        .map_err(|error| DriverError::Internal(Box::new(error)))?;
    let is_unchanged = after.is_some_and(|after| {
        after.last_refresh == before.last_refresh
            && after.access_token_expiry == before.access_token_expiry
    });
    let mut dead_renewals = lock(&legs.dead_renewals);
    if !is_unchanged {
        dead_renewals.remove(&provider_account_id);
        return Ok(observation);
    }
    let count = dead_renewals.entry(provider_account_id).or_default();
    *count = count.saturating_add(1);
    Ok(if *count >= DEAD_RENEWALS_FOR_SIGN_IN_GONE {
        ProviderObservation::SignInGone
    } else {
        observation
    })
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
