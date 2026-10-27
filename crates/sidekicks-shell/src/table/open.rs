//! Opening a shell: one open per key, the session's checks, the orphan registry's record around
//! the terminal's start, and the shell's record whether or not its terminal started.

use std::error::Error;
use std::sync::Arc;

use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::terminal::{TerminalId, TerminalOpenRequest, TerminalOpenResponse};
use sidekicks_platforms::PathRules;
use sidekicks_terminal::TerminalError;
use tokio::sync::watch;

use crate::integration::injection::{ShellMarkNonce, discard_mark_nonce_file, mint_mark_nonce};
use crate::output::stream::ShellOutputEnd;
use crate::record::ShellRecord;
use crate::refusals::backend_unavailable;
use crate::start::{ShellStartInput, check_working_folder, plan_shell_start};
use crate::table::end::{close_terminal, let_shell_go};
use crate::table::output::drain_output;
use crate::table::{ShellTable, TableShared, log_failure};
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_ipc::session_not_found::session_not_found;
use sidekicks_provider::spawn_environment::SessionEnvironment;
use sidekicks_std::error_description::describe_error;

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start builds the shell table and the terminal methods call it"
    )
)]
impl ShellTable {
    /// Starts a shell for the session, or answers the shell a retry with the same key already
    /// started, waiting for an open of that key under way. Refuses a chat session
    /// `terminal.chatUnsupported`, a session whose working folder is not in place
    /// `session.workingFolder.missing`, one being deleted `session.notFound`, and any while the
    /// daemon's terminals drain at its stop `terminal.backendUnavailable`. A login shell
    /// the system will not start gives way to the platform's default shell inside the `shell`
    /// mode, and a shell whose terminal fails to start keeps its record as `didNotStart` with the
    /// daemon's words for why. Fails as a fault when the start cannot be prepared.
    pub(crate) async fn open(
        &self,
        request: TerminalOpenRequest,
    ) -> Result<TerminalOpenResponse, HandlerError> {
        let session_id = request.session_id;
        let key = request.client_idempotency_key.clone();
        let opening = loop {
            let mut waiting = {
                let mut sessions = self.shared.lock_sessions();
                let session = self.shared.session_of(&mut sessions, &session_id);
                if let Some(shell) = session
                    .shells
                    .values()
                    .find(|shell| shell.client_idempotency_key == key)
                {
                    return Ok(TerminalOpenResponse {
                        terminal_id: shell.terminal_id.clone(),
                    });
                }
                if let Some(waiting) = session.opening.get(&key) {
                    waiting.clone()
                } else {
                    let (opening, waiting) = watch::channel(());
                    session.opening.insert(key.clone(), waiting);
                    break opening;
                }
            };
            // The open under way never sends; its sender drops once it settles.
            while waiting.changed().await.is_ok() {}
        };
        let started = self.shared.start_shell(&request).await;
        {
            let mut sessions = self.shared.lock_sessions();
            if let Some(session) = sessions.get_mut(&session_id) {
                session.opening.remove(&key);
            }
        }
        drop(opening);
        self.shared.forget_if_idle(&session_id);
        started
    }
}

