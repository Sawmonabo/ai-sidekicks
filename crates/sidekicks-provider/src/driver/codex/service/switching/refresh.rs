//! The switching service's answer to Codex's token refresh. The token Codex refused is the one the
//! service carries when the request arrives; the renewer judges it in the account's own home, and
//! under the hand the answer is the renewed tokens, or the tokens a switch that landed meanwhile
//! carries, never undoing it. A refresh that finds none carried, as while a rejoin hands them, is
//! answered with the tokens that hand gave. An account carried on its API key has no token to
//! renew, so a refresh for it is refused at once. A token the renewal left dead hands the previous
//! account back where a switch just moved onto it: its tokens are the answer, or, for an account
//! that signs in with an API key, the refresh is refused and the key is handed after it. Otherwise
//! it is refused, at once on every later refresh, since Codex retries a refused one with fresh
//! requests. The whole answer is bounded inside Codex's own wait; past the bound it is refused and
//! nothing is remembered.

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
use crate::driver::codex::service::switching::hand_back::CodexHandBack;
use crate::driver::codex::service::switching::{
    CarriedAccount, CarriedSignIn, CodexSwitchingAccount,
};

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
        // A key carried has no token to renew; its home's tokens are never handed over it.
        let refused = refused?;
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
                self.renew_carried_token(&provider_account_id, tokens.access_token.clone());
                Some(tokens)
            }
            Ok(CodexRenewal::Dead) => {
                // Refused right after a switch moved onto it: the previous account goes back, its
                // tokens the answer; a previous account on its key is handed back after a refusal.
                let hand_back = self.hand_back(&provider_account_id).await;
                if let CodexHandBack::Tokens(previous_tokens) = hand_back {
                    return Some(previous_tokens);
                }
                if let Some(CarriedAccount {
                    sign_in: CarriedSignIn::Tokens { dead_token, .. },
                    ..
                }) = lock(&self.carried).as_mut()
                {
                    *dead_token = Some(refused);
                }
                // A key handed back after the refusal recovers the sessions, so no end is logged.
                if matches!(hand_back, CodexHandBack::NotHanded) {
                    tracing::warn!("a Codex token refresh was refused: its sign-in renews no more");
                }
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
    // hand is done; still none carried, or a key carried, is the refusal.
    async fn answer_after_hand(&self) -> Option<CodexAuthTokens> {
        let _hand = self.hands.lock().await;
        let (carried, Some(_handed)) = self.carried_token()? else {
            return None;
        };
        match self.read_tokens(&carried).await {
            Ok(tokens) => Some(tokens),
            Err(error) => {
                report_refusal(&error);
                None
            }
        }
    }

    // Whether `refused` is the token `provider_account_id`'s home could not renew.
    fn is_dead(&self, provider_account_id: &ProviderAccountId, refused: &SecretString) -> bool {
        lock(&self.carried).as_ref().is_some_and(|carried| {
            carried.provider_account_id == *provider_account_id
                && match &carried.sign_in {
                    CarriedSignIn::Tokens {
                        dead_token: Some(dead),
                        ..
                    } => is_same_token(dead, refused),
                    CarriedSignIn::Tokens {
                        dead_token: None, ..
                    }
                    | CarriedSignIn::ApiKey => false,
                }
        })
    }
}

// Logs why a refresh was refused; no error here carries a token.
fn report_refusal(error: &(dyn Error + 'static)) {
    tracing::warn!(error, "a Codex token refresh was refused");
}
