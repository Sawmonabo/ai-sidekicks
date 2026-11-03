//! The renewer the switching service's token refresh is answered through: Codex renews the refused
//! sign-in in that account's own home, on the service serving there or a short-lived one on the
//! `file` store, and the renewed tokens are read back from the home's `auth.json`, judged against
//! the token Codex refused. One renewal per account at a time, under the home's hold, each asker
//! meanwhile joining it, and none while a sign-in's flow runs in the home: a refresh then waits
//! for the flow to end and judges the sign-in it left; and the refresh's answer, which carries
//! the tokens.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};
use std::time::Duration;

use futures::FutureExt as _;
use secrecy::SecretString;
use serde::Serialize;
use sidekicks_contracts::provider::account::record::ProviderAccountId;

use crate::account::home_lock::AccountHomeFlights;
use crate::driver::codex::account::CodexAccountLegs;
use crate::driver::codex::account::auth_file::{
    CodexAuthTokens, is_same_token, read_codex_auth_tokens, serialize_secret,
};
use crate::driver::codex::auth_status::renew_codex_sign_in;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::contract::error::DriverError;
use crate::runtime_binding::writer::RuntimeBindingWriter;

/// How long the renewing read waits, Codex's own bound on an `account/read`: its refresh and the
/// retry after it run inside the read.
const CODEX_RENEWING_READ_TIMEOUT: Duration = Duration::from_secs(15);

/// The renewals of one account's sign-in, at most one in flight per account; `None` where a
/// sign-in marked the home before the renewal took it, so nothing was judged.
pub(super) type CodexRenewalFlights =
    AccountHomeFlights<Option<Result<CodexRenewal, CodexRenewalFailed>>>;

/// What a renewal in an account's home found.
#[derive(Clone)]
pub(crate) enum CodexRenewal {
    /// The home holds an access token other than the refused one, renewed now or before.
    Renewed(CodexAuthTokens),
    /// Codex's renewal left the refused token in the home: the sign-in cannot be renewed.
    Dead,
}

