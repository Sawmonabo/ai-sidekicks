//! Restarting a service on the program as it is now, after a Codex update, when the service asks
//! for a restart before it lists models or its supervisor asks for a planned restart, when the
//! executor running its commands ended, or when it left a purge's delete unanswered, with its
//! conversations resumed on the new process. A new build, on an account's service and on the
//! terminal service alike, gets a second service started beside the first, which each
//! conversation moves to once its session's running reply ends, so no session waits on another's
//! turn: the conversation leaves the first, which unloads it, since Codex refuses to resume one
//! another service still writes, and the first is retired once no session is on it, no move toward
//! it is under way and no conversation is held there for its commands. Each session moves to the
//! home's service as it is when the session goes idle, so a second build move meanwhile takes it
//! straight to the newest. Where the system cannot move the terminal home's socket, that restart
//! ends once the second is asked for, which waits until the first is free to stop. A service whose
//! executor ended or that left a delete unanswered restarts in place once every session on it is
//! idle, each held in its slot so no turn starts meanwhile, and so does an account's service not
//! serving, which runs no turn. The person's own service is not the daemon's to restart; it is
//! only dialed again.

use std::collections::hash_map::Entry;
use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::session::controls::events::SessionNotice;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_platforms::CAN_LINK_A_SOCKET;
use tokio::sync::oneshot;
use tokio::time::Instant;

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
use crate::spawned_version::parse_cli_version_report;

/// How a restart of a service runs.
#[derive(Clone, Debug)]
pub(crate) enum CodexServiceRestart {
    /// The service stops and starts again in place once every session on it is idle, each held in
    /// its slot meanwhile: its executor ended, or it left a request unanswered.
    InPlace,
    /// A second service starts beside it on the build the program resolves to now, and each
    /// session moves to it once its running reply ends, told of the build change where one is
    /// named.
    Beside(Option<ProviderBuildChange>),
}

impl CodexServiceRecovery {
    /// Moves every session on each of the driver's services that serves another build than the
    /// installed one, `change`'s, onto it, each when its running reply ends or at once while idle,
    /// and tells each session moved; the person's own service stays on the build it runs, and so
    /// does one whose version did not parse, which no build compares with. Each call moves every
    /// service not on the installed build, so one whose second could not start keeps serving and
    /// is moved at the next call. Answers once every move is under way.
    pub(crate) fn move_to_provider_build(self: &Arc<Self>, change: &ProviderBuildChange) {
        for service in self.dependencies.services.services() {
            if service.kind() == CodexServiceKind::Joined
                || service.attached_sessions().is_empty()
                || !is_behind_build(&service, &change.to_version)
            {
                continue;
            }
            self.request_restart(&service, CodexServiceRestart::Beside(Some(change.clone())));
        }
    }

    /// Restarts `service` as [`Self::restart_service`] does on the driver's tasks, without waiting
    /// for it: a request while an earlier one has not ended joins that one, so one restart runs at
    /// a time per service, and a joined build change runs once more after it. A failure no caller
    /// waits for is reported.
    pub(crate) fn request_restart(
        self: &Arc<Self>,
        service: &Arc<CodexService>,
        restart: CodexServiceRestart,
    ) {
        self.enter_restart(service, restart, Vec::new());
    }

