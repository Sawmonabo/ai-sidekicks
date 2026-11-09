//! The sign-in of the one switching service, which keeps none of its own: the account it carries,
//! whose tokens the daemon reads from that account's own home and hands it with Codex's
//! `account/login/start {type: "chatgptAuthTokens"}`, or whose sealed API key it hands with
//! `{type: "apiKey"}` once the service is signed out of any other kind of sign-in, Codex refusing a
//! key over handed tokens; either is held in memory alone. The sign-in is handed
//! at each start or rejoin of the service, before it answers, so before any resume or admission
//! there; at a switch, and at any hand onto another account than the one carried, its answer the
//! place among the service's frames where every session on it moves with it, between their turns;
//! and when a limits read in the
//! carried account's home finds its access token renewed, and when the API key of the account it
//! carries on its key is re-supplied. Never on a timer, since each such login refreshes the tool
//! servers of every conversation loaded there.
//! One hand at a time: each holds the switching service's hand through its login's answer, so a
//! renewal never hands an account back over a switch that landed meanwhile. A login written and
//! never answered leaves the service's account unknown, carried as none until the next hand.
//! When Codex refuses the login it runs on, it asks for fresh tokens, which the renewer attached
//! here answers. A switch off another account opens a hand-back window over the sessions it moved,
//! checked by one `account/read` once the hand is let go: a login refused there hands the previous
//! account back.
//! A switch, a session start's hand onto another account and a re-supplied key's hand are held
//! until no turn runs on the service, in `held`.

pub(crate) mod hand_back;
pub(crate) mod held;
mod refresh;
/// What a test of the switching service's moves runs its sessions and binding store on.
#[cfg(test)]
pub(crate) mod test_moves;
/// What a test signs its accounts in with: each account's home holding a `ChatGPT` sign-in Codex
/// wrote, an accounts reader resolving each account to its home and to its pasted key, and a hand
/// answered through its login, tokens or key alike.
#[cfg(test)]
pub(crate) mod test_sign_in;

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use secrecy::SecretString;
use serde_json::value::RawValue;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::account::record::{ProviderAccountId, ProviderAuthMode};
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use tokio::sync::{oneshot, watch};

use self::held::{CodexSwitchAsker, CodexSwitchLanding, HeldSwitch};

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::account::api_key::read_codex_api_key;
use crate::driver::codex::account::auth_file::{
    CodexAuthTokens, is_same_token, read_codex_auth_tokens,
};
use crate::driver::codex::account::login::{
    CODEX_ACCOUNT_LOGOUT_METHOD, CODEX_LOGIN_START_METHOD, CodexLoginAccountParams,
};
use crate::driver::codex::account::token_refresh::CodexTokenRenewer;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::service::switching::hand_back::{
    FirstRequestWatch, HandBackWindows, WatchedSession,
};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::inbound::{
    CodexAccountMove, CodexSessionInbound, CodexSessionInboundSender,
};
use crate::driver::codex::telemetry::read_unix_time_ms;
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

/// The account the switching service carries, the sign-in it was last handed for it, the renewer
/// its token refreshes are answered through, the hand-back window of its last switch, and the
/// switch held until the service's turns end.
pub(crate) struct CodexSwitchingAccount {
    provider_accounts: Arc<PortRegistration<Arc<dyn ProviderAccountReader>>>,
    // Shared with the hook a switch's answer runs on the connection's reader.
    carried: Arc<Mutex<Option<CarriedAccount>>>,
    // Each change of the carried account, shared with that hook too.
    switches: Arc<AccountSwitches>,
    // Held by each hand from its tokens' read through its login's answer.
    hands: tokio::sync::Mutex<()>,
    // Attached once the account legs are built; a refresh before then is refused.
    renewer: OnceLock<CodexTokenRenewer>,
    // Shared with the hook a switch's answer runs, which opens it, and with its check's task.
    windows: Arc<HandBackWindows>,
    // The one switch waiting for the service's turns to end, which a newer one joins.
    held: Mutex<Option<HeldSwitch>>,
    // `true` from a switch's hold until its login is answered and no other is held, while every
    // turn start on the switching service waits.
    is_switch_held: watch::Sender<bool>,
}

// The account the service carries and the kind of sign-in last handed for it.
struct CarriedAccount {
    provider_account_id: ProviderAccountId,
    sign_in: CarriedSignIn,
}

