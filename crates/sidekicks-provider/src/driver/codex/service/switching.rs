//! The sign-in of the one switching service, which keeps none of its own: the account it carries,
//! whose tokens the daemon reads from that account's own home and hands it with Codex's
//! `account/login/start {type: "chatgptAuthTokens"}`, held in memory alone. The tokens are handed
//! at each start or rejoin of the service, before it answers, so before any resume or admission
//! there; at a switch, and at any hand onto another account than the one carried, its answer the
//! acknowledgment that moves every session on the service with it; and when a limits read in the
//! carried account's home finds its access token renewed. Never on a timer, since each such login
//! refreshes the tool servers of every conversation loaded there.
//! One hand at a time: each holds the switching service's hand through its login's answer, so a
//! renewal never hands an account back over a switch that landed meanwhile. A login written and
//! never answered leaves the service's account unknown, carried as none until the next hand.
//! When Codex refuses the login it runs on, it asks for fresh tokens, which the renewer attached
//! here answers. A switch off another account opens a hand-back window over the sessions it moved,
//! checked by one `account/read` once the hand is let go: a login refused there hands the previous
//! account back.

pub(crate) mod hand_back;
mod refresh;
/// What a test of the switching service's moves runs its sessions and binding store on.
#[cfg(test)]
pub(crate) mod test_moves;
/// What a test signs its accounts in with: each account's home holding a `ChatGPT` sign-in Codex
/// wrote, and an accounts reader resolving each account to its home.
#[cfg(test)]
pub(crate) mod test_sign_in;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use secrecy::SecretString;
use serde_json::value::RawValue;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use tokio::sync::oneshot;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::account::auth_file::{
    CodexAuthTokens, is_same_token, read_codex_auth_tokens,
};
use crate::driver::codex::account::login::{CODEX_LOGIN_START_METHOD, CodexLoginAccountParams};
use crate::driver::codex::account::token_refresh::CodexTokenRenewer;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::service::switching::hand_back::{
    FirstRequestWatch, HandBackWindows, WatchedSession,
};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::inbound::{
    CodexAccountMove, CodexSessionInbound, CodexSessionInboundSender,
};
use crate::driver::codex::transport::connection::CodexAppServerConnection;
use crate::driver::contract::account::FirstRequestAfterMove;
use crate::driver::contract::error::DriverError;
use crate::driver::{ProviderAccountReader, read_current_account};

/// A session a switch names, moved at the switch's acknowledgment with its lead's binding, and
/// where the switch waits on that move.
pub(crate) struct CodexNamedMove {
    /// The session to move.
    pub(crate) session_id: SessionId,
    /// The binding its lead runs on, which moves with it.
    pub(crate) binding_id: RuntimeBindingId,
    /// Where the bindings' move, or its failure, goes once the spend before it is recorded.
    pub(crate) moved: oneshot::Sender<Result<(), DriverError>>,
    /// Where its first request on the account moved to settles, kept by the hand-back window.
    pub(crate) first_request: FirstRequestWatch,
}

/// The account the switching service carries, the tokens it was last handed for it, the renewer
/// its token refreshes are answered through, and the hand-back window of its last switch.
pub(crate) struct CodexSwitchingAccount {
    provider_accounts: Arc<PortRegistration<Arc<dyn ProviderAccountReader>>>,
    // Shared with the hook a switch's answer runs on the connection's reader.
    carried: Arc<Mutex<Option<CarriedAccount>>>,
    // Held by each hand from its tokens' read through its login's answer.
    hands: tokio::sync::Mutex<()>,
    // Attached once the account legs are built; a refresh before then is refused.
    renewer: OnceLock<CodexTokenRenewer>,
    // Shared with the hook a switch's answer runs, which opens it, and with its check's task.
    windows: Arc<HandBackWindows>,
}

// The account the service carries, the access token last handed for it, and the token its home
// could not renew, which every later refresh for it is refused on at once.
struct CarriedAccount {
    provider_account_id: ProviderAccountId,
    access_token: SecretString,
    dead_token: Option<SecretString>,
}

impl CodexSwitchingAccount {
    /// Carrying no account yet, each account's home and the current account read through
    /// `provider_accounts`.
    pub(crate) fn new(
        provider_accounts: Arc<PortRegistration<Arc<dyn ProviderAccountReader>>>,
    ) -> Self {
        Self {
            provider_accounts,
            carried: Arc::default(),
            hands: tokio::sync::Mutex::default(),
            renewer: OnceLock::new(),
            windows: Arc::default(),
        }
    }

