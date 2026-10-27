//! A Claude Code process that ended on its own: its runs end through the run engine, then the
//! session resumes after its crash window's next wait, or, once the window fills, the restarts stop
//! and the person is told. A new provider build relaunches each session the same way, an idle one
//! at once and a busy one when its turn settles.

use std::collections::HashMap;
use std::error::Error;
use std::sync::{Arc, Mutex, Weak};
use std::time::SystemTime;

use futures::future::join_all;
use serde_json::json;
use sidekicks_contracts::command::ExitCode;
use sidekicks_contracts::provider::driver::recovery::RecoveryCondition;
use sidekicks_contracts::run::control::{ProcessExit, ProcessExitWithCode};
use sidekicks_contracts::session::controls::events::{SessionNotice, SessionNoticePostedPayload};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_std::error_description::describe_error;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::settle_all::settle_all;
use tokio_util::task::AbortOnDropHandle;

use crate::crash_window::{CrashOutcome, CrashWindow};
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::delivery::claude_delivery_origin;
use crate::driver::claude::run::routes::ClaudeRunRoutes;
use crate::driver::claude::session::errors::record_unheard_claude_failure;
use crate::driver::claude::session::establishment::ClaudeSessionEstablishment;
use crate::driver::claude::session::process::ClaudeProcessEnd;
use crate::driver::claude::session::slots::{ClaudeCloseStart, ClaudeSessionSlots};
use crate::driver::claude::session::state::LiveClaudeSession;
use crate::driver::claude::session::ultracode::relaunch_claude_options;
use crate::driver::contract::{DriverError, bound_failure_detail};
use crate::driver::delivery_dispatch::dispatch_delivery;
use crate::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use crate::driver::error_causes::UNSPECIFIED_PROVIDER_FAILURE_DETAIL;
use crate::driver::ports::DriverPorts;
use crate::driver::session_control::{
    DriverResumeResult, ProviderBuildChange, ResumeSessionParams,
};
use crate::port::inbound_dispatch::InboundDispatch;
use crate::port::run_host::RunHost;
use crate::run::delivery::InboundDelivery;

