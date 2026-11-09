//! A session's move onto another account as its task makes it: the record's account at once, its
//! bindings once the spend metered before is recorded, then the move answered to the switch that
//! waits on it, or, where none waits and the move took the session off another account, reported
//! to the daemon's record of a move no switch settles, by the person whose switch moved the
//! service where one did.

use std::error::Error;
use std::sync::Arc;

use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::port_registration::PortRegistration;

use crate::driver::codex::session::inbound::CodexAccountMove;
use crate::driver::contract::account::SessionAccountMove;
use crate::driver::contract::error::DriverError;
use crate::port::session_account_move::SessionAccountMoveRecorder;
use crate::runtime_binding::writer::RuntimeBindingWriter;

/// One session's move of its bindings onto another account, planned on its task.
pub(crate) struct CodexBindingMove {
    session_id: SessionId,
    // The lead's binding a switch named, and the record's own.
    binding_ids: Vec<RuntimeBindingId>,
    account_move: CodexAccountMove,
    // No switch waits on the move, and it took the session's record off another account.
    is_reported: bool,
}

impl CodexBindingMove {
    /// Plans `account_move` for `session_id`, whose record, where it has one, runs on the account
    /// and binding `record` names: the record's account is moved at once, and its binding joins
    /// the bindings to move.
    pub(crate) fn plan(
        session_id: SessionId,
        record: Option<(&mut ProviderAccountId, Option<&RuntimeBindingId>)>,
        account_move: CodexAccountMove,
    ) -> Self {
        let mut binding_ids: Vec<_> = account_move.binding_id.iter().cloned().collect();
        let mut is_reported = false;
        if let Some((account, binding_id)) = record {
            is_reported =
                account_move.moved.is_none() && *account != account_move.provider_account_id;
            account.clone_from(&account_move.provider_account_id);
            if let Some(binding_id) = binding_id
                && !binding_ids.contains(binding_id)
            {
                binding_ids.push(binding_id.clone());
            }
        }
        Self {
            session_id,
            binding_ids,
            account_move,
            is_reported,
        }
    }

    /// Moves each binding onto the account through `bindings`, the first failure ending it, then
    /// answers the switch waiting on the move; where none waits, a move that took the session off
    /// another account goes to `recorder` once every binding moved, with the watch of its first
    /// request where the switch keeps one, and a failure is logged.
    pub(crate) async fn land(
        self,
        bindings: &dyn RuntimeBindingWriter,
        recorder: &PortRegistration<Arc<dyn SessionAccountMoveRecorder>>,
    ) {
        let Self {
            session_id,
            binding_ids,
            account_move,
            is_reported,
        } = self;
        let mut moved = Ok(());
        for binding_id in binding_ids {
            moved = bindings
                .move_account(binding_id, account_move.provider_account_id.clone())
                .await
                .map_err(DriverError::Internal);
            if moved.is_err() {
                break;
            }
        }
        // The switch that asked may have stopped waiting.
        if let Some(waiting) = account_move.moved {
            let _unheard = waiting.send(moved);
            return;
        }
        if let Err(error) = moved {
            tracing::warn!(
                %session_id,
                error = &error as &(dyn Error + 'static),
                "a session's binding was not moved onto the account its service now carries"
            );
            return;
        }
        if !is_reported {
            return;
        }
        let Some(recorder) = recorder.port() else {
            tracing::warn!(
                %session_id,
                "a session moved onto another account before its record was registered"
            );
            return;
        };
        let landed_on = account_move.provider_account_id;
        let moved = match account_move.first_request {
            Some(first_request) => {
                SessionAccountMove::watched(session_id, landed_on, first_request)
            }
            None => SessionAccountMove::unobserved(session_id, landed_on),
        };
        recorder
            .record_account_moved(moved, account_move.actor)
            .await;
    }
}
