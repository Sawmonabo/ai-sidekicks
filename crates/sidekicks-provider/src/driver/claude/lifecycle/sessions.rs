//! A session's life on Claude Code: its create, resume and the person's restart, a fork or a cut of
//! its conversation, a move to a new build, its close and the daemon's stop, its name, the purge
//! of its conversations, and the messages its process took.

use std::error::Error;

use futures::future::join_all;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::PathRules;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::settle_all::settle_all;

use super::{ClaudeDriver, internal};
use crate::driver::claude::delivery::requests::answers::claude_project_folder;
use crate::driver::claude::session::conversation_file::{
    conversation_file_of, find_claude_taken_messages,
};
use crate::driver::claude::session::errors::record_unheard_claude_failure;
use crate::driver::claude::session::naming::{
    name_claude_session, stored_claude_conversation, tell_claude_session_name,
};
use crate::driver::claude::session::purge::{ClaudePurgePlace, purge_claude_conversations};
use crate::driver::claude::session::restart::{ClaudeEndedConversation, ClaudeSessionStanding};
use crate::driver::claude::session::slots::ClaudeCloseStart;
use crate::driver::contract::{DriverError, SessionProcessState};
use crate::driver::daemon_stop::DaemonStopIntent;
use crate::driver::diagnostics::DriverDiagnosticKind;
use crate::driver::rewind::{RewindConversationParams, RewindConversationResult};
use crate::driver::run_control::{FindTakenMessagesParams, TakenMessages};
use crate::driver::session_control::{
    CloseSessionParams, CreateSessionParams, DriverResumeResult, MoveSessionToForkParams,
    MoveSessionToForkResult, NameSessionParams, ProviderBuildChange, ProviderSessionHandle,
    PurgeSessionParams, ResumeSessionParams,
};
use crate::runtime_binding::store::RuntimeBinding;

impl ClaudeDriver {
    /// Opens a session on a new conversation; see the establishment's create.
    pub(crate) async fn create_session(
        &self,
        params: CreateSessionParams,
    ) -> Result<ProviderSessionHandle, DriverError> {
        self.parts()?.establishment.create(params).await
    }

    /// Resumes a session's conversation in a fresh process, every failure on the `Failed` arm.
    pub(crate) async fn resume_session(
        &self,
        params: ResumeSessionParams,
    ) -> Result<DriverResumeResult, DriverError> {
        Ok(self.parts()?.establishment.resume(params).await.result)
    }

    /// The person's restart of a session whose process stayed down: its crash window and any
    /// restart still waiting are dropped, it resumes, and the person is told it runs again unless
    /// a process already live answered it.
    pub(crate) async fn restart_session(
        &self,
        params: ResumeSessionParams,
    ) -> Result<DriverResumeResult, DriverError> {
        let parts = self.parts()?;
        let session_id = params.session_id;
        parts.restarts.clear_crash_window(session_id);
        let answer = parts.establishment.resume(params).await;
        if answer.has_started_process {
            parts.restarts.report_restarted(session_id, true).await;
        }
        Ok(answer.result)
    }

    /// Where the session's process stands: a live process is `Live`; a restart waiting out its
    /// crash wait, a relaunch or a fork's bring-up is `Restarting`; anything else, a crash loop
    /// included, is `Down`. A read of the driver's own tables.
    pub(crate) fn session_process_state(&self, session_id: SessionId) -> SessionProcessState {
        let Some(parts) = self.composed_parts() else {
            return SessionProcessState::Down;
        };
        match parts.restarts.standing(session_id) {
            ClaudeSessionStanding::Live(_) => SessionProcessState::Live,
            ClaudeSessionStanding::Held { .. } | ClaudeSessionStanding::Settling(_) => {
                SessionProcessState::Restarting
            }
            ClaudeSessionStanding::Down => SessionProcessState::Down,
        }
    }

    /// Moves the session onto a fork of its conversation; see the establishment's fork.
    pub(crate) async fn move_session_to_fork(
        &self,
        params: MoveSessionToForkParams,
    ) -> Result<MoveSessionToForkResult, DriverError> {
        let parts = self.parts()?;
        let predecessor = parts.run_start.live_session(params.session_id)?;
        parts.establishment.fork(params, predecessor).await
    }

    /// Cuts the live conversation in place before the person's message.
    pub(crate) async fn rewind_conversation(
        &self,
        params: RewindConversationParams,
    ) -> Result<RewindConversationResult, DriverError> {
        let parts = self.parts()?;
        let live = parts.run_start.live_session(params.session_id)?;
        parts
            .cuts
            .rewind(
                &live,
                &params.target_message_id,
                &self.sources.ports.reviewer_denials,
            )
            .await
    }

