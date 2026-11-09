//! The switch held on the switching service until no turn runs there, because Codex revokes every
//! model request in flight whenever its sign-in changes owner: the running turns finish on the
//! account they started on and no turn starts while the switch is held. A person's switch asked
//! meanwhile takes the held one's account, so one login lands both; a session start's carry and a
//! re-supplied key join it as it is. A session two switches name lands by the newer one, which
//! reports it, and the older one's caller is told so. A switch lands on the switching service
//! signed in last, read under the hand, and a service started beside another signs in only once
//! any held switch has landed, so neither carries an account the other left.

use std::sync::Arc;

use secrecy::SecretString;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::{oneshot, watch};

use crate::driver::codex::account::login::CODEX_LOGIN_START_METHOD;
use crate::driver::codex::run::turn_end_waiters::CodexTurnWait;
use crate::driver::codex::service::home::CodexHomeKind;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::service::supervisor::running_turns::CodexTurnLease;
use crate::driver::codex::service::switching::{
    CodexHandedLogin, CodexNamedMove, CodexSwitchingAccount,
};
use crate::driver::codex::session::calls::wait_for_codex_turns;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::transport::connection::CodexAppServerConnection;
use crate::driver::contract::error::DriverError;

/// Who asks the switching service a switch.
pub(crate) enum CodexSwitchAsker {
    /// The person's switch, which takes the held switch's account.
    Person(DeviceId),
    /// A session start's carry onto the current account, which joins a held switch as it is.
    SessionStart,
    /// The account's API key re-supplied, handed again where the service carries the account on
    /// its key; it joins a held switch as it is.
    KeyResupply(SecretString),
}

/// Where a held switch landed for one caller: the account the service carries by it, and the
/// sessions this caller named that a newer switch named too, which that switch reports.
pub(crate) struct CodexSwitchLanding {
    /// The account.
    pub(crate) landed_on: ProviderAccountId,
    /// The sessions the newer switch reports.
    pub(crate) replaced: Vec<SessionId>,
}

// A switch held until no turn runs on the switching service: the account it moves to, the
// sessions it names, each with the caller that named it, the person whose switch it is, the key
// re-supplied for the account it moves to, handed again where the service carries it, and each
// caller it lands for.
pub(super) struct HeldSwitch {
    to: ProviderAccountId,
    named: Vec<(usize, CodexNamedMove)>,
    actor: Option<DeviceId>,
    resupplied_key: Option<SecretString>,
    callers: Vec<HeldCaller>,
}

// One caller of a held switch: where its landing goes, and the sessions it named that a newer
// switch named too.
struct HeldCaller {
    landing: oneshot::Sender<Result<CodexSwitchLanding, CodexError>>,
    replaced: Vec<SessionId>,
}

impl HeldSwitch {
    // Joins a caller asking `to` with `named` for `asker`.
    fn join(
        &mut self,
        to: ProviderAccountId,
        named: Vec<CodexNamedMove>,
        asker: CodexSwitchAsker,
        landing: oneshot::Sender<Result<CodexSwitchLanding, CodexError>>,
    ) {
        let caller = self.callers.len();
        for session in named {
            if let Some(at) = self
                .named
                .iter()
                .position(|(_, held)| held.session_id == session.session_id)
            {
                let (older, _) = self.named.remove(at);
                self.callers[older].replaced.push(session.session_id);
            }
            self.named.push((caller, session));
        }
        match asker {
            CodexSwitchAsker::Person(actor) => {
                self.to = to;
                self.actor = Some(actor);
            }
            CodexSwitchAsker::KeyResupply(api_key) => {
                if self.to == to {
                    self.resupplied_key = Some(api_key);
                }
            }
            CodexSwitchAsker::SessionStart => {}
        }
        self.callers.push(HeldCaller {
            landing,
            replaced: Vec::new(),
        });
    }
}

impl CodexSwitchingAccount {
    /// The wait of a turn start on `service` for a held switch to land, `None` where none is
    /// held or `service` is not the switching one, the only service whose sign-in a switch changes;
    /// the receiver reads `false` once no switch is held.
    pub(crate) fn held_switch_on(&self, service: &CodexService) -> Option<watch::Receiver<bool>> {
        (service.home().kind == CodexHomeKind::Switching && *self.is_switch_held.borrow())
            .then(|| self.is_switch_held.subscribe())
    }