// Every session's crash window and what waits to start it again.
#[derive(Default)]
struct ClaudeRestartTable {
    crash_windows: HashMap<SessionId, CrashWindow>,
    pending_restarts: HashMap<SessionId, AbortOnDropHandle<()>>,
    // The build each busy session moves to once its turn settles.
    pending_build_moves: HashMap<SessionId, ProviderBuildChange>,
    // The conversation each session's last ended process wrote, until the session closes.
    ended_conversations: HashMap<SessionId, ClaudeEndedConversation>,
    // Set once the daemon stops: from then on no session is started again.
    is_stopped: bool,
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
        {
            let mut table = lock(&self.table);
            // The restart resumes on the build installed now, so a move that waited is done.
            table.pending_build_moves.remove(&session_id);
            table
                .ended_conversations
                .insert(session_id, ended_conversation_of(&live));
        }
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
        if let Some(process_gone) = self.ports.process_gone.port() {
            process_gone.process_gone(session_id);
        }
        let outcome = {
            let mut table = lock(&self.table);
            if table.is_stopped {
                return;
            }
            table
                .crash_windows
                .entry(session_id)
                .or_insert_with(CrashWindow::provider)
                .record_crash(SystemTime::now())
        };
        match outcome {
            CrashOutcome::CrashLoop => self.report_crash_loop(session_id, &exit).await,
            CrashOutcome::RestartAfter(wait) => {
                let restarts = Arc::clone(self);
                let pending = tokio::spawn(async move {
                    tokio::time::sleep(wait).await;
                    // Held to the end, so dropping it aborts nothing of this run.
                    let _own = lock(&restarts.table).pending_restarts.remove(&session_id);
                    restarts.restart(&live).await;
                });
                lock(&self.table)
                    .pending_restarts
                    .insert(session_id, AbortOnDropHandle::new(pending));
            }
        }
    }

    /// Forgets the session's crashes, so the next counts from the first, and drops a restart still
    /// waiting; the person's own restart.
    pub(crate) fn clear_crash_window(&self, session_id: SessionId) {
        let mut table = lock(&self.table);
        table.pending_restarts.remove(&session_id);
        if let Some(window) = table.crash_windows.get_mut(&session_id) {
            window.clear();
        }
    }

    /// Forgets a closed session's crash window and anything it had waiting.
    pub(crate) fn forget_session(&self, session_id: SessionId) {
        let mut table = lock(&self.table);
        table.pending_restarts.remove(&session_id);
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
        let Some(result) = self.relaunch(live).await else {
            return Ok(());
        };
        let DriverResumeResult::Failed {
            provider_failure_detail,
            ..
        } = &result
        else {
            return Ok(());
        };
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
        table.pending_restarts.clear();
        table.pending_build_moves.clear();
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
        let Some(result) = self.relaunch(live).await else {
            return Ok(());
        };
        let is_resumed = matches!(result, DriverResumeResult::Resumed { .. });
        self.report_relaunch(session_id, result).await?;
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

    // Ends `live`'s process the way a close does and resumes its conversation; `None`, with
    // nothing ended, once the process is no longer the session's or the daemon stops.
    async fn relaunch(&self, live: &Arc<LiveClaudeSession>) -> Option<DriverResumeResult> {
        let session_id = live.session_id;
        let close = {
            let is_own = self
                .slots
                .live_session(session_id)
                .is_some_and(|held| Arc::ptr_eq(&held.channel, &live.channel));
            if lock(&self.table).is_stopped || !is_own {
                return None;
            }
            match self.slots.begin_close(session_id) {
                ClaudeCloseStart::Closing(close) => close,
                // A create, resume or close took the session first and owns it now.
                ClaudeCloseStart::Empty | ClaudeCloseStart::Wait(_) => return None,
            }
        };
        let relaunch = compose_claude_relaunch(live);
        lock(&self.table)
            .ended_conversations
            .insert(session_id, ended_conversation_of(live));
        close.retire_for_bring_up(&self.routes, &self.ports).await;
        Some(self.resume(relaunch).await)
    }

    // The wait passed: the session resumes unless a create, resume or close reached it meanwhile.
    async fn restart(&self, live: &LiveClaudeSession) {
        let session_id = live.session_id;
        if lock(&self.table).is_stopped || self.slots.holds_slot(session_id) {
            return;
        }
        let result = self.resume(compose_claude_relaunch(live)).await;
        let is_resumed = matches!(result, DriverResumeResult::Resumed { .. });
        if let Err(error) = self.report_relaunch(session_id, result).await {
            record_unheard_claude_failure(
                DriverDiagnosticKind::ProcessReportFailed,
                session_id,
                "the record of a restart",
                &error,
            );
        }
        if is_resumed {
            self.report_restarted(session_id, false).await;
        }
    }

    // Resumes through the establishment, which is gone only once the driver is.
    async fn resume(&self, params: Option<ResumeSessionParams>) -> DriverResumeResult {
        let Some(params) = params else {
            return DriverResumeResult::Failed {
                recovery_condition: RecoveryCondition::RecoveryNeeded,
                provider_failure_detail: bound_failure_detail(
                    "The model the session ran on has no name the relaunch can carry.",
                    UNSPECIFIED_PROVIDER_FAILURE_DETAIL.clone(),
                ),
            };
        };
        match self.establishment.upgrade() {
            Some(establishment) => establishment.resume(params).await.result,
            None => DriverResumeResult::Failed {
                recovery_condition: RecoveryCondition::RecoveryNeeded,
                provider_failure_detail: bound_failure_detail(
                    "The Claude Code driver has stopped.",
                    UNSPECIFIED_PROVIDER_FAILURE_DETAIL.clone(),
                ),
            },
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
        let (exit_code, signal) = match exit {
            ProcessExit::Code(ended) => (Some(ended.exit_code), None),
            ProcessExit::Signal(ended) => (None, Some(ended.signal.clone())),
        };
        let ending = match (&exit_code, &signal) {
            (Some(code), _) => ("exitCode".to_owned(), json!(code)),
            (None, signal) => ("signal".to_owned(), json!(signal)),
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
            output_tail: bound_failure_detail(
                &describe_error(&**error as &(dyn Error + 'static)),
                UNSPECIFIED_PROVIDER_FAILURE_DETAIL.clone(),
            ),
        }),
    }
}

// The resume that brings `live` back on the legs and level it ran at, the person's later moves
// included, under the account it was admitted on, asking for the callback tools and Settings rows
// its process was asked for, which the session's own advisor and style still override; `None` when
// the model it moved to has no name a resume carries.
fn compose_claude_relaunch(live: &LiveClaudeSession) -> Option<ResumeSessionParams> {
    let settings = lock(&live.settings).clone();
    let legs = &live.spawn_bound_legs;
    Some(ResumeSessionParams {
        session_id: live.session_id,
        agent_id: live.agent_id,
        resume_handle: live.provider_session_id.clone(),
        // The model it runs on now, which a session-long switch by Claude Code may have moved.
        model: FreeFormText::new(settings.running_model).ok()?,
        // Claude Code's model id names its window, so the driver keeps no figure of its own.
        larger_window: None,
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
    })
}
