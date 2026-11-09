//! The hand-back window of a switch on the switching service. From the switch's acknowledgment
//! until one `account/read` there is answered, every session the switch moved keeps the watch of
//! its first request on the new account. Codex runs its workspace check on that read with the new
//! login, and where the login is refused it asks for fresh tokens: a renewal that leaves the
//! refused token in place hands the previous account back, its tokens the refresh's answer and
//! every moved session moving back with it, reported by no one. A previous account that signs in
//! with an API key has no tokens to answer with: the refresh is refused, its key is then handed as
//! a switch hands one, and the sessions move back once Codex answers that login. Otherwise the
//! read's end closes the window: an account named settles every watch as run, anything else as
//! unobserved, so a network failure never hands back. A new hand closes an open window as
//! unobserved.

use std::error::Error;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use futures::future::join_all;
use secrecy::SecretString;
use serde_json::value::RawValue;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::oneshot;

use crate::driver::codex::account::auth_file::CodexAuthTokens;
use crate::driver::codex::account::login::CODEX_LOGIN_START_METHOD;
use crate::driver::codex::account::switch::wait_for_move;
use crate::driver::codex::account::token_refresh::CodexTokenRenewer;
use crate::driver::codex::auth_status::read_codex_auth_status;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::service::switching::{
    CarriedAccount, CarriedSignIn, CodexHandedLogin, CodexSwitchingAccount, PreparedLogin,
    attached_by_session, carry, queue_reported_move,
};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::inbound::{CodexAccountMove, CodexSessionInbound};
use crate::driver::codex::transport::connection::CodexAppServerConnection;
use crate::driver::contract::account::FirstRequestAfterMove;
use crate::driver::contract::error::DriverError;
use crate::driver::session_control::DriverAuthProbeStatus;
use crate::runtime_binding::writer::RuntimeBindingWriter;

/// How long the window's check waits for its `account/read`, inside which Codex asks for fresh
/// tokens and retries with them.
const CODEX_HAND_BACK_CHECK_WAIT: Duration = Duration::from_secs(20);

/// What a hand-back answers a refresh with: the previous account's tokens, the refusal before its
/// key is handed, or the refusal where nothing is handed back.
pub(crate) enum CodexHandBack {
    /// The previous account's tokens, carried again at once.
    Tokens(CodexAuthTokens),
    /// The refusal; the previous account's key is handed once the hand is let go.
    KeyToFollow,
    /// The refusal; no window is open onto the refused account, or its previous account's
    /// sign-in could not be read.
    NotHanded,
}

/// Where a moved session's first request on the account it moved to settles.
pub(crate) type FirstRequestWatch = oneshot::Sender<Result<FirstRequestAfterMove, DriverError>>;

// Each handed-back session with where its move back lands.
type WatchedSessionMoves = Vec<(WatchedSession, oneshot::Receiver<Result<(), DriverError>>)>;

/// A session a switch moved, whose first request the window watches.
pub(crate) struct WatchedSession {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The lead's binding the switch named with it, which moves back with it; `None` for a
    /// session the switch moved without naming it, whose own binding moves on its task alone.
    pub(crate) binding_id: Option<RuntimeBindingId>,
    /// Where its first request settles.
    pub(crate) watch: FirstRequestWatch,
}

/// The switching service's hand-back window, at most one open: the last switch's, until its check
/// ends, a hand-back takes it, or a new hand closes it.
#[derive(Default)]
pub(crate) struct HandBackWindows(Mutex<WindowSlot>);

#[derive(Default)]
struct WindowSlot {
    // How many windows were opened, the serial of the last.
    opened: u64,
    open: Option<HandBackWindow>,
}

// One switch's window: the account it left and the one it moved onto, the service it ran on, and
// the sessions it moved.
struct HandBackWindow {
    serial: u64,
    previous: ProviderAccountId,
    to: ProviderAccountId,
    service: Weak<CodexService>,
    sessions: Vec<WatchedSession>,
}

