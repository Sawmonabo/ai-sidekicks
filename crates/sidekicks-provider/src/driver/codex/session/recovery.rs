//! What happens to a service's conversations when the service ends, comes back, is restarted or
//! moves to a new provider build: running turns end with the process, every conversation resumes
//! once it runs again, and the sessions hear what the person needs to: the crash loop that keeps
//! the service down, the person's restart that brought it back, and the build a move left them
//! on. The daemon's own restarts write no notice. The moves to a new build are in `build_move`.

mod build_move;
#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::sync::{Arc, Mutex, MutexGuard};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use serde::Deserialize;
use serde_json::value::RawValue;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::control::ProcessExit;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::controls::events::{SessionNotice, SessionNoticePostedPayload};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::oneshot;
use tokio_util::task::TaskTracker;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::delivery::frames::turns::codex_compaction_wait_key;
use crate::driver::codex::event_normalizer::CODEX_TURN_COMPLETED_METHOD;
use crate::driver::codex::notification_routing::CodexRoutedFrames;
use crate::driver::codex::rate_limits::CodexRateLimitFiling;
use crate::driver::codex::run::control::fail_codex_run;
use crate::driver::codex::run::turn_end_waiters::CodexRecordExit;
use crate::driver::codex::service::registry::CodexServiceRegistry;
use crate::driver::codex::service::supervisor::events::CodexServiceRecoveryCause;
use crate::driver::codex::service::supervisor::{CodexService, CodexServiceId};
use crate::driver::codex::session::calls::{
    CodexSessionCallDependencies, CodexSessionTask, call_codex_session,
};
use crate::driver::codex::session::conversation_release::CodexConversationRelease;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::establishment::CodexSessionEstablishment;
use crate::driver::codex::session::inbound::{CodexSessionCall, CodexSessionInboundSender};
use crate::driver::codex::session::slots::CodexSessionSlots;
use crate::driver::codex::transport::connection::read_codex_object;
use crate::driver::codex::transport::diagnostics::{CodexDeliveryPort, CodexTransportDiagnostic};
use crate::driver::codex::turn_evidence::CodexTurnStatus;
use crate::driver::contract::bound_failure_detail;
use crate::driver::delivery_dispatch::{DeliveryOrigin, dispatch_delivery};
use crate::driver::error_causes::UNSPECIFIED_PROVIDER_FAILURE_DETAIL;
use crate::driver::ports::{ProcessGoneListener, SessionRelaunchListener};
use crate::driver::session_control::{DriverResumeResult, ProviderBuildChange};
use crate::port::inbound_dispatch::InboundDispatch;
use crate::port::registration::PortRegistration;
use crate::port::reviewer_denial::ReviewerDenialPort;
use crate::port::run_host::RunHost;
use crate::run::delivery::InboundDelivery;

/// The words a run is failed with when its service ended with no exit the daemon could read.
const CODEX_EXIT_UNREAD_FAILURE: &str = "The Codex service ended";

/// What a process exit took from one session: the runs whose turns ended with it, and the binding
/// its conversation ran under.
pub(crate) struct CodexDroppedTurns {
    /// The runs, each once, oldest turn first.
    pub(crate) run_ids: Vec<RunId>,
    /// The binding, `None` before the session's first run.
    pub(crate) binding_id: Option<RuntimeBindingId>,
}

/// Answers whether the runtime that still wrote a conversation let it go, so a refused resume is
/// tried again; `false` ends the tries.
pub(crate) type CodexWriterLeft = Box<dyn FnMut() -> BoxFuture<'static, bool> + Send>;

/// One resume in place, as a call carries it to the session's task.
pub(crate) struct CodexInPlaceResumeCall {
    /// The establishment that resumes it.
    pub(crate) establishment: Arc<CodexSessionEstablishment>,
    /// The service it resumes on.
    pub(crate) service: Arc<CodexService>,
    /// Whether a refusing writer let the conversation go.
    pub(crate) writer_left: CodexWriterLeft,
}

