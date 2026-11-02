//! The Claude Code switch leg: each running session moves onto another account. Between two
//! accounts signed in through their stores the process is pointed at the new store in place, and
//! the move lands where Claude Code acknowledges it among the session's frames; where either
//! account runs on a pasted token, the process starts again between turns on the new account,
//! which hands it that account's token on its pipe, and resumes its conversation by id. A login
//! refusal on the first request after the move hands the previous account back the same way.

use std::collections::BTreeMap;
use std::sync::{Arc, Weak};

use futures::FutureExt;
use futures::future::join_all;
use sidekicks_contracts::provider::account::record::{ProviderAccountId, ProviderAuthMode};
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::PathRules;
use sidekicks_store::database::connection::read_pool::ReadLength;
use tokio::sync::oneshot;

use super::ClaudeAccountLegs;
use crate::driver::claude::account::credentials::SECURE_STORAGE_FOLDER_VARIABLE;
use crate::driver::claude::delivery::stream::ClaudeFirstRequest;
use crate::driver::claude::session::control_requests::ClaudeAccountMoveMarker;
use crate::driver::claude::session::conversation_home::{
    ClaudeConversationHomeKeep, claude_conversation_home_metadata, read_claude_conversation_home,
};
use crate::driver::claude::session::establishment::ClaudeSessionEstablishment;
use crate::driver::claude::session::restart::{ClaudeLegBinding, ClaudeSessionStanding};
use crate::driver::claude::session::state::LiveClaudeSession;
use crate::driver::claude::session::transport::control::{
    ClaudeControlRequest, ClaudeFlagSettings,
};
use crate::driver::claude::spawn::environment::{ClaudeAccountFolders, claude_config_folder};
use crate::driver::contract::account::{FirstRequestAfterMove, SessionAccountMove, SessionToMove};
use crate::driver::contract::error::DriverError;
use crate::driver::error_causes::session_process_unavailable;
use crate::runtime_binding::store::{RuntimeBindingStoreError, read_binding};
use crate::runtime_binding::writer::RuntimeBindingWriter;

/// Moves each of `sessions` from `from` onto `to` through `legs`, every move at once, as
/// [`crate::driver::contract::account::ProviderSwitchLegs::move_sessions`] says.
pub(super) async fn move_claude_sessions(
    legs: &ClaudeAccountLegs,
    from: ProviderAccountId,
    to: ProviderAccountId,
    sessions: Vec<SessionToMove>,
) -> Vec<Result<SessionAccountMove, (SessionId, DriverError)>> {
    join_all(sessions.into_iter().map(|session| {
        let session_id = session.session_id;
        let (from, to) = (from.clone(), to.clone());
        async move {
            move_claude_session(legs, from, to, session)
                .await
                .map_err(|error| (session_id, error))
        }
    }))
    .await
}

// How one account signs in to a running process: through its store, which a process is pointed
// at in place, or by a pasted token, which reaches a process only at its start.
enum ClaudeAccountSignIn {
    // The folder of the account's store, in the form the process's environment carries.
    Store(String),
    Token,
}

// What a moved session hands back on a login refusal: the binding its lead runs on after the
// move, the account it left and how that account reaches its process.
struct ClaudeHandBack {
    establishment: Arc<ClaudeSessionEstablishment>,
    bindings: Arc<dyn RuntimeBindingWriter>,
    session_id: SessionId,
    binding_id: RuntimeBindingId,
    previous: ProviderAccountId,
    previous_sign_in: ClaudeAccountSignIn,
}

// Moves one session, answering once the move landed with how its first request goes after.
async fn move_claude_session(
    legs: &ClaudeAccountLegs,
    from: ProviderAccountId,
    to: ProviderAccountId,
    session: SessionToMove,
) -> Result<SessionAccountMove, DriverError> {
    let establishment = legs
        .sessions
        .get()
        .and_then(Weak::upgrade)
        .ok_or_else(|| DriverError::Internal("the Claude Code driver has stopped".into()))?;
    let previous_sign_in = read_sign_in(legs, &from).await?;
    let target_sign_in = read_sign_in(legs, &to).await?;
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
                    return Ok(SessionAccountMove::unobserved(session.session_id));
                }
            }
            ClaudeSessionStanding::Settling(settled) => {
                settled.wait().await;
            }
            ClaudeSessionStanding::Down => {
                keep_stored_home(legs, &session).await?;
                move_binding(&*legs.bindings, &session, &to).await?;
                return Ok(SessionAccountMove::unobserved(session.session_id));
            }
        }
    };
    let home = keep_process_home(legs, &session, &live).await?;
    let (watch, heard) = oneshot::channel();
    // The lead's binding moves with the session, never apart from its frames: at the marker an
    // in-place move queues among them, or before a relaunch starts the new process on its copy.
    let binding_id = match (&previous_sign_in, &target_sign_in) {
        (ClaudeAccountSignIn::Store(_), ClaudeAccountSignIn::Store(store)) => {
            let account_move = ClaudeStoreMove {
                store,
                provider_account_id: &to,
                lead_binding_id: &session.binding_id,
                conversation_home: Some(home),
            };
            point_at_store(
                &establishment,
                &live,
                &legs.bindings,
                account_move,
                Some(watch),
            )
            .await?;
            session.binding_id
        }
        (ClaudeAccountSignIn::Token, _) | (_, ClaudeAccountSignIn::Token) => {
            let leg = ClaudeLegBinding {
                bindings: Arc::clone(&legs.bindings),
                binding_id: session.binding_id,
            };
            let relaunched = restarts.relaunch_on_account(&live, to.clone(), leg).await?;
            if let Some(stream) = establishment.streams.get(session.session_id) {
                stream.watch_first_request(watch);
            }
            relaunched
        }
    };
    let hand_back = ClaudeHandBack {
        establishment: Arc::clone(&establishment),
        bindings: Arc::clone(&legs.bindings),
        session_id: session.session_id,
        binding_id,
        previous: from,
        previous_sign_in,
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
    Ok(SessionAccountMove {
        session_id: session.session_id,
        first_request: async move {
            watching
                .await
                .unwrap_or_else(|error| Err(DriverError::Internal(Box::new(error))))
        }
        .boxed(),
    })
}

