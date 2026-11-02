//! The Codex switch leg: every session following the current account runs on the one switching
//! service, so a switch is one `account/login/start` there with the new account's tokens, its
//! answer the acknowledgment for every conversation on the service. At that answer's place among
//! the service's frames the service carries the new account, its limit readings start afresh, and
//! each moved session takes its move in its queue, its binding moving once the spend metered
//! before is recorded. A refused login moves nothing.

use std::path::Path;
use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::{BoxFuture, join_all};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_ipc::domain_error::DomainError;
use tokio::sync::oneshot;

use super::CodexAccountLegs;
use crate::driver::codex::service::registry::switching_home;
use crate::driver::codex::service::switching::CodexNamedMove;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::contract::account::{FirstRequestAfterMove, SessionAccountMove, SessionToMove};
use crate::driver::contract::error::DriverError;

/// Moves each of `sessions` onto `to` through `legs` with one login on the switching service, as
/// [`crate::driver::contract::account::ProviderSwitchLegs::move_sessions`] says. The account it
/// leaves is the one the service carries. A refused login, or a service that cannot start, fails
/// every move with that error.
pub(super) async fn move_codex_sessions(
    legs: &CodexAccountLegs,
    to: ProviderAccountId,
    sessions: Vec<SessionToMove>,
) -> Vec<Result<SessionAccountMove, (SessionId, DriverError)>> {
    let (queued, landings): (Vec<_>, Vec<_>) = sessions
        .into_iter()
        .map(|session| {
            let (moved, landed) = oneshot::channel();
            ((session.clone(), moved), (session, landed))
        })
        .unzip();
    if let Err(error) = switch_service(legs, to.clone(), queued).await {
        let error = Arc::new(DriverError::from(error));
        return landings
            .into_iter()
            .map(|(session, _landed)| Err((session.session_id, share_failure(&error))))
            .collect();
    }
    join_all(landings.into_iter().map(|(session, landed)| {
        let to = to.clone();
        async move {
            let session_id = session.session_id;
            let moved = match landed.await {
                Ok(moved) => moved,
                // The session's queue took no move, so no frame of it waits: it moves at once.
                Err(_untaken) => legs
                    .bindings
                    .move_account(session.binding_id, to)
                    .await
                    .map_err(DriverError::Internal),
            };
            moved.map_err(|error| (session_id, error))?;
            Ok(SessionAccountMove {
                session_id,
                first_request: unobserved(),
            })
        }
    }))
    .await
}

// Starts the switching service where it is not up and hands it `to`'s tokens; at the answer the
// service's readings start afresh and each session on it, each of `queued` among them, takes its
// move in its queue.
async fn switch_service(
    legs: &CodexAccountLegs,
    to: ProviderAccountId,
    queued: Vec<(SessionToMove, oneshot::Sender<Result<(), DriverError>>)>,
) -> Result<(), CodexError> {
    let service = legs
        .registry
        .switching_service()
        .await
        .map_err(CodexError::Driver)?;
    service
        .ensure_started(legs.dependencies.startup_timeout)
        .await?;
    let named = queued
        .into_iter()
        .map(|(session, moved)| CodexNamedMove {
            session_id: session.session_id,
            binding_id: session.binding_id,
            moved,
        })
        .collect();
    service
        .dependencies()
        .switching
        .hand_switch(&service, to, named)
        .await
}

/// Hands the switching service the tokens in `codex_home` again where it carries
/// `provider_account_id`'s account and a limits read there left that home's access token renewed.
/// A switching service not up takes the home's tokens at its next start, so it is handed nothing.
/// Fails as the home's `auth.json` cannot be read and with Codex's refusal of the login.
pub(super) async fn hand_switching_service_again(
    legs: &CodexAccountLegs,
    provider_account_id: &ProviderAccountId,
    codex_home: &Path,
) -> Result<(), DriverError> {
    let Some(service) = legs
        .registry
        .service_on(&switching_home(&legs.dependencies.data_folder))
    else {
        return Ok(());
    };
    let Ok(connection) = service.connection() else {
        return Ok(());
    };
    service
        .dependencies()
        .switching
        .hand_again_if_renewed(&connection, provider_account_id, codex_home)
        .await?;
    Ok(())
}

// One failed switch's failure, shared by the move of every session it held back.
#[derive(Debug, thiserror::Error)]
#[error(transparent)]
struct SharedSwitchFailure(Arc<DriverError>);

// `error` as one session's move carries it: a refusal under its own code and words, any other
// failure as the driver's own, each with the switch's failure underneath.
fn share_failure(error: &Arc<DriverError>) -> DriverError {
    let shared = Box::new(SharedSwitchFailure(Arc::clone(error)));
    if let DriverError::Refused(refusal) = &**error {
        let mut shared_refusal = DomainError::new(refusal.message.clone(), refusal.code);
        shared_refusal.detail.clone_from(&refusal.detail);
        return DriverError::from(
            shared_refusal.with_source(shared as Box<dyn std::error::Error + Send + Sync>),
        );
    }
    DriverError::Internal(shared)
}

// The switch's answer settles no first request: Codex reports a login it then refuses through its
// own refresh request, which the hand-back answers.
fn unobserved() -> BoxFuture<'static, Result<FirstRequestAfterMove, DriverError>> {
    futures::future::ready(Ok(FirstRequestAfterMove::Unobserved)).boxed()
}

#[cfg(test)]
mod tests;