impl HandBackWindows {
    /// Opens the window of a switch from `previous` onto `to` on `service`, watching `sessions`,
    /// once a window still open is closed as unobserved.
    pub(crate) fn open(
        &self,
        previous: ProviderAccountId,
        to: ProviderAccountId,
        service: &Arc<CodexService>,
        sessions: Vec<WatchedSession>,
    ) {
        let closed = {
            let mut slot = lock(&self.0);
            slot.opened += 1;
            let window = HandBackWindow {
                serial: slot.opened,
                previous,
                to,
                service: Arc::downgrade(service),
                sessions,
            };
            slot.open.replace(window)
        };
        if let Some(closed) = closed {
            closed.settle(FirstRequestAfterMove::Unobserved);
        }
    }

    /// Closes the window open, as a new hand does, settling every watch as unobserved.
    pub(crate) fn close(&self) {
        let closed = lock(&self.0).open.take();
        if let Some(closed) = closed {
            closed.settle(FirstRequestAfterMove::Unobserved);
        }
    }

    /// The serial of the window open, which its check closes it by.
    pub(crate) fn open_serial(&self) -> Option<u64> {
        lock(&self.0).open.as_ref().map(|window| window.serial)
    }

    // Closes the window `serial` names where it is still open, settling every watch as
    // `first_request`.
    fn close_checked(&self, serial: u64, first_request: FirstRequestAfterMove) {
        let closed = {
            let mut slot = lock(&self.0);
            if slot.open.as_ref().map(|window| window.serial) != Some(serial) {
                return;
            }
            slot.open.take()
        };
        if let Some(closed) = closed {
            closed.settle(first_request);
        }
    }

    // The account the switch whose window is open onto `to` left.
    fn previous_of(&self, to: &ProviderAccountId) -> Option<ProviderAccountId> {
        lock(&self.0)
            .open
            .as_ref()
            .filter(|window| window.to == *to)
            .map(|window| window.previous.clone())
    }

    // Takes the window open onto `to`.
    fn take_onto(&self, to: &ProviderAccountId) -> Option<HandBackWindow> {
        let mut slot = lock(&self.0);
        if slot.open.as_ref().is_some_and(|window| window.to == *to) {
            return slot.open.take();
        }
        None
    }
}

impl HandBackWindow {
    // Settles every watch as `first_request`; a session that stopped watching is skipped.
    fn settle(self, first_request: FirstRequestAfterMove) {
        for session in self.sessions {
            let _unheard = session.watch.send(Ok(first_request));
        }
    }

    // Fails every watch with `error`: the hand-back could not be made.
    fn fail(self, error: DriverError) {
        let error = Arc::new(error);
        for session in self.sessions {
            let _unheard = session.watch.send(Err(DriverError::shared(&error)));
        }
    }
}

impl CodexSwitchingAccount {
    /// Checks the window `serial` names on `service`'s `connection` on a task of its own: one
    /// `account/read`, which Codex answers with the new login's workspace check run. An account
    /// named settles every watch as run, and no account or no answer as unobserved; a hand-back
    /// made meanwhile took the window, so the read's end touches nothing.
    pub(crate) fn check_window(
        &self,
        service: &CodexService,
        connection: Arc<CodexAppServerConnection>,
        serial: u64,
    ) {
        let windows = Arc::clone(&self.windows);
        service.dependencies().tasks.spawn(async move {
            let checked = read_codex_auth_status(&connection, CODEX_HAND_BACK_CHECK_WAIT).await;
            // A read that failed says nothing of the login, so it never hands back.
            let first_request = match checked {
                Ok(reading) if matches!(reading.status, DriverAuthProbeStatus::Authenticated) => {
                    FirstRequestAfterMove::Ran
                }
                Ok(_) | Err(_) => FirstRequestAfterMove::Unobserved,
            };
            windows.close_checked(serial, first_request);
        });
    }

