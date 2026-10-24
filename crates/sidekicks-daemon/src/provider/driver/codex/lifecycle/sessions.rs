//! A Codex session's life: its create, resume and the person's restart, a fork or a cut of its
//! conversation, a move to a new build, its close and the daemon's stop, the purge of its
//! conversations, and the messages a continue sent that Codex took.

use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::id::SessionId;

use super::{CODEX_SERVICE_STARTUP_TIMEOUT, CodexDriver};
use crate::provider::driver::codex::lifecycle::intake::{CodexLifecycleCall, call_codex_lifecycle};
use crate::provider::driver::codex::run::turn_end_waiters::CodexRecordExit;
use crate::provider::driver::codex::session::calls::call_codex_session;
use crate::provider::driver::codex::session::errors::{CodexError, CodexSessionSlotState};
use crate::provider::driver::codex::session::history::read_codex_turn_id_by_client_message_id;
use crate::provider::driver::codex::session::inbound::{
    CodexSessionCall, CodexSessionInboundSender,
};
use crate::provider::driver::codex::session::purge::purge_codex_conversations;
use crate::provider::driver::contract::DriverError;
use crate::provider::driver::daemon_stop::DaemonStopIntent;
use crate::provider::driver::rewind::{RewindConversationParams, RewindConversationResult};
use crate::provider::driver::run_control::{FindTakenMessagesParams, TakenMessages};
use crate::provider::driver::session_control::{
    CloseSessionParams, CreateSessionParams, DriverResumeResult, MoveSessionToForkParams,
    MoveSessionToForkResult, ProviderBuildChange, ProviderSessionHandle, PurgeSessionParams,
    ResumeSessionParams,
};
use crate::provider::usage_delta_accountant::UsageAxisCounts;

/// Lets `inbound`'s record go on its session's task as `exit`; a task that let it go first has
/// nothing more to let go.
pub(crate) async fn let_go_codex_session_record(
    inbound: &CodexSessionInboundSender,
    exit: CodexRecordExit,
) {
    let _gone =
        call_codex_lifecycle(inbound, |reply| CodexLifecycleCall::LetGo { exit, reply }).await;
}

impl CodexDriver {
    /// Opens a session on a fresh conversation on its account's service. Fails with
    /// `CodexError::SessionAlreadyLive` while the session holds a live record or a transition,
    /// and as the establishment fails, nothing left behind.
    pub(crate) async fn create_session(
        &self,
        params: CreateSessionParams,
    ) -> Result<ProviderSessionHandle, DriverError> {
        let parts = self.parts()?;
        let session_id = params.session_id;
        parts.slots.check_free(session_id)?;
        let claim = parts.slots.claim_establishing(session_id).await?;
        // A create that claimed the slot behind another create finds its record.
        if claim.live().is_some() {
            return Err(CodexError::SessionAlreadyLive {
                session_id,
                holder_state: CodexSessionSlotState::Live,
            }
            .into());
        }
        let (handle, established) = parts.establishment.create(&params).await?;
        let opened = parts.establishment.open(established, None).await;
        claim.install(opened.record.inbound.clone());
        self.spawn_session_task(parts, opened);
        Ok(handle)
    }

    /// Reopens a session's conversation on a fork carrying every setting it holds, the record it
    /// held let go first; every failure answers `Failed`. Fails with `CodexError::SessionClosed`
    /// when the session closed while the resume waited behind the close.
    pub(crate) async fn resume_session(
        &self,
        params: ResumeSessionParams,
    ) -> Result<DriverResumeResult, DriverError> {
        let parts = self.parts()?;
        let session_id = params.session_id;
        let claim = parts.slots.claim_establishing(session_id).await?;
        if let Some(inbound) = claim.live() {
            let_go_codex_session_record(&inbound, CodexRecordExit::SessionContinues).await;
            claim.vacate();
        }
        let forked = parts.establishment.resume_as_fork(&params).await;
        let Some(established) = forked.established else {
            return Ok(forked.result);
        };
        let prior_emitted = self.read_prior_emitted(session_id, &params.resume_handle);
        let opened = parts.establishment.open(established, prior_emitted).await;
        claim.install(opened.record.inbound.clone());
        self.spawn_session_task(parts, opened);
        Ok(forked.result)
    }

    /// The person's restart of a session whose service stayed down: the service starts again and
    /// its recovery resumes the session with the rest; a session the service holds no record of
    /// is resumed as a resume is. Fails as the service's start fails.
    pub(crate) async fn restart_session(
        &self,
        params: ResumeSessionParams,
    ) -> Result<DriverResumeResult, DriverError> {
        let parts = self.parts()?;
        let service = parts
            .registry
            .service_for(params.provider_account_id.as_ref())
            .await?;
        match parts
            .recovery
            .restart_for_person(&service, params.session_id)
            .await?
        {
            Some(result) => Ok(result),
            None => self.resume_session(params).await,
        }
    }

    /// Moves the live session onto a fork of its conversation after a recorded boundary. Fails
    /// with `CodexError::Transport` with no live record, and as the fork fails.
    pub(crate) async fn move_session_to_fork(
        &self,
        params: MoveSessionToForkParams,
    ) -> Result<MoveSessionToForkResult, DriverError> {
        let parts = self.parts()?;
        let claim = parts.slots.claim_establishing(params.session_id).await?;
        let Some(inbound) = claim.live() else {
            return Err(CodexError::Transport {
                detail: format!("No live Codex session for \"{}\".", params.session_id),
                cause: None,
            }
            .into());
        };
        let moved = call_codex_session(&inbound, |reply| CodexSessionCall::MoveToFork {
            params,
            reply,
        })
        .await??;
        Ok(moved)
    }