impl ClaudeHandBack {
    // Moves the session back onto the account it left, the way it moved: its store sent again,
    // or its process started again on that account between turns.
    async fn hand_back(self) -> Result<(), DriverError> {
        let session_id = self.session_id;
        let restarts = &self.establishment.task_services.restarts;
        let live = restarts
            .slots()
            .live_session(session_id)
            .ok_or_else(|| DriverError::from(session_process_unavailable(session_id)))?;
        match &self.previous_sign_in {
            ClaudeAccountSignIn::Store(store) => {
                // The account handed back holds the conversation in its own home.
                let account_move = ClaudeStoreMove {
                    store,
                    provider_account_id: &self.previous,
                    lead_binding_id: &self.binding_id,
                    conversation_home: None,
                };
                point_at_store(
                    &self.establishment,
                    &live,
                    &self.bindings,
                    account_move,
                    None,
                )
                .await
            }
            ClaudeAccountSignIn::Token => {
                let leg = ClaudeLegBinding {
                    bindings: Arc::clone(&self.bindings),
                    binding_id: self.binding_id.clone(),
                };
                restarts
                    .relaunch_on_account(&live, self.previous.clone(), leg)
                    .await
                    .map(drop)
            }
        }
    }
}

// An in-place move: the store the process is pointed at, the account it signs in to, the binding
// the session's lead runs on, which moves with it, and the home every binding moved keeps first
// where the account moved onto does not hold the conversation.
struct ClaudeStoreMove<'a> {
    store: &'a str,
    provider_account_id: &'a ProviderAccountId,
    lead_binding_id: &'a RuntimeBindingId,
    conversation_home: Option<ClaudeConversationHomeKeep>,
}

// Points `live`'s process at `account_move`'s store in place, through its stream's queue: the
// session's account, which its stream shares, its lead's binding and its bound runs' move onto
// the move's account where Claude Code acknowledged it among the frames, each binding naming the
// move's home first where it carries one, so a run bound since the lead's home was kept never
// rests on the new account without it, and a process started
// from the session's legs signs in to the store from the answer on; `first_request` hears how the
// next request goes. Fails as the request does, nothing moved.
async fn point_at_store(
    establishment: &ClaudeSessionEstablishment,
    live: &LiveClaudeSession,
    bindings: &Arc<dyn RuntimeBindingWriter>,
    account_move: ClaudeStoreMove<'_>,
    first_request: Option<oneshot::Sender<ClaudeFirstRequest>>,
) -> Result<(), DriverError> {
    let request = ClaudeControlRequest::ApplyFlagSettings {
        settings: ClaudeFlagSettings {
            env: Some(BTreeMap::from([(
                SECURE_STORAGE_FOLDER_VARIABLE.to_owned(),
                account_move.store.to_owned(),
            )])),
            ..ClaudeFlagSettings::default()
        },
    };
    let stream = establishment
        .streams
        .get(live.session_id)
        .ok_or_else(|| DriverError::from(session_process_unavailable(live.session_id)))?;
    let store = account_move.store.to_owned();
    let account_move = ClaudeAccountMoveMarker {
        arrivals: stream.arrivals().clone(),
        provider_account_id: account_move.provider_account_id.clone(),
        lead_binding_id: account_move.lead_binding_id.clone(),
        bindings: Arc::clone(bindings),
        conversation_home: account_move.conversation_home,
        first_request,
    };
    live.channel
        .send_account_move(request, account_move)
        .await
        .map_err(DriverError::from)?;
    live.account.point_at_store(store);
    Ok(())
}

// How `provider_account_id`'s account reaches a running process: by its store, or by the token
// pasted for it. Fails as the account cannot be read.
async fn read_sign_in(
    legs: &ClaudeAccountLegs,
    provider_account_id: &ProviderAccountId,
) -> Result<ClaudeAccountSignIn, DriverError> {
    let accounts = legs
        .ports
        .provider_accounts
        .require_port()
        .map_err(|error| DriverError::Internal(Box::new(error)))?;
    let mode = accounts
        .read_observed_auth_mode(provider_account_id.clone())
        .await
        .map_err(DriverError::Internal)?;
    if mode == Some(ProviderAuthMode::OauthToken) {
        return Ok(ClaudeAccountSignIn::Token);
    }
    let folders = accounts
        .resolve_account_folders(provider_account_id.clone())
        .await?;
    Ok(ClaudeAccountSignIn::Store(
        ClaudeAccountFolders::from(&folders).credential_store_folder,
    ))
}

// Records in the lead's binding the home `process` wrote the session's conversation into, every
// other member of its recovery data kept, before the binding moves off the account whose home it
// may be, so every later resume finds it there; answers that home, which the session's other
// bindings keep as they move. Fails as the binding cannot be read or written.
async fn keep_process_home(
    legs: &ClaudeAccountLegs,
    session: &SessionToMove,
    process: &LiveClaudeSession,
) -> Result<ClaudeConversationHomeKeep, DriverError> {
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
        .map_err(DriverError::Internal)?;
    Ok(keep)
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
// the live process's move takes the binding over among its frames. Answers whether the held
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
    // goes back there: spend metered before the live process's in-place move stays on the account
    // that served it. Killed by the binding left on the new account when the held restart did not
    // move.
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
