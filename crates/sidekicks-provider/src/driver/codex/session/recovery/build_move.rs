//! Restarting a service on the program as it is now, after a Codex update, when the service asks
//! for a restart before it lists models or its supervisor asks for a planned restart, when the
//! executor running its commands ended, or when it left a purge's delete unanswered, with its
//! conversations resumed on the new process. An account's service restarts in place once every
//! session on it is idle, each held in its slot so no turn starts meanwhile. A terminal service,
//! which terminals the person joined share, gets a second service each conversation moves to as its
//! session goes idle: the conversation leaves the first, which unloads it, since Codex refuses to
//! resume one another service still writes, and the first is retired once no session is on it and
//! no conversation is held there for its commands; where the system cannot move the home's socket,
//! that restart ends once the second is asked for, which waits until the first is free to stop.
//! The person's own service is not the daemon's to restart; it is only dialed again.

use std::collections::hash_map::Entry;
use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::session::controls::events::SessionNotice;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_platforms::CAN_LINK_A_SOCKET;
use tokio::sync::oneshot;
use tokio::time::Instant;

use super::in_place_resume::CodexReleasedConversations;
use super::{CodexServiceRecovery, CodexWriterLeft, never_left};
use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::run::turn_end_waiters::CodexTurnWait;
use crate::driver::codex::service::home::CodexServiceKind;
use crate::driver::codex::service::supervisor::refusals::start_failure;
use crate::driver::codex::service::supervisor::{
    CODEX_UNLOAD_TIMEOUT, CodexService, CodexServiceId,
};
use crate::driver::codex::session::calls::{call_codex_session, wait_for_codex_turns};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::establishment::CodexInPlaceOutcome;
use crate::driver::codex::session::inbound::{CodexSessionCall, CodexSessionInboundSender};
use crate::driver::codex::session::slots::{CodexSessionClaim, let_go_codex_thread};
use crate::driver::codex::transport::diagnostics::CodexTransportDiagnostic;
use crate::driver::session_control::{DriverResumeResult, ProviderBuildChange};

impl CodexServiceRecovery {
    /// Moves every session on the driver's services onto the build that replaced the running one,
    /// each when its running reply ends or at once while idle, and tells each session moved; the
    /// person's own service stays on the build it runs. Answers once every move is under way.
    pub(crate) fn move_to_provider_build(self: &Arc<Self>, change: &ProviderBuildChange) {
        for service in self.dependencies.services.services() {
            if service.kind() == CodexServiceKind::Joined || service.attached_sessions().is_empty()
            {
                continue;
            }
            self.request_restart(&service, Some(change.clone()));
        }
    }

    /// Restarts `service` as [`Self::restart_service`] does on the driver's tasks, without waiting
    /// for it: a request while an earlier one has not ended joins that one, so one restart runs at
    /// a time per service, and a joined `change` runs once more after it. A failure no caller
    /// waits for is reported.
    pub(crate) fn request_restart(
        self: &Arc<Self>,
        service: &Arc<CodexService>,
        change: Option<ProviderBuildChange>,
    ) {
        self.enter_restart(service, change, None);
    }

    /// Restarts `service` as [`Self::request_restart`] does and answers once the restart it began
    /// or joined has ended, with the one a joined change runs. Fails as the last of them fails,
    /// read as a start's failure is.
    pub(crate) fn restart_and_wait(
        self: &Arc<Self>,
        service: &Arc<CodexService>,
        change: Option<ProviderBuildChange>,
    ) -> impl Future<Output = Result<(), CodexError>> + Send + use<> {
        let (ended, ending) = oneshot::channel();
        self.enter_restart(service, change, Some(ended));
        async move {
            match ending.await {
                Ok(restarted) => restarted.map_err(start_failure),
                Err(_unanswered) => Err(CodexError::Transport {
                    detail: "The Codex service's restart ended without an answer.".to_owned(),
                    cause: None,
                }),
            }
        }
    }

