//! A Claude Code process that ended on its own: its runs end through the run engine, then the
//! session resumes after its crash window's next wait, or, once the window fills, the restarts stop
//! and the person is told. A new provider build relaunches each session the same way, an idle one
//! at once and a busy one when its turn settles. Until a relaunch has composed its start, the
//! ended process's settings are held, so a level or mode moved meanwhile starts with it.

use std::collections::HashMap;
use std::error::Error;
use std::sync::{Arc, Mutex, Weak};
use std::time::SystemTime;

use futures::future::join_all;
use serde_json::{Map, json};
use sidekicks_contracts::command::ExitCode;
use sidekicks_contracts::provider::driver::recovery::RecoveryCondition;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::control::{ProcessExit, ProcessExitWithCode};
use sidekicks_contracts::session::controls::events::{SessionNotice, SessionNoticePostedPayload};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_std::error_description::describe_error;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::settle_all::settle_all;
use tokio::sync::SetOnce;
use tokio_util::task::AbortOnDropHandle;

use crate::crash_window::{CrashOutcome, CrashWindow};
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::delivery::claude_delivery_origin;
use crate::driver::claude::run::routes::ClaudeRunRoutes;
use crate::driver::claude::session::errors::record_unheard_claude_failure;
use crate::driver::claude::session::establishment::{
    ClaudeResumeAnswer, ClaudeSessionEstablishment,
};
use crate::driver::claude::session::process::ClaudeProcessEnd;
use crate::driver::claude::session::slots::{
    ClaudeCloseStart, ClaudeSessionSlots, ClaudeSlotClose,
};
use crate::driver::claude::session::state::{
    ClaudeLiveSettings, ClaudeSlotSettled, LiveClaudeSession,
};
use crate::driver::claude::session::ultracode::relaunch_claude_options;
use crate::driver::contract::error::{DriverError, bound_failure_detail};
use crate::driver::delivery_dispatch::dispatch_delivery;
use crate::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use crate::driver::error_causes::{
    UNSPECIFIED_PROVIDER_FAILURE_DETAIL, session_process_unavailable,
};
use crate::driver::ports::DriverPorts;
use crate::driver::session_control::{
    DriverResumeResult, ProviderBuildChange, ResumeSessionParams,
};
use crate::port::inbound_dispatch::InboundDispatch;
use crate::port::run_host::RunHost;
use crate::run::delivery::InboundDelivery;
use crate::runtime_binding::store::mint_runtime_binding_id;

// Every session's crash window and the sessions the driver brings back itself.
#[derive(Default)]
struct ClaudeRestartTable {
    crash_windows: HashMap<SessionId, CrashWindow>,
    restarting: HashMap<SessionId, ClaudeRestartStage>,
    // The build each busy session moves to once its turn settles.
    pending_build_moves: HashMap<SessionId, ProviderBuildChange>,
    // The conversation each session's last ended process wrote, until the session closes.
    ended_conversations: HashMap<SessionId, ClaudeEndedConversation>,
    // Set once the daemon stops: from then on no session is started again.
    is_stopped: bool,
}

// Where a session the driver brings back itself stands.
enum ClaudeRestartStage {
    // Its process ended and no relaunch has composed its start: the ended process's settings,
    // which the relaunch composes from, the crash window's wait once one is set, and the cell set
    // once the stage goes.
    Held {
        ended: Arc<LiveClaudeSession>,
        wait: Option<AbortOnDropHandle<()>>,
        left: ClaudeHeldStageLeft,
    },
    // A relaunch composed its start and brings the process up; set once it is done.
    Relaunching {
        settled: ClaudeSlotSettled,
    },
}

/// Where a session's process stands for a control that moves its level or mode.
pub(crate) enum ClaudeSessionStanding {
    /// A process serves the session.
    Live(Arc<LiveClaudeSession>),
    /// The process ended and the driver brings it back from `ended`'s settings, which a move
    /// writes; `left` is set once the restart composed its start or was dropped.
    Held {
        /// The ended process, whose settings the relaunch composes from.
        ended: Arc<LiveClaudeSession>,
        /// Set once the session is no longer held.
        left: ClaudeSlotSettled,
    },
    /// A process comes up without the daemon's open; the move waits for this, then looks again.
    Settling(ClaudeSlotSettled),
    /// No process serves the session and none comes back until the daemon opens it.
    Down,
}