    /// Moves every live session onto the build that replaced the running one; none is live before
    /// the session pieces are composed.
    pub(crate) async fn move_to_provider_build(
        &self,
        change: ProviderBuildChange,
    ) -> Result<(), DriverError> {
        match self.composed_parts() {
            Some(parts) => parts.restarts.move_to_provider_build(&change).await,
            None => Ok(()),
        }
    }

    /// Closes the session: a restart waiting for it, its controls and its reviewer's blocks go,
    /// then its process is disposed of, after any transition in flight settles, each run it still
    /// held ends as the daemon's intended close, and the `Allow once` presses its bindings held
    /// are let go; a session with no process needs nothing.
    pub(crate) async fn close_session(
        &self,
        params: CloseSessionParams,
    ) -> Result<(), DriverError> {
        let Some(parts) = self.composed_parts() else {
            return Ok(());
        };
        let session_id = params.session_id;
        parts.restarts.forget_session(session_id);
        parts.session_controls.forget_session(session_id).await;
        parts.reviewer.forget_session(session_id);
        loop {
            match parts.slots().begin_close(session_id) {
                ClaudeCloseStart::Empty => return Ok(()),
                ClaudeCloseStart::Wait(settled) => {
                    settled.wait().await;
                }
                ClaudeCloseStart::Closing(close) => {
                    // Marked first, so a `result` read before the channel closes ends its turn
                    // as the daemon's intended close.
                    if let Some(stream) = parts.establishment.streams.get(session_id) {
                        stream.signal_intended_close();
                    }
                    let session = close.session();
                    close.close_channel().await;
                    // Read once the session's task has ended, so a turn Claude Code started by
                    // itself while the close drained it is ended too.
                    let routes = &parts.establishment.routes;
                    let runs = routes.bound_runs_on(session_id);
                    // Routes once the channel is closed, so a frame read before it still reaches
                    // its run, and no later interrupt aims at a run of the dead process.
                    routes.retire_run_routes(session_id);
                    routes.forget_session_bindings(session_id);
                    lock(&parts.establishment.prompts).forget_session(session_id);
                    self.pending_compactions
                        .release_binding(&session_id.to_string());
                    for run in &runs {
                        if let Err(error) =
                            parts.run_start.engine.end_turn_on_close(run.run_id).await
                        {
                            record_unheard_claude_failure(
                                DriverDiagnosticKind::ProcessReportFailed,
                                session_id,
                                "the run end of a closed session",
                                &*error,
                            );
                        }
                    }
                    session.release_served_presses(&self.sources.ports.reviewer_denials);
                    close.finish();
                    return Ok(());
                }
            }
        }
    }

    /// Ends every Claude Code process as the daemon stops: no restart starts from here, every
    /// session closes, and every process still running is stopped. Each process is the daemon's
    /// own child, so a restart of the daemon stops them as a stop does. Fails with every close
    /// that failed once all have ended.
    pub(crate) async fn shutdown(&self, _intent: DaemonStopIntent) -> Result<(), DriverError> {
        let Some(parts) = self.composed_parts() else {
            self.starts.stop_every_process().await;
            return Ok(());
        };
        parts.restarts.stop();
        let closes = join_all(
            parts
                .slots()
                .session_ids()
                .into_iter()
                .map(|session_id| self.close_session(CloseSessionParams { session_id })),
        );
        let (closed, ()) = futures::join!(closes, self.starts.stop_every_process());
        settle_all(closed, "closing the Claude Code sessions at the stop")
            .map(drop)
            .map_err(internal)
    }

    /// Whether a run started on the session brings a process up: no process is live for it.
    pub(crate) fn starts_process(&self, session_id: SessionId) -> bool {
        self.composed_parts()
            .is_none_or(|parts| parts.slots().live_session(session_id).is_none())
    }

    /// Names the session from its first exchange; see the naming pass. At rest the pass runs on
    /// the account the session's stored leg ran on; a session that never ran answers `None`.
    /// Fails as the stored leg cannot be read, and as the pass fails.
    pub(crate) async fn name_session(
        &self,
        params: NameSessionParams,
    ) -> Result<Option<String>, DriverError> {
        let live = self
            .composed_parts()
            .and_then(|parts| parts.slots().live_session(params.session_id));
        let rest_account = if live.is_some() {
            None
        } else {
            let Some(leg) = self.read_session_leg(params.session_id).await? else {
                return Ok(None);
            };
            leg.spawn_config.provider_account_id
        };
        name_claude_session(
            live.as_deref(),
            &*self.starts,
            &self.sources,
            rest_account,
            params,
        )
        .await
    }