    /// Whether a restart [`Self::request_restart`] or [`Self::restart_and_wait`] began on the
    /// service `service_id` has not ended, or the terminal service's replacement it asked for has
    /// not taken its place.
    pub(crate) fn is_restarting(&self, service_id: CodexServiceId) -> bool {
        let state = self.lock();
        state.restarting.contains_key(&service_id) || state.replacing.contains_key(&service_id)
    }

    // Marks `service` restarting and spawns its restart, or joins the restart under way, `change`
    // kept for one more restart after it, the latest replacing an earlier one; `ended`, when given,
    // is told how the last restart ended.
    fn enter_restart(
        self: &Arc<Self>,
        service: &Arc<CodexService>,
        change: Option<ProviderBuildChange>,
        ended: Option<RestartEnded>,
    ) {
        let mut state = self.lock();
        match state.restarting.entry(service.id()) {
            Entry::Occupied(mut under_way) => {
                let under_way = under_way.get_mut();
                under_way.waiters.extend(ended);
                if change.is_some() {
                    under_way.joined_change = change;
                }
                return;
            }
            Entry::Vacant(slot) => {
                slot.insert(ServiceRestart {
                    joined_change: None,
                    waiters: ended.into_iter().collect(),
                });
            }
        }
        drop(state);
        let mark = RestartMark {
            recovery: Arc::clone(self),
            service: Arc::clone(service),
            is_removed: false,
        };
        self.dependencies.tasks.spawn(mark.run(change));
    }

    /// Restarts `service` on the program as it is now, its conversations resumed on the new
    /// process and each session told of `change` where a build move asked for one, and answers once
    /// the restart took hold: an account's in place once its sessions are idle, a terminal one
    /// once a second service took its place, and the person's own once it is dialed again. Fails as
    /// the new start or the redial fails.
    async fn restart_service(
        self: &Arc<Self>,
        service: &Arc<CodexService>,
        change: Option<ProviderBuildChange>,
    ) -> Result<(), CodexError> {
        match service.kind() {
            CodexServiceKind::Account => {
                self.restart_account_service(service, change.as_ref()).await
            }
            // Only one that serves is replaced, as its own planned restart replaces only one up.
            CodexServiceKind::Terminal if service.is_serving() && CAN_LINK_A_SOCKET => {
                self.replace_terminal_service(service, change).await
            }
            CodexServiceKind::Terminal if service.is_serving() => {
                self.replace_terminal_service_once_free(service, change);
                Ok(())
            }
            CodexServiceKind::Terminal => Ok(()),
            // The redial's recovery resumes its conversations as a reconnect does.
            CodexServiceKind::Joined => service.restart_planned().await,
        }
    }

    // Starts a second service in a terminal service's place and moves each session to it once
    // idle, each told of `change` once it resumed there; the first is retired once it holds none.
    // Fails as the second's start fails, the first then kept.
    async fn replace_terminal_service(
        self: &Arc<Self>,
        service: &Arc<CodexService>,
        change: Option<ProviderBuildChange>,
    ) -> Result<(), CodexError> {
        let replacement = self.dependencies.services.replace(service).await?;
        self.move_sessions_to(service, &replacement, change.as_ref());
        Ok(())
    }

    // Moves each session on `service` to `replacement` once idle, each told of `change` once it
    // resumed there, and retires `service` once it holds none.
    fn move_sessions_to(
        self: &Arc<Self>,
        service: &Arc<CodexService>,
        replacement: &Arc<CodexService>,
        change: Option<&ProviderBuildChange>,
    ) {
        let sessions = service.attached_sessions();
        if sessions.is_empty() {
            self.retire_when_empty(service);
        }
        for inbound in sessions {
            let recovery = Arc::clone(self);
            let from = Arc::clone(service);
            let to = Arc::clone(replacement);
            let change = change.cloned();
            self.dependencies.tasks.spawn(async move {
                recovery
                    .move_when_idle(&inbound, &from, &to, change.as_ref())
                    .await;
            });
        }
    }

