//! The switching service's answer to Codex's token refresh. The token Codex refused is the one the
//! service carries when the request arrives; the renewer judges it in the account's own home, and
//! under the hand the answer is the renewed tokens, or the tokens a switch that landed meanwhile
//! carries, never undoing it. A refresh that finds none carried, as while a rejoin hands them, is
//! answered with the tokens that hand gave. A token the renewal left dead is refused at once on every later
//! refresh, since Codex retries a refused one with fresh requests. The whole answer is bounded
//! inside Codex's own wait; past the bound it is refused and nothing is remembered.

use std::error::Error;
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use secrecy::SecretString;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_std::mutex_lock::lock;

use crate::driver::codex::account::auth_file::{CodexAuthTokens, is_same_token};
use crate::driver::codex::account::token_refresh::CodexRenewal;
use crate::driver::codex::server_requests::CodexTokenRefresher;
use crate::driver::codex::service::switching::CodexSwitchingAccount;

/// How long a refresh's answer may take: Codex waits about 10 s for it.
const CODEX_TOKEN_REFRESH_BOUND: Duration = Duration::from_secs(8);

impl CodexTokenRefresher for CodexSwitchingAccount {
    fn refresh_tokens(&self) -> BoxFuture<'_, Option<CodexAuthTokens>> {
        async move {
            if let Ok(answer) =
                tokio::time::timeout(CODEX_TOKEN_REFRESH_BOUND, self.answer_refresh()).await
            {
                return answer;
            }
            tracing::warn!("a Codex token refresh was refused: its answer outlived its bound");
            None
        }
        .boxed()
    }
}

impl CodexSwitchingAccount {
    // The tokens a refresh is answered with, `None` for its refusal.
    async fn answer_refresh(&self) -> Option<CodexAuthTokens> {
        let Some((provider_account_id, refused)) = self.carried_token() else {
            return self.answer_after_hand().await;
        };
        if self.is_dead(&provider_account_id, &refused) {
            return None;
        }
        let renewer = self.renewer.get()?;
        let codex_home = match self.resolve_home(&provider_account_id).await {
            Ok(codex_home) => codex_home,
            Err(error) => {
                report_refusal(&error);
                return None;
            }
        };
        let renewal = renewer
            .renew(provider_account_id.clone(), codex_home, refused.clone())
            .await;
        let hand = self.hands.lock().await;
        if self.carried_account()? != provider_account_id {
            // A switch landed meanwhile: its account's tokens are the answer.
            drop(hand);
            return self.answer_after_hand().await;
        }
        match renewal {
            Ok(CodexRenewal::Renewed(tokens)) => {
                if let Some(carried) = lock(&self.carried).as_mut() {
                    carried.access_token = tokens.access_token.clone();
                }
                Some(tokens)
            }
            Ok(CodexRenewal::Dead) => {
                if let Some(carried) = lock(&self.carried).as_mut() {
                    carried.dead_token = Some(refused);
                }
                tracing::warn!("a Codex token refresh was refused: its sign-in renews no more");
                None
            }
            Err(error) => {
                report_refusal(&error);
                None
            }
        }
    }

    // A refresh that found no account carried, as while a rejoin's hand is in progress: the
    // tokens that hand gave are the answer, read again from the carried account's home once the
    // hand is done; still none carried is the refusal.
    async fn answer_after_hand(&self) -> Option<CodexAuthTokens> {
        let _hand = self.hands.lock().await;
        let carried = self.carried_account()?;
        match self.read_tokens(&carried).await {
            Ok(tokens) => Some(tokens),
            Err(error) => {
                report_refusal(&error);
                None
            }
        }
    }

    // The account carried and its access token, the one Codex refused.
    fn carried_token(&self) -> Option<(ProviderAccountId, SecretString)> {
        lock(&self.carried).as_ref().map(|carried| {
            (
                carried.provider_account_id.clone(),
                carried.access_token.clone(),
            )
        })
    }

    // Whether `refused` is the token `provider_account_id`'s home could not renew.
    fn is_dead(&self, provider_account_id: &ProviderAccountId, refused: &SecretString) -> bool {
        lock(&self.carried).as_ref().is_some_and(|carried| {
            carried.provider_account_id == *provider_account_id
                && carried
                    .dead_token
                    .as_ref()
                    .is_some_and(|dead| is_same_token(dead, refused))
        })
    }
}

// Logs why a refresh was refused; no error here carries a token.
fn report_refusal(error: &(dyn Error + 'static)) {
    tracing::warn!(error, "a Codex token refresh was refused");
}