// The cell of a held restart, set when the stage goes: replaced by its relaunch, or dropped by the
// person's restart, a close or the daemon's stop.
struct ClaudeHeldStageLeft(ClaudeSlotSettled);

impl Drop for ClaudeHeldStageLeft {
    fn drop(&mut self) {
        drop(self.0.set(()));
    }
}

/// The conversation an ended process wrote, where its file is found again.
#[derive(Clone, Debug)]
pub(crate) struct ClaudeEndedConversation {
    /// Claude Code's id of the conversation.
    pub(crate) provider_session_id: String,
    /// The environment the process ran in, which names its Claude Code home.
    pub(crate) spawn_environment: Vec<(String, String)>,
}

/// Every Claude Code session's restarts after an exit, and its moves to a new build.
pub(crate) struct ClaudeSessionRestarts {
    slots: ClaudeSessionSlots,
    routes: Arc<ClaudeRunRoutes>,
    engine: Arc<dyn RunHost>,
    dispatch: Arc<dyn InboundDispatch>,
    establishment: Weak<ClaudeSessionEstablishment>,
    ports: Arc<DriverPorts>,
    table: Mutex<ClaudeRestartTable>,
}

impl ClaudeSessionRestarts {
    /// The restarts of every session's slot, which they make here, resumed through
    /// `establishment`, which holds them: a rewind's predecessor that exited while its fork came up
    /// takes the exit path once the fork fails.
    pub(crate) fn new(
        routes: Arc<ClaudeRunRoutes>,
        engine: Arc<dyn RunHost>,
        dispatch: Arc<dyn InboundDispatch>,
        establishment: Weak<ClaudeSessionEstablishment>,
        ports: Arc<DriverPorts>,
    ) -> Arc<Self> {
        Arc::new_cyclic(|restarts: &Weak<Self>| {
            let restarts = restarts.clone();
            let slots = ClaudeSessionSlots::new(Arc::new(move |predecessor| {
                let Some(restarts) = restarts.upgrade() else {
                    return;
                };
                let exit = predecessor
                    .process_exit
                    .get()
                    .expect("a predecessor's exit is set before its slot records it")
                    .clone();
                tokio::spawn(async move { restarts.process_exited(predecessor, exit).await });
            }));
            Self {
                slots,
                routes,
                engine,
                dispatch,
                establishment,
                ports,
                table: Mutex::new(ClaudeRestartTable::default()),
            }
        })
    }

    /// Every session's slot.
    pub(crate) fn slots(&self) -> &ClaudeSessionSlots {
        &self.slots
    }

