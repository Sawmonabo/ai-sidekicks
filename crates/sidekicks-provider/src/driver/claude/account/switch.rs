//! The Claude Code switch leg: each running session moves onto another account by starting its
//! process again between turns on that account, which resumes its conversation by id, whether the
//! account signs in through its store or a pasted token; Claude Code reads a store pointed at in
//! place only once its store-read cache lapses, so no move is made in place. A login refusal on the
//! first request after the move hands the previous account back the same way.

use std::sync::{Arc, Weak};

use futures::FutureExt;
use futures::future::join_all;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::PathRules;
use sidekicks_store::database::connection::read_pool::ReadLength;
use tokio::sync::oneshot;

use super::ClaudeAccountLegs;
use crate::driver::claude::delivery::stream::ClaudeFirstRequest;
use crate::driver::claude::session::conversation_home::{
    ClaudeConversationHomeKeep, claude_conversation_home_metadata, read_claude_conversation_home,
};
use crate::driver::claude::session::establishment::ClaudeSessionEstablishment;
use crate::driver::claude::session::restart::ClaudeSessionStanding;
use crate::driver::claude::session::restart::account_move::{
    ClaudeAccountLanding, ClaudeAccountMoveAsker, ClaudeLegBinding,
};
use crate::driver::claude::session::state::LiveClaudeSession;
use crate::driver::claude::spawn::environment::claude_config_folder;
use crate::driver::contract::account::{
    FirstRequestAfterMove, SessionAccountMove, SessionToMove, SwitchMovesAccepted,
};
use crate::driver::contract::error::DriverError;
use crate::driver::error_causes::session_process_unavailable;
use crate::runtime_binding::store::{RuntimeBindingStoreError, read_binding};
use crate::runtime_binding::writer::RuntimeBindingWriter;

/// Moves each of `sessions` from `from` onto `to` through `legs`, every move at once, telling
/// `accepted` once each has landed or waits, as
/// [`crate::driver::contract::account::ProviderSwitchLegs::move_sessions`] says.
pub(super) async fn move_claude_sessions(
    legs: &ClaudeAccountLegs,
    from: ProviderAccountId,
    to: ProviderAccountId,
    sessions: Vec<SessionToMove>,
    accepted: SwitchMovesAccepted,
) -> Vec<Result<SessionAccountMove, (SessionId, DriverError)>> {
    let asked = join_all(sessions.into_iter().map(|session| {
        let session_id = session.session_id;
        let (from, to) = (from.clone(), to.clone());
        async move {
            ask_claude_move(legs, from, to, session)
                .await
                .map_err(|error| (session_id, error))
        }
    }))
    .await;
    // The daemon may stop waiting for the answer.
    accepted.send(()).unwrap_or(());
    join_all(asked.into_iter().map(|asked| async move {
        match asked {
            Ok(ClaudeMoveAsked::Landed(moved)) => Ok(moved),
            Ok(ClaudeMoveAsked::Waiting(waiting)) => {
                let session_id = waiting.session.session_id;
                waiting.land().await.map_err(|error| (session_id, error))
            }
            Err(failed) => Err(failed),
        }
    }))
    .await
}

// A session's move once asked: landed already, or waiting in the restarts for its relaunch.
enum ClaudeMoveAsked {
    Landed(SessionAccountMove),
    Waiting(ClaudeMoveWaiting),
}

// A move waiting for its relaunch: where its landing is told, and what a login refusal on its
// first request hands back.
struct ClaudeMoveWaiting {
    establishment: Arc<ClaudeSessionEstablishment>,
    bindings: Arc<dyn RuntimeBindingWriter>,
    session: SessionToMove,
    from: ProviderAccountId,
    landing: oneshot::Receiver<Result<ClaudeAccountLanding, DriverError>>,
}

// What a moved session hands back on a login refusal: the binding its lead runs on after the
// move and the account it left.
struct ClaudeHandBack {
    establishment: Arc<ClaudeSessionEstablishment>,
    bindings: Arc<dyn RuntimeBindingWriter>,
    session_id: SessionId,
    binding_id: RuntimeBindingId,
    previous: ProviderAccountId,
}