    /// Waits until no switch is held on `service`, then counts a copy's turn there among its
    /// running turns until the lease is dropped, so a switch held after this waits for that turn.
    pub(crate) async fn lease_copy_turn(&self, service: &CodexService) -> CodexTurnLease {
        loop {
            if let Some(mut is_held) = self.held_switch_on(service) {
                // The sender lives as long as `self`, so the wait ends only once none is held.
                drop(is_held.wait_for(|is_held| !*is_held).await);
            }
            let lease = service.lease_turn();
            // A switch held between the read and the lease would not have seen the lease.
            if self.held_switch_on(service).is_none() {
                return lease;
            }
        }
    }

    /// Waits until no switch is held, so a switching service started next signs in with the
    /// account any held switch lands on.
    pub(crate) async fn wait_for_held_switch_to_land(&self) {
        let mut is_held = self.is_switch_held.subscribe();
        // The sender lives as long as `self`, so the wait ends only once none is held.
        drop(is_held.wait_for(|is_held| !*is_held).await);
    }

    // Holds the switch onto `to` for `asker`, joining any held already, telling `accepted` once
    // it is held; the first hold starts the task that lands it. Answers as its login does.
    pub(super) async fn hold_switch(
        &self,
        service: &Arc<CodexService>,
        to: ProviderAccountId,
        named: Vec<CodexNamedMove>,
        asker: CodexSwitchAsker,
        accepted: Option<oneshot::Sender<()>>,
    ) -> Result<CodexSwitchLanding, CodexError> {
        let (landing, landed) = oneshot::channel();
        let is_first_hold = {
            let mut held = lock(&self.held);
            if let Some(waiting) = held.as_mut() {
                waiting.join(to, named, asker, landing);
                false
            } else {
                let mut first = HeldSwitch {
                    to: to.clone(),
                    named: Vec::new(),
                    actor: None,
                    resupplied_key: None,
                    callers: Vec::new(),
                };
                first.join(to, named, asker, landing);
                *held = Some(first);
                self.is_switch_held.send_replace(true);
                true
            }
        };
        if let Some(accepted) = accepted {
            // The caller may have stopped waiting.
            accepted.send(()).unwrap_or(());
        }
        if is_first_hold {
            // On a task of its own, so a caller that stops waiting never leaves the switch held.
            let landing_service = Arc::clone(service);
            service.dependencies().tasks.spawn(async move {
                let switching = Arc::clone(&landing_service.dependencies().switching);
                switching.land_held_switch(&landing_service).await;
            });
        }
        landed.await.unwrap_or_else(|_dropped| {
            Err(CodexError::Transport {
                detail: "The Codex switching service stopped before its held switch landed."
                    .to_owned(),
                cause: None,
            })
        })
    }

    // Lands the held switch once no turn runs on the switching service, `held_on` or the one
    // signed in beside it since: its one login under the hand, then,
    // with the hand let go, the check of the hand-back window it opened, whose refresh is answered
    // under the hand. A switch asking only to carry the account the service carries sends
    // nothing, unless a re-supplied key asks it handed again. The turn starts go on once the login
    // is answered and no newer switch is held, and every caller is answered.
    async fn land_held_switch(&self, held_on: &Arc<CodexService>) {
        let (hand, service) = self.take_hand_on_serving_service(held_on).await;
        let service = &service;
        let HeldSwitch {
            to,
            named,
            actor,
            resupplied_key,
            callers,
        } = lock(&self.held)
            .take()
            .expect("a held switch is taken once, by the task its hold started");
        let named: Vec<_> = named.into_iter().map(|(_, session)| session).collect();
        let is_carried =
            named.is_empty() && actor.is_none() && self.carried_account().as_ref() == Some(&to);
        let landed = match (is_carried, resupplied_key) {
            (true, None) => Ok(None),
            (true, Some(api_key)) => match service.connection() {
                Ok(connection) => self
                    .hand_carried_key_again(&connection, &to, api_key)
                    .await
                    .map(|()| None),
                Err(error) => Err(error),
            },
            (false, _) => match service.connection() {
                Ok(connection) => {
                    let opened = self
                        .hand_switch_holding(&hand, service, &connection, to.clone(), named, actor)
                        .await;
                    opened.map(|opened| opened.map(|window| (connection, window)))
                }
                Err(error) => Err(error),
            },
        };
        // Under the hand, so no newer switch's login is sent before turn starts are told.
        self.let_turns_start();
        drop(hand);
        let landed = match landed {
            Ok(Some((connection, window))) => {
                self.check_window(service, connection, window);
                Ok(())
            }
            Ok(None) => Ok(()),
            Err(error) => Err(error),
        };
        answer_held_switch(callers, &to, landed);
    }