/// A renewal that could not be judged: the home's lock was not registered, its `auth.json` could
/// not be read or held no `ChatGPT` sign-in, as after a sign-in that ended with none, or its
/// service could not start or answer.
#[derive(Clone, Debug, thiserror::Error)]
#[error("the sign-in in the Codex account's home could not be renewed")]
pub(crate) struct CodexRenewalFailed(#[source] Arc<DriverError>);

impl From<DriverError> for CodexRenewalFailed {
    fn from(error: DriverError) -> Self {
        Self(Arc::new(error))
    }
}

impl From<CodexError> for CodexRenewalFailed {
    fn from(error: CodexError) -> Self {
        Self::from(DriverError::from(error))
    }
}

/// The switching service's renewer, holding the account legs weakly: the legs hold the switching
/// account it is attached to, so a strong hold would keep both alive for good.
pub(crate) struct CodexTokenRenewer {
    legs: Weak<CodexAccountLegs>,
}

impl CodexTokenRenewer {
    /// The renewer over the legs `legs` points at.
    pub(super) fn new(legs: Weak<CodexAccountLegs>) -> Self {
        Self { legs }
    }

    /// The binding store a hand-back moves a session's lead binding in where its queue took no
    /// move; `None` once the legs are gone.
    pub(crate) fn bindings(&self) -> Option<Arc<dyn RuntimeBindingWriter>> {
        self.legs.upgrade().map(|legs| Arc::clone(&legs.bindings))
    }

    /// Judges `refused`, the access token Codex refused for `provider_account_id`, against that
    /// account's home `codex_home`, renewing the sign-in there when the home still holds it.
    /// Waits for a sign-in's flow running in the home to end, then joins a renewal in flight on
    /// the account, else waits for the home's hold, so a sign-in's new tokens are the answer. The
    /// caller bounds the wait. Fails as [`CodexRenewalFailed`] says, and once the legs are gone.
    pub(crate) async fn renew(
        &self,
        provider_account_id: ProviderAccountId,
        codex_home: PathBuf,
        refused: SecretString,
    ) -> Result<CodexRenewal, CodexRenewalFailed> {
        let legs = self.legs.upgrade().ok_or_else(|| {
            CodexRenewalFailed::from(DriverError::Internal(
                "the Codex account legs were let go of".into(),
            ))
        })?;
        let home_lock = legs
            .account_home_lock
            .require_port()
            .map_err(|error| DriverError::Internal(Box::new(error)))?;
        let flights = legs
            .token_renewals
            .get_or_init(|| AccountHomeFlights::new(Arc::clone(home_lock)));
        loop {
            home_lock.wait_out_sign_in(&provider_account_id).await;
            let renewing = Arc::clone(&legs);
            let marks = Arc::clone(home_lock);
            let (account, codex_home, refused) = (
                provider_account_id.clone(),
                codex_home.clone(),
                refused.clone(),
            );
            let judged = flights
                .run_when_free(provider_account_id.clone(), move || {
                    async move {
                        // Read under the home's hold, which a sign-in's start takes to mark it.
                        if marks.is_signing_in(&account) {
                            return None;
                        }
                        Some(renewing.judge_renewal(account, codex_home, refused).await)
                    }
                    .boxed()
                })
                .await
                .map_err(|ended| DriverError::Internal(Box::new(ended)))?
                // Only joining an act that runs only on a free home answers none; no renewal is.
                .ok_or_else(|| {
                    CodexRenewalFailed::from(DriverError::Internal(
                        "the account's home was held by an act that runs only when it is free"
                            .into(),
                    ))
                })?;
            if let Some(judged) = judged {
                return judged;
            }
        }
    }
}

impl CodexAccountLegs {
    // Under the home's hold: the home's tokens where they are no longer the refused ones, with no
    // renewal; else the renewing read on the home's service, and the home's tokens again, the
    // sign-in dead where they are still the refused ones.
    async fn judge_renewal(
        &self,
        provider_account_id: ProviderAccountId,
        codex_home: PathBuf,
        refused: SecretString,
    ) -> Result<CodexRenewal, CodexRenewalFailed> {
        let before = read_home_sign_in(&codex_home).await?;
        if !is_same_token(&before.access_token, &refused) {
            return Ok(CodexRenewal::Renewed(before));
        }
        self.act_on_home_service(provider_account_id, codex_home.clone(), async |service| {
            service
                .ensure_started(service.dependencies().startup_timeout)
                .await?;
            renew_codex_sign_in(&*service.connection()?, CODEX_RENEWING_READ_TIMEOUT).await
        })
        .await?;
        let after = read_home_sign_in(&codex_home).await?;
        Ok(if is_same_token(&after.access_token, &refused) {
            CodexRenewal::Dead
        } else {
            CodexRenewal::Renewed(after)
        })
    }
}

/// The answer to Codex's token refresh, `{accessToken, chatgptAccountId, chatgptPlanType}`,
/// borrowing the tokens so the access token leaves its wrapper only as the answer is encoded.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexTokenRefreshAnswer<'tokens> {
    #[serde(serialize_with = "serialize_secret")]
    access_token: &'tokens SecretString,
    chatgpt_account_id: &'tokens str,
    chatgpt_plan_type: Option<&'tokens str>,
}

impl<'tokens> From<&'tokens CodexAuthTokens> for CodexTokenRefreshAnswer<'tokens> {
    fn from(tokens: &'tokens CodexAuthTokens) -> Self {
        Self {
            access_token: &tokens.access_token,
            chatgpt_account_id: &tokens.chatgpt_account_id,
            chatgpt_plan_type: tokens.chatgpt_plan_type.as_deref(),
        }
    }
}

// The `ChatGPT` sign-in's tokens in `codex_home`'s `auth.json`. Fails where it cannot be read or
// holds none.
async fn read_home_sign_in(codex_home: &Path) -> Result<CodexAuthTokens, CodexRenewalFailed> {
    read_codex_auth_tokens(codex_home)
        .await
        .map_err(|error| DriverError::Internal(Box::new(error)))?
        .ok_or_else(|| {
            CodexRenewalFailed::from(DriverError::Internal(
                "the Codex account's home holds no ChatGPT sign-in to renew".into(),
            ))
        })
}

#[cfg(test)]
mod tests;