    /// Takes `live`'s process, which ended on its own while its slot held it, the slot already
    /// released so no run starts on it: each run it held ends on `exit`, its held presses are let
    /// go, and the session restarts after its window's wait or stops restarting.
    pub(crate) async fn process_exited(
        self: &Arc<Self>,
        live: Arc<LiveClaudeSession>,
        exit: ProcessExit,
    ) {
        let session_id = live.session_id;
        let runs = self.routes.bound_runs_on(session_id);
        // Decided before anything awaits, so a read of the session's state from here on, the
        // queue's on hearing the process gone among them, sees whether it comes back.
        let outcome = {
            let mut table = lock(&self.table);
            // The restart resumes on the build installed now, so a move that waited is done.
            table.pending_build_moves.remove(&session_id);
            table
                .ended_conversations
                .insert(session_id, ended_conversation_of(&live));
            if table.is_stopped {
                None
            } else {
                let outcome = table
                    .crash_windows
                    .entry(session_id)
                    .or_insert_with(CrashWindow::provider)
                    .record_crash(SystemTime::now());
                if matches!(outcome, CrashOutcome::RestartAfter(_)) {
                    // Held from the exit on, so a move while its runs end reaches the restart.
                    table.restarting.insert(
                        session_id,
                        ClaudeRestartStage::Held {
                            ended: Arc::clone(&live),
                            wait: None,
                            left: ClaudeHeldStageLeft(Arc::new(SetOnce::new())),
                        },
                    );
                }
                Some(outcome)
            }
        };
        self.routes.retire_run_routes(session_id);
        self.routes.retire_child_routes(session_id);
        for run in &runs {
            // Forgotten first with the helpers beneath it, so nothing is delivered to it after.
            self.routes.forget_run(run.run_id);
            if let Err(error) = self
                .engine
                .end_turn_on_process_exit(run.run_id, exit.clone())
                .await
            {
                record_unheard_claude_failure(
                    DriverDiagnosticKind::ProcessReportFailed,
                    session_id,
                    "the run end of a process that exited",
                    &*error,
                );
            }
        }
        live.release_served_presses(&self.ports.reviewer_denials);
        self.report_gone(session_id);
        match outcome {
            None => {}
            Some(CrashOutcome::CrashLoop) => self.report_crash_loop(session_id, &exit).await,
            Some(CrashOutcome::RestartAfter(wait)) => {
                // Spawned under the lock its wait is kept under, so the wait cannot end before it
                // is kept.
                let mut table = lock(&self.table);
                let Some(ClaudeRestartStage::Held {
                    ended,
                    wait: kept_wait,
                    ..
                }) = table.restarting.get_mut(&session_id)
                else {
                    // The person's restart, a close or the daemon's stop took the session.
                    return;
                };
                if !Arc::ptr_eq(ended, &live) {
                    return;
                }
                let restarts = Arc::clone(self);
                let pending = tokio::spawn(async move {
                    tokio::time::sleep(wait).await;
                    restarts.restart(live).await;
                });
                *kept_wait = Some(AbortOnDropHandle::new(pending));
            }
        }
    }

    /// Forgets the session's crashes, so the next counts from the first, and drops a restart still
    /// waiting; the person's own restart.
    pub(crate) fn clear_crash_window(&self, session_id: SessionId) {
        let mut table = lock(&self.table);
        if matches!(
            table.restarting.get(&session_id),
            Some(ClaudeRestartStage::Held { .. })
        ) {
            table.restarting.remove(&session_id);
        }
        if let Some(window) = table.crash_windows.get_mut(&session_id) {
            window.clear();
        }
    }

    /// Forgets a closed session's crash window and anything it had waiting.
    pub(crate) fn forget_session(&self, session_id: SessionId) {
        let mut table = lock(&self.table);
        table.restarting.remove(&session_id);
        table.crash_windows.remove(&session_id);
        table.pending_build_moves.remove(&session_id);
        table.ended_conversations.remove(&session_id);
    }

    /// The conversation the session's last ended process wrote; `None` before any ended.
    pub(crate) fn ended_conversation(
        &self,
        session_id: SessionId,
    ) -> Option<ClaudeEndedConversation> {
        lock(&self.table)
            .ended_conversations
            .get(&session_id)
            .cloned()
    }

    /// Relaunches `live`'s process before a turn whose step bound it was not started with, on
    /// the same conversation and binding. Does nothing once the process is no longer the
    /// session's; fails with the resume's failure, which the session directory records too.
    pub(crate) async fn relaunch_for_step_bound(
        &self,
        live: &Arc<LiveClaudeSession>,
    ) -> Result<(), DriverError> {
        let session_id = live.session_id;
        // The runs keep their binding, so the session directory records no new one.
        let Some(ClaudeResumeAnswer { result, .. }) = self.relaunch(live, false).await else {
            return Ok(());
        };
        let DriverResumeResult::Failed {
            provider_failure_detail,
            ..
        } = &result
        else {
            return Ok(());
        };
        self.report_gone(session_id);
        let failure = DriverError::Internal(provider_failure_detail.as_str().into());
        if let Err(error) = self.report_relaunch(session_id, result).await {
            record_unheard_claude_failure(
                DriverDiagnosticKind::ProcessReportFailed,
                session_id,
                "the record of a failed relaunch",
                &error,
            );
        }
        Err(failure)
    }

    /// Drops every restart and build move still waiting and starts none from here, as the daemon
    /// stops.
    pub(crate) fn stop(&self) {
        let mut table = lock(&self.table);
        table.is_stopped = true;
        table
            .restarting
            .retain(|_, stage| matches!(stage, ClaudeRestartStage::Relaunching { .. }));
        table.pending_build_moves.clear();
    }

