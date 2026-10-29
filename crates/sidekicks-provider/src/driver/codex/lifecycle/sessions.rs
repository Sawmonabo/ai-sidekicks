//! A Codex session's life: its create, resume and the person's restart, a fork or a cut of its
//! conversation, a move to a new build, its close and the daemon's stop, the purge of its
//! conversations, and the messages a continue sent that Codex took.

use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::id::SessionId;

use super::{CODEX_SERVICE_STARTUP_TIMEOUT, CodexDriver, CodexDriverParts};
use crate::driver::codex::run::turn_end_waiters::{CodexRecordExit, CodexTurnWait};
use crate::driver::codex::session::calls::{call_codex_session, wait_for_codex_turns};
use crate::driver::codex::session::errors::{CodexError, CodexSessionSlotState};
use crate::driver::codex::session::history::read_codex_turn_id_by_client_message_id;
use crate::driver::codex::session::inbound::{CodexSessionCall, CodexSessionInboundSender};
use crate::driver::codex::session::lifecycle_call::{
    CodexLifecycleCall, call_codex_lifecycle, let_go_codex_session_record,
};
use crate::driver::codex::session::purge::purge_codex_conversations;
use crate::driver::codex::session::slots::CODEX_LET_GO_TIMEOUT;
use crate::driver::contract::{DriverError, SessionProcessState};
use crate::driver::daemon_stop::DaemonStopIntent;
use crate::driver::rewind::{RewindConversationParams, RewindConversationResult};
use crate::driver::run_control::{FindTakenMessagesParams, TakenMessages};
use crate::driver::session_control::{
    CloseSessionParams, CreateSessionParams, DriverResumeResult, MoveSessionToForkParams,
    MoveSessionToForkResult, ProviderBuildChange, ProviderSessionHandle, PurgeSessionParams,
    ResumeSessionParams,
};
use crate::usage_delta_accountant::UsageAxisCounts;

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

    /// Reopens a session's conversation in place by its handle, the record it held let go first:
    /// joined as it runs where its service holds it loaded, else loaded again with every setting
    /// the session holds; every failure answers `Failed`. Fails with `CodexError::SessionClosed`
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
        let resumed = parts.establishment.resume_by_handle(&params).await;
        let Some(mut established) = resumed.established else {
            return Ok(resumed.result);
        };
        let prior_emitted = self
            .read_prior_emitted(session_id, &params.resume_handle)
            .await;
        for helper in established.restored_helpers_mut() {
            helper.prior_emitted = self
                .read_prior_emitted(session_id, &helper.thread_id)
                .await
                .unwrap_or_default();
        }
        let opened = parts.establishment.open(established, prior_emitted).await;
        claim.install(opened.record.inbound.clone());
        self.spawn_session_task(parts, opened);
        Ok(resumed.result)
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
            .service_for(&params.provider_account_id)
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

    /// Closes the session: its command list, side questions and asks go, and a live record's close
    /// is marked, so a turn that ends now ends as closed and no turn starts, and its turns are
    /// stopped; then, after any transition in flight settles, each run the record held ends as the
    /// daemon's intended close, and the record is let go; the conversations it moved off are
    /// released last. A session with no record needs nothing more.
    pub(crate) async fn close_session(
        &self,
        params: CloseSessionParams,
    ) -> Result<(), DriverError> {
        let Some(parts) = self.parts.get() else {
            return Ok(());
        };
        let session_id = params.session_id;
        parts.provider_commands.forget_session(session_id);
        parts.hand_off.forget_session(session_id);
        // Before the claim, which refuses run control while it holds the slot; a transition in
        // flight runs no turn. The side questions' copies are let go beside the session's own
        // interrupts, so a wedged service holds neither behind the other.
        let (mut runs, ()) = futures::join!(
            async {
                match parts.slots.require_live(session_id) {
                    Ok(inbound) => stop_closing_turns(parts, &inbound).await,
                    Err(_no_record) => Vec::new(),
                }
            },
            parts.side_questions.forget_session(session_id),
        );
        let claim = parts.slots.claim_closing(session_id).await;
        if let Some(inbound) = claim.live() {
            // A task that let its record go first holds no run. A run whose interrupted turn
            // already ended is held no more, and its end is the close's all the same.
            let held =
                call_codex_lifecycle(&inbound, |reply| CodexLifecycleCall::BeginClose { reply })
                    .await
                    .unwrap_or_default();
            for run_id in held {
                if !runs.contains(&run_id) {
                    runs.push(run_id);
                }
            }
            for run_id in runs {
                if let Err(error) = parts.engine.end_turn_on_close(run_id).await {
                    tracing::warn!(
                        error = &*error as &(dyn std::error::Error + 'static),
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
        self.limit_stopped_helpers.forget_session(session_id);
        self.forget_relayed_commands(session_id).await;
        Ok(())
    }

    /// Refuses every establishment from now on, stops every service the driver dials, then waits
    /// for each transition in flight and lets each live record go, so its session's task ends, and
    /// waits for the driver's tasks to end. A record let go once its service stopped sends
    /// nothing, no interrupt among it; a later daemon resumes the conversation by its handle.
    /// Every side question's copy is stopped first, since its service may outlive the daemon: a
    /// live session's copy whose turn started is let go here, a resting session's by its own
    /// task, and one still starting its turn by its ask.
    pub(crate) async fn shutdown(&self, intent: DaemonStopIntent) {
        self.tasks.close();
        self.slots.refuse_establishing();
        if let Some(parts) = self.parts.get() {
            parts.side_questions.stop_every_copy().await;
        }
        self.registry.shutdown(intent).await;
        for session_id in self.slots.held_sessions() {
            let claim = self.slots.claim_closing(session_id).await;
            if let Some(inbound) = claim.live() {
                let_go_codex_session_record(&inbound, CodexRecordExit::SessionContinues).await;
                claim.vacate();
            }
        }
        self.tasks.wait().await;
    }

    /// Where the session's process stands: a live record on a service that is up is `Live`; one
    /// being established again, or whose service is on its way back, is `Restarting`; anything
    /// else, a crash loop or a closing session included, is `Down`. A read of the driver's own
    /// tables.
    pub(crate) fn session_process_state(&self, session_id: SessionId) -> SessionProcessState {
        match self.slots.describe_holder(session_id) {
            Some(CodexSessionSlotState::Establishing) => SessionProcessState::Restarting,
            Some(CodexSessionSlotState::Closing) | None => SessionProcessState::Down,
            Some(CodexSessionSlotState::Live) => match self.views.service(session_id) {
                Some(service) if service.is_coming_back() => SessionProcessState::Restarting,
                Some(service) if service.is_serving() => SessionProcessState::Live,
                Some(_) | None => SessionProcessState::Down,
            },
        }
    }

    /// Whether a run on `session_id` brings a Codex service up: `false` while the session's
    /// conversation is loaded on a service that runs, or, with none loaded, while the service of
    /// `provider_account_id`, the account the run is admitted against, runs. A home that cannot
    /// be resolved reads as a start, which then fails on it.
    pub(crate) async fn starts_process(
        &self,
        session_id: SessionId,
        provider_account_id: ProviderAccountId,
    ) -> bool {
        let service = match self.views.service(session_id) {
            Some(service) => service,
            None => match self.registry.service_for(&provider_account_id).await {
                Ok(service) => service,
                Err(_) => return true,
            },
        };
        service.connection().is_err()
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
    async fn read_prior_emitted(
        &self,
        session_id: SessionId,
        thread_id: &str,
    ) -> Option<UsageAxisCounts> {
        let sink = self.ports.usage.port()?;
        match sink
            .read_prior_emitted(session_id, thread_id.to_owned())
            .await
        {
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

// Marks the close on the live record `inbound` reaches, so a turn that ends now ends as closed and
// a turn start is refused, then interrupts each run it holds through run control, since Codex keeps
// a turn running once no client is subscribed: a live turn is interrupted, and a start in flight is
// withdrawn, its turn interrupted once Codex names it. Codex answers an interrupt once the turn
// stopped, so the close waits for each answer and for the session to go idle within the let-go's
// bound, and past it goes on, logged. Answers the runs it interrupted.
async fn stop_closing_turns(
    parts: &CodexDriverParts,
    inbound: &CodexSessionInboundSender,
) -> Vec<RunId> {
    let session_id = inbound.session_id();
    // A task that let its record go first holds no run.
    let Ok(runs) =
        call_codex_lifecycle(inbound, |reply| CodexLifecycleCall::BeginClose { reply }).await
    else {
        return Vec::new();
    };
    let stopped = tokio::time::timeout(CODEX_LET_GO_TIMEOUT, async {
        futures::future::join_all(runs.iter().map(|run_id| async move {
            if let Err(error) = parts.run_control.interrupt_run(*run_id).await {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    %session_id,
                    %run_id,
                    "the turn of a closing codex session's run could not be interrupted"
                );
            }
        }))
        .await;
        // A record let go meanwhile has no turn left to wait for.
        let _idle = wait_for_codex_turns(inbound, CodexTurnWait::Idle, None).await;
    })
    .await;
    if stopped.is_err() {
        tracing::warn!(
            %session_id,
            "a closing codex session's turns did not stop within the close's bound"
        );
    }
    runs
}