    // Takes the hand between turns on the switching service signed in last, read under the hand,
    // else on `held_on`, waiting out the turns of each it reads, and answers that service.
    async fn take_hand_on_serving_service(
        &self,
        held_on: &Arc<CodexService>,
    ) -> (tokio::sync::MutexGuard<'_, ()>, Arc<CodexService>) {
        let mut service = Arc::clone(held_on);
        loop {
            let hand = self.take_hand_between_turns(&service).await;
            let serving = lock(&self.serving)
                .upgrade()
                .unwrap_or_else(|| Arc::clone(&service));
            if Arc::ptr_eq(&serving, &service) || !serving.is_turn_running() {
                return (hand, serving);
            }
            drop(hand);
            service = serving;
        }
    }

    /// Takes the hand once no turn runs on `service`, with turn starts held from then until
    /// [`Self::let_turns_start`], so a login sent under it cuts no request in flight; a turn that
    /// began while the hand was awaited is waited out too.
    pub(super) async fn take_hand_between_turns(
        &self,
        service: &CodexService,
    ) -> tokio::sync::MutexGuard<'_, ()> {
        loop {
            self.is_switch_held.send_replace(true);
            wait_until_no_turn_runs(service).await;
            let hand = self.hands.lock().await;
            // A switch landed meanwhile may have let turn starts go; they are held again here.
            self.is_switch_held.send_replace(true);
            if !service.is_turn_running() {
                return hand;
            }
            self.let_turns_start();
        }
    }

    /// Lets turn starts go unless a switch is still held; called under the hand.
    pub(super) fn let_turns_start(&self) {
        let held = lock(&self.held);
        self.is_switch_held.send_replace(held.is_some());
    }

    // Hands the service on `connection` `api_key`, just re-supplied for `provider_account_id`'s
    // account, where it carries that account on its key, so its conversations take the new key;
    // carrying it on tokens, it is handed nothing. Fails with Codex's refusal of the login.
    async fn hand_carried_key_again(
        &self,
        connection: &CodexAppServerConnection,
        provider_account_id: &ProviderAccountId,
        api_key: SecretString,
    ) -> Result<(), CodexError> {
        if !matches!(self.carried_token(), Some((carried, None)) if carried == *provider_account_id)
        {
            return Ok(());
        }
        let prepared = self
            .prepare_login(connection, CodexHandedLogin::ApiKey(api_key))
            .await?;
        self.windows.close();
        self.settle_handed_login(
            connection
                .request(CODEX_LOGIN_START_METHOD, &prepared.params)
                .await,
            prepared.is_signed_out,
        )
        .map(drop)
    }
}

/// Waits until no turn runs on `service`: no session attached to it runs, starts or still ends a
/// turn, and none of its conversations or copies, a side question's, a helper's or one Codex
/// started itself, runs one; looked at again after each wait, since a turn may start meanwhile.
/// It has no clock of its own: a turn that never ends is ended by the service's silence handling.
pub(crate) async fn wait_until_no_turn_runs(service: &CodexService) {
    loop {
        for session in service.attached_sessions() {
            // Answered once the session runs no turn: idle, or its record let go or closed.
            let _no_turn_runs = wait_for_codex_turns(&session, CodexTurnWait::Idle, None).await;
        }
        if !service.is_turn_running() {
            return;
        }
        service.wait_for_no_running_turn().await;
    }
}

// Answers each caller of a landed switch with its one login's outcome: where it landed, with the
// sessions it named that a newer switch reports, or the failure as it is where one caller waits
// and a copy to each where several do.
fn answer_held_switch(
    callers: Vec<HeldCaller>,
    to: &ProviderAccountId,
    landed: Result<(), CodexError>,
) {
    let mut callers = callers.into_iter();
    let failure = match landed {
        Ok(()) => None,
        Err(error) if callers.len() == 1 => {
            if let Some(caller) = callers.next() {
                // A caller that stopped waiting needs no answer.
                let _unheard = caller.landing.send(Err(error));
            }
            return;
        }
        Err(error) => Some(Arc::new(DriverError::from(error))),
    };
    for caller in callers {
        let answer = match &failure {
            Some(shared) => Err(CodexError::Driver(DriverError::shared(shared))),
            None => Ok(CodexSwitchLanding {
                landed_on: to.clone(),
                replaced: caller.replaced,
            }),
        };
        // A caller that stopped waiting needs no answer.
        let _unheard = caller.landing.send(answer);
    }
}
