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
use sidekicks_contracts::session::id::SessionId;
use tokio::sync::oneshot;

use super::ClaudeAccountLegs;
use crate::driver::claude::account_credentials::SECURE_STORAGE_FOLDER_VARIABLE;
use crate::driver::claude::delivery::stream::ClaudeFirstRequest;
use crate::driver::claude::session::control_requests::ClaudeAccountMoveMarker;
use crate::driver::claude::session::establishment::ClaudeSessionEstablishment;
use crate::driver::claude::session::restart::ClaudeSessionStanding;
use crate::driver::claude::session::state::LiveClaudeSession;
use crate::driver::claude::session::transport::control::{
    ClaudeControlRequest, ClaudeFlagSettings,
};
use crate::driver::claude::spawn::environment::ClaudeAccountFolders;
use crate::driver::contract::account::{FirstRequestAfterMove, SessionAccountMove, SessionToMove};
use crate::driver::contract::error::DriverError;
use crate::driver::error_causes::session_process_unavailable;
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
            let first_request = move_claude_session(legs, from, to, session)
                .await
                .map_err(|error| (session_id, error))?;
            Ok(SessionAccountMove {
                session_id,
                first_request,
            })
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

// What a moved session hands back on a login refusal: the account it left and how that account
// reaches its process.
struct ClaudeHandBack {
    establishment: Arc<ClaudeSessionEstablishment>,
    bindings: Arc<dyn RuntimeBindingWriter>,
    session: SessionToMove,
    previous: ProviderAccountId,
    previous_sign_in: ClaudeAccountSignIn,
}

// Moves one session, answering once the move landed with how its first request goes after.
async fn move_claude_session(
    legs: &ClaudeAccountLegs,
    from: ProviderAccountId,
    to: ProviderAccountId,
    session: SessionToMove,
) -> Result<
    futures::future::BoxFuture<'static, Result<FirstRequestAfterMove, DriverError>>,
    DriverError,
> {
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
            // Its restart composes its start from the moved account, as does its next open.
            ClaudeSessionStanding::Held { ended, .. } => {
                if restarts.move_held_account(&ended, to.clone()) {
                    move_binding(&*legs.bindings, &session, &to).await?;
                    return Ok(unobserved());
                }
            }
            ClaudeSessionStanding::Settling(settled) => {
                settled.wait().await;
            }
            ClaudeSessionStanding::Down => {
                move_binding(&*legs.bindings, &session, &to).await?;
                return Ok(unobserved());
            }
        }
    };
    let (watch, heard) = oneshot::channel();
    match (&previous_sign_in, &target_sign_in) {
        (ClaudeAccountSignIn::Store(_), ClaudeAccountSignIn::Store(store)) => {
            point_at_store(
                &establishment,
                &live,
                &legs.bindings,
                store,
                &to,
                Some(watch),
            )
            .await?;
        }
        (ClaudeAccountSignIn::Token, _) | (_, ClaudeAccountSignIn::Token) => {
            restarts.relaunch_on_account(&live, to.clone()).await?;
            if let Some(stream) = establishment.streams.get(session.session_id) {
                stream.watch_first_request(watch);
            }
        }
    }
    move_binding(&*legs.bindings, &session, &to).await?;
    let hand_back = ClaudeHandBack {
        establishment: Arc::clone(&establishment),
        bindings: Arc::clone(&legs.bindings),
        session,
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
    Ok(async move {
        watching
            .await
            .unwrap_or_else(|error| Err(DriverError::Internal(Box::new(error))))
    }
    .boxed())
}

impl ClaudeHandBack {
    // Moves the session back onto the account it left, the way it moved: its store sent again,
    // or its process started again on that account between turns.
    async fn hand_back(self) -> Result<(), DriverError> {
        let session_id = self.session.session_id;
        let restarts = &self.establishment.task_services.restarts;
        let live = restarts
            .slots()
            .live_session(session_id)
            .ok_or_else(|| DriverError::from(session_process_unavailable(session_id)))?;
        match &self.previous_sign_in {
            ClaudeAccountSignIn::Store(store) => {
                point_at_store(
                    &self.establishment,
                    &live,
                    &self.bindings,
                    store,
                    &self.previous,
                    None,
                )
                .await?;
            }
            ClaudeAccountSignIn::Token => {
                restarts
                    .relaunch_on_account(&live, self.previous.clone())
                    .await?;
            }
        }
        move_binding(&*self.bindings, &self.session, &self.previous).await
    }
}

// Points `live`'s process at `store` in place, through its stream's queue, its bindings moving onto `provider_account_id`'s
// account where Claude Code acknowledged it among the frames, and the session's account with them
// once the answer is read; `first_request` hears how the next request goes. Fails as the request
// does, nothing moved.
async fn point_at_store(
    establishment: &ClaudeSessionEstablishment,
    live: &LiveClaudeSession,
    bindings: &Arc<dyn RuntimeBindingWriter>,
    store: &str,
    provider_account_id: &ProviderAccountId,
    first_request: Option<oneshot::Sender<ClaudeFirstRequest>>,
) -> Result<(), DriverError> {
    let request = ClaudeControlRequest::ApplyFlagSettings {
        settings: ClaudeFlagSettings {
            env: Some(BTreeMap::from([(
                SECURE_STORAGE_FOLDER_VARIABLE.to_owned(),
                store.to_owned(),
            )])),
            ..ClaudeFlagSettings::default()
        },
    };
    let stream = establishment
        .streams
        .get(live.session_id)
        .ok_or_else(|| DriverError::from(session_process_unavailable(live.session_id)))?;
    let account_move = ClaudeAccountMoveMarker {
        arrivals: stream.arrivals().clone(),
        provider_account_id: provider_account_id.clone(),
        bindings: Arc::clone(bindings),
        first_request,
    };
    live.channel
        .send_account_move(request, account_move)
        .await
        .map_err(DriverError::from)?;
    live.move_admitted_account(provider_account_id.clone());
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

// The binding the session's lead runs on, moved onto `provider_account_id`'s account, which a
// session with no bound run between turns has no frame to move it at.
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

fn unobserved() -> futures::future::BoxFuture<'static, Result<FirstRequestAfterMove, DriverError>> {
    futures::future::ready(Ok(FirstRequestAfterMove::Unobserved)).boxed()
}