/// What recovery acts through.
pub(crate) struct CodexServiceRecoveryDependencies {
    /// The sessions' slots, each resume claimed in its session's.
    pub(crate) slots: Arc<CodexSessionSlots>,
    /// The establishment, which resumes a conversation in place.
    pub(crate) establishment: Arc<CodexSessionEstablishment>,
    /// The services, which a build move replaces and retires.
    pub(crate) services: Arc<CodexServiceRegistry>,
    /// The conversations sessions moved off, held while their commands run.
    pub(crate) release: Arc<CodexConversationRelease>,
    /// The run engine's end of the turns a process left.
    pub(crate) run_ends: Arc<dyn RunHost>,
    /// The run engine's dispatch, which takes the sessions' notices and a lost run's end.
    pub(crate) dispatch: Arc<dyn InboundDispatch>,
    /// Lets a block's `Allow once` be pressed again once its process ended.
    pub(crate) reviewer_denials: Arc<PortRegistration<Arc<dyn ReviewerDenialPort>>>,
    /// The queue's intake of a session whose process ended.
    pub(crate) process_gone: Arc<PortRegistration<Arc<dyn ProcessGoneListener>>>,
    /// The session directory's intake of a resume recovery started.
    pub(crate) session_relaunched: Arc<PortRegistration<Arc<dyn SessionRelaunchListener>>>,
    /// The account's rate-limit readings, read again after each restart and reconnect.
    pub(crate) rate_limits: CodexRateLimitFiling,
    /// The driver's tracked tasks: the moves to a new build and a replaced service's retirement.
    pub(crate) tasks: TaskTracker,
}

/// What recovery remembers between a service's events, by service.
#[derive(Default)]
struct RecoveryState {
    // How each service's process last ended since it last ran again, which its crash loop's
    // banner names.
    last_exit: HashMap<CodexServiceId, ProcessExit>,
    // The sessions each service's crash loop told it stays down, owed the person's restart notice.
    held_by_crash_loop: HashMap<CodexServiceId, HashSet<SessionId>>,
    // The sessions whose person's restart waits for the resume the restart's recovery makes.
    restart_waits: HashMap<CodexServiceId, Vec<(SessionId, oneshot::Sender<DriverResumeResult>)>>,
    // The build a terminal service's planned restart moves its sessions to.
    pending_build_change: HashMap<CodexServiceId, ProviderBuildChange>,
    // The services a build move left, waiting for their held conversations to be let go.
    retiring: HashSet<CodexServiceId>,
    // The sessions each service that came back owes a resume, until its recovery resumed them.
    owed_resumes: HashMap<CodexServiceId, Vec<SessionId>>,
}

/// Keeps each service's conversations through its exits, restarts, reconnects and build moves.
pub(crate) struct CodexServiceRecovery {
    dependencies: CodexServiceRecoveryDependencies,
    state: Mutex<RecoveryState>,
}

impl CodexServiceRecovery {
    /// Recovery acting through `dependencies`.
    pub(crate) fn new(dependencies: CodexServiceRecoveryDependencies) -> Self {
        Self {
            dependencies,
            state: Mutex::new(RecoveryState::default()),
        }
    }

    /// Remembers `exit` as the service's last, for a crash loop's notice to name; called in the
    /// service's own event order, ahead of the exit's other work.
    pub(crate) fn remember_exit(&self, service: &CodexService, exit: ProcessExit) {
        self.lock().last_exit.insert(service.id(), exit);
    }

    /// Forgets the service's remembered exit once it runs again, so a later crash loop names only
    /// its own; called in the service's own event order.
    pub(crate) fn forget_exit(&self, service: &CodexService) {
        self.lock().last_exit.remove(&service.id());
    }

    /// Marks every session on a service that came back as owed its resume, in the service's own
    /// event order before the service reads as up, so none reads live and no move or run reaches
    /// its conversation until [`Self::recover`] claimed its slot.
    pub(crate) fn owe_resumes(&self, service: &CodexService) {
        let owed: Vec<SessionId> = service
            .attached_sessions()
            .iter()
            .map(CodexSessionInboundSender::session_id)
            .collect();
        for session_id in &owed {
            self.dependencies.slots.owe_resume(*session_id);
        }
        self.lock()
            .owed_resumes
            .entry(service.id())
            .or_default()
            .extend(owed);
    }