    /// Restarts `service` as [`Self::request_restart`] does and answers once the restart it began
    /// or joined has ended, with the one a joined change runs. Fails as the last of them fails,
    /// read as a start's failure is.
    pub(crate) fn restart_and_wait(
        self: &Arc<Self>,
        service: &Arc<CodexService>,
        restart: CodexServiceRestart,
    ) -> impl Future<Output = Result<(), CodexError>> + Send + use<> {
        let (ended, ending) = oneshot::channel();
        self.enter_restart(service, restart, vec![ended]);
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

    // Marks `service` restarting and spawns its restart, or joins the restart under way, a build
    // change `restart` names kept for one more restart after it, the latest replacing an earlier
    // one; each of `ended` is told how the last restart ended.
    fn enter_restart(
        self: &Arc<Self>,
        service: &Arc<CodexService>,
        restart: CodexServiceRestart,
        ended: Vec<RestartEnded>,
    ) {
        let mut state = self.lock();
        match state.restarting.entry(service.id()) {
            Entry::Occupied(mut under_way) => {
                let under_way = under_way.get_mut();
                under_way.waiters.extend(ended);
                // The restart under way starts the program as it is now, so only a change it
                // must tell the sessions of runs again.
                if let CodexServiceRestart::Beside(Some(change)) = restart {
                    under_way.joined_change = Some(change);
                }
                return;
            }
            Entry::Vacant(slot) => {
                slot.insert(ServiceRestart {
                    joined_change: None,
                    waiters: ended,
                });
            }
        }
        drop(state);
        let mark = RestartMark {
            recovery: Arc::clone(self),
            service: Arc::clone(service),
            is_removed: false,
        };
        self.dependencies.tasks.spawn(mark.run(restart));
    }

    /// Restarts `service` on the program as it is now, its conversations resumed on the new
    /// process and each session told of the build change where a build move names one, and answers
    /// once the restart took hold: a serving service asked to restart beside once a second service
    /// took its place, a service asked to restart in place, and an account's service not serving,
    /// once it is back with its sessions idle, and the person's own once it is dialed again. A
    /// terminal service not serving asked to restart beside is left as it is and answers at once.
    /// Fails as the new start or the redial fails.
    async fn restart_service(
        self: &Arc<Self>,
        service: &Arc<CodexService>,
        restart: CodexServiceRestart,
    ) -> Result<(), CodexError> {
        match (service.kind(), restart) {
            // The redial's recovery resumes its conversations as a reconnect does.
            (CodexServiceKind::Joined, _) => service.restart_planned().await,
            // Only one that serves is replaced; one down runs no turn to wait on.
            (CodexServiceKind::Account, CodexServiceRestart::Beside(change))
                if service.is_serving() =>
            {
                self.replace_service(service, change).await
            }
            (CodexServiceKind::Account, CodexServiceRestart::Beside(change)) => {
                self.restart_in_place(service, change.as_ref()).await
            }
            // Only one that serves is replaced, as its own planned restart replaces only one up.
            (CodexServiceKind::Terminal, CodexServiceRestart::Beside(change))
                if service.is_serving() && CAN_LINK_A_SOCKET =>
            {
                self.replace_service(service, change).await
            }
            (CodexServiceKind::Terminal, CodexServiceRestart::Beside(change))
                if service.is_serving() =>
            {
                self.replace_terminal_service_once_free(service, change);
                Ok(())
            }
            (CodexServiceKind::Terminal, CodexServiceRestart::Beside(_)) => Ok(()),
            (
                CodexServiceKind::Account | CodexServiceKind::Terminal,
                CodexServiceRestart::InPlace,
            ) => self.restart_in_place(service, None).await,
        }
    }

    // Starts a second service beside `service` and moves each session to the home's service once
    // idle, each told of `change` once it resumed there; the first is retired once it holds none.
    // Fails as the second's start fails, the first then kept.
    async fn replace_service(
        self: &Arc<Self>,
        service: &Arc<CodexService>,
        change: Option<ProviderBuildChange>,
    ) -> Result<(), CodexError> {
        let replacement = self.dependencies.services.replace(service).await?;
        self.move_sessions_to(service, &replacement, change.as_ref());
        Ok(())
    }

    // Moves each session on `service` to the home's service once idle, each told of `change`, the
    // one that started `replacement`, once it resumed there, and retires `service` once it holds
    // none.
    fn move_sessions_to(
        self: &Arc<Self>,
        service: &Arc<CodexService>,
        replacement: &CodexService,
        change: Option<&ProviderBuildChange>,
    ) {
        self.lock()
            .replacement_changes
            .insert(replacement.id(), change.cloned());
        let sessions = service.attached_sessions();
        if sessions.is_empty() {
            self.retire_when_empty(service);
        }
        for inbound in sessions {
            let recovery = Arc::clone(self);
            let from = Arc::clone(service);
            let change = change.cloned();
            self.dependencies.tasks.spawn(async move {
                recovery.move_when_idle(&inbound, from, change).await;
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

    // Holds every session on `service` in its slot once each is idle, stops and starts the service
    // in place, and resumes each conversation on the new process, each resume settled as a
    // recovery's is.
    async fn restart_in_place(
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
                    ClaimedIdle::Idle(claim, _, _) => held.push((claim, inbound)),
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
        match service.kind() {
            // A terminal service's planned restart is handed back to recovery, which replaces it.
            CodexServiceKind::Terminal => {
                service.stop().await;
                service
                    .ensure_started(service.dependencies().startup_timeout)
                    .await?;
            }
            CodexServiceKind::Account | CodexServiceKind::Joined => {
                service.restart_planned().await?;
            }
        }
        self.dependencies.release.forget_service(service.id());
        for (claim, inbound) in held {
            let Some(outcome) = self
                .resume_claimed(service, &inbound, never_left(), None)
                .await
            else {
                continue;
            };
            let result = self.settle_resumed(service, &inbound, claim, outcome).await;
            self.report_moved(service, &inbound, result, change).await;
        }
        Ok(())
    }

    // Moves one session off `from` once it is idle, inside its slot, to the home's service as it is
    // then, its resume settled as a recovery's is, and tells it of the build it moved to, `change`
    // where that service is the one `change` started. One that landed on a service replaced
    // meanwhile moves on from there; one another move took off `from` is left to that move.
    async fn move_when_idle(
        &self,
        inbound: &CodexSessionInboundSender,
        mut from: Arc<CodexService>,
        mut change: Option<ProviderBuildChange>,
    ) {
        loop {
            match self.claim_idle(inbound).await {
                ClaimedIdle::Idle(claim, thread_id, on) => {
                    let to = self
                        .dependencies
                        .services
                        .home_service(&from.home().codex_home);
                    let Some(to) =
                        to.filter(|to| Arc::ptr_eq(&on, &from) && !Arc::ptr_eq(to, &from))
                    else {
                        break;
                    };
                    // A target retiring meanwhile left the home; the next round looks it up again.
                    let Some(toward) = MoveToward::begin(self, &to) else {
                        continue;
                    };
                    let told = self.read_told_change(change.take(), &to);
                    let resumed = match self.move_claimed(inbound, &from, &to, thread_id).await {
                        Some(outcome) => {
                            Some(self.settle_resumed(&to, inbound, claim, outcome).await)
                        }
                        None => None,
                    };
                    drop(toward);
                    let Some(result) = resumed else {
                        self.retire_if_replaced(&to);
                        break;
                    };
                    let is_resumed = matches!(result, DriverResumeResult::Resumed { .. });
                    // The service the record runs on keeps the session; the other lets it go.
                    if is_resumed {
                        from.detach_session(&inbound.session_id());
                    } else {
                        to.detach_session(&inbound.session_id());
                    }
                    self.report_moved(&to, inbound, result, told.as_ref()).await;
                    if !is_resumed {
                        self.retire_if_replaced(&to);
                        break;
                    }
                    self.retire_when_empty(&from);
                    from = to;
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
        self.retire_if_replaced(&from);
    }

    // The build change to tell a session that moved to `to` under `change`: from the build it
    // left to the one `to` serves, where a later build move started `to`.
    fn read_told_change(
        &self,
        change: Option<ProviderBuildChange>,
        to: &CodexService,
    ) -> Option<ProviderBuildChange> {
        let started_by = self
            .lock()
            .replacement_changes
            .get(&to.id())
            .cloned()
            .flatten();
        match (change, started_by) {
            (Some(left), Some(started_by)) => Some(ProviderBuildChange {
                from_version: left.from_version,
                to_version: started_by.to_version,
            }),
            (change, started_by) => change.or(started_by),
        }
    }

    // Retires `service` once it holds none, where a second service took its place on its home.
    fn retire_if_replaced(&self, service: &Arc<CodexService>) {
        let is_home_service = self
            .dependencies
            .services
            .home_service(&service.home().codex_home)
            .is_some_and(|home_service| Arc::ptr_eq(&home_service, service));
        if !is_home_service {
            self.retire_when_empty(service);
        }
    }

    // Claims the session's slot and reads whether a turn is in flight on it, its conversation and
    // the service it runs on; a busy session's slot is let go again, so its turn can end.
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
            Ok(reading) => ClaimedIdle::Idle(claim, reading.thread_id, reading.service),
            Err(_) => ClaimedIdle::Gone,
        }
    }

    // The move itself, the session's slot claimed: its conversations leave `from`, `thread_id`
    // unloading there first, then it resumes on `to`, tried again while `from` still writes it;
    // answers the resume's outcome, `None` when the session closed or was established anew.
    async fn move_claimed(
        &self,
        inbound: &CodexSessionInboundSender,
        from: &Arc<CodexService>,
        to: &Arc<CodexService>,
        thread_id: String,
    ) -> Option<CodexInPlaceOutcome> {
        let session_id = inbound.session_id();
        let deadline = Instant::now() + CODEX_UNLOAD_TIMEOUT;
        self.dependencies
            .release
            .release_session_threads(from, &session_id, |released| released != thread_id);
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
        let leaving = Arc::clone(from);
        let writer_left: CodexWriterLeft = Box::new(move || {
            let leaving = Arc::clone(&leaving);
            let thread_id = thread_id.clone();
            async move { leaving.await_unloaded(&thread_id, deadline).await }.boxed()
        });
        self.resume_claimed(to, inbound, writer_left, None).await
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

    /// Stops a service a second service replaced once no session is on it, no move toward it is
    /// under way and no conversation is held there for its commands, which would end with it; a
    /// move begun after it reads the service retiring.
    pub(super) fn retire_when_empty(&self, service: &Arc<CodexService>) {
        if !service.attached_sessions().is_empty() {
            return;
        }
        {
            let mut state = self.lock();
            if state.moving_toward.contains_key(&service.id())
                || !state.retiring.insert(service.id())
            {
                return;
            }
            state.replacement_changes.remove(&service.id());
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
    // Restarts the service as `restart` asks, then once more beside the home's service as it is
    // then with each change a request joined meanwhile, and tells each waiter how the last restart
    // ended; a failure no waiter heard is reported. A change joined once a second service took the
    // first's place is handed, with the waiters, to that service's own restart.
    async fn run(mut self, mut restart: CodexServiceRestart) {
        let service_id = self.service.id();
        let (restarted, waiters) = loop {
            let restarted = self
                .recovery
                .restart_service(&self.service, restart)
                .await
                .map_err(Arc::new);
            // Taken and cleared in one step, so a request between the two is never lost.
            let mut state = self.recovery.lock();
            let mut under_way = state
                .restarting
                .remove(&service_id)
                .expect("the restart's own entry");
            let Some(joined) = under_way.joined_change.take() else {
                self.is_removed = true;
                break (restarted, under_way.waiters);
            };
            let home_service = self
                .recovery
                .dependencies
                .services
                .home_service(&self.service.home().codex_home);
            match home_service {
                Some(home_service) if Arc::ptr_eq(&home_service, &self.service) => {
                    state.restarting.insert(service_id, under_way);
                }
                // The second this restart started already serves the joined change's build.
                Some(home_service) if !is_behind_build(&home_service, &joined.to_version) => {
                    self.is_removed = true;
                    break (restarted, under_way.waiters);
                }
                Some(home_service) => {
                    self.is_removed = true;
                    drop(state);
                    if let Err(error) = &restarted {
                        report_restart_failed(&self.service, error);
                    }
                    self.recovery.enter_restart(
                        &home_service,
                        CodexServiceRestart::Beside(Some(joined)),
                        under_way.waiters,
                    );
                    return;
                }
                // The home's service left it meanwhile, so the change has no service to run on.
                None => {
                    self.is_removed = true;
                    break (restarted, under_way.waiters);
                }
            }
            drop(state);
            if let Err(error) = &restarted {
                report_restart_failed(&self.service, error);
            }
            restart = CodexServiceRestart::Beside(Some(joined));
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

/// A move's mark on the service a session moves toward, held while the move runs, so the service
/// is not retired under it; dropped, it lets the service retire again.
pub(super) struct MoveToward<'recovery> {
    recovery: &'recovery CodexServiceRecovery,
    service_id: CodexServiceId,
}

impl<'recovery> MoveToward<'recovery> {
    /// Marks a move toward `service` under way; `None` where it is retiring, under the same hold
    /// its retire takes, so a move and a retire of one service never both go ahead.
    pub(super) fn begin(
        recovery: &'recovery CodexServiceRecovery,
        service: &CodexService,
    ) -> Option<Self> {
        let mut state = recovery.lock();
        if state.retiring.contains(&service.id()) {
            return None;
        }
        *state.moving_toward.entry(service.id()).or_default() += 1;
        Some(Self {
            recovery,
            service_id: service.id(),
        })
    }
}

impl Drop for MoveToward<'_> {
    fn drop(&mut self) {
        let mut state = self.recovery.lock();
        if let Entry::Occupied(mut moves) = state.moving_toward.entry(self.service_id) {
            *moves.get_mut() -= 1;
            if *moves.get() == 0 {
                moves.remove();
            }
        }
    }
}

/// A session's slot as a move found it.
enum ClaimedIdle<'slots> {
    /// Idle, held in its slot, on the conversation and the service named.
    Idle(CodexSessionClaim<'slots>, String, Arc<CodexService>),
    /// A turn is in flight; the slot is let go.
    Busy,
    /// The session closed or was established anew.
    Gone,
}

// Whether `service` serves a build other than `version`, both read as parsed versions; `false`
// where either does not parse, since no build then compares with it.
fn is_behind_build(service: &CodexService, version: &str) -> bool {
    let served = service
        .version_reading()
        .and_then(|served| served.report.parsed_version);
    let installed = parse_cli_version_report(version).parsed_version;
    served
        .zip(installed)
        .is_some_and(|(served, installed)| served != installed)
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