    /// Tells Claude Code the session's name, on its live process or in its conversation at rest:
    /// the one its last process here wrote, else the one its stored leg names, which outlives a
    /// restart of the daemon. A session that never ran has nothing to rename and answers `Ok`.
    pub(crate) async fn tell_session_name(
        &self,
        session_id: SessionId,
        name: String,
    ) -> Result<(), DriverError> {
        let parts = self.composed_parts();
        let live = parts.and_then(|parts| parts.slots().live_session(session_id));
        let mut ended = parts.and_then(|parts| parts.restarts.ended_conversation(session_id));
        if live.is_none() && ended.is_none() {
            let Some(leg) = self.read_session_leg(session_id).await? else {
                return Ok(());
            };
            let Some(handle) = leg.resume_handle else {
                return Ok(());
            };
            ended = Some(
                stored_claude_conversation(
                    &self.sources,
                    session_id,
                    leg.spawn_config.provider_account_id,
                    handle,
                )
                .await?,
            );
        }
        tell_claude_session_name(session_id, live.as_deref(), ended, name).await
    }

    /// The messages a process that ended took, read from the conversation it wrote: the live
    /// process's own, which resumed it, else the one the last ended process wrote. Fails as the
    /// file cannot be read, and when the driver knows no conversation of the session.
    pub(crate) async fn find_taken_messages(
        &self,
        params: FindTakenMessagesParams,
    ) -> Result<TakenMessages, DriverError> {
        let session_id = params.session_id;
        let parts = self.composed_parts();
        let conversation = parts
            .and_then(|parts| parts.slots().live_session(session_id))
            .map(|live| ClaudeEndedConversation {
                provider_session_id: live.provider_session_id.clone(),
                spawn_environment: live.spawn_bound_legs.spawn_environment.clone(),
            })
            .or_else(|| parts.and_then(|parts| parts.restarts.ended_conversation(session_id)))
            .ok_or_else(|| {
                DriverError::Internal(
                    format!("no Claude Code conversation of session {session_id} is known").into(),
                )
            })?;
        let file = conversation_file_of(
            &conversation.spawn_environment,
            &conversation.provider_session_id,
        )
        .await
        .map_err(internal)?
        .ok_or_else(|| {
            DriverError::Internal(
                format!(
                    "the Claude Code conversation {} has no file",
                    conversation.provider_session_id
                )
                .into(),
            )
        })?;
        let asked: Vec<String> = params
            .message_ids
            .iter()
            .map(|message_id| message_id.text().as_str().to_owned())
            .collect();
        let found = find_claude_taken_messages(&file, &asked)
            .await
            .map_err(internal)?;
        Ok(TakenMessages {
            taken: params
                .message_ids
                .into_iter()
                .filter(|message_id| found.iter().any(|uuid| uuid == message_id.text().as_str()))
                .collect(),
        })
    }

    /// Deletes Claude Code's own copy of each of the session's conversations from every home it
    /// ran in; see the conversation purge.
    pub(crate) async fn purge_session(
        &self,
        params: PurgeSessionParams,
    ) -> Result<(), DriverError> {
        let sources = &self.sources;
        let session_id = params.session_id;
        let context = sources
            .ports
            .spawn_contexts
            .require_port()
            .map_err(internal)?
            .resolve_spawn_context(session_id, None)
            .await
            .map_err(DriverError::Internal)?;
        let repository = self.read_repository(&context.working_directory).await;
        let project_folder = claude_project_folder(&context.working_directory, repository.as_ref());
        let data_folder = sources.data_folder.to_string_lossy();
        let place = ClaudePurgePlace {
            project_folder: &project_folder,
            home_folder: &sources.home_folder,
            path_rules: PathRules::NATIVE,
            data_folder: &data_folder,
        };
        purge_claude_conversations(&params, &place, |provider_account_id| {
            self.session_environment(session_id, provider_account_id)
        })
        .await
        .map_err(internal)
    }

    // The environment a spawn of the session on `provider_account_id`'s home starts with.
    async fn session_environment(
        &self,
        session_id: SessionId,
        provider_account_id: Option<ProviderAccountId>,
    ) -> Result<Vec<(String, String)>, Box<dyn Error + Send + Sync>> {
        let sources = &self.sources;
        let context = sources
            .ports
            .spawn_contexts
            .require_port()?
            .resolve_spawn_context(session_id, provider_account_id.clone())
            .await?;
        let account = context.account_folders.zip(provider_account_id.as_ref());
        Ok(self.process_environment(account, &context.every_project_rows, &context.project_rows)?)
    }

    // The session's stored leg, as the run engine reads it; `None` for a session that never ran.
    async fn read_session_leg(
        &self,
        session_id: SessionId,
    ) -> Result<Option<RuntimeBinding>, DriverError> {
        self.sources
            .ports
            .run_engine
            .require_port()
            .map_err(internal)?
            .read_session_leg(session_id)
            .await
            .map_err(DriverError::Internal)
    }
}