    /// Waits until the session's process no longer comes back on its own: a restart held for its
    /// crash window's wait, a relaunch or a bring-up in flight each waited out. Answers once the
    /// process is live; fails `provider.unavailable` once none serves the session.
    pub(crate) async fn settle(&self, session_id: SessionId) -> Result<(), DriverError> {
        loop {
            match self.standing(session_id) {
                ClaudeSessionStanding::Live(_) => return Ok(()),
                ClaudeSessionStanding::Down => {
                    return Err(DriverError::from(session_process_unavailable(session_id)));
                }
                ClaudeSessionStanding::Held { left, .. } => {
                    left.wait().await;
                }
                ClaudeSessionStanding::Settling(settled) => {
                    settled.wait().await;
                }
            }
        }
    }

    /// Where the session's process stands: live, held by a restart that has not composed its
    /// start, coming up without the daemon's open (a relaunch, or a fork that replaces it), or
    /// down. A read of what the driver holds.
    pub(crate) fn standing(&self, session_id: SessionId) -> ClaudeSessionStanding {
        match lock(&self.table).restarting.get(&session_id) {
            Some(ClaudeRestartStage::Held { ended, left, .. }) => {
                return ClaudeSessionStanding::Held {
                    ended: Arc::clone(ended),
                    left: Arc::clone(&left.0),
                };
            }
            Some(ClaudeRestartStage::Relaunching { settled }) => {
                return ClaudeSessionStanding::Settling(Arc::clone(settled));
            }
            None => {}
        }
        if let Some(live) = self.slots.live_session(session_id) {
            return ClaudeSessionStanding::Live(live);
        }
        match self.slots.establishing_settled(session_id) {
            Some(settled) => ClaudeSessionStanding::Settling(settled),
            None => ClaudeSessionStanding::Down,
        }
    }

    /// Writes `write` into the settings `ended`'s restart composes its start from, while they are
    /// still held for it; `false` once the relaunch composed it or the session left the restart.
    pub(crate) fn write_held_settings(
        &self,
        ended: &Arc<LiveClaudeSession>,
        write: impl FnOnce(&mut ClaudeLiveSettings),
    ) -> bool {
        // Written under the table's lock, which the relaunch takes before it composes.
        let table = lock(&self.table);
        let is_held = matches!(
            table.restarting.get(&ended.session_id),
            Some(ClaudeRestartStage::Held { ended: held, .. }) if Arc::ptr_eq(held, ended)
        );
        if is_held {
            write(&mut lock(&ended.settings));
        }
        is_held
    }

    /// Moves every live session onto the build that replaced the running one: an idle one at once,
    /// a busy one when its turn settles, each told with a `providerUpdated` notice. The idle ones
    /// move together, so one that fails strands none of the rest; fails with every failure once
    /// all have moved.
    pub(crate) async fn move_to_provider_build(
        self: &Arc<Self>,
        change: &ProviderBuildChange,
    ) -> Result<(), DriverError> {
        let mut idle = Vec::new();
        for live in self.slots.live_sessions() {
            if self.routes.is_turn_held(live.session_id) {
                lock(&self.table)
                    .pending_build_moves
                    .insert(live.session_id, change.clone());
            } else {
                idle.push(live);
            }
        }
        let moves = join_all(idle.iter().map(|live| self.move_to_build(live, change))).await;
        settle_all(moves, "moving Claude Code sessions to the new build")
            .map(drop)
            .map_err(|failures| DriverError::Internal(Box::new(failures)))
    }

    /// `live`'s turn settled: a build move that waited for it goes now.
    pub(crate) fn turn_settled(self: &Arc<Self>, live: &Arc<LiveClaudeSession>) {
        let Some(change) = lock(&self.table)
            .pending_build_moves
            .remove(&live.session_id)
        else {
            return;
        };
        let (restarts, live) = (Arc::clone(self), Arc::clone(live));
        tokio::spawn(async move {
            if let Err(error) = restarts.move_to_build(&live, &change).await {
                record_unheard_claude_failure(
                    DriverDiagnosticKind::ProcessReportFailed,
                    live.session_id,
                    "the move to a new provider build",
                    &error,
                );
            }
        });
    }