/// How many changes of its carried account a switching service remembers, so a request exported
/// after a switch is still charged to the account it ran on.
const ACCOUNT_SWITCHES_KEPT: usize = 16;

// The changes of the carried account, oldest first, each when it landed, in Unix milliseconds by
// the wall clock Codex stamps its records with, and the account carried before it.
#[derive(Default)]
struct AccountSwitches {
    switches: Mutex<VecDeque<(u64, Option<ProviderAccountId>)>>,
}

impl AccountSwitches {
    // Notes a change from `before` to `after` now; a hand onto the same account changes nothing.
    fn note(&self, before: Option<ProviderAccountId>, after: Option<&ProviderAccountId>) {
        if before.as_ref() == after {
            return;
        }
        let mut switches = lock(&self.switches);
        if switches.len() >= ACCOUNT_SWITCHES_KEPT {
            switches.pop_front();
        }
        switches.push_back((read_unix_time_ms(), before));
    }

    // The account carried at `at_ms`: the one carried before the first change noted after it,
    // else `current`, where no change was noted since.
    fn carried_at(
        &self,
        at_ms: u64,
        current: Option<ProviderAccountId>,
    ) -> Option<ProviderAccountId> {
        lock(&self.switches)
            .iter()
            .find(|(switched_at_ms, _before)| *switched_at_ms > at_ms)
            .map_or(current, |(_switched_at_ms, before)| before.clone())
    }
}

// The sign-in a carried account was handed.
enum CarriedSignIn {
    // `ChatGPT` tokens: the access token last handed, and the token its home could not renew,
    // which every later refresh for it is refused on at once.
    Tokens {
        access_token: SecretString,
        dead_token: Option<SecretString>,
    },
    // Its sealed API key, which Codex never asks to refresh.
    ApiKey,
}

// What a hand gives the service: an account's `ChatGPT` tokens, read from its home, or its sealed
// API key.
enum CodexHandedLogin {
    Tokens(CodexAuthTokens),
    ApiKey(SecretString),
}

// A hand's login ready to send: its request's params, the sign-in carried once it is answered,
// and whether the service was signed out for it.
struct PreparedLogin {
    params: CodexLoginAccountParams,
    sign_in: CarriedSignIn,
    is_signed_out: bool,
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
            switches: Arc::default(),
            hands: tokio::sync::Mutex::default(),
            renewer: OnceLock::new(),
            windows: Arc::default(),
            held: Mutex::default(),
            is_switch_held: watch::channel(false).0,
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

    /// The account the switching service carried at `at_ms`, in Unix milliseconds: the one a
    /// switch since then left, else the one it carries now.
    pub(crate) fn carried_account_at(&self, at_ms: u64) -> Option<ProviderAccountId> {
        self.switches.carried_at(at_ms, self.carried_account())
    }

