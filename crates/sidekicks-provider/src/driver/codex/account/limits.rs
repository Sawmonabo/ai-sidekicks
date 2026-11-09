//! Codex's limits read of one account's home: `account/rateLimits/read` on the home's own service,
//! or on a short-lived one started there for it, never on a service of another home. The read
//! answers its windows with the plan its reply named, the email and plan the home's account read
//! names, and the sign-in's last renewal from the home's `auth.json`, and keeps its reset credits
//! on the account's row. A read that answers no figures reads as a lost sign-in when the home's own
//! account read finds none signed in, or when it needed a renewal (an expired access token), the
//! usage server refused the sign-in, and the home's `auth.json` stayed unchanged, twice in a row; a
//! read the server never answered, as with no network, says nothing of the sign-in. A read in the
//! home of the account the switching service carries hands that service the home's tokens again
//! when the read left them renewed, and fails when that hand fails.

use std::path::Path;

use jiff::Timestamp;
use sidekicks_contracts::provider::account::record::{ProviderAccountId, ProviderAuthMode};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_std::mutex_lock::lock;

use crate::driver::ProviderAccountFolders;
use crate::driver::codex::account::auth_file::{CodexAuthFile, read_codex_auth_file};
use crate::driver::codex::account::{CodexAccountLegs, switch};
use crate::driver::codex::auth_status::{
    CODEX_AUTH_PROBE_TIMEOUT, CodexAccountReading, read_codex_account, read_codex_auth_status,
};
use crate::driver::codex::rate_limits::{CodexRateLimitFiling, CodexRateLimitRead};
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::contract::account::{
    ObservedAccountIdentity, ProviderAccountFigures, ProviderObservation,
};
use crate::driver::contract::error::DriverError;
use crate::driver::session_control::auth_probe::DriverAuthProbeStatus;

/// Dead renewals in a row that read as a lost sign-in.
const DEAD_RENEWALS_FOR_SIGN_IN_GONE: u8 = 2;

/// Reads `provider_account_id`'s limits in `folders`' Codex home. An API-key account has no
/// limits to read, so it answers out of scope with no process started and no request sent. The
/// sign-in reads as gone when the home's account read finds none signed in, or on the second read
/// in a row that needed a renewal, had the sign-in refused by the usage server and left the home's
/// `auth.json` unchanged. Fails when the
/// account cannot be read from the registry, the home's `auth.json` cannot be read, the service
/// cannot start, the read gets no answer, its reset credits cannot be kept, or the switching
/// service carrying the account refuses or never answers the renewed sign-in handed to it.
pub(super) async fn observe_codex_limits(
    legs: &CodexAccountLegs,
    provider_account_id: ProviderAccountId,
    folders: ProviderAccountFolders,
) -> Result<ProviderObservation, DriverError> {
    let account = legs
        .accounts()?
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
    let (observation, reset_credits, is_sign_in_refused) = match read {
        LimitsRead::Read { read, account } if !read.windows.is_empty() => (
            ProviderObservation::Figures(ProviderAccountFigures {
                identity: name_account(read.plan, account),
                refreshed_at: read_refreshed_at(&codex_home).await?,
                windows: read.windows,
            }),
            Some(read.reset_credits_available),
            false,
        ),
        LimitsRead::Read { read, .. } => (
            ProviderObservation::Unanswered,
            Some(read.reset_credits_available),
            false,
        ),
        LimitsRead::Refused {
            observation,
            is_sign_in_refused,
        } => (observation, None, is_sign_in_refused),
    };
    if let Some(reset_credits) = reset_credits {
        legs.accounts()?
            .record_reset_credits(&provider_account_id, reset_credits)
            .await
            .map_err(|error| DriverError::Internal(Box::new(error)))?;
    }
    // The read may have renewed the sign-in, which the switching service then takes again. A
    // hand that fails fails the read, so the account's status says so; the token it did not take
    // still reads as renewed, so the next read hands it again.
    switch::hand_switching_service_again(legs, &provider_account_id, &codex_home).await?;
    match observation {
        ProviderObservation::Figures(_) => {
            lock(&legs.dead_renewals).remove(&provider_account_id);
            Ok(observation)
        }
        // Only a refusal of the sign-in the usage server answered judges the renewal; a read it
        // never answered leaves the count as it was.
        ProviderObservation::RefusedInBand | ProviderObservation::Unanswered
            if is_sign_in_refused =>
        {
            judge_renewal(legs, provider_account_id, &codex_home, before, observation).await
        }
        ProviderObservation::RefusedInBand
        | ProviderObservation::Unanswered
        | ProviderObservation::SignInRefusedBeforeAnswer
        | ProviderObservation::SignInGone
        | ProviderObservation::OutOfScope => Ok(observation),
    }
}

