//! A re-supplied setup token reaching the Claude Code processes running on its account. A token
//! reaches a process on its pipe at its start, so each live session on the account starts again
//! between turns, as a switch onto a token account starts it, and resumes its conversation by id
//! on the new token.

use std::sync::{Arc, Weak};

use sidekicks_contracts::provider::account::record::ProviderAccountId;

use super::ClaudeAccountLegs;
use crate::driver::claude::session::errors::record_unheard_claude_failure;
use crate::driver::claude::session::restart::ClaudeSessionRestarts;
use crate::driver::claude::session::restart::account_move::{
    ClaudeAccountMoveAsker, ClaudeLegBinding,
};
use crate::driver::claude::session::state::LiveClaudeSession;
use crate::driver::contract::error::DriverError;
use crate::driver::diagnostics::DriverDiagnosticKind;
use crate::port::run_host::RunHost;
use crate::runtime_binding::writer::RuntimeBindingWriter;

/// Starts again, each on a task of its own, every live session of `legs` whose process runs on
/// `provider_account_id`'s account, an idle one at once and a busy one once its turn settles,
/// under its stored leg's binding, so it resumes on the account's token sealed now, or, where a
/// person's switch waits on the session, on that switch's account; answers once
/// each is set going, never waiting on a turn. A failed start is recorded as the driver's
/// diagnostic, the relaunch recording it in the session directory too. Fails while the run engine
/// is not registered.
pub(super) fn relaunch_on_resupplied_token(
    legs: &ClaudeAccountLegs,
    provider_account_id: &ProviderAccountId,
) -> Result<(), DriverError> {
    // A driver that has not composed its sessions, or has stopped, runs no process.
    let Some(establishment) = legs.sessions.get().and_then(Weak::upgrade) else {
        return Ok(());
    };
    let run_engine = legs
        .ports
        .run_engine
        .require_port()
        .map_err(|error| DriverError::Internal(Box::new(error)))?;
    let restarts = &establishment.task_services.restarts;
    for live in restarts.slots().live_sessions() {
        if live.admitted_provider_account_id() != *provider_account_id {
            continue;
        }
        let restarts = Arc::clone(restarts);
        let run_engine = Arc::clone(run_engine);
        let bindings = Arc::clone(&legs.bindings);
        let provider_account_id = provider_account_id.clone();
        tokio::spawn(async move {
            let relaunched = relaunch_session(
                &restarts,
                &*run_engine,
                bindings,
                &live,
                provider_account_id,
            )
            .await;
            if let Err(error) = relaunched {
                record_unheard_claude_failure(
                    DriverDiagnosticKind::ProcessReportFailed,
                    live.session_id,
                    "the start on a re-supplied token",
                    &error,
                );
            }
        });
    }
    Ok(())
}

// Starts `live` again on `provider_account_id`'s account under the binding of its stored leg, the
// one a switch moves. Fails for a session with no stored leg, and as the read or the relaunch
// fails.
async fn relaunch_session(
    restarts: &Arc<ClaudeSessionRestarts>,
    run_engine: &dyn RunHost,
    bindings: Arc<dyn RuntimeBindingWriter>,
    live: &Arc<LiveClaudeSession>,
    provider_account_id: ProviderAccountId,
) -> Result<(), DriverError> {
    let leg = run_engine
        .read_session_leg(live.session_id)
        .await
        .map_err(DriverError::Internal)?
        .ok_or_else(|| DriverError::Internal("the session has no stored leg to resume".into()))?;
    let leg = ClaudeLegBinding {
        bindings,
        binding_id: leg.id,
    };
    restarts
        .relaunch_on_account(
            live,
            provider_account_id,
            leg,
            ClaudeAccountMoveAsker::Driver,
        )
        .await
        .map(drop)
}

#[cfg(test)]
mod tests;