    /// Ends every turn the service's sessions held with its process, in the order a kept message
    /// needs: the sessions taken out of the daemon's provider processes, each run's turns ended,
    /// then the turns' safety holds, then the held presses of `Allow once` released, and only then
    /// the queue told the process is gone, which settles the messages the process kept. The
    /// conversations stay to be resumed. With no `exit` read, a lasting service a former daemon
    /// started, each run fails as a provider failure.
    pub(crate) async fn end_turns_on_exit(
        &self,
        service: &Arc<CodexService>,
        exit: Option<ProcessExit>,
    ) {
        self.dependencies
            .establishment
            .forget_service_process(service);
        for inbound in service.attached_sessions() {
            let session_id = inbound.session_id();
            let Ok(dropped) =
                call_codex_session(&inbound, |reply| CodexSessionCall::DropTurns { reply }).await
            else {
                // The session closed meanwhile; its close ended what it held.
                continue;
            };
            for run_id in &dropped.run_ids {
                self.end_run_on_exit(service, session_id, *run_id, exit.as_ref(), &dropped)
                    .await;
            }
            // A session whose task ended has no hold left to end.
            let _ended =
                call_codex_session(&inbound, |reply| CodexSessionCall::EndSafetyHolds { reply })
                    .await;
            if let (Some(binding_id), Some(denials)) = (
                &dropped.binding_id,
                self.dependencies.reviewer_denials.port(),
            ) {
                denials.release_held_presses(binding_id);
            }
            if let Some(listener) = self.dependencies.process_gone.port() {
                listener.process_gone(session_id);
            }
        }
        self.dependencies.release.forget_service(service.id());
    }