    /// Attaches the renewer the service's token refreshes are answered through. A driver builds
    /// its account legs once, so a second attach is ignored and the first renewer kept.
    pub(crate) fn attach_renewer(&self, renewer: CodexTokenRenewer) {
        let _first_kept = self.renewer.set(renewer);
    }

    /// The account the switching service carries; `None` before its first hand and after a login
    /// that went unanswered.
    pub(crate) fn carried_account(&self) -> Option<ProviderAccountId> {
        lock(&self.carried)
            .as_ref()
            .map(|carried| carried.provider_account_id.clone())
    }

    /// Hands a starting or rejoined switching `service`, over `connection`, the tokens of the
    /// account it carries, else of Codex's current account, and carries that account; a service
    /// that carried none moves every session attached to it onto that account, as a switch does.
    /// Fails with the refusal of an account with no current one or no `ChatGPT` sign-in in its
    /// home, as its home cannot be read, and with Codex's refusal of the login.
    pub(crate) async fn hand_at_start(
        &self,
        service: &Arc<CodexService>,
        connection: &CodexAppServerConnection,
    ) -> Result<(), CodexError> {
        let hand = self.hands.lock().await;
        let Some(provider_account_id) = self.carried_account() else {
            let current = read_current_account(&self.provider_accounts, DESCRIPTOR.provider_id())
                .await
                .map_err(CodexError::Driver)?;
            // Carrying none, the service has no account to hand back to, so no window opens.
            return self
                .hand_switch_holding(&hand, service, connection, current, Vec::new(), None)
                .await
                .map(drop);
        };
        let tokens = self.read_tokens(&provider_account_id).await?;
        let access_token = tokens.access_token.clone();
        self.windows.close();
        self.settle_login(
            connection
                .request(CODEX_LOGIN_START_METHOD, &compose_login(tokens))
                .await,
        )?;
        carry(&self.carried, provider_account_id, access_token);
        Ok(())
    }

    /// Hands the switching `service` the tokens of `to`'s account, the switch's one call for
    /// `actor`: at its answer's place among the service's frames its readings start afresh, it
    /// carries `to`, and every session attached to it is queued its move onto `to`, each of
    /// `named` with its lead's binding and its switch's wait, every other one reported as moved by
    /// `actor`; a refused login leaves it carrying what it did and moves nothing. A switch off
    /// another account then checks its hand-back window. Fails as [`Self::hand_at_start`] does,
    /// before anything is sent where `to`'s home holds no sign-in, and while the service has no
    /// connection.
    pub(crate) async fn hand_switch(
        &self,
        service: &Arc<CodexService>,
        to: ProviderAccountId,
        named: Vec<CodexNamedMove>,
        actor: DeviceId,
    ) -> Result<(), CodexError> {
        let hand = self.hands.lock().await;
        self.hand_switch_then_check(hand, service, to, named, Some(actor))
            .await
    }

    /// Hands the switching `service` `to`'s tokens as a switch does where it carries another
    /// account or none, so a session following the current account starts on `to` though no
    /// switch moved the service there, and every session already on it moves with it; a service
    /// carrying `to` is handed nothing. Fails as [`Self::hand_switch`] does.
    pub(crate) async fn carry_for_session(
        &self,
        service: &Arc<CodexService>,
        to: &ProviderAccountId,
    ) -> Result<(), CodexError> {
        let hand = self.hands.lock().await;
        if self.carried_account().as_ref() == Some(to) {
            return Ok(());
        }
        self.hand_switch_then_check(hand, service, to.clone(), Vec::new(), None)
            .await
    }

    // The switch's login under `hand`, as `hand_switch_holding` sends it, then, with the hand let
    // go, the check of the hand-back window it opened: the check's refresh is answered under the
    // hand.
    async fn hand_switch_then_check(
        &self,
        hand: tokio::sync::MutexGuard<'_, ()>,
        service: &Arc<CodexService>,
        to: ProviderAccountId,
        named: Vec<CodexNamedMove>,
        actor: Option<DeviceId>,
    ) -> Result<(), CodexError> {
        let connection = service.connection()?;
        let opened = self
            .hand_switch_holding(&hand, service, &connection, to, named, actor)
            .await?;
        drop(hand);
        if let Some(window) = opened {
            self.check_window(service, connection, window);
        }
        Ok(())
    }