    // Where the home's socket cannot be moved, the second service takes it only once the first is
    // free to stop, which lasts as long as the person's terminals stay inside it; so the restart
    // ends once the replacement is asked for, and the first reads as restarting until it is
    // replaced. A request while the replacement is under way asks nothing more, its `change`
    // replacing an earlier one, so the sessions moved once it lands are told of the latest build;
    // a failed replacement is reported.
    fn replace_terminal_service_once_free(
        self: &Arc<Self>,
        service: &Arc<CodexService>,
        change: Option<ProviderBuildChange>,
    ) {
        match self.lock().replacing.entry(service.id()) {
            Entry::Occupied(mut under_way) => {
                if change.is_some() {
                    *under_way.get_mut() = change;
                }
                return;
            }
            Entry::Vacant(slot) => {
                slot.insert(change);
            }
        }
        let mut mark = ReplacementMark {
            recovery: Arc::clone(self),
            service: Arc::clone(service),
            is_removed: false,
        };
        self.dependencies.tasks.spawn(async move {
            let replaced = mark
                .recovery
                .dependencies
                .services
                .replace(&mark.service)
                .await;
            let change = mark.take_change();
            match replaced {
                Ok(replacement) => {
                    mark.recovery
                        .move_sessions_to(&mark.service, &replacement, change.as_ref());
                }
                Err(error) => report_restart_failed(&mark.service, &error),
            }
        });
    }