    /// Resumes every conversation of a service that runs again: after a crash, a reconnect or the
    /// person's restart of a crash loop. After a reconnect the conversations held for their running
    /// commands are subscribed to again first. Only the person's restart writes a notice: one
    /// `ProviderRestarted` on each session its crash loop held that the restart brought back.
    pub(crate) async fn recover(
        &self,
        service: &Arc<CodexService>,
        cause: CodexServiceRecoveryCause,
    ) {
        if cause == CodexServiceRecoveryCause::Reconnect {
            self.dependencies.release.resubscribe_service(service).await;
        }
        let resumed = self.resume_all(service).await;
        if cause == CodexServiceRecoveryCause::Reconnect {
            CodexTransportDiagnostic::ServiceReconnected {
                codex_home: service.home().codex_home.clone(),
                conversations: resumed
                    .iter()
                    .map(|(_, thread_id, _)| thread_id.clone())
                    .collect(),
            }
            .report();
        } else {
            tracing::info!(
                codex_home = %service.home().codex_home.display(),
                ?cause,
                conversations = resumed.len(),
                "the codex service runs again and its conversations resumed"
            );
        }
        if cause == CodexServiceRecoveryCause::PersonRestart {
            self.announce_person_restart(service, &resumed).await;
        }
        if let Err(error) = self.dependencies.rate_limits.read(service).await {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "the codex account's rate limits could not be read after its service came back"
            );
        }
    }

    /// Tells every session on a service that stays down after its crash window filled, naming how
    /// its process last ended, the newest end recovery read, else, for a loop of failed restarts
    /// after an end the daemon could not read, `start_failure`, the failure of the restart that
    /// filled the window. A loop with neither, whose ends no wait read, posts nothing. The queue
    /// hears each session's process gone first, so its next run opens it again.
    pub(crate) async fn crash_loop(
        &self,
        service: &Arc<CodexService>,
        start_failure: Option<&CodexError>,
    ) {
        let sessions = self.report_sessions_gone(service);
        let exit = {
            let mut state = self.lock();
            state
                .held_by_crash_loop
                .insert(service.id(), sessions.clone());
            state.last_exit.get(&service.id()).cloned()
        };
        let (exit_code, signal, start_failure) = match (exit, start_failure) {
            (Some(ProcessExit::Code(ended)), _) => (Some(ended.exit_code), None, None),
            (Some(ProcessExit::Signal(ended)), _) => (None, Some(ended.signal), None),
            (None, Some(failure)) => (
                None,
                None,
                Some(bound_failure_detail(
                    &failure.to_string(),
                    UNSPECIFIED_PROVIDER_FAILURE_DETAIL.clone(),
                )),
            ),
            (None, None) => {
                tracing::warn!(
                    codex_home = %service.home().codex_home.display(),
                    "a codex service stays down after a crash loop whose ends no wait read"
                );
                return;
            }
        };
        for session_id in sessions {
            self.post_notice(
                service,
                session_id,
                SessionNotice::ProviderCrashLoop {
                    session_id,
                    provider: DESCRIPTOR.provider_id(),
                    exit_code,
                    signal: signal.clone(),
                    start_failure: start_failure.clone(),
                },
            )
            .await;
        }
    }

    /// Tells the queue each session on a service that stays down, its start having failed, that
    /// its process is gone, so its next run opens it again.
    pub(crate) fn start_failed(&self, service: &CodexService) {
        self.report_sessions_gone(service);
    }

    // Tells the queue the process of every session on `service`, which stays down, is gone, and
    // answers those sessions. A resume the service owed them is let go first, so each reads down
    // by the notice and the queue forgets it.
    fn report_sessions_gone(&self, service: &CodexService) -> HashSet<SessionId> {
        let sessions: HashSet<SessionId> = service
            .attached_sessions()
            .iter()
            .map(CodexSessionInboundSender::session_id)
            .collect();
        let owed = self.lock().owed_resumes.remove(&service.id());
        for session_id in owed.into_iter().flatten() {
            self.dependencies.slots.settle_resume(session_id);
        }
        if let Some(listener) = self.dependencies.process_gone.port() {
            for session_id in &sessions {
                listener.process_gone(*session_id);
            }
        }
        sessions
    }

    /// The person's restart of `session_id`'s service: one its crash loop left down starts again
    /// and its recovery resumes every conversation on it, this session's among them, whose result
    /// it answers; on a service that runs, the session's conversation is resumed in place. `None`
    /// when the session holds no live record on the service. Fails as the start fails.
    pub(crate) async fn restart_for_person(
        &self,
        service: &Arc<CodexService>,
        session_id: SessionId,
    ) -> Result<Option<DriverResumeResult>, CodexError> {
        let (answer, answered) = oneshot::channel();
        let is_crash_looped = {
            let mut state = self.lock();
            let is_crash_looped = state.held_by_crash_loop.contains_key(&service.id());
            if is_crash_looped {
                state
                    .restart_waits
                    .entry(service.id())
                    .or_default()
                    .push((session_id, answer));
            }
            is_crash_looped
        };
        service.restart();
        if let Err(error) = service
            .ensure_started(service.dependencies().startup_timeout)
            .await
        {
            if let Some(waits) = self.lock().restart_waits.get_mut(&service.id()) {
                waits.retain(|(waiting, _)| *waiting != session_id);
            }
            return Err(error);
        }
        if is_crash_looped {
            // Dropped unanswered when the recovery found no record of the session.
            return Ok(answered.await.ok());
        }
        let Some(inbound) = service
            .attached_sessions()
            .into_iter()
            .find(|inbound| inbound.session_id() == session_id)
        else {
            return Ok(None);
        };
        Ok(self.resume_session(service, &inbound, never_left()).await)
    }

    /// Resumes every conversation the service holds, each inside its session's slot, reports each
    /// relaunch and answers each resumed session with its conversation and result.
    async fn resume_all(
        &self,
        service: &Arc<CodexService>,
    ) -> Vec<(SessionId, String, DriverResumeResult)> {
        let mut resumed = Vec::new();
        for inbound in service.attached_sessions() {
            let session_id = inbound.session_id();
            let Some(result) = self.resume_session(service, &inbound, never_left()).await else {
                continue;
            };
            let waits = self
                .lock()
                .restart_waits
                .get_mut(&service.id())
                .map(|waits| {
                    let (answered, waiting) = waits
                        .drain(..)
                        .partition(|(waiting, _)| *waiting == session_id);
                    *waits = waiting;
                    answered
                })
                .unwrap_or_default();
            for (_, answer) in waits {
                let _unheard = answer.send(result.clone());
            }
            let thread_id = match &result {
                DriverResumeResult::Resumed { resume_handle, .. } => {
                    resume_handle.as_str().to_owned()
                }
                DriverResumeResult::Failed { .. } => String::new(),
            };
            resumed.push((session_id, thread_id, result));
        }
        // A person's restart waiting on a session with no record here answers `None`, and a
        // session owed a resume that moved off the service meanwhile owes it no longer.
        let owed = {
            let mut state = self.lock();
            state.restart_waits.remove(&service.id());
            state.owed_resumes.remove(&service.id())
        };
        for session_id in owed.into_iter().flatten() {
            self.dependencies.slots.settle_resume(session_id);
        }
        resumed
    }

    // Resumes one session's conversation in place on `service` inside its slot and reports the
    // relaunch; `None` when the session closed or was established anew meanwhile.
    async fn resume_session(
        &self,
        service: &Arc<CodexService>,
        inbound: &CodexSessionInboundSender,
        writer_left: CodexWriterLeft,
    ) -> Option<DriverResumeResult> {
        let session_id = inbound.session_id();
        let claimed = self.dependencies.slots.claim_establishing(session_id).await;
        // From here its claim reads it re-established, or it closed meanwhile.
        self.dependencies.slots.settle_resume(session_id);
        let claim = claimed.ok()?;
        let result = self.resume_claimed(service, inbound, writer_left).await;
        drop(claim);
        let result = result?;
        self.report_relaunch(service, session_id, result.clone())
            .await;
        Some(result)
    }

    // The resume itself, the session's slot already claimed.
    async fn resume_claimed(
        &self,
        service: &Arc<CodexService>,
        inbound: &CodexSessionInboundSender,
        writer_left: CodexWriterLeft,
    ) -> Option<DriverResumeResult> {
        let resume = CodexInPlaceResumeCall {
            establishment: Arc::clone(&self.dependencies.establishment),
            service: Arc::clone(service),
            writer_left,
        };
        call_codex_session(inbound, |reply| CodexSessionCall::ResumeInPlace {
            resume: Box::new(resume),
            reply,
        })
        .await
        .ok()
    }

    // Hands the relaunch to the session directory, which records its binding; a failed resume is
    // logged, as the person sees it on the session's next request.
    async fn report_relaunch(
        &self,
        service: &CodexService,
        session_id: SessionId,
        result: DriverResumeResult,
    ) {
        if let DriverResumeResult::Failed {
            provider_failure_detail,
            ..
        } = &result
        {
            tracing::warn!(
                %session_id,
                detail = provider_failure_detail.as_str(),
                "a codex conversation could not be resumed after its service came back"
            );
        }
        let Some(listener) = self.dependencies.session_relaunched.port() else {
            return;
        };
        if let Err(error) = listener.session_relaunched(session_id, result).await {
            CodexTransportDiagnostic::PortDeliveryFailed {
                provider_account_id: service.home().provider_account_id.clone(),
                port: CodexDeliveryPort::SessionRelaunched,
                session_id: Some(session_id),
                error,
            }
            .report();
        }
    }

    // `ProviderRestarted` on each session the crash loop held that the person's restart resumed.
    async fn announce_person_restart(
        &self,
        service: &Arc<CodexService>,
        resumed: &[(SessionId, String, DriverResumeResult)],
    ) {
        let held = self
            .lock()
            .held_by_crash_loop
            .remove(&service.id())
            .unwrap_or_default();
        for (session_id, _, result) in resumed {
            if held.contains(session_id) && matches!(result, DriverResumeResult::Resumed { .. }) {
                self.post_notice(
                    service,
                    *session_id,
                    SessionNotice::ProviderRestarted {
                        session_id: *session_id,
                        provider: DESCRIPTOR.provider_id(),
                    },
                )
                .await;
            }
        }
    }

    // Ends one run whose turns the exit took: through the run engine with the exit read, else
    // failed as a provider failure on the session's binding.
    async fn end_run_on_exit(
        &self,
        service: &CodexService,
        session_id: SessionId,
        run_id: RunId,
        exit: Option<&ProcessExit>,
        dropped: &CodexDroppedTurns,
    ) {
        match exit {
            Some(exit) => {
                if let Err(error) = self
                    .dependencies
                    .run_ends
                    .end_turn_on_process_exit(run_id, exit.clone())
                    .await
                {
                    CodexTransportDiagnostic::PortDeliveryFailed {
                        provider_account_id: service.home().provider_account_id.clone(),
                        port: CodexDeliveryPort::RunEnd,
                        session_id: Some(session_id),
                        error,
                    }
                    .report();
                }
            }
            None => {
                if let Some(binding_id) = &dropped.binding_id {
                    let error = CodexError::Transport {
                        detail: "The Codex service ended, and how it ended could not be read."
                            .to_owned(),
                        cause: None,
                    };
                    fail_codex_run(
                        &*self.dependencies.dispatch,
                        run_id,
                        binding_id.clone(),
                        CODEX_EXIT_UNREAD_FAILURE,
                        &error,
                    )
                    .await;
                }
            }
        }
    }

    // Posts `notice` on the session; the process that would order it among its rows is gone.
    async fn post_notice(
        &self,
        service: &CodexService,
        session_id: SessionId,
        notice: SessionNotice,
    ) {
        Box::pin(dispatch_delivery(
            &*self.dependencies.dispatch,
            DeliveryOrigin {
                provider: DESCRIPTOR.provider_id(),
                provider_account_id: service.home().provider_account_id.clone(),
                raw_wire_type: None,
            },
            InboundDelivery::SessionNotice {
                session_id,
                notice: SessionNoticePostedPayload::Notice(notice),
            },
        ))
        .await;
    }

    fn lock(&self) -> MutexGuard<'_, RecoveryState> {
        lock(&self.state)
    }
}