    /// Cuts the live conversation back to before the person's message; see the rewind.
    pub(crate) async fn rewind_conversation(
        &self,
        params: RewindConversationParams,
    ) -> Result<RewindConversationResult, DriverError> {
        Ok(self.parts()?.rewind.rewind(&params).await?)
    }

    /// Moves every session on the driver's services onto the build that replaced the running one;
    /// none is live before the session pieces are composed.
    pub(crate) fn move_to_provider_build(&self, change: &ProviderBuildChange) {
        if let Some(parts) = self.parts.get() {
            parts.recovery.move_to_provider_build(change);
        }
    }

    /// Deletes every conversation the session opened from its account's home, and its helpers'
    /// role files. Fails with every step that failed, after the rest were tried.
    pub(crate) async fn purge_session(
        &self,
        params: PurgeSessionParams,
    ) -> Result<(), DriverError> {
        purge_codex_conversations(
            &self.registry,
            &self.helper_roles_folder,
            CODEX_SERVICE_STARTUP_TIMEOUT,
            &params,
        )
        .await?;
        Ok(())
    }

    /// Closes the session: its command list, side questions and asks go, then, after any
    /// transition in flight settles, its close is marked on its record so a turn that ends now
    /// ends as closed, each run the record held ends as the daemon's intended close, and the
    /// record is let go; the conversations it moved off are released last. A session with no
    /// record needs nothing more.
    pub(crate) async fn close_session(
        &self,
        params: CloseSessionParams,
    ) -> Result<(), DriverError> {
        let Some(parts) = self.parts.get() else {
            return Ok(());
        };
        let session_id = params.session_id;
        parts.provider_commands.forget_session(session_id);
        parts.side_questions.forget_session(session_id).await;
        parts.hand_off.forget_session(session_id);
        let claim = parts.slots.claim_closing(session_id).await;
        if let Some(inbound) = claim.live() {
            // A task that let its record go first holds no run.
            let runs =
                call_codex_lifecycle(&inbound, |reply| CodexLifecycleCall::BeginClose { reply })
                    .await
                    .unwrap_or_default();
            for run_id in runs {
                if let Err(error) = parts.engine.end_turn_on_close(run_id).await {
                    tracing::warn!(
                        error = &error as &(dyn std::error::Error + 'static),
                        %session_id,
                        %run_id,
                        "the run of a closed codex session could not be ended"
                    );
                }
            }
            let_go_codex_session_record(&inbound, CodexRecordExit::SessionClosed).await;
        }
        claim.close();
        drop(claim);
        parts.release.forget_session(&session_id).await;
        parts.adoptions.forget_session(session_id);
        Ok(())
    }

    /// Stops every service the driver dials, then lets each live record go, so its session's task
    /// ends, and waits for the driver's tasks to end. A record let go once its service stopped
    /// sends nothing; a later daemon resumes the conversation by its handle.
    pub(crate) async fn shutdown(&self, intent: DaemonStopIntent) {
        self.tasks.close();
        self.registry.shutdown(intent).await;
        for session_id in self.slots.live_sessions() {
            let claim = self.slots.claim_closing(session_id).await;
            if let Some(inbound) = claim.live() {
                let_go_codex_session_record(&inbound, CodexRecordExit::SessionContinues).await;
                claim.vacate();
            }
        }
        self.tasks.wait().await;
    }

    /// Whether a run on `session_id` brings a Codex service up: `false` while the session's
    /// conversation is loaded on a service that runs.
    pub(crate) fn starts_process(&self, session_id: SessionId) -> bool {
        self.views
            .service(session_id)
            .is_none_or(|service| service.connection().is_err())
    }

    /// The messages of a continue Codex holds in the session's conversation. A continue sends its
    /// messages in one turn under the first one's id, so that id found means every message was
    /// taken. Fails with `CodexError::Transport` with no live record, and as the read fails.
    pub(crate) async fn find_taken_messages(
        &self,
        params: FindTakenMessagesParams,
    ) -> Result<TakenMessages, DriverError> {
        let Some(first) = params.message_ids.first() else {
            return Ok(TakenMessages { taken: Vec::new() });
        };
        let inbound = self.slots.require_live(params.session_id)?;
        let reading = call_codex_session(&inbound, |reply| CodexSessionCall::ReadSession {
            thread_id: None,
            reply,
        })
        .await?;
        let connection = reading.connection?;
        let turn_id_by_client_message_id =
            read_codex_turn_id_by_client_message_id(&connection, &reading.thread_id).await?;
        let taken: Vec<QueueItemId> =
            if turn_id_by_client_message_id.contains_key(&first.to_string()) {
                params.message_ids
            } else {
                Vec::new()
            };
        Ok(TakenMessages { taken })
    }

    // The spend the session's conversation emitted before its resume, which its usage is based
    // on; with no usage sink yet, or an unreadable record, the base starts at zero, logged.
    fn read_prior_emitted(
        &self,
        session_id: SessionId,
        thread_id: &str,
    ) -> Option<UsageAxisCounts> {
        let sink = self.ports.usage.port()?;
        match sink.read_prior_emitted(session_id, thread_id) {
            Ok(prior) => Some(prior),
            Err(error) => {
                tracing::warn!(
                    error = &*error as &(dyn std::error::Error + 'static),
                    %session_id,
                    "a resumed codex conversation's prior usage could not be read"
                );
                None
            }
        }
    }
}