// Asks one session's move: a session with no live process moves at once, a live one's relaunch
// is asked of the restarts.
async fn ask_claude_move(
    legs: &ClaudeAccountLegs,
    from: ProviderAccountId,
    to: ProviderAccountId,
    session: SessionToMove,
) -> Result<ClaudeMoveAsked, DriverError> {
    let establishment = legs
        .sessions
        .get()
        .and_then(Weak::upgrade)
        .ok_or_else(|| DriverError::Internal("the Claude Code driver has stopped".into()))?;
    let restarts = &establishment.task_services.restarts;
    let live = loop {
        match restarts.standing(session.session_id) {
            ClaudeSessionStanding::Live(live) => break live,
            // Its restart composes its start from the moved account, as does its next open. The
            // binding names the home and moves first, so a failure leaves the restart on `from`
            // with it.
            ClaudeSessionStanding::Held { ended, .. } => {
                keep_process_home(legs, &session, &ended).await?;
                let is_moved = move_held_binding(&*legs.bindings, &session, &from, &to, || {
                    restarts.move_held_account(&ended, to.clone())
                })
                .await?;
                if is_moved {
                    return Ok(ClaudeMoveAsked::Landed(SessionAccountMove::unobserved(
                        session.session_id,
                        to,
                    )));
                }
            }
            ClaudeSessionStanding::Settling(settled) => {
                settled.wait().await;
            }
            ClaudeSessionStanding::Down => {
                keep_stored_home(legs, &session).await?;
                move_binding(&*legs.bindings, &session, &to).await?;
                return Ok(ClaudeMoveAsked::Landed(SessionAccountMove::unobserved(
                    session.session_id,
                    to,
                )));
            }
        }
    };
    keep_process_home(legs, &session, &live).await?;
    // The lead's binding moves just before the new process starts, after every frame of the turn
    // the relaunch waited for, so each reading of that turn stays on the account it ran on.
    let leg = ClaudeLegBinding {
        bindings: Arc::clone(&legs.bindings),
        binding_id: session.binding_id.clone(),
    };
    let landing =
        restarts.ask_account_move(session.session_id, to, leg, ClaudeAccountMoveAsker::Person);
    Ok(ClaudeMoveAsked::Waiting(ClaudeMoveWaiting {
        bindings: Arc::clone(&legs.bindings),
        establishment,
        session,
        from,
        landing,
    }))
}

impl ClaudeMoveWaiting {
    // Answers once the relaunch landed, with how the session's first request goes after; a move a
    // newer one replaced answers where the session landed, its first request that move's.
    async fn land(self) -> Result<SessionAccountMove, DriverError> {
        let session_id = self.session.session_id;
        let landing = self
            .landing
            .await
            .unwrap_or_else(|_dropped| Err(session_process_unavailable(session_id).into()))?;
        if landing.is_replaced {
            return Ok(SessionAccountMove::replaced(
                session_id,
                landing.provider_account_id,
            ));
        }
        let (watch, heard) = oneshot::channel();
        if let Some(stream) = self.establishment.streams.get(session_id) {
            stream.watch_first_request(watch);
        }
        let hand_back = ClaudeHandBack {
            establishment: self.establishment,
            bindings: self.bindings,
            session_id,
            binding_id: landing.binding_id,
            previous: self.from,
        };
        // Its own task, so the hand-back is made whether or not anyone waits on the answer.
        let watching = tokio::spawn(async move {
            match heard.await {
                Ok(ClaudeFirstRequest::Answered) => Ok(FirstRequestAfterMove::Ran),
                Ok(ClaudeFirstRequest::LoginRefused) => {
                    hand_back.hand_back().await?;
                    Ok(FirstRequestAfterMove::HandedBack)
                }
                // The process ended, or a later move took the watch, before a request was answered.
                Err(_unheard) => Ok(FirstRequestAfterMove::Unobserved),
            }
        });
        Ok(SessionAccountMove::landed(
            session_id,
            landing.provider_account_id,
            async move {
                watching
                    .await
                    .unwrap_or_else(|error| Err(DriverError::Internal(Box::new(error))))
            }
            .boxed(),
        ))
    }
}

impl ClaudeHandBack {
    // Moves the session back onto the account it left the way it moved: its process started
    // again on that account between turns, unless a person's switch waits, which stands.
    async fn hand_back(self) -> Result<(), DriverError> {
        let session_id = self.session_id;
        let restarts = &self.establishment.task_services.restarts;
        let live = restarts
            .slots()
            .live_session(session_id)
            .ok_or_else(|| DriverError::from(session_process_unavailable(session_id)))?;
        let leg = ClaudeLegBinding {
            bindings: self.bindings,
            binding_id: self.binding_id,
        };
        restarts
            .relaunch_on_account(&live, self.previous, leg, ClaudeAccountMoveAsker::Driver)
            .await
            .map(drop)
    }
}