// A resume that never waits for another writer: after a crash or a reconnect, nothing else holds
// the conversation.
fn never_left() -> CodexWriterLeft {
    Box::new(|| async { false }.boxed())
}

/// Drops every turn the session held on a service whose process ended, on the session's task:
/// the live, interrupted, paused and retried turns with their routes, pauses and continues, the
/// compaction wait on the conversation and the waits on its turns, which no turn ends now.
/// Answers each run those turns belonged to, once.
pub(crate) fn drop_codex_turns(
    task: &mut CodexSessionTask<'_>,
    dependencies: &CodexSessionCallDependencies,
) -> CodexDroppedTurns {
    let record = &mut *task.record;
    let mut run_ids: Vec<RunId> = Vec::new();
    let held = record
        .active_turns
        .drain(..)
        .chain(record.interrupted_run_by_turn_id.drain(..))
        .chain(record.paused_run_id_by_interrupted_turn_id.drain())
        .chain(record.delivery.retried_run_id_by_turn_id.drain());
    for (_, run_id) in held {
        if !run_ids.contains(&run_id) {
            run_ids.push(run_id);
        }
    }
    record.continues_awaiting_pause.clear();
    record.pause_run_id_by_turn_id.clear();
    record.interrupting_turn_ids.clear();
    record.turn_input_by_turn_id.clear();
    record.delivery.unowned_turn_ids.clear();
    dependencies
        .runs
        .run_routes
        .forget_run_routes(record.session_id);
    dependencies
        .forks
        .pending_compactions
        .release_binding(&codex_compaction_wait_key(record, &record.thread_id));
    task.waiters
        .abandon(record.session_id, CodexRecordExit::SessionContinues);
    CodexDroppedTurns {
        run_ids,
        binding_id: record.binding_id.clone(),
    }
}