// The identity a read answers: the plan the limits reply named, else the one the account read
// named, and the account read's email.
fn name_account(plan: Option<String>, account: CodexAccountReading) -> ObservedAccountIdentity {
    let (email, account_plan) = match account {
        CodexAccountReading::SignedIn { email, plan, .. } => (email, plan),
        CodexAccountReading::SignedOut | CodexAccountReading::Unreadable => (None, None),
    };
    ObservedAccountIdentity {
        email: email.and_then(|email| FreeFormText::new(email).ok()),
        plan: plan
            .or(account_plan)
            .and_then(|plan| FreeFormText::new(plan).ok()),
        ..ObservedAccountIdentity::default()
    }
}

// When Codex last renewed the home's sign-in, from its `auth.json`; `None` where the file or its
// mark is absent.
async fn read_refreshed_at(codex_home: &Path) -> Result<Option<WireInstant>, DriverError> {
    let auth_file = read_codex_auth_file(codex_home)
        .await
        .map_err(|error| DriverError::Internal(Box::new(error)))?;
    Ok(auth_file
        .and_then(|auth_file| auth_file.last_refresh)
        .and_then(WireInstant::from_timestamp))
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

// What the read on the home's service answered: its reply with the home's account read, or Codex's
// refusal as judged by that read, and whether the usage server answered it by refusing the
// sign-in.
enum LimitsRead {
    Read {
        read: CodexRateLimitRead,
        account: CodexAccountReading,
    },
    Refused {
        observation: ProviderObservation,
        is_sign_in_refused: bool,
    },
}

// What Codex's refusal of a limits read carries where the usage server answered it by refusing
// the sign-in: Codex writes the server's status into the message, a read that never reached the
// server carrying no status at all.
const CODEX_SIGN_IN_REFUSED_STATUS: &str = "failed: 401 Unauthorized;";

// Starts `service` where it is not up, reads its account's limits through `rate_limits` and the
// account that answered them, which names it where that read succeeds, and, on Codex's refusal,
// reads the home's sign-in without a refresh: none signed in is a lost sign-in, one signed in a
// refused or throttled read, and an unreadable answer neither.
async fn read_limits(
    rate_limits: &CodexRateLimitFiling,
    service: &CodexService,
) -> Result<LimitsRead, DriverError> {
    service
        .ensure_started(service.dependencies().startup_timeout)
        .await?;
    match rate_limits.read_whole(service).await {
        Ok(read) => Ok(LimitsRead::Read {
            read,
            account: read_naming_account(service).await,
        }),
        Err(CodexError::ProviderRequest { message, .. }) => {
            let status = read_codex_auth_status(&*service.connection()?, CODEX_AUTH_PROBE_TIMEOUT)
                .await?
                .status;
            Ok(LimitsRead::Refused {
                observation: match status {
                    DriverAuthProbeStatus::Unauthenticated => ProviderObservation::SignInGone,
                    DriverAuthProbeStatus::Authenticated => ProviderObservation::RefusedInBand,
                    DriverAuthProbeStatus::Indeterminate => ProviderObservation::Unanswered,
                },
                is_sign_in_refused: message.contains(CODEX_SIGN_IN_REFUSED_STATUS),
            })
        }
        Err(error) => Err(error.into()),
    }
}

// The account `service` names after its limits answered; a read that fails names no one, so the
// figures it follows are kept.
async fn read_naming_account(service: &CodexService) -> CodexAccountReading {
    let reading =
        async { read_codex_account(&*service.connection()?, CODEX_AUTH_PROBE_TIMEOUT).await }.await;
    reading.unwrap_or_else(|error| {
        tracing::debug!(
            error = &error as &(dyn std::error::Error + 'static),
            "a Codex limits read's account read failed, so it names no one"
        );
        CodexAccountReading::Unreadable
    })
}

#[cfg(test)]
mod tests;