    // Holds every session on an account's service in its slot once each is idle, restarts the
    // service, and resumes each conversation on the new process, each resume settled as a
    // recovery's is.
    async fn restart_account_service(
        &self,
        service: &Arc<CodexService>,
        change: Option<&ProviderBuildChange>,
    ) -> Result<(), CodexError> {
        // Sessions already held stay held while a busy one's turn ends, so none of them starts a
        // turn meanwhile; each round claims only the sessions not held yet.
        let mut held: Vec<(CodexSessionClaim<'_>, CodexSessionInboundSender)> = Vec::new();
        loop {
            let mut busy = None;
            for inbound in service.attached_sessions() {
                let session_id = inbound.session_id();
                if held
                    .iter()
                    .any(|(_claim, kept)| kept.session_id() == session_id)
                {
                    continue;
                }
                match self.claim_idle(&inbound).await {
                    ClaimedIdle::Idle(claim, _) => held.push((claim, inbound)),
                    ClaimedIdle::Busy => {
                        busy = Some(inbound);
                        break;
                    }
                    ClaimedIdle::Gone => {}
                }
            }
            let Some(busy) = busy else {
                break;
            };
            // A session that closed meanwhile is passed over on the next round.
            let _settled = wait_for_codex_turns(&busy, CodexTurnWait::Idle, None).await;
        }
        service.restart_planned().await?;
        self.dependencies.release.forget_service(service.id());
        for (claim, inbound) in held {
            let Some(outcome) = self
                .resume_claimed(service, &inbound, never_left(), None, None)
                .await
            else {
                continue;
            };
            let result = self.settle_resumed(service, &inbound, claim, outcome).await;
            self.report_moved(service, &inbound, result, change).await;
        }
        Ok(())
    }

    // Moves one session from `from` to `to` once it is idle, inside its slot, its resume settled as
    // a recovery's is, and tells it of `change` once it resumed there.
    async fn move_when_idle(
        &self,
        inbound: &CodexSessionInboundSender,
        from: &Arc<CodexService>,
        to: &Arc<CodexService>,
        change: Option<&ProviderBuildChange>,
    ) {
        loop {
            match self.claim_idle(inbound).await {
                ClaimedIdle::Idle(claim, thread_id) => {
                    let resumed = match self.move_claimed(inbound, from, to, thread_id).await {
                        Some(outcome) => {
                            Some(self.settle_resumed(to, inbound, claim, outcome).await)
                        }
                        None => None,
                    };
                    if let Some(result) = resumed {
                        let is_resumed = matches!(result, DriverResumeResult::Resumed { .. });
                        // The service the record runs on keeps the session; the other lets it go.
                        if is_resumed {
                            from.detach_session(&inbound.session_id());
                        } else {
                            to.detach_session(&inbound.session_id());
                        }
                        self.report_moved(to, inbound, result, change).await;
                    }
                    break;
                }
                ClaimedIdle::Busy => {
                    if wait_for_codex_turns(inbound, CodexTurnWait::Idle, None)
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                ClaimedIdle::Gone => break,
            }
        }
        self.retire_when_empty(from);
    }

    // Claims the session's slot and reads whether a turn is in flight on it and its conversation;
    // a busy session's slot is let go again, so its turn can end.
    async fn claim_idle(&self, inbound: &CodexSessionInboundSender) -> ClaimedIdle<'_> {
        let Ok(claim) = self
            .dependencies
            .slots
            .claim_establishing(inbound.session_id())
            .await
        else {
            return ClaimedIdle::Gone;
        };
        let reading = call_codex_session(inbound, |reply| CodexSessionCall::ReadSession {
            thread_id: None,
            reply,
        })
        .await;
        match reading {
            Ok(reading) if reading.is_turn_in_flight => ClaimedIdle::Busy,
            Ok(reading) => ClaimedIdle::Idle(claim, reading.thread_id),
            Err(_) => ClaimedIdle::Gone,
        }
    }

    // The move itself, the session's slot claimed: its conversations leave `from`, `thread_id`
    // unloading there first, then it resumes on `to`, tried again while `from` still writes it,
    // and each helper is reopened on `to` once `from` no longer holds it, since Codex refuses the
    // reopen meanwhile; answers the resume's outcome, `None` when the session closed or was
    // established anew.
    async fn move_claimed(
        &self,
        inbound: &CodexSessionInboundSender,
        from: &Arc<CodexService>,
        to: &Arc<CodexService>,
        thread_id: String,
    ) -> Option<CodexInPlaceOutcome> {
        let session_id = inbound.session_id();
        let deadline = Instant::now() + CODEX_UNLOAD_TIMEOUT;
        let released = self
            .dependencies
            .release
            .release_session_threads(from, &session_id, |released| released != thread_id)
            .await;
        to.attach_session(inbound.clone());
        let_go_codex_thread(from, &thread_id).await;
        if !from.await_unloaded(&thread_id, deadline).await {
            // Another client, such as a terminal the person joined, still holds it on the old
            // service; the resume goes ahead and Codex decides.
            CodexTransportDiagnostic::ConversationUnloadTimedOut {
                thread_id: thread_id.clone(),
            }
            .report();
        }
        let released = CodexReleasedConversations {
            service: Arc::clone(from),
            thread_ids: released,
            deadline,
            tasks: self.dependencies.tasks.clone(),
        };
        let leaving = Arc::clone(from);
        let writer_left: CodexWriterLeft = Box::new(move || {
            let leaving = Arc::clone(&leaving);
            let thread_id = thread_id.clone();
            async move { leaving.await_unloaded(&thread_id, deadline).await }.boxed()
        });
        self.resume_claimed(to, inbound, writer_left, None, Some(released))
            .await
    }

    // Tells a session it moved to `change`'s build once its conversation resumed there.
    async fn report_moved(
        &self,
        service: &CodexService,
        inbound: &CodexSessionInboundSender,
        result: DriverResumeResult,
        change: Option<&ProviderBuildChange>,
    ) {
        let session_id = inbound.session_id();
        let is_resumed = matches!(result, DriverResumeResult::Resumed { .. });
        let Some(change) = change.filter(|_| is_resumed) else {
            return;
        };
        let (Ok(from_version), Ok(to_version)) = (
            FreeFormText::new(change.from_version.clone()),
            FreeFormText::new(change.to_version.clone()),
        ) else {
            return;
        };
        self.post_notice(
            service,
            session_id,
            SessionNotice::ProviderUpdated {
                session_id,
                provider: DESCRIPTOR.provider_id(),
                from_version,
                to_version,
            },
        )
        .await;
    }

    // Stops a service a planned restart replaced once no session is on it and no conversation is
    // held there for its commands, which would end with it.
    fn retire_when_empty(&self, service: &Arc<CodexService>) {
        if !service.attached_sessions().is_empty() || !self.lock().retiring.insert(service.id()) {
            return;
        }
        let retiring = Arc::clone(service);
        let release = Arc::clone(&self.dependencies.release);
        let services = Arc::clone(&self.dependencies.services);
        self.dependencies.tasks.spawn(async move {
            release.when_none_held_on(retiring.id()).await;
            services.retire(&retiring).await;
        });
    }
}

/// Told how a restart ended, its failure shared by every caller that waited on it.
type RestartEnded = oneshot::Sender<Result<(), Arc<CodexError>>>;

/// A restart begun on a service that has not ended, with the callers waiting for its end.
pub(super) struct ServiceRestart {
    /// The build change a request brought while the restart ran, run in one more restart once it
    /// ends.
    joined_change: Option<ProviderBuildChange>,
    /// Each told how the last restart ended.
    waiters: Vec<RestartEnded>,
}

/// A service's restart mark, held by the task that runs its restarts. Dropped before that task
/// removed it, as a panic in a restart drops it, it removes the mark, so the service no longer
/// reads as restarting and each waiter, its sender dropped, hears the restart ended unanswered.
struct RestartMark {
    /// The recovery whose state holds the mark.
    recovery: Arc<CodexServiceRecovery>,
    /// The service restarting.
    service: Arc<CodexService>,
    /// Whether the task removed the mark itself, its waiters then told.
    is_removed: bool,
}

impl RestartMark {
    // Restarts the service, then once more with each change a request joined meanwhile, and tells
    // each waiter how the last restart ended; a failure no waiter heard is reported.
    async fn run(mut self, mut change: Option<ProviderBuildChange>) {
        let service_id = self.service.id();
        let (restarted, waiters) = loop {
            let restarted = self
                .recovery
                .restart_service(&self.service, change)
                .await
                .map_err(Arc::new);
            // Taken and cleared in one step, so a request between the two is never lost.
            let mut state = self.recovery.lock();
            let mut restart = state
                .restarting
                .remove(&service_id)
                .expect("the restart's own entry");
            let Some(joined) = restart.joined_change.take() else {
                self.is_removed = true;
                break (restarted, restart.waiters);
            };
            state.restarting.insert(service_id, restart);
            drop(state);
            if let Err(error) = &restarted {
                report_restart_failed(&self.service, error);
            }
            change = Some(joined);
        };
        let heard = waiters
            .into_iter()
            .filter_map(|waiter| waiter.send(restarted.clone()).ok())
            .count();
        if heard == 0
            && let Err(error) = &restarted
        {
            report_restart_failed(&self.service, error);
        }
    }
}

impl Drop for RestartMark {
    fn drop(&mut self) {
        if !self.is_removed {
            let _unanswered = self.recovery.lock().restarting.remove(&self.service.id());
        }
    }
}

/// A terminal service's replacement under way, held by the task that runs it; dropped before that
/// task removed it, as a panic drops it, it removes the service from those the recovery is
/// replacing.
struct ReplacementMark {
    /// The recovery whose state holds the mark.
    recovery: Arc<CodexServiceRecovery>,
    /// The service being replaced.
    service: Arc<CodexService>,
    /// Whether the task removed the mark itself.
    is_removed: bool,
}

impl ReplacementMark {
    // Removes the mark and answers the latest build change a request brought, in one step, so a
    // request between the two is never lost.
    fn take_change(&mut self) -> Option<ProviderBuildChange> {
        self.is_removed = true;
        self.recovery
            .lock()
            .replacing
            .remove(&self.service.id())
            .expect("the replacement's own entry")
    }
}

impl Drop for ReplacementMark {
    fn drop(&mut self) {
        if !self.is_removed {
            let _unanswered = self.recovery.lock().replacing.remove(&self.service.id());
        }
    }
}

/// A session's slot as a move found it.
enum ClaimedIdle<'slots> {
    /// Idle, held in its slot, on the conversation named.
    Idle(CodexSessionClaim<'slots>, String),
    /// A turn is in flight; the slot is let go.
    Busy,
    /// The session closed or was established anew.
    Gone,
}

fn report_restart_failed(service: &CodexService, error: &CodexError) {
    tracing::warn!(
        provider_account_id = service
            .provider_account_id()
            .as_ref()
            .map(ProviderAccountId::as_str),
        error = error as &(dyn std::error::Error + 'static),
        "a codex service could not be restarted on the program as it is now"
    );
}