    /// Hands the previous account back, under the hand, where the login Codex refused and could
    /// not renew is `refused`'s, the account a switch whose window is open moved onto. A previous
    /// account on its tokens is carried again at once, every session the switch moved moves back
    /// waited on and reported by no one, every session attached since moves back reported, and each
    /// watch settles once its move landed; its tokens are the refresh's answer. A previous account
    /// on its API key answers [`CodexHandBack::KeyToFollow`], and its key is handed on a task once
    /// the hand is let go, the sessions moving back at that login's answer. Answers
    /// [`CodexHandBack::NotHanded`] where no window is open onto `refused`, or where the previous
    /// account's sign-in cannot be read, every watch then failing with that error.
    pub(crate) async fn hand_back(&self, refused: &ProviderAccountId) -> CodexHandBack {
        let Some(previous) = self.windows.previous_of(refused) else {
            return CodexHandBack::NotHanded;
        };
        let Some(bindings) = self.renewer.get().and_then(CodexTokenRenewer::bindings) else {
            return CodexHandBack::NotHanded;
        };
        let login = self.read_login(&previous).await;
        // The window's check may have ended during the read; then there is nothing to hand back.
        let Some(window) = self.windows.take_onto(refused) else {
            return CodexHandBack::NotHanded;
        };
        let login = match login {
            Ok(login) => login,
            Err(error) => {
                window.fail(DriverError::from(error));
                return CodexHandBack::NotHanded;
            }
        };
        // A service gone left no session to move; the window dropped settles each as unobserved.
        let Some(service) = window.service.upgrade() else {
            return CodexHandBack::NotHanded;
        };
        match login {
            CodexHandedLogin::Tokens(tokens) => {
                let sign_in = CarriedSignIn::Tokens {
                    access_token: tokens.access_token.clone(),
                    dead_token: None,
                };
                land_hand_back(&self.carried, &service, window, sign_in, bindings);
                CodexHandBack::Tokens(tokens)
            }
            CodexHandedLogin::ApiKey(api_key) => {
                // The switching service's own account, owned by the task that waits for the hand.
                let switching = Arc::clone(&service.dependencies().switching);
                service
                    .dependencies()
                    .tasks
                    .spawn(switching.hand_back_key(window, api_key, bindings));
                CodexHandBack::KeyToFollow
            }
        }
    }

