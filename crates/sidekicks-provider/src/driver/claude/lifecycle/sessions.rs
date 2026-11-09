//! A session's life on Claude Code: its create, resume and the person's restart, a fork or a cut of
//! its conversation, a move to a new build, its close and the daemon's stop, its name, the purge
//! of its conversations, and the messages its process took.

use std::error::Error;
use std::path::PathBuf;

use futures::future::join_all;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::PathRules;
use sidekicks_std::mutex_lock::lock;
use tokio::time::{Instant, timeout_at};

use super::held_calls::{HELD_TASK_STOP_BOUND, stop_held_tasks};
use super::{ClaudeDriver, ClaudeSessionParts, internal};
use crate::driver::claude::delivery::mcp_tasks::restore::ClaudeHeldCallSettle;
use crate::driver::claude::delivery::requests::answers::claude_project_folder;
use crate::driver::claude::session::conversation_file::{
    conversation_file_of, find_claude_taken_messages,
};
use crate::driver::claude::session::conversation_home::read_claude_conversation_home;
use crate::driver::claude::session::errors::record_unheard_claude_failure;
use crate::driver::claude::session::establishment::ClaudeResumeAnswer;
use crate::driver::claude::session::naming::{
    name_claude_session, stored_claude_conversation, tell_claude_session_name,
};
use crate::driver::claude::session::purge::{ClaudePurgePlace, purge_claude_conversations};
use crate::driver::claude::session::restart::ClaudeSessionStanding;
use crate::driver::claude::session::restart::ended_process::{
    ClaudeEndedConversation, ended_conversation_of,
};
use crate::driver::claude::session::slots::{ClaudeCloseStart, ClaudeSlotClose};
use crate::driver::claude::session::state::{ClaudeSlotSettled, LiveClaudeSession};
use crate::driver::contract::error::DriverError;
use crate::driver::contract::params_and_results::SessionProcessState;
use crate::driver::daemon_stop::{DaemonStopIntent, run_until};
use crate::driver::diagnostics::DriverDiagnosticKind;
use crate::driver::rewind::{RewindConversationParams, RewindConversationResult};
use crate::driver::run_control::{FindTakenMessagesParams, TakenMessages};
use crate::driver::session_control::{
    CloseSessionParams, CreateSessionParams, DriverResumeResult, MoveSessionToForkParams,
    MoveSessionToForkResult, NameSessionParams, ProviderBuildChange, ProviderSessionHandle,
    PurgeSessionParams, ResumeSessionParams, SessionCloseCause,
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

    /// Resumes a session's conversation in a fresh process, every failure on the `Failed` arm and
    /// a resume whose runs in progress all wait on the person, are pausing, or stop on the
    /// `Deferred` one; a live process that answers it is sent the person's answers on the held
    /// lead's turn. Fails as that send fails.
    pub(crate) async fn resume_session(
        &self,
        params: ResumeSessionParams,
    ) -> Result<DriverResumeResult, DriverError> {
        let session_id = params.session_id;
        let answer = self.parts()?.establishment.resume(params).await?;
        self.send_held_lead_answers(session_id, answer).await
    }

    /// The person's restart of a session whose process stayed down: its crash window and any
    /// restart still waiting are dropped, it resumes, and the person is told it runs again only
    /// when a process started, not when a live one answered it or every run in progress waits on
    /// the person, is pausing, or stops.
    pub(crate) async fn restart_session(
        &self,
        params: ResumeSessionParams,
    ) -> Result<DriverResumeResult, DriverError> {
        let parts = self.parts()?;
        let session_id = params.session_id;
        parts.restarts.clear_crash_window(session_id);
        let answer = parts.establishment.resume(params).await?;
        if answer.has_started_process {
            parts.restarts.report_restarted(session_id, true).await;
        }
        self.send_held_lead_answers(session_id, answer).await
    }

    // `answer`'s result, once the live process it answered on is sent the person's answers on the
    // held lead's turn it names, where it names one. Fails as that send fails.
    async fn send_held_lead_answers(
        &self,
        session_id: SessionId,
        answer: ClaudeResumeAnswer,
    ) -> Result<DriverResumeResult, DriverError> {
        if let Some((turn, answers)) = answer.live_turn_to_continue {
            self.parts()?
                .run_controls
                .continue_held_lead(session_id, turn, answers)
                .await?;
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

    /// Closes the session: a restart waiting for it, its idle sleep, its inbox, its controls and
    /// its reviewer's blocks go, then its process is disposed of, after any transition in flight
    /// settles; a person's close first stops each background task of a tool server that outlives
    /// the process, on a session with no process in one resumed for those stops alone. Each run
    /// it still held ends as the daemon's intended close, and the `Allow once` presses its
    /// bindings held are let go. Its held tool-server calls still open then end as the close ends
    /// them, unless the daemon stops; last its command channel is removed. Under `DaemonStop` its
    /// runs and its review are left as they stand, for the stop's own settle.
    pub(crate) async fn close_session(
        &self,
        params: CloseSessionParams,
    ) -> Result<(), DriverError> {
        let session_id = params.session_id;
        let Some(parts) = self.composed_parts() else {
            // No process ran here, but the log may hold calls from before a restart of the daemon.
            self.settle_held_calls_at_rest(
                session_id,
                None,
                ClaudeHeldCallSettle::SessionClose,
                params.cause == SessionCloseCause::Person,
            )
            .await;
            return Ok(());
        };
        let mut close = begin_session_close(parts, params).await;
        while let Some(settled) = close.take_slot(parts) {
            settled.wait().await;
        }
        if close.cause == SessionCloseCause::Person
            && let Some(slot) = &close.slot
        {
            stop_surviving_tasks(parts, slot.session(), Instant::now() + HELD_TASK_STOP_BOUND)
                .await;
        }
        self.finish_session_close(parts, close, None).await;
        Ok(())
    }

    // Finishes `close` once its slot is the close's or empty: the process's channel closed, by
    // `deadline` where one is given, its routes retired and, unless the daemon stops, each run it
    // held ended as the daemon's intended close; then its held calls settled at rest, a person's
    // close of a session with no process stopping its surviving tasks first, its inbox released
    // and its command channel removed, by `deadline` too. A channel still open at the
    // deadline leaves its process quarantined, and a folder still being removed is left to the
    // next start's sweep.
    async fn finish_session_close(
        &self,
        parts: &ClaudeSessionParts,
        close: ClaudeSessionClose,
        deadline: Option<Instant>,
    ) {
        let ClaudeSessionClose {
            session_id,
            cause,
            conversation,
            slot,
        } = close;
        // A live process's surviving tasks were stopped on it before its channel closed.
        let stops_surviving_tasks = cause == SessionCloseCause::Person && slot.is_none();
        if let Some(slot) = slot {
            let is_closed = run_until(deadline, slot.close_channel()).await.is_ok();
            if !is_closed {
                tracing::warn!(
                    %session_id,
                    "a Claude Code process had not ended by the stop's deadline, so its session is \
                     left quarantined"
                );
            }
            // Read once the session's task has ended, so a turn Claude Code started by itself
            // while the close drained it is ended too.
            let routes = &parts.establishment.routes;
            let runs = routes.bound_runs_on(session_id);
            // Routes once the channel is closed, so a frame read before it still reaches its run,
            // and no later interrupt aims at a run of the dead process.
            routes.retire_run_routes(session_id);
            routes.forget_session_bindings(session_id);
            lock(&parts.establishment.prompts).forget_session(session_id);
            self.pending_compactions
                .release_binding(&session_id.to_string());
            // The daemon's stop settles its runs itself, so a run that should resume still can.
            if cause != SessionCloseCause::DaemonStop {
                for run in &runs {
                    if let Err(error) = parts.run_start.engine.end_turn_on_close(run.run_id).await {
                        record_unheard_claude_failure(
                            DriverDiagnosticKind::ProcessReportFailed,
                            session_id,
                            "the run end of a closed session",
                            &*error,
                        );
                    }
                }
            }
            slot.session()
                .release_served_presses(&self.sources.ports.reviewer_denials);
            if is_closed {
                slot.finish();
            }
        }
        // Once no process can be adopted, so a spawn the close waited for leaves no rows behind.
        parts
            .establishment
            .inspector_reads
            .forget_session(session_id);
        // Once the process's own exit settled what it held, so only what that left open is read.
        if !parts.restarts.is_stopped() {
            self.settle_held_calls_at_rest(
                session_id,
                conversation,
                ClaudeHeldCallSettle::SessionClose,
                stops_surviving_tasks,
            )
            .await;
        }
        // Again once the slot is gone, for a bring-up that bound the inbox after the first release.
        parts
            .establishment
            .task_services
            .inboxes
            .release(session_id);
        if run_until(deadline, self.close_command_channel(session_id))
            .await
            .is_err()
        {
            tracing::warn!(
                %session_id,
                "a Claude Code session's command channel was not removed by the stop's deadline, \
                 so the next start removes its folder"
            );
        }
    }

    // Removes the session's command channel once no process of it runs; a removal that fails is
    // logged, and the close goes on.
    async fn close_command_channel(&self, session_id: SessionId) {
        if let Err(error) = self.sources.command_channels.close(session_id).await {
            tracing::error!(
                %session_id,
                error = &error as &(dyn Error + 'static),
                "a closed Claude Code session's command channel could not be removed"
            );
        }
    }

    /// Ends every Claude Code process as the daemon stops, every wait ended by `deadline`, records
    /// each one-turn process's spend, and leaves each session's runs for the stop's own settle. A
    /// session still coming up or going down at the deadline is left to the process stop, which
    /// ends its process too.
    pub(crate) async fn shutdown(&self, intent: DaemonStopIntent, deadline: Instant) {
        let Some(parts) = self.composed_parts() else {
            self.starts.stop_every_process(deadline).await;
            return;
        };
        // No restart starts from here, and every slot reads closing before any process ends.
        parts.restarts.stop();
        parts.establishment.task_services.inboxes.release_all();
        let closes = join_all(parts.slots().session_ids().into_iter().map(|session_id| {
            begin_session_close(
                parts,
                CloseSessionParams {
                    session_id,
                    cause: SessionCloseCause::DaemonStop,
                },
            )
        }))
        .await;
        // Each slot a transition holds is waited out on its own, so one slow bring-up holds back
        // no other session's close.
        let closes: Vec<ClaudeSessionClose> =
            join_all(closes.into_iter().map(|mut close| async move {
                let is_taken = timeout_at(deadline, async {
                    while let Some(settled) = close.take_slot(parts) {
                        settled.wait().await;
                    }
                })
                .await
                .is_ok();
                if !is_taken {
                    tracing::warn!(
                        session_id = %close.session_id,
                        "a Claude Code session was still coming up or going down at the stop's \
                         deadline, so its process is left to the process stop"
                    );
                }
                is_taken.then_some(close)
            }))
            .await
            .into_iter()
            .flatten()
            .collect();
        if intent == DaemonStopIntent::Stop {
            join_all(closes.iter().filter_map(|close| {
                let slot = close.slot.as_ref()?;
                Some(stop_surviving_tasks(parts, slot.session(), deadline))
            }))
            .await;
        }
        self.starts.stop_every_process(deadline).await;
        // A one-turn process stopped with the rest records what it spent before the stop ends.
        if timeout_at(deadline, parts.session_controls.wait_for_recorded_turns())
            .await
            .is_err()
        {
            tracing::warn!(
                "a Claude Code one-turn process's spend was still being recorded at the stop's \
                 deadline"
            );
        }
        join_all(
            closes
                .into_iter()
                .map(|close| self.finish_session_close(parts, close, Some(deadline))),
        )
        .await;
    }

    /// Whether a run started on the session brings a process up: no process is live for it.
    pub(crate) fn starts_process(&self, session_id: SessionId) -> bool {
        self.composed_parts()
            .is_none_or(|parts| parts.slots().live_session(session_id).is_none())
    }

    /// Names the session from its first exchange; see the naming pass. The pass runs on the live
    /// process's account, else, at rest, on the one the session's stored leg ran on; a session that
    /// never ran answers `None`; its one-turn process's spend is recorded and priced as the
    /// session's own. Fails as the session pieces cannot be composed, as the stored leg cannot be
    /// read, and as the pass fails; the daemon registers the pieces' ports before any driver call.
    pub(crate) async fn name_session(
        &self,
        params: NameSessionParams,
    ) -> Result<Option<String>, DriverError> {
        let parts = self.parts()?;
        let live = parts.slots().live_session(params.session_id);
        let account = if let Some(live) = &live {
            live.admitted_provider_account_id()
        } else {
            let Some(leg) = self.read_session_leg(params.session_id).await? else {
                return Ok(None);
            };
            leg.spawn_config.provider_account_id
        };
        name_claude_session(
            live.as_deref(),
            &self.starts,
            &self.sources,
            &parts.session_controls,
            account,
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
            let Some(stored) = self.stored_conversation(session_id).await? else {
                return Ok(());
            };
            ended = Some(stored);
        }
        tell_claude_session_name(session_id, live.as_deref(), ended, name).await
    }

    /// The conversation the session's stored leg names, at rest on the account the leg ran on,
    /// which outlives a restart of the daemon; `None` for a session that never ran or whose leg
    /// names no conversation. Fails as the leg, the session's folder or its stored settings
    /// cannot be read.
    pub(super) async fn stored_conversation(
        &self,
        session_id: SessionId,
    ) -> Result<Option<ClaudeEndedConversation>, DriverError> {
        let Some(leg) = self.read_session_leg(session_id).await? else {
            return Ok(None);
        };
        let Some(handle) = leg.resume_handle else {
            return Ok(None);
        };
        stored_claude_conversation(
            &self.sources,
            session_id,
            leg.spawn_config.provider_account_id,
            handle,
            read_claude_conversation_home(&leg.runtime_metadata).as_deref(),
        )
        .await
        .map(Some)
    }

    /// The messages a process that ended took, read from the conversation it wrote: the live
    /// process's own, which resumed it, else the one the last ended process wrote. Fails as the
    /// file cannot be read, and when the driver knows no conversation of the session.
    pub(crate) async fn find_taken_messages(
        &self,
        params: FindTakenMessagesParams,
    ) -> Result<TakenMessages, DriverError> {
        let session_id = params.session_id;
        let conversation = self.last_conversation(session_id).ok_or_else(|| {
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

    /// Deletes Claude Code's own copy of each of the session's conversations from the home that
    /// holds it, its command channel removed first; see the conversation purge. A session with no
    /// conversation has nothing to delete.
    pub(crate) async fn purge_session(
        &self,
        params: PurgeSessionParams,
    ) -> Result<(), DriverError> {
        let sources = &self.sources;
        let session_id = params.session_id;
        self.close_command_channel(session_id).await;
        if let Some(parts) = self.composed_parts() {
            parts
                .establishment
                .inspector_reads
                .forget_session(session_id);
        }
        // The session's folder is the same on every account it ran on.
        let Some(first) = params.conversations.first() else {
            return Ok(());
        };
        let context = sources
            .ports
            .spawn_contexts
            .require_port()
            .map_err(internal)?
            .resolve_spawn_context(session_id, first.provider_account_id.clone())
            .await
            .map_err(DriverError::Internal)?;
        let repository = sources.read_repository(&context.working_directory).await?;
        let project_folder = claude_project_folder(&context.working_directory, repository.as_ref());
        let data_folder = sources.data_folder.to_string_lossy();
        let place = ClaudePurgePlace {
            project_folder: &project_folder,
            home_folder: &sources.home_folder,
            path_rules: PathRules::NATIVE,
            data_folder: &data_folder,
        };
        purge_claude_conversations(&params, &place, |provider_account_id| {
            self.account_home(session_id, provider_account_id)
        })
        .await
        .map_err(internal)
    }

    // The configuration home of `provider_account_id`'s account, as the session resolves it.
    async fn account_home(
        &self,
        session_id: SessionId,
        provider_account_id: ProviderAccountId,
    ) -> Result<PathBuf, Box<dyn Error + Send + Sync>> {
        let context = self
            .sources
            .ports
            .spawn_contexts
            .require_port()?
            .resolve_spawn_context(session_id, provider_account_id)
            .await?;
        Ok(context.account_folders.configuration_folder)
    }

    /// The session's stored leg, as the run engine reads it; `None` for a session that never ran.
    pub(super) async fn read_session_leg(
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

/// A session's close once what it held besides its process is forgotten: its process's slot, the
/// close's once no transition holds it, and the conversation its settle at rest reads.
struct ClaudeSessionClose {
    session_id: SessionId,
    cause: SessionCloseCause,
    conversation: Option<ClaudeEndedConversation>,
    slot: Option<ClaudeSlotClose>,
}

impl ClaudeSessionClose {
    // Takes the session's slot for the close, answering the settle cell of a transition that holds
    // it, to wait on and take it again. Once the slot is the close's, a `result` read from then on
    // ends its turn as the daemon's intended close, unless the daemon stops.
    fn take_slot(&mut self, parts: &ClaudeSessionParts) -> Option<ClaudeSlotSettled> {
        match parts.slots().begin_close(self.session_id) {
            ClaudeCloseStart::Empty => None,
            ClaudeCloseStart::Wait(settled) => Some(settled),
            ClaudeCloseStart::Closing(slot) => {
                if self.cause != SessionCloseCause::DaemonStop
                    && let Some(stream) = parts.establishment.streams.get(self.session_id)
                {
                    stream.signal_intended_close();
                }
                self.conversation = Some(ended_conversation_of(slot.session()));
                self.slot = Some(slot);
                None
            }
        }
    }
}

// Forgets what `params`' session held besides its process: a restart waiting for it, its idle
// sleep, its inbox, its controls, with its review finished unless the daemon stops, and its
// reviewer's blocks. The conversation of a process that ended here is read first.
async fn begin_session_close(
    parts: &ClaudeSessionParts,
    params: CloseSessionParams,
) -> ClaudeSessionClose {
    let session_id = params.session_id;
    // Read before the restarts forget it: the conversation of a process that ended here.
    let conversation = parts.restarts.ended_conversation(session_id);
    parts.restarts.forget_session(session_id);
    let task_services = &parts.establishment.task_services;
    task_services.idle_sleep.forget_session(session_id);
    task_services.inboxes.release(session_id);
    parts
        .session_controls
        .forget_session(session_id, params.cause != SessionCloseCause::DaemonStop)
        .await;
    parts.reviewer.forget_session(session_id);
    ClaudeSessionClose {
        session_id,
        cause: params.cause,
        conversation,
        slot: None,
    }
}

// Before the channel closes, tells Claude Code to stop each background task of a tool server still
// running for the closing `session`, the read of what Claude Code kept and the stops ended by
// `deadline`: a session that never resumes would otherwise leave it running with nobody following
// it.
async fn stop_surviving_tasks(
    parts: &ClaudeSessionParts,
    session: &LiveClaudeSession,
    deadline: Instant,
) {
    let session_id = session.session_id;
    let Some(stream) = parts.establishment.streams.get(session_id) else {
        return;
    };
    let stops = async {
        match stream.surviving_held_tasks().await {
            Ok(task_ids) => stop_held_tasks(&*session.channel, task_ids).await,
            Err(error) => tracing::warn!(
                %session_id,
                error = &error as &(dyn Error + 'static),
                "what Claude Code keeps of a closing session's background calls could not be \
                 read, so none of its tasks is stopped"
            ),
        }
    };
    if timeout_at(deadline, stops).await.is_err() {
        tracing::warn!(
            %session_id,
            "Claude Code had not answered every stop of a closed session's surviving tasks by \
             the close's deadline, so the stops still waiting are withdrawn"
        );
    }
}