    // The switch's login, sent on `connection` under `_hand`, its answer the acknowledgment that
    // moves the service and every session attached to it onto `to`, those `named` not reported as
    // moved by `actor`, the person whose switch it is, or else by no one. A switch off another
    // account opens the hand-back window over every session it moved, whose serial it answers.
    async fn hand_switch_holding(
        &self,
        _hand: &tokio::sync::MutexGuard<'_, ()>,
        service: &Arc<CodexService>,
        connection: &CodexAppServerConnection,
        to: ProviderAccountId,
        named: Vec<CodexNamedMove>,
        actor: Option<DeviceId>,
    ) -> Result<Option<u64>, CodexError> {
        let tokens = self.read_tokens(&to).await?;
        let access_token = tokens.access_token.clone();
        let carried = Arc::clone(&self.carried);
        let windows = Arc::clone(&self.windows);
        let acknowledged = Arc::downgrade(service);
        self.windows.close();
        let answer = connection
            .request_ordered(
                CODEX_LOGIN_START_METHOD,
                &compose_login(tokens),
                Box::new(move |answer: Option<&RawValue>| {
                    let Some(service) = answer.and(acknowledged.upgrade()) else {
                        return;
                    };
                    let mut previous = None;
                    service.restart_rate_limits(|| {
                        previous = carry(&carried, to.clone(), access_token);
                    });
                    let watched = move_attached_sessions(&service, &to, named, actor.as_ref());
                    if let Some(previous) = previous.filter(|previous| *previous != to) {
                        windows.open(previous, to, &service, watched);
                    }
                }),
            )
            .await;
        self.settle_login(answer)?;
        // The hook ran before the answer came back, so the window it opened is the one open.
        Ok(self.windows.open_serial())
    }

    /// Hands the switching service on `connection` the tokens in `codex_home` again where that
    /// home is the carried `provider_account_id`'s and its access token is no longer the one last
    /// handed, as a renewal there leaves it; the carried account is checked under the hand, so a
    /// switch that landed first is never undone. Answers whether it handed them. Fails as the
    /// home's `auth.json` cannot be read and with Codex's refusal of the login.
    pub(crate) async fn hand_again_if_renewed(
        &self,
        connection: &CodexAppServerConnection,
        provider_account_id: &ProviderAccountId,
        codex_home: &Path,
    ) -> Result<bool, CodexError> {
        let _hand = self.hands.lock().await;
        if self.carried_account().as_ref() != Some(provider_account_id) {
            return Ok(false);
        }
        let Some(tokens) = read_home_tokens(codex_home).await? else {
            return Ok(false);
        };
        let is_renewed = lock(&self.carried)
            .as_ref()
            .is_some_and(|carried| !is_same_token(&carried.access_token, &tokens.access_token));
        if !is_renewed {
            return Ok(false);
        }
        let access_token = tokens.access_token.clone();
        self.windows.close();
        self.settle_login(
            connection
                .request(CODEX_LOGIN_START_METHOD, &compose_login(tokens))
                .await,
        )?;
        if let Some(carried) = lock(&self.carried)
            .as_mut()
            .filter(|carried| carried.provider_account_id == *provider_account_id)
        {
            carried.access_token = access_token;
        }
        Ok(true)
    }

    /// The registration of the accounts reader the tokens are found through, for a test to
    /// register its own.
    #[cfg(test)]
    pub(crate) fn provider_accounts(&self) -> &PortRegistration<Arc<dyn ProviderAccountReader>> {
        &self.provider_accounts
    }

    // A login's answer: one written and never answered may have landed or not, so the service's
    // account is unknown and carried as none, which the next hand at a start or session start
    // replaces; any other failure leaves the account carried as it was.
    fn settle_login<Answer>(
        &self,
        answer: Result<Answer, CodexError>,
    ) -> Result<Answer, CodexError> {
        if let Err(CodexError::Unanswered { .. }) = &answer {
            *lock(&self.carried) = None;
        }
        answer
    }

    // The ChatGPT sign-in's tokens in `provider_account_id`'s home. Refuses
    // `provider.account.notAuthenticated` where the home holds none.
    async fn read_tokens(
        &self,
        provider_account_id: &ProviderAccountId,
    ) -> Result<CodexAuthTokens, CodexError> {
        read_home_tokens(&self.resolve_home(provider_account_id).await?)
            .await?
            .ok_or_else(|| {
                CodexError::Driver(DriverError::from(DomainError::new(
                    "The Codex account's home holds no ChatGPT sign-in to hand over",
                    RefusalCode::ProviderAccountNotAuthenticated,
                )))
            })
    }