    // Hands `window`'s previous account its `api_key` once this task holds the hand and no turn
    // runs, as a held switch lands, where the service still carries the account the window moved
    // onto, so a switch that landed meanwhile is never undone and the window dropped settles each
    // watch as unobserved. The refused turn ends on the refresh's refusal, so the wait is for the
    // others. A login that cannot be sent or is refused fails every watch with its error and moves
    // no session.
    async fn hand_back_key(
        self: Arc<Self>,
        window: HandBackWindow,
        api_key: SecretString,
        bindings: Arc<dyn RuntimeBindingWriter>,
    ) {
        let Some(service) = window.service.upgrade() else {
            return;
        };
        let hand = self.take_hand_between_turns(&service).await;
        let sent = if self.carried_account().as_ref() == Some(&window.to) {
            let unlanded = Arc::new(Mutex::new(Some(window)));
            let sent = self
                .send_key_back(&service, &unlanded, api_key, bindings)
                .await;
            Some((sent, unlanded))
        } else {
            None
        };
        self.let_turns_start();
        drop(hand);
        let Some((Err(error), unlanded)) = sent else {
            return;
        };
        tracing::warn!(
            error = &error as &(dyn Error + 'static),
            "the previous Codex account's API key could not be handed back"
        );
        let failed = lock(&unlanded).take();
        if let Some(window) = failed {
            window.fail(DriverError::from(error));
        }
    }

    // The key's login on `service`, sent as a switch sends one, its answer landing the window in
    // `unlanded` on the key: taken from there by the hook, so a failed login leaves it for its
    // watches to fail. Fails while the service has no connection, and as the read, the sign-out
    // or the login does.
    async fn send_key_back(
        &self,
        service: &Arc<CodexService>,
        unlanded: &Arc<Mutex<Option<HandBackWindow>>>,
        api_key: SecretString,
        bindings: Arc<dyn RuntimeBindingWriter>,
    ) -> Result<(), CodexError> {
        let connection = service.connection()?;
        let PreparedLogin {
            params,
            sign_in,
            is_signed_out,
        } = self
            .prepare_login(&connection, CodexHandedLogin::ApiKey(api_key))
            .await?;
        let carried = Arc::clone(&self.carried);
        let landing = Arc::clone(unlanded);
        let acknowledged = Arc::downgrade(service);
        let answer = connection
            .request_ordered(
                CODEX_LOGIN_START_METHOD,
                &params,
                Box::new(move |answer: Option<&RawValue>| {
                    let Some(service) = answer.and(acknowledged.upgrade()) else {
                        return;
                    };
                    let landed = lock(&landing).take();
                    if let Some(window) = landed {
                        land_hand_back(&carried, &service, window, sign_in, bindings);
                    }
                }),
            )
            .await;
        self.settle_handed_login(answer, is_signed_out).map(drop)
    }
}

// Carries `window`'s previous account again on `sign_in` and moves its sessions back onto it,
// each watch settling on a task of `service`'s once its move landed.
fn land_hand_back(
    carried: &Mutex<Option<CarriedAccount>>,
    service: &CodexService,
    window: HandBackWindow,
    sign_in: CarriedSignIn,
    bindings: Arc<dyn RuntimeBindingWriter>,
) {
    let HandBackWindow {
        previous, sessions, ..
    } = window;
    service.restart_rate_limits(|| {
        carry(
            carried,
            &service.dependencies().switching.switches,
            previous.clone(),
            sign_in,
        );
    });
    let landings = move_back(service, &previous, sessions);
    service
        .dependencies()
        .tasks
        .spawn(settle_hand_back(landings, previous, bindings));
}

// Queues each of `sessions` its move back onto `previous`, waited on and reported by no one, and
// every other session attached to `service`, one that attached after the switch, its reported
// move there; answers each of `sessions` with where its move lands.
fn move_back(
    service: &CodexService,
    previous: &ProviderAccountId,
    sessions: Vec<WatchedSession>,
) -> WatchedSessionMoves {
    let mut attached_since = attached_by_session(service);
    let landings = sessions
        .into_iter()
        .map(|session| {
            attached_since.remove(&session.session_id);
            let (moved, landed) = oneshot::channel();
            // A queue that takes nothing drops the wait, and the settling moves the binding.
            let _taken = service.push_session_item(
                &session.session_id,
                CodexSessionInbound::AccountMoved(CodexAccountMove {
                    provider_account_id: previous.clone(),
                    binding_id: session.binding_id.clone(),
                    moved: Some(moved),
                    actor: None,
                    first_request: None,
                }),
            );
            (session, landed)
        })
        .collect();
    for session in attached_since.into_values() {
        queue_reported_move(&session, previous, None, None);
    }
    landings
}

// Settles each handed-back session's watch once its move back landed: a lead's binding whose
// queue took no move is moved at once, as a switch moves it; a session the switch did not name
// whose queue took none ended first, its own binding left on the account it moved to.
async fn settle_hand_back(
    landings: WatchedSessionMoves,
    previous: ProviderAccountId,
    bindings: Arc<dyn RuntimeBindingWriter>,
) {
    join_all(landings.into_iter().map(|(session, landed)| {
        let previous = previous.clone();
        let bindings = Arc::clone(&bindings);
        async move {
            let moved = match session.binding_id {
                Some(binding_id) => wait_for_move(landed, &*bindings, binding_id, previous).await,
                None => landed.await.unwrap_or_else(|_untaken| {
                    Err(DriverError::Internal(
                        "the session ended before its previous account was handed back".into(),
                    ))
                }),
            };
            let _unheard = session
                .watch
                .send(moved.map(|()| FirstRequestAfterMove::HandedBack));
        }
    }))
    .await;
}

#[cfg(test)]
mod tests;