/// Resumes the session's conversation in place on the session's task, then ends each turn the
/// session still owed an end that the resume lists as over: its `turn/completed` was sent while
/// the daemon was not connected, and Codex sends none again. Answers the resume's result and the
/// frames its routing released.
pub(crate) async fn resume_codex_session_in_place(
    task: &mut CodexSessionTask<'_>,
    dependencies: &CodexSessionCallDependencies,
    resume: CodexInPlaceResumeCall,
) -> (DriverResumeResult, CodexRoutedFrames) {
    let CodexInPlaceResumeCall {
        establishment,
        service,
        writer_left,
    } = resume;
    let resumed = establishment
        .resume_in_place(task, service, writer_left)
        .await;
    let mut routed = resumed.routed;
    for listed in resumed.listed_turns {
        let is_owed = task.record.active_turn_run(&listed.id).is_some()
            || task.record.ending_turn_ids().contains(&listed.id.as_str());
        if !is_owed || is_turn_in_progress(&listed.turn) {
            continue;
        }
        let Some(params) = compose_turn_completed_params(&task.record.thread_id, &listed.turn)
        else {
            continue;
        };
        let ended = task
            .routing
            .route_notification(
                &dependencies.forks.delivery,
                task.record,
                CODEX_TURN_COMPLETED_METHOD.to_owned(),
                params,
            )
            .await;
        routed.extend(ended);
    }
    (resumed.result, routed)
}

// Whether a listed turn still runs.
fn is_turn_in_progress(turn: &RawValue) -> bool {
    #[derive(Deserialize)]
    struct ListedTurnStatus {
        status: Option<String>,
    }
    read_codex_object::<ListedTurnStatus>(turn.get())
        .and_then(|listed| listed.status)
        .and_then(|status| CodexTurnStatus::read(&status))
        == Some(CodexTurnStatus::InProgress)
}

// The params of the `turn/completed` Codex sent for a listed turn: the conversation and the turn.
fn compose_turn_completed_params(thread_id: &str, turn: &RawValue) -> Option<Box<RawValue>> {
    let thread_id = serde_json::to_string(thread_id).ok()?;
    RawValue::from_string(format!(
        r#"{{"threadId":{thread_id},"turn":{}}}"#,
        turn.get()
    ))
    .ok()
}