// Records in the lead's binding the home `process` wrote the session's conversation into, every
// other member of its recovery data kept, before the binding moves off the account whose home it
// may be, so every later resume finds it there. Fails as the binding cannot be read or written.
async fn keep_process_home(
    legs: &ClaudeAccountLegs,
    session: &SessionToMove,
    process: &LiveClaudeSession,
) -> Result<(), DriverError> {
    let home = claude_config_folder(
        &process.spawn_bound_legs.spawn_environment,
        PathRules::NATIVE,
    )
    .ok_or_else(|| DriverError::Internal("the session's process names no home".into()))?;
    let keep = ClaudeConversationHomeKeep {
        pool: Arc::clone(&legs.pool),
        home,
    };
    keep.keep_in(&*legs.bindings, session.binding_id.clone())
        .await
        .map_err(DriverError::Internal)
}

// Records in the lead's stored binding, for a session with no process, the home of the account it
// names where its recovery data names no home yet: the home its conversation was written into.
// Fails closed where the binding has no row or that account's home is gone.
async fn keep_stored_home(
    legs: &ClaudeAccountLegs,
    session: &SessionToMove,
) -> Result<(), DriverError> {
    let binding_id = session.binding_id.clone();
    let binding = legs
        .pool
        .read(ReadLength::Short, move |reader| {
            read_binding(reader, &binding_id).map_err(RuntimeBindingStoreError::from)
        })
        .await
        .map_err(|error| DriverError::Internal(Box::new(error)))?
        .ok_or_else(|| DriverError::Internal("the session's lead binding has no row".into()))?;
    if read_claude_conversation_home(&binding.runtime_metadata).is_some() {
        return Ok(());
    }
    let folders = legs
        .ports
        .provider_accounts
        .require_port()
        .map_err(|error| DriverError::Internal(Box::new(error)))?
        .resolve_account_folders(binding.spawn_config.provider_account_id)
        .await?;
    let mut runtime_metadata = binding.runtime_metadata;
    runtime_metadata.extend(claude_conversation_home_metadata(
        &folders.configuration_folder,
    ));
    legs.bindings
        .keep_recovery_data(session.binding_id.clone(), runtime_metadata)
        .await
        .map_err(DriverError::Internal)
}

// The binding the session's lead runs on, moved onto `provider_account_id`'s account at once, for
// a session with no process whose frames it could move among.
async fn move_binding(
    bindings: &dyn RuntimeBindingWriter,
    session: &SessionToMove,
    provider_account_id: &ProviderAccountId,
) -> Result<(), DriverError> {
    bindings
        .move_account(session.binding_id.clone(), provider_account_id.clone())
        .await
        .map_err(DriverError::Internal)
}

// Moves the held session's lead binding onto `to`, then its held restart through
// `move_held_account`; where that restart began meanwhile, the binding goes back to `from`, the
// account the restart still runs on, so spend metered before the move is charged where it ran and
// the live process's relaunch moves the binding once its turn settles. Answers whether the held
// restart moved. Fails as the binding cannot move.
async fn move_held_binding(
    bindings: &dyn RuntimeBindingWriter,
    session: &SessionToMove,
    from: &ProviderAccountId,
    to: &ProviderAccountId,
    move_held_account: impl FnOnce() -> bool,
) -> Result<bool, DriverError> {
    move_binding(bindings, session, to).await?;
    if move_held_account() {
        return Ok(true);
    }
    move_binding(bindings, session, from).await?;
    Ok(false)
}

#[cfg(test)]
mod tests {
    use sidekicks_contracts::provider::account::record::ProviderAccountId;

    use super::move_held_binding;
    use crate::driver::claude::session::scripted::binding_id;
    use crate::driver::claude::session::scripted::daemon_services::TakenBindingWrites;
    use crate::driver::contract::account::SessionToMove;
    use crate::driver::test_registry::new_session_id;

    // A held restart that began meanwhile still runs on the account left, so the lead's binding
    // goes back there: spend metered before the live process starts again on the new account
    // stays on the account that served it. Killed by the binding left on the new account when the
    // held restart did not move.
    #[tokio::test]
    async fn a_held_restart_that_began_meanwhile_takes_the_binding_back() {
        let bindings = TakenBindingWrites::default();
        let session = SessionToMove {
            session_id: new_session_id(),
            binding_id: binding_id("resting"),
        };
        let from = ProviderAccountId::new("account-from".to_owned()).expect("an account id");
        let to = ProviderAccountId::new("account-to".to_owned()).expect("an account id");

        let is_moved = move_held_binding(&bindings, &session, &from, &to, || false)
            .await
            .expect("the binding moves");

        assert!(!is_moved);
        assert_eq!(
            bindings.moves(),
            [(binding_id("resting"), to), (binding_id("resting"), from)]
        );
    }
}
