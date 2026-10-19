//! Ending shells: a pane's close of one shell and a session's deletion of all of them. Each ends
//! the shell's subscriptions and releases the holds they carried before the shell leaves its
//! session, then has the terminal let it go and forgets its child in the orphan registry.

use std::sync::{Arc, Weak};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::terminal::TerminalCloseRequest;
use sidekicks_contracts::trust_statement::DeviceId;

use crate::ipc::registry::HandlerError;
use crate::pty::shell::output::stream::ShellOutputEnd;
use crate::pty::shell::record::ShellRecord;
use crate::pty::shell::refusals::terminal_not_found;
use crate::pty::shell::table::open::discard_unread_nonce;
use crate::pty::shell::table::{ShellTable, TableShared};

/// Holds a deleted session's opens refused until it drops.
pub(crate) struct SessionShellsClosed {
    table: Weak<TableShared>,
    session_id: SessionId,
}

impl Drop for SessionShellsClosed {
    fn drop(&mut self) {
        if let Some(table) = self.table.upgrade() {
            table.allow_opens(&self.session_id);
        }
    }
}

#[expect(
    dead_code,
    reason = "the daemon's start builds the shell table and the terminal methods call it"
)]
impl ShellTable {
    /// Ends a shell and removes it, ending its subscriptions and releasing the holds they
    /// carried; refused while a run holds it, and while another device holds it unless `force`.
    /// Of two closes of one shell, the second is refused `terminal.notFound`. Answers once the
    /// terminal has let the shell go, and fails as a fault when its program outlives its kill.
    pub(crate) async fn close(
        &self,
        request: &TerminalCloseRequest,
        device_id: &DeviceId,
    ) -> Result<(), HandlerError> {
        let shell = self
            .shared
            .find_shell(&request.session_id, &request.terminal_id)?;
        let ending = shell
            .lease
            .admit_close(device_id, request.force == Some(true), || {
                self.shared.end_shell(&shell)
            })
            .await?;
        // Another close may have removed the shell while this one waited on its lease.
        let ending = ending.ok_or_else(|| terminal_not_found(&request.terminal_id))?;
        self.shared.forget_if_idle(&request.session_id);
        ending.await
    }

    /// Ends every shell of a session being deleted, whoever holds it and those still opening, so
    /// none keeps running in a folder about to go, and refuses the session's opens
    /// `session.notFound` until the answered hold drops. Answers once every shell's program has
    /// exited; fails with the first program that will not end, the session's opens no longer
    /// refused.
    pub(crate) async fn close_session_shells(
        &self,
        session_id: &SessionId,
    ) -> Result<SessionShellsClosed, HandlerError> {
        let opening = {
            let mut sessions = self.shared.lock_sessions();
            let session = self.shared.session_of(&mut sessions, session_id);
            session.close_holds += 1;
            session.opening.values().cloned().collect::<Vec<_>>()
        };
        let hold = SessionShellsClosed {
            table: Arc::downgrade(&self.shared),
            session_id: session_id.clone(),
        };
        // An open under way sees the hold once its shell started and leaves the shell here.
        for mut waiting in opening {
            while waiting.changed().await.is_ok() {}
        }
        let shells: Vec<Arc<ShellRecord>> = self
            .shared
            .lock_sessions()
            .get(session_id)
            .map(|session| session.shells.values().cloned().collect())
            .unwrap_or_default();
        let endings: Vec<_> = shells
            .iter()
            .filter_map(|shell| self.shared.end_shell(shell))
            .collect();
        for ending in endings {
            ending.await?;
        }
        Ok(hold)
    }
}

impl TableShared {
    /// Takes `shell` out of its session and starts its end; `None` once it already left. The
    /// answered future lets the terminal go, then forgets the shell's nonces.
    fn end_shell(
        self: &Arc<Self>,
        shell: &Arc<ShellRecord>,
    ) -> Option<BoxFuture<'static, Result<(), HandlerError>>> {
        {
            let mut sessions = self.lock_sessions();
            let session = sessions.get_mut(&shell.session_id)?;
            if !session
                .shells
                .get(&shell.terminal_id)
                .is_some_and(|held| Arc::ptr_eq(held, shell))
            {
                return None;
            }
            session.shells.remove(&shell.terminal_id);
            session.order.retain(|id| *id != shell.terminal_id);
            session.list.mark_changed();
        }
        let (handle, mark_nonce, spawn_nonce) = shell.record_end(ShellOutputEnd::Closed, true);
        self.release_streams(shell);
        let table = Arc::clone(self);
        Some(
            async move {
                let closed = match handle {
                    Some(handle) => table.deps.terminals.close(handle).await,
                    None => Ok(()),
                };
                if let Some(mark_nonce) = mark_nonce {
                    discard_unread_nonce(&mark_nonce).await;
                }
                // A child that outlived its kill stays in the registry for the next start's sweep.
                if closed.is_ok()
                    && let Some(spawn_nonce) = spawn_nonce
                {
                    table.deps.orphan_guard.retire(&spawn_nonce).await;
                }
                closed.map_err(|error| HandlerError::Internal(Box::new(error)))
            }
            .boxed(),
        )
    }

    fn allow_opens(&self, session_id: &SessionId) {
        if let Some(session) = self.lock_sessions().get_mut(session_id) {
            session.close_holds -= 1;
        }
        self.forget_if_idle(session_id);
    }
}