impl TableShared {
    async fn start_shell(
        self: &Arc<Self>,
        request: &TerminalOpenRequest,
    ) -> Result<TerminalOpenResponse, HandlerError> {
        let session_id = &request.session_id;
        self.refuse_if_closing(session_id)?;
        let working_folder = (self.deps.read_working_folder)(*session_id).await?;
        let folder = check_working_folder(session_id, working_folder).await?;
        let settings = (self.deps.read_shell_settings)(*session_id).await?;
        let spawn_nonce = self
            .deps
            .orphan_guard
            .prepare_spawn()
            .await
            .map_err(|error| HandlerError::Internal(Box::new(error)))?;
        let prepared = async {
            let mark_nonce = mint_mark_nonce(&self.deps.startup_folders).await?;
            let start = plan_shell_start(ShellStartInput {
                environment: SessionEnvironment {
                    base: &self.deps.base_environment,
                    every_project_rows: &settings.every_project_rows,
                    project_rows: &settings.project_rows,
                    reserved_names: &self.deps.reserved_names,
                    rules: PathRules::NATIVE,
                },
                is_screen_reader_mode_on: settings.is_screen_reader_mode_on,
                screen_reader_environment_names: &self.deps.screen_reader_environment_names,
                startup_folders: &self.deps.startup_folders,
                folder: &folder,
                spawn_nonce: &spawn_nonce,
                mark_nonce: &mark_nonce,
                shell_mode: self.deps.shell_mode.clone(),
            })
            .await;
            match start {
                Ok(start) => Ok((mark_nonce, start)),
                Err(error) => {
                    discard_unread_nonce(&mark_nonce).await;
                    Err(error)
                }
            }
        }
        .await;
        let (mark_nonce, start) = match prepared {
            Ok(prepared) => prepared,
            Err(error) => {
                self.deps.orphan_guard.retire(&spawn_nonce).await;
                return Err(HandlerError::Internal(Box::new(error)));
            }
        };
        let terminal_id =
            TerminalId::new(mint_uuid_v7().to_string()).expect("a minted UUID is a terminal id");
        let record = {
            let mut sessions = self.lock_sessions();
            let list = self.session_of(&mut sessions, session_id).list.clone();
            ShellRecord::new(
                *session_id,
                terminal_id.clone(),
                request.client_idempotency_key.clone(),
                start.program_name,
                Arc::clone(&self.record_deps),
                list,
            )
        };
        let listening = Arc::clone(&record);
        let spawned = self
            .deps
            .terminals
            .spawn(
                start.request,
                move |answers| listening.listen(answers),
                record.mark_filter(&mark_nonce.nonce),
            )
            .await;
        match spawned {
            Ok(spawned) => {
                record.record_started(
                    spawned.handle,
                    spawned.screen,
                    mark_nonce,
                    spawn_nonce.clone(),
                );
                self.deps.runtime.spawn(drain_output(
                    Arc::downgrade(self),
                    Arc::clone(&record),
                    spawned.output,
                ));
                if let Some(process_id) = spawned.process_id {
                    self.record_child(&record, &spawn_nonce, process_id).await;
                }
            }
            Err(error) => {
                discard_unread_nonce(&mark_nonce).await;
                self.deps.orphan_guard.retire(&spawn_nonce).await;
                // The terminals drain as the daemon stops, so no shell can start at all.
                if matches!(error, TerminalError::Draining) {
                    return Err(backend_unavailable(&describe_error(&error)).into());
                }
                record.record_did_not_start(describe_error(&error));
            }
        }
        let is_closing = {
            let mut sessions = self.lock_sessions();
            let session = self.session_of(&mut sessions, session_id);
            session
                .shells
                .insert(terminal_id.clone(), Arc::clone(&record));
            session.order.push(terminal_id.clone());
            session.list.mark_changed();
            session.close_holds > 0
        };
        if is_closing {
            // The session's deletion began while the shell started; it waited for this open, so it
            // ends the shell with the rest.
            return Err(session_not_found(session_id).into());
        }
        Ok(TerminalOpenResponse { terminal_id })
    }

    // Refuses an open while the session is being deleted.
    fn refuse_if_closing(&self, session_id: &SessionId) -> Result<(), HandlerError> {
        let is_closing = self
            .lock_sessions()
            .get(session_id)
            .is_some_and(|session| session.close_holds > 0);
        if is_closing {
            return Err(session_not_found(session_id).into());
        }
        Ok(())
    }

    // Records the started child in the orphan registry; one that cannot be recorded is ended, so
    // no child runs unrecorded, and its shell reads as one that did not start.
    async fn record_child(&self, record: &Arc<ShellRecord>, spawn_nonce: &str, process_id: u32) {
        let Err(error) = self
            .deps
            .orphan_guard
            .complete_spawn(spawn_nonce, process_id)
            .await
        else {
            return;
        };
        record.record_did_not_start(describe_error(&error));
        let (handle, mark_nonce, spawn_nonce) =
            record.record_end(ShellOutputEnd::DidNotStart, false);
        let closing = close_terminal(&self.deps.terminals, handle);
        if let Err(error) =
            let_shell_go(&self.deps.orphan_guard, closing, mark_nonce, spawn_nonce).await
        {
            log_failure(record, "could not close its unrecorded child", &error);
        }
    }
}

/// Removes a nonce file a shell has read or never will, logging a failure.
pub(super) async fn discard_unread_nonce(mark_nonce: &ShellMarkNonce) {
    if let Err(error) = discard_mark_nonce_file(mark_nonce).await {
        tracing::warn!(
            error = &error as &(dyn Error + 'static),
            "a shell's nonce file could not be removed"
        );
    }
}
