//! A session's life on Claude Code: its create, resume and the person's restart, a fork or a cut of
//! its conversation, a move to a new build, its close and the daemon's stop, its name, the purge
//! of its conversations, and the messages its process took.

use std::error::Error;

use futures::future::join_all;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::PathRules;

use super::{ClaudeDriver, internal};
use crate::mutex_lock::lock;
use crate::provider::driver::claude::delivery::requests::answers::claude_project_folder;
use crate::provider::driver::claude::session::conversation_file::find_claude_taken_messages;
use crate::provider::driver::claude::session::establishment::conversation_file_of;
use crate::provider::driver::claude::session::naming::{
    name_claude_session, tell_claude_session_name,
};
use crate::provider::driver::claude::session::purge::{
    ClaudePurgePlace, purge_claude_conversations,
};
use crate::provider::driver::claude::session::restart::ClaudeEndedConversation;
use crate::provider::driver::claude::session::slots::ClaudeCloseStart;
use crate::provider::driver::contract::DriverError;
use crate::provider::driver::daemon_stop::DaemonStopIntent;
use crate::provider::driver::rewind::{RewindConversationParams, RewindConversationResult};
use crate::provider::driver::run_control::{FindTakenMessagesParams, TakenMessages};
use crate::provider::driver::session_control::{
    CloseSessionParams, CreateSessionParams, DriverResumeResult, MoveSessionToForkParams,
    MoveSessionToForkResult, NameSessionParams, ProviderBuildChange, ProviderSessionHandle,
    PurgeSessionParams, ResumeSessionParams,
};
use crate::settle_all::settle_all;

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
        Ok(self.parts()?.establishment.resume(params).await)
    }

    /// The person's restart of a session whose process stayed down: its crash window and any
    /// restart still waiting are dropped, it resumes, and the person is told it runs again.
    pub(crate) async fn restart_session(
        &self,
        params: ResumeSessionParams,
    ) -> Result<DriverResumeResult, DriverError> {
        let parts = self.parts()?;
        let session_id = params.session_id;
        parts.restarts.clear_crash_window(session_id);
        let result = parts.establishment.resume(params).await;
        if matches!(result, DriverResumeResult::Resumed { .. }) {
            parts.restarts.report_restarted(session_id, true).await;
        }
        Ok(result)
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
    /// then its process is disposed of, after any transition in flight settles, and the `Allow
    /// once` presses its bindings held are let go; a session with no process needs nothing.
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
                    let routes = &parts.establishment.routes;
                    // Routes first, so no later interrupt aims at a run of the dying process.
                    routes.retire_run_routes(session_id);
                    routes.forget_session_bindings(session_id);
                    lock(&parts.establishment.prompts).forget_session(session_id);
                    self.pending_compactions
                        .release_binding(&session_id.to_string());
                    let session = close.session();
                    session.channel.close().await;
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

    /// Names the session from its first exchange; see the naming pass.
    pub(crate) async fn name_session(
        &self,
        params: NameSessionParams,
    ) -> Result<Option<String>, DriverError> {
        let live = self
            .composed_parts()
            .and_then(|parts| parts.slots().live_session(params.session_id));
        name_claude_session(live.as_deref(), &*self.starts, &self.sources, params).await
    }

    /// Tells Claude Code the session's name, on its live process or in its conversation at rest.
    pub(crate) async fn tell_session_name(
        &self,
        session_id: SessionId,
        name: String,
    ) -> Result<(), DriverError> {
        let parts = self.composed_parts();
        let live = parts.and_then(|parts| parts.slots().live_session(session_id));
        let ended = parts.and_then(|parts| parts.restarts.ended_conversation(session_id));
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
            .spawn_contexts
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
            .spawn_contexts
            .resolve_spawn_context(session_id, provider_account_id.clone())
            .await?;
        let account = context.account_folders.zip(provider_account_id.as_ref());
        Ok(self.process_environment(account, &context.every_project_rows, &context.project_rows)?)
    }
}