    /// Records that the session's process runs again, and tells the person when it was their own
    /// restart that brought it back, which ends a crash loop's banner. A resume a live process
    /// answered reports nothing, since what brought that process up reported it.
    pub(crate) async fn report_restarted(&self, session_id: SessionId, is_persons: bool) {
        emit_driver_diagnostic(&DriverDiagnosticRecord {
            provider: DESCRIPTOR.provider_id(),
            provider_account_id: None,
            kind: DriverDiagnosticKind::ProviderRestarted,
            raw_wire_type: None,
            disposition_reason: "the Claude Code process was started again".to_owned(),
            details: [("sessionId".to_owned(), json!(session_id))]
                .into_iter()
                .collect(),
        });
        if is_persons {
            self.post_notice(
                session_id,
                SessionNotice::ProviderRestarted {
                    session_id,
                    provider: DESCRIPTOR.provider_id(),
                },
            )
            .await;
        }
    }

    // Ends the process the way a close does and resumes its conversation on the new build.
    async fn move_to_build(
        &self,
        live: &Arc<LiveClaudeSession>,
        change: &ProviderBuildChange,
    ) -> Result<(), DriverError> {
        let session_id = live.session_id;
        lock(&self.table).pending_build_moves.remove(&session_id);
        let Some(answer) = self.relaunch(live, true).await else {
            return Ok(());
        };
        let is_resumed = matches!(answer.result, DriverResumeResult::Resumed { .. });
        if !is_resumed {
            self.report_gone(session_id);
        }
        self.record_relaunch(session_id, answer).await?;
        if is_resumed
            && let (Ok(from_version), Ok(to_version)) = (
                FreeFormText::new(change.from_version.clone()),
                FreeFormText::new(change.to_version.clone()),
            )
        {
            self.post_notice(
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
        Ok(())
    }

    /// Starts `live`'s stop for the idle sleep and answers the resume that wakes it, which brings
    /// its conversation back on the same account, folder, settings and level; `None`, with nothing
    /// stopped, once the process is no longer the session's, the daemon stops, or the model it
    /// runs on has no name a resume carries.
    pub(crate) fn begin_sleep(
        &self,
        live: &Arc<LiveClaudeSession>,
    ) -> Option<(ClaudeSlotClose, ResumeSessionParams)> {
        let resume = compose_claude_relaunch(live)?;
        Some((self.begin_own_close(live)?, resume))
    }

    /// Ends the process a sleep's `close` holds the way a close does, keeping its conversation:
    /// its input closes, so Claude Code finishes writing it, and it settles once it exited.
    pub(crate) async fn finish_sleep(&self, close: ClaudeSlotClose, live: &LiveClaudeSession) {
        self.retire_keeping_conversation(close, live).await;
    }

    /// Wakes a sleeping session through `resume`, under a binding the session directory opens
    /// first, and hands the directory the result, so it records the binding. Fails with the
    /// resume's failure, which the directory records too, and as the record fails.
    pub(crate) async fn wake(&self, resume: ResumeSessionParams) -> Result<(), DriverError> {
        let session_id = resume.session_id;
        let answer = self.resume(Some(resume), true).await;
        let failure = match &answer.result {
            DriverResumeResult::Resumed { .. } => None,
            DriverResumeResult::Failed {
                provider_failure_detail,
                ..
            } => Some(DriverError::Internal(
                provider_failure_detail.as_str().into(),
            )),
        };
        self.record_relaunch(session_id, answer).await?;
        failure.map_or(Ok(()), Err)
    }

    // Ends `live`'s process the way a close does and resumes its conversation, under a binding the
    // session directory opens first where `is_recorded`, since it records it; `None`, with
    // nothing ended, once the process is no longer the session's or the daemon stops.
    async fn relaunch(
        &self,
        live: &Arc<LiveClaudeSession>,
        is_recorded: bool,
    ) -> Option<ClaudeResumeAnswer> {
        let close = self.begin_own_close(live)?;
        let _relaunching = self.mark_relaunching(live.session_id);
        let relaunch = compose_claude_relaunch(live);
        self.retire_keeping_conversation(close, live).await;
        Some(self.resume(relaunch, is_recorded).await)
    }

    // Takes `live`'s slot for a close that keeps its conversation; `None` once the process is no
    // longer the session's or the daemon stops.
    fn begin_own_close(&self, live: &Arc<LiveClaudeSession>) -> Option<ClaudeSlotClose> {
        let is_own = self
            .slots
            .live_session(live.session_id)
            .is_some_and(|held| Arc::ptr_eq(&held.channel, &live.channel));
        if lock(&self.table).is_stopped || !is_own {
            return None;
        }
        match self.slots.begin_close(live.session_id) {
            ClaudeCloseStart::Closing(close) => Some(close),
            // A create, resume or close took the session first and owns it now.
            ClaudeCloseStart::Empty | ClaudeCloseStart::Wait(_) => None,
        }
    }

    // Ends the process `close` holds, its conversation kept where a later read finds its file.
    async fn retire_keeping_conversation(&self, close: ClaudeSlotClose, live: &LiveClaudeSession) {
        lock(&self.table)
            .ended_conversations
            .insert(live.session_id, ended_conversation_of(live));
        close.retire_for_bring_up(&self.routes, &self.ports).await;
    }

    // The wait passed: the session resumes from the settings held for it unless a create, resume
    // or close reached it meanwhile.
    async fn restart(&self, live: Arc<LiveClaudeSession>) {
        let session_id = live.session_id;
        // Its own wait is taken out with its stage and kept to the end, so dropping it aborts
        // nothing of this restart.
        let (_own_wait, relaunching) = {
            let mut table = lock(&self.table);
            let (wait, left) = match table.restarting.remove(&session_id) {
                Some(ClaudeRestartStage::Held {
                    ended, wait, left, ..
                }) if Arc::ptr_eq(&ended, &live) => (wait, left),
                Some(stage) => {
                    table.restarting.insert(session_id, stage);
                    return;
                }
                None => return,
            };
            if table.is_stopped || self.slots.holds_slot(session_id) {
                return;
            }
            let relaunching = self.mark_relaunching_in(&mut table, session_id);
            // Whoever waited on the held stage now waits on the relaunch.
            drop(left);
            (wait, relaunching)
        };
        let answer = self.resume(compose_claude_relaunch(&live), true).await;
        let is_resumed = matches!(answer.result, DriverResumeResult::Resumed { .. });
        if !is_resumed {
            // Let go first, so the session reads down once the relaunch failed.
            drop(relaunching);
            self.report_gone(session_id);
        }
        if let Err(error) = self.record_relaunch(session_id, answer).await {
            record_unheard_claude_failure(
                DriverDiagnosticKind::ProcessReportFailed,
                session_id,
                "the record of a restart",
                &error,
            );
            return;
        }
        if is_resumed {
            self.report_restarted(session_id, false).await;
        }
    }

    // Resumes through the establishment, which is gone only once the driver is, under a binding
    // the session directory opened first where `is_recorded`, so what the resumed process delivers
    // at once is taken; a binding that cannot be opened fails the relaunch with no resume.
    async fn resume(
        &self,
        params: Option<ResumeSessionParams>,
        is_recorded: bool,
    ) -> ClaudeResumeAnswer {
        let Some(params) = params else {
            return relaunch_failure(
                "The model the session ran on has no name the relaunch can carry.",
            );
        };
        let Some(establishment) = self.establishment.upgrade() else {
            return relaunch_failure("The Claude Code driver has stopped.");
        };
        if is_recorded
            && let Err(error) = self
                .open_relaunch_binding(params.session_id, params.binding_id.clone())
                .await
        {
            return relaunch_failure(&describe_error(&error as &(dyn Error + 'static)));
        }
        establishment.resume(params).await
    }

    // Has the session directory open the cursor of `binding_id`, the relaunch's binding.
    async fn open_relaunch_binding(
        &self,
        session_id: SessionId,
        binding_id: RuntimeBindingId,
    ) -> Result<(), DriverError> {
        let listener = self
            .ports
            .session_relaunched
            .require_port()
            .map_err(|error| DriverError::Internal(Box::new(error)))?;
        listener
            .open_relaunch_binding(session_id, binding_id)
            .await
            .map_err(DriverError::Internal)
    }

    // Hands the session directory a relaunch's answer, so it records the binding or the failure; a
    // process the relaunch started whose binding was not recorded is ended, so none runs under a
    // binding with no row.
    async fn record_relaunch(
        &self,
        session_id: SessionId,
        answer: ClaudeResumeAnswer,
    ) -> Result<(), DriverError> {
        let recorded = self.report_relaunch(session_id, answer.result).await;
        if recorded.is_err()
            && answer.has_started_process
            && let ClaudeCloseStart::Closing(close) = self.slots.begin_close(session_id)
        {
            close.retire_for_bring_up(&self.routes, &self.ports).await;
        }
        recorded
    }

    // Tells the queue the session's process is gone: at an exit, and once a relaunch failed, after
    // which the session stands down and its next run opens it again.
    fn report_gone(&self, session_id: SessionId) {
        if let Some(process_gone) = self.ports.process_gone.port() {
            process_gone.process_gone(session_id);
        }
    }

    // Hands the session directory the relaunch's result, so it records the binding or the failure.
    async fn report_relaunch(
        &self,
        session_id: SessionId,
        result: DriverResumeResult,
    ) -> Result<(), DriverError> {
        let listener = self
            .ports
            .session_relaunched
            .require_port()
            .map_err(|error| DriverError::Internal(Box::new(error)))?;
        listener
            .session_relaunched(session_id, result)
            .await
            .map_err(DriverError::Internal)
    }

    async fn report_crash_loop(&self, session_id: SessionId, exit: &ProcessExit) {
        let (exit_code, signal, silent_seconds) = match exit {
            ProcessExit::Code(ended) => (Some(ended.exit_code), None, None),
            ProcessExit::Signal(ended) => (None, Some(ended.signal.clone()), None),
            ProcessExit::Silent(ended) => (None, None, Some(ended.silent_seconds)),
        };
        let ending = match (&exit_code, &signal, &silent_seconds) {
            (Some(code), _, _) => ("exitCode".to_owned(), json!(code)),
            (None, None, Some(seconds)) => ("silentSeconds".to_owned(), json!(seconds)),
            (None, signal, _) => ("signal".to_owned(), json!(signal)),
        };
        emit_driver_diagnostic(&DriverDiagnosticRecord {
            provider: DESCRIPTOR.provider_id(),
            provider_account_id: None,
            kind: DriverDiagnosticKind::ProviderCrashLoop,
            raw_wire_type: None,
            disposition_reason:
                "the Claude Code process ended on its own too often to restart again".to_owned(),
            details: [("sessionId".to_owned(), json!(session_id)), ending]
                .into_iter()
                .collect(),
        });
        self.post_notice(
            session_id,
            SessionNotice::ProviderCrashLoop {
                session_id,
                provider: DESCRIPTOR.provider_id(),
                exit_code,
                signal,
                silent_seconds,
                start_failure: None,
            },
        )
        .await;
    }

    // Posts `notice` on the session; the process that would order it among its rows is gone.
    async fn post_notice(&self, session_id: SessionId, notice: SessionNotice) {
        let delivery = InboundDelivery::SessionNotice {
            session_id,
            notice: SessionNoticePostedPayload::Notice(notice),
        };
        drop(
            dispatch_delivery(
                &*self.dispatch,
                claude_delivery_origin(None, None),
                delivery,
            )
            .await,
        );
    }
}

// A relaunch marked as its session's stage; dropping it takes the mark out and settles whoever
// waits for the relaunch.
struct ClaudeRelaunchMark<'restarts> {
    restarts: &'restarts ClaudeSessionRestarts,
    session_id: SessionId,
    settled: ClaudeSlotSettled,
}

impl Drop for ClaudeRelaunchMark<'_> {
    fn drop(&mut self) {
        {
            let mut table = lock(&self.restarts.table);
            let is_own = matches!(
                table.restarting.get(&self.session_id),
                Some(ClaudeRestartStage::Relaunching { settled })
                    if Arc::ptr_eq(settled, &self.settled)
            );
            if is_own {
                table.restarting.remove(&self.session_id);
            }
        }
        drop(self.settled.set(()));
    }
}

impl ClaudeSessionRestarts {
    // Marks the session relaunching until the mark drops.
    fn mark_relaunching(&self, session_id: SessionId) -> ClaudeRelaunchMark<'_> {
        self.mark_relaunching_in(&mut lock(&self.table), session_id)
    }

    // Marks the session relaunching in `table`, which the caller holds locked.
    fn mark_relaunching_in(
        &self,
        table: &mut ClaudeRestartTable,
        session_id: SessionId,
    ) -> ClaudeRelaunchMark<'_> {
        let settled: ClaudeSlotSettled = Arc::new(SetOnce::new());
        table.restarting.insert(
            session_id,
            ClaudeRestartStage::Relaunching {
                settled: Arc::clone(&settled),
            },
        );
        ClaudeRelaunchMark {
            restarts: self,
            session_id,
            settled,
        }
    }
}

// A relaunch that failed for `detail` before any process started, which the run needs recovered.
fn relaunch_failure(detail: &str) -> ClaudeResumeAnswer {
    ClaudeResumeAnswer {
        result: DriverResumeResult::Failed {
            recovery_condition: RecoveryCondition::RecoveryNeeded,
            provider_failure_detail: bound_failure_detail(
                detail,
                UNSPECIFIED_PROVIDER_FAILURE_DETAIL.clone(),
            ),
        },
        has_started_process: false,
    }
}

// Where the file of the conversation `live`'s process wrote is found again.
fn ended_conversation_of(live: &LiveClaudeSession) -> ClaudeEndedConversation {
    ClaudeEndedConversation {
        provider_session_id: live.provider_session_id.clone(),
        spawn_environment: live.spawn_bound_legs.spawn_environment.clone(),
    }
}

/// The exit a process's end crosses the wire with: a wait that failed reads as code 0, its error
/// the output tail, since the process is gone either way.
pub(crate) fn claude_process_exit_of(end: &ClaudeProcessEnd) -> ProcessExit {
    match end {
        Ok(exit) => exit.clone(),
        Err(error) => ProcessExit::Code(ProcessExitWithCode {
            exit_code: ExitCode::new(0).expect("zero is a safe integer"),
            signal: None,
            silent_seconds: None,
            output_tail: bound_failure_detail(
                &describe_error(&**error as &(dyn Error + 'static)),
                UNSPECIFIED_PROVIDER_FAILURE_DETAIL.clone(),
            ),
        }),
    }
}

// The resume that brings `live` back on the legs and level it ran at, the person's later moves
// included, under the account it was admitted on, asking for the callback tools and Settings rows
// its process was asked for, which the session's own advisor and style still override, under a
// binding minted for it; `None` when the model it moved to has no name a resume carries.
fn compose_claude_relaunch(live: &LiveClaudeSession) -> Option<ResumeSessionParams> {
    let settings = lock(&live.settings).clone();
    let legs = &live.spawn_bound_legs;
    Some(ResumeSessionParams {
        session_id: live.session_id,
        binding_id: mint_runtime_binding_id(),
        agent_id: live.agent_id,
        resume_handle: live.provider_session_id.clone(),
        // The model it runs on now, which a session-long switch by Claude Code may have moved.
        model: FreeFormText::new(settings.running_model).ok()?,
        // Claude Code's model id names its window, so the driver keeps no figure of its own.
        larger_window: None,
        runtime_metadata: Map::new(),
        mode: settings.session_mode,
        execution_posture: settings.execution_posture,
        output_speed: settings
            .applied_output_speed
            .and_then(|level| FreeFormText::new(level).ok()),
        options: relaunch_claude_options(settings.ultracode_requested),
        row_values: live.requested_spawn.row_values.clone(),
        callback_tools: live.requested_spawn.callback_tools.clone(),
        subagent_policy: legs.subagent_policy.clone(),
        tool_servers: Some(legs.tool_servers.clone()),
        output_schema: legs.output_schema.clone(),
        provider_account_id: live.admitted_provider_account_id.clone(),
        on_mcp_server_status: legs.on_mcp_server_status.clone(),
        // This daemon's idle sleep still holds the session's jobs across the relaunch.
        kept_schedules: Vec::new(),
    })
}