    // `provider_account_id`'s Codex home. Fails for an account that is not registered or whose
    // folders cannot be resolved.
    async fn resolve_home(
        &self,
        provider_account_id: &ProviderAccountId,
    ) -> Result<PathBuf, CodexError> {
        let folders = self
            .provider_accounts
            .require_port()
            .map_err(|error| CodexError::Driver(DriverError::Internal(Box::new(error))))?
            .resolve_account_folders(provider_account_id.clone())
            .await
            .map_err(|error| CodexError::Driver(error.into()))?;
        Ok(folders.configuration_folder)
    }
}

// Carries `provider_account_id` on `access_token` in `carried`, keeping the token its home could
// not renew while the account stays the same and forgetting it when the account changes. Answers
// the account carried before, `None` where none was.
fn carry(
    carried: &Mutex<Option<CarriedAccount>>,
    provider_account_id: ProviderAccountId,
    access_token: SecretString,
) -> Option<ProviderAccountId> {
    let mut carried = lock(carried);
    let before = carried.take();
    let previous = before
        .as_ref()
        .map(|before| before.provider_account_id.clone());
    let dead_token = before
        .filter(|before| before.provider_account_id == provider_account_id)
        .and_then(|before| before.dead_token);
    *carried = Some(CarriedAccount {
        provider_account_id,
        access_token,
        dead_token,
    });
    previous
}

// Queues each session attached to `service` its move onto `to` at this place among its frames:
// each of `named` with its lead's binding and its switch's wait, every other one with its own
// binding alone, reported as moved by `actor`. A named session no longer attached drops its wait,
// which moves it at once. Answers every moved session with the watch of its first request.
fn move_attached_sessions(
    service: &CodexService,
    to: &ProviderAccountId,
    named: Vec<CodexNamedMove>,
    actor: Option<&DeviceId>,
) -> Vec<WatchedSession> {
    let mut unnamed = attached_by_session(service);
    let mut watched = Vec::new();
    for session in named {
        unnamed.remove(&session.session_id);
        // A queue that takes nothing drops the wait, which moves the session at once.
        let _taken = service.push_session_item(
            &session.session_id,
            CodexSessionInbound::AccountMoved(CodexAccountMove {
                provider_account_id: to.clone(),
                binding_id: Some(session.binding_id.clone()),
                moved: Some(session.moved),
                actor: None,
                first_request: None,
            }),
        );
        watched.push(WatchedSession {
            session_id: session.session_id,
            binding_id: Some(session.binding_id),
            watch: session.first_request,
        });
    }
    for session in unnamed.into_values() {
        let (watch, first_request) = oneshot::channel();
        queue_reported_move(&session, to, actor, Some(first_request));
        watched.push(WatchedSession {
            session_id: session.session_id(),
            binding_id: None,
            watch,
        });
    }
    watched
}

// Every session attached to `service`, by its id.
fn attached_by_session(service: &CodexService) -> HashMap<SessionId, CodexSessionInboundSender> {
    service
        .attached_sessions()
        .into_iter()
        .map(|session| (session.session_id(), session))
        .collect()
}

// Queues `session` its move onto `to` with its own binding alone, reported as moved by `actor`,
// its first request settling on `first_request` where it is watched.
fn queue_reported_move(
    session: &CodexSessionInboundSender,
    to: &ProviderAccountId,
    actor: Option<&DeviceId>,
    first_request: Option<oneshot::Receiver<Result<FirstRequestAfterMove, DriverError>>>,
) {
    // A queue whose task ended takes nothing more; its session is closing.
    let _taken = session.push(CodexSessionInbound::AccountMoved(CodexAccountMove {
        provider_account_id: to.clone(),
        binding_id: None,
        moved: None,
        actor: actor.cloned(),
        first_request,
    }));
}

// The tokens of `codex_home`'s `auth.json`, `None` where it holds none. Fails as it cannot be read.
async fn read_home_tokens(codex_home: &Path) -> Result<Option<CodexAuthTokens>, CodexError> {
    read_codex_auth_tokens(codex_home)
        .await
        .map_err(|error| CodexError::Driver(DriverError::Internal(Box::new(error))))
}

fn compose_login(tokens: CodexAuthTokens) -> CodexLoginAccountParams {
    CodexLoginAccountParams::ChatgptAuthTokens {
        access_token: tokens.access_token,
        chatgpt_account_id: tokens.chatgpt_account_id,
        chatgpt_plan_type: tokens.chatgpt_plan_type,
    }
}
