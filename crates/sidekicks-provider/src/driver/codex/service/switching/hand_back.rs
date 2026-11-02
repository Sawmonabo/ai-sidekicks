//! The hand-back window of a switch on the switching service. From the switch's acknowledgment
//! until one `account/read` there is answered, every session the switch moved keeps the watch of
//! its first request on the new account. Codex runs its workspace check on that read with the new
//! login, and where the login is refused it asks for fresh tokens: a renewal that leaves the
//! refused token in place hands the previous account back, its tokens the refresh's answer and
//! every moved session moving back with it, reported by no one. Otherwise the read's end closes
//! the window: an account named settles every watch as run, anything else as unobserved, so a
//! network failure never hands back. A new hand closes an open window as unobserved.

use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use futures::future::join_all;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::oneshot;

use crate::driver::codex::account::auth_file::CodexAuthTokens;
use crate::driver::codex::account::switch::{share_failure, wait_for_move};
use crate::driver::codex::auth_status::read_codex_auth_status;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::service::switching::{
    CarriedSignIn, CodexSwitchingAccount, attached_by_session, carry, queue_reported_move,
};
use crate::driver::codex::session::inbound::{CodexAccountMove, CodexSessionInbound};
use crate::driver::codex::transport::connection::CodexAppServerConnection;
use crate::driver::contract::account::FirstRequestAfterMove;
use crate::driver::contract::error::DriverError;
use crate::driver::session_control::DriverAuthProbeStatus;
use crate::runtime_binding::writer::RuntimeBindingWriter;

/// How long the window's check waits for its `account/read`, inside which Codex asks for fresh
/// tokens and retries with them.
const CODEX_HAND_BACK_CHECK_WAIT: Duration = Duration::from_secs(20);

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
            let _unheard = session.watch.send(Err(share_failure(&error)));
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
    /// not renew is `refused`'s, the account a switch whose window is open moved onto: the
    /// previous account is carried again, every session the switch moved moves back waited on and
    /// reported by no one, every session attached since moves back reported, and each watch
    /// settles once its move landed. Answers the previous account's tokens, the refresh's answer;
    /// `None` where no window is open onto `refused`, or where the previous account's home holds
    /// no sign-in to hand, every watch then failing with that error.
    pub(crate) async fn hand_back(&self, refused: &ProviderAccountId) -> Option<CodexAuthTokens> {
        let previous = self.windows.previous_of(refused)?;
        let bindings = self.renewer.get()?.bindings()?;
        let tokens = self.read_tokens(&previous).await;
        // The window's check may have ended during the read; then there is nothing to hand back.
        let window = self.windows.take_onto(refused)?;
        let tokens = match tokens {
            Ok(tokens) => tokens,
            Err(error) => {
                window.fail(DriverError::from(error));
                return None;
            }
        };
        // A service gone left no session to move; the window dropped settles each as unobserved.
        let service = window.service.upgrade()?;
        let sign_in = CarriedSignIn::Tokens {
            access_token: tokens.access_token.clone(),
            dead_token: None,
        };
        service.restart_rate_limits(|| {
            carry(&self.carried, previous.clone(), sign_in);
        });
        let landings = move_back(&service, &previous, window.sessions);
        service
            .dependencies()
            .tasks
            .spawn(settle_hand_back(landings, previous, bindings));
        Some(tokens)
    }
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
