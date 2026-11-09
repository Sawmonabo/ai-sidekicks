//! The Codex switch leg: every session following the current account runs on the one switching
//! service, so a switch is one `account/login/start` there with the new account's tokens, held
//! until no turn runs on the service. At that login's answer's place among the service's frames
//! the service carries the new account, its limit readings start afresh, and each moved session
//! takes its move in its queue, its binding moving once the spend metered before is recorded. A
//! refused login moves nothing. Each move's first request is watched by the switching service's
//! hand-back window, which settles it.

use std::path::Path;
use std::sync::Arc;

use futures::future::join_all;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use tokio::sync::oneshot;

use super::CodexAccountLegs;
use crate::driver::codex::service::registry::switching_home;
use crate::driver::codex::service::switching::CodexNamedMove;
use crate::driver::codex::service::switching::held::CodexSwitchLanding;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::contract::account::{SessionAccountMove, SessionToMove, SwitchMovesAccepted};
use crate::driver::contract::error::DriverError;
use crate::runtime_binding::writer::RuntimeBindingWriter;

/// Moves each of `sessions` onto `to` through `legs` with one login on the switching service for
/// `actor`, telling `accepted` once the switch is held, as
/// [`crate::driver::contract::account::ProviderSwitchLegs::move_sessions`] says. The account it
/// leaves is the one the service carries. A refused login, or a service that cannot start, fails
/// every move with that error; a session a newer switch named too answers where that switch
/// landed it.
pub(crate) async fn move_codex_sessions(
    legs: &CodexAccountLegs,
    to: ProviderAccountId,
    sessions: Vec<SessionToMove>,
    actor: DeviceId,
    accepted: SwitchMovesAccepted,
) -> Vec<Result<SessionAccountMove, (SessionId, DriverError)>> {
    let (named, landings): (Vec<_>, Vec<_>) = sessions
        .into_iter()
        .map(|session| {
            let (moved, landed) = oneshot::channel();
            let (watch, first_request) = oneshot::channel();
            let named = CodexNamedMove {
                session_id: session.session_id,
                binding_id: session.binding_id.clone(),
                moved,
                first_request: watch,
            };
            (named, (session, landed, first_request))
        })
        .unzip();
    let CodexSwitchLanding {
        landed_on,
        replaced,
    } = match switch_service(legs, to, named, actor, accepted).await {
        Ok(landing) => landing,
        Err(error) => {
            let error = Arc::new(DriverError::from(error));
            return landings
                .into_iter()
                .map(|(session, _landed, _first_request)| {
                    Err((session.session_id, DriverError::shared(&error)))
                })
                .collect();
        }
    };
    join_all(
        landings
            .into_iter()
            .map(|(session, landed, first_request)| {
                let landed_on = landed_on.clone();
                let is_replaced = replaced.contains(&session.session_id);
                async move {
                    let session_id = session.session_id;
                    if is_replaced {
                        return Ok(SessionAccountMove::replaced(session_id, landed_on));
                    }
                    wait_for_move(
                        landed,
                        &*legs.bindings,
                        session.binding_id,
                        landed_on.clone(),
                    )
                    .await
                    .map_err(|error| (session_id, error))?;
                    Ok(SessionAccountMove::watched(
                        session_id,
                        landed_on,
                        first_request,
                    ))
                }
            }),
    )
    .await
}

/// Waits for a session's move queued among its frames to land on `landed`, its lead's binding
/// `binding_id` with it; a queue that took no move holds no frame of it, so the binding moves onto
/// `to` through `bindings` at once. Fails with the move's error.
pub(crate) async fn wait_for_move(
    landed: oneshot::Receiver<Result<(), DriverError>>,
    bindings: &dyn RuntimeBindingWriter,
    binding_id: RuntimeBindingId,
    to: ProviderAccountId,
) -> Result<(), DriverError> {
    match landed.await {
        Ok(moved) => moved,
        Err(_untaken) => bindings
            .move_account(binding_id, to)
            .await
            .map_err(DriverError::Internal),
    }
}

// Starts the switching service where it is not up and hands it `to`'s tokens for `actor`, telling
// `accepted` once the switch is held; at the answer the service's readings start afresh and each
// session on it, each of `named` among them, takes its move in its queue.
async fn switch_service(
    legs: &CodexAccountLegs,
    to: ProviderAccountId,
    named: Vec<CodexNamedMove>,
    actor: DeviceId,
    accepted: SwitchMovesAccepted,
) -> Result<CodexSwitchLanding, CodexError> {
    let service = legs
        .registry
        .switching_service()
        .await
        .map_err(CodexError::Driver)?;
    service
        .ensure_started(legs.dependencies.startup_timeout)
        .await?;
    service
        .dependencies()
        .switching
        .hand_switch(&service, to, named, actor, accepted)
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

#[cfg(test)]
mod tests;