    /// Hands a starting or rejoined switching `service`, over `connection`, the sign-in of the
    /// account it carries, else of Codex's current account, and carries that account; a service
    /// that carried none moves every session attached to it onto that account, as a switch does.
    /// An API-key account's key is handed once the service is signed out of any other kind of
    /// sign-in; a key refused after that sign-out leaves it carrying none. Fails with the refusal
    /// of an account with no current one, no `ChatGPT` sign-in in its home or no key sealed, as
    /// its home or key cannot be read, and with Codex's refusal of the sign-out or the login.
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
        let login = self.read_login(&provider_account_id).await?;
        let prepared = self.prepare_login(connection, login).await?;
        self.windows.close();
        self.settle_handed_login(
            connection
                .request(CODEX_LOGIN_START_METHOD, &prepared.params)
                .await,
            prepared.is_signed_out,
        )?;
        carry(
            &self.carried,
            &self.switches,
            provider_account_id,
            prepared.sign_in,
        );
        Ok(())
    }

    /// Hands the switching `service` the sign-in of `to`'s account, the switch's one call for
    /// `actor`, once no turn runs on it, every turn start there waiting meanwhile, telling
    /// `accepted` once the switch is held; a person's switch asked while this one is held takes its
    /// place, so one login onto the newest account lands both. At the login's answer's place among
    /// the service's frames its readings start afresh, it carries the account landed on, and every
    /// session attached to it is queued its move there, each of `named` with its lead's binding and
    /// its switch's wait, every other one reported as moved by `actor`; a refused login moves
    /// nothing and leaves it carrying what it did, or nothing where it was signed out for a key. A
    /// switch off another account then checks its hand-back window. Answers where it landed, with
    /// the sessions of `named` a newer switch named too, once the login is answered, and fails as
    /// [`Self::hand_at_start`] does, before anything is sent where the account has no sign-in to
    /// hand, and while the service has no connection; a caller whose switch another joined gets a
    /// copy of the failure.
    pub(crate) async fn hand_switch(
        &self,
        service: &Arc<CodexService>,
        to: ProviderAccountId,
        named: Vec<CodexNamedMove>,
        actor: DeviceId,
        accepted: oneshot::Sender<()>,
    ) -> Result<CodexSwitchLanding, CodexError> {
        self.hold_switch(
            service,
            to,
            named,
            CodexSwitchAsker::Person(actor),
            Some(accepted),
        )
        .await
    }

    /// Hands the switching `service` `to`'s sign-in as a switch does, held the same way, where it
    /// carries another account or none, so a session following the current account starts on `to`
    /// though no switch moved the service there, and every session already on it moves with it; a
    /// switch held already is joined as it is, the session opening once it lands. A service
    /// carrying `to` with no switch held is handed nothing. Fails as [`Self::hand_switch`] does.
    pub(crate) async fn carry_for_session(
        &self,
        service: &Arc<CodexService>,
        to: &ProviderAccountId,
    ) -> Result<(), CodexError> {
        if lock(&self.held).is_none() && self.carried_account().as_ref() == Some(to) {
            return Ok(());
        }
        self.hold_switch(
            service,
            to.clone(),
            Vec::new(),
            CodexSwitchAsker::SessionStart,
            None,
        )
        .await
        .map(drop)
    }

    // The switch's login, sent on `connection` under `_hand`, its answer the place among the
    // service's frames that moves the service and every session attached to it onto `to`, those `named` not reported as
    // moved by `actor`, the person whose switch it is, or else by no one; a key's sign-out before
    // it moves nothing. A switch off another account opens the hand-back window over every session
    // it moved, whose serial it answers.
    async fn hand_switch_holding(
        &self,
        _hand: &tokio::sync::MutexGuard<'_, ()>,
        service: &Arc<CodexService>,
        connection: &CodexAppServerConnection,
        to: ProviderAccountId,
        named: Vec<CodexNamedMove>,
        actor: Option<DeviceId>,
    ) -> Result<Option<u64>, CodexError> {
        let login = self.read_login(&to).await?;
        let PreparedLogin {
            params,
            sign_in,
            is_signed_out,
        } = self.prepare_login(connection, login).await?;
        let carried = Arc::clone(&self.carried);
        let switches = Arc::clone(&self.switches);
        let windows = Arc::clone(&self.windows);
        let acknowledged = Arc::downgrade(service);
        self.windows.close();
        let answer = connection
            .request_ordered(
                CODEX_LOGIN_START_METHOD,
                &params,
                Box::new(move |answer: Option<&RawValue>| {
                    let Some(service) = answer.and(acknowledged.upgrade()) else {
                        return;
                    };
                    let mut previous = None;
                    service.restart_rate_limits(|| {
                        previous = carry(&carried, &switches, to.clone(), sign_in);
                    });
                    let watched = move_attached_sessions(&service, &to, named, actor.as_ref());
                    if let Some(previous) = previous.filter(|previous| *previous != to) {
                        windows.open(previous, to, &service, watched);
                    }
                }),
            )
            .await;
        self.settle_handed_login(answer, is_signed_out)?;
        // The hook ran before the answer came back, so the window it opened is the one open.
        Ok(self.windows.open_serial())
    }

    /// Hands the switching service on `connection` the tokens in `codex_home` again where that
    /// home is the carried `provider_account_id`'s and its access token is no longer the one last
    /// handed, as a renewal there leaves it; the carried account is checked under the hand, so a
    /// switch that landed first is never undone, and an account carried on its API key is never
    /// handed its home's tokens. Answers whether it handed them. Fails as the home's `auth.json`
    /// cannot be read and with Codex's refusal of the login.
    pub(crate) async fn hand_again_if_renewed(
        &self,
        connection: &CodexAppServerConnection,
        provider_account_id: &ProviderAccountId,
        codex_home: &Path,
    ) -> Result<bool, CodexError> {
        let _hand = self.hands.lock().await;
        let Some((carried_id, Some(handed))) = self.carried_token() else {
            return Ok(false);
        };
        if carried_id != *provider_account_id {
            return Ok(false);
        }
        let Some(tokens) = read_home_tokens(codex_home).await? else {
            return Ok(false);
        };
        if is_same_token(&handed, &tokens.access_token) {
            return Ok(false);
        }
        let access_token = tokens.access_token.clone();
        self.windows.close();
        self.settle_login(
            connection
                .request(CODEX_LOGIN_START_METHOD, &compose_login(tokens))
                .await,
        )?;
        self.renew_carried_token(provider_account_id, access_token);
        Ok(true)
    }

    /// Hands the switching `service` `api_key`, just re-supplied for `provider_account_id`'s
    /// account, where it carries that account on its key, so its
    /// conversations take the new key, held as a switch is until no turn runs there, since the
    /// login cuts every request in flight; a switch held already is joined as it is. Carrying
    /// another account or that one on tokens, it is handed nothing, its next hand reading the
    /// sealed key. Fails with Codex's refusal of the login.
    pub(crate) async fn hand_resupplied_key(
        &self,
        service: &Arc<CodexService>,
        provider_account_id: &ProviderAccountId,
        api_key: SecretString,
    ) -> Result<(), CodexError> {
        if lock(&self.held).is_none()
            && !matches!(self.carried_token(), Some((carried, None)) if carried == *provider_account_id)
        {
            return Ok(());
        }
        self.hold_switch(
            service,
            provider_account_id.clone(),
            Vec::new(),
            CodexSwitchAsker::KeyResupply(api_key),
            None,
        )
        .await
        .map(drop)
    }

    // A login's answer: one written and never answered may have landed or not, so the service's
    // account is unknown and carried as none, which the next hand at a start or session start
    // replaces; any other failure leaves the account carried as it was.
    fn settle_login<Answer>(
        &self,
        answer: Result<Answer, CodexError>,
    ) -> Result<Answer, CodexError> {
        if let Err(CodexError::Unanswered { .. }) = &answer {
            self.carry_none();
        }
        answer
    }

    // A hand's login answer, settled as [`Self::settle_login`] settles it, except that one failed
    // after the service was signed out for it leaves the service signed out, so it carries none.
    fn settle_handed_login<Answer>(
        &self,
        answer: Result<Answer, CodexError>,
        is_signed_out: bool,
    ) -> Result<Answer, CodexError> {
        if is_signed_out && answer.is_err() {
            self.carry_none();
        }
        self.settle_login(answer)
    }

    // Carries no account, the service's being unknown or signed out.
    fn carry_none(&self) {
        let before = lock(&self.carried)
            .take()
            .map(|carried| carried.provider_account_id);
        self.switches.note(before, None);
    }

    // The account carried and the access token last handed it, the one Codex refuses; `None` for
    // the token where the account was handed its API key.
    fn carried_token(&self) -> Option<(ProviderAccountId, Option<SecretString>)> {
        lock(&self.carried).as_ref().map(|carried| {
            let access_token = match &carried.sign_in {
                CarriedSignIn::Tokens { access_token, .. } => Some(access_token.clone()),
                CarriedSignIn::ApiKey => None,
            };
            (carried.provider_account_id.clone(), access_token)
        })
    }

    // Keeps `access_token` as the token last handed where `provider_account_id` is still carried
    // on its tokens.
    fn renew_carried_token(
        &self,
        provider_account_id: &ProviderAccountId,
        access_token: SecretString,
    ) {
        if let Some(CarriedAccount {
            sign_in:
                CarriedSignIn::Tokens {
                    access_token: handed,
                    ..
                },
            ..
        }) = lock(&self.carried)
            .as_mut()
            .filter(|carried| carried.provider_account_id == *provider_account_id)
        {
            *handed = access_token;
        }
    }

    // What `provider_account_id`'s account is handed: its sealed API key where it signs in with
    // one, else its home's `ChatGPT` tokens. Its home is resolved first, so an account that is not
    // registered or has no home is refused as such. Fails as how it signs in, its home's sign-in
    // or its key cannot be read, and refuses `provider.account.notAuthenticated` where the one it
    // signs in with is missing.
    async fn read_login(
        &self,
        provider_account_id: &ProviderAccountId,
    ) -> Result<CodexHandedLogin, CodexError> {
        let codex_home = self.resolve_home(provider_account_id).await?;
        let mode = self
            .provider_accounts
            .require_port()
            .map_err(|error| CodexError::Driver(DriverError::Internal(Box::new(error))))?
            .read_observed_auth_mode(provider_account_id.clone())
            .await
            .map_err(|error| CodexError::Driver(DriverError::Internal(error)))?;
        if mode == Some(ProviderAuthMode::ApiKey) {
            return Ok(CodexHandedLogin::ApiKey(
                read_codex_api_key(&self.provider_accounts, provider_account_id).await?,
            ));
        }
        Ok(CodexHandedLogin::Tokens(
            require_home_tokens(&codex_home).await?,
        ))
    }

    // `login` ready to send. Codex refuses a key while handed tokens are active, so a key's
    // service is signed out first unless it carries an account on a key. A service carrying none
    // is signed out unread, a sign-out of a signed-out service changing nothing, since a read on a
    // token Codex refuses asks for a refresh that waits on this hand. The sign-out leaves the
    // handed tokens unrevoked. Fails as the sign-out does.
    async fn prepare_login(
        &self,
        connection: &CodexAppServerConnection,
        login: CodexHandedLogin,
    ) -> Result<PreparedLogin, CodexError> {
        match login {
            CodexHandedLogin::Tokens(tokens) => Ok(PreparedLogin {
                sign_in: CarriedSignIn::Tokens {
                    access_token: tokens.access_token.clone(),
                    dead_token: None,
                },
                params: compose_login(tokens),
                is_signed_out: false,
            }),
            CodexHandedLogin::ApiKey(api_key) => {
                let is_clear = matches!(self.carried_token(), Some((_, None)));
                if !is_clear {
                    self.settle_login(connection.request(CODEX_ACCOUNT_LOGOUT_METHOD, &()).await)?;
                }
                Ok(PreparedLogin {
                    params: CodexLoginAccountParams::ApiKey { api_key },
                    sign_in: CarriedSignIn::ApiKey,
                    is_signed_out: !is_clear,
                })
            }
        }
    }

    // The ChatGPT sign-in's tokens in `provider_account_id`'s home. Refuses
    // `provider.account.notAuthenticated` where the home holds none.
    async fn read_tokens(
        &self,
        provider_account_id: &ProviderAccountId,
    ) -> Result<CodexAuthTokens, CodexError> {
        require_home_tokens(&self.resolve_home(provider_account_id).await?).await
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

// Carries `provider_account_id` on `sign_in` in `carried`, noting the change in `switches`, keeping the token its home could not
// renew while the account stays the same on its tokens and forgetting it otherwise. Answers the
// account carried before, `None` where none was.
fn carry(
    carried: &Mutex<Option<CarriedAccount>>,
    switches: &AccountSwitches,
    provider_account_id: ProviderAccountId,
    mut sign_in: CarriedSignIn,
) -> Option<ProviderAccountId> {
    let mut carried = lock(carried);
    let before = carried.take();
    let previous = before
        .as_ref()
        .map(|before| before.provider_account_id.clone());
    if let Some(before) = before
        && before.provider_account_id == provider_account_id
        && let CarriedSignIn::Tokens {
            dead_token: Some(dead),
            ..
        } = before.sign_in
        && let CarriedSignIn::Tokens { dead_token, .. } = &mut sign_in
    {
        *dead_token = Some(dead);
    }
    switches.note(previous.clone(), Some(&provider_account_id));
    *carried = Some(CarriedAccount {
        provider_account_id,
        sign_in,
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

// The tokens of `codex_home`'s `auth.json`. Refuses `provider.account.notAuthenticated` where it
// holds none, and fails as it cannot be read.
async fn require_home_tokens(codex_home: &Path) -> Result<CodexAuthTokens, CodexError> {
    read_home_tokens(codex_home).await?.ok_or_else(|| {
        CodexError::Driver(DriverError::from(DomainError::new(
            "The Codex account's home holds no ChatGPT sign-in to hand over",
            RefusalCode::ProviderAccountNotAuthenticated,
        )))
    })
}

fn compose_login(tokens: CodexAuthTokens) -> CodexLoginAccountParams {
    CodexLoginAccountParams::ChatgptAuthTokens {
        access_token: tokens.access_token,
        chatgpt_account_id: tokens.chatgpt_account_id,
        chatgpt_plan_type: tokens.chatgpt_plan_type,
    }
}

#[cfg(test)]
mod tests;
