//! A Claude Code process that ended on its own: its runs end through the run engine, then the
//! session resumes after its crash window's next wait, or, once the window fills, the restarts stop
//! and the person is told. A new provider build relaunches each session the same way, an idle one
//! at once and a busy one when its turn settles.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::error::Error;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::SystemTime;

use futures::future::join_all;
use serde_json::json;
use sidekicks_contracts::command::ExitCode;
use sidekicks_contracts::machine::settings::{ProviderRowValue, ProviderRowValues};
use sidekicks_contracts::provider::declaration::ProviderDeclarationId;
use sidekicks_contracts::provider::driver::recovery::RecoveryCondition;
use sidekicks_contracts::run::control::{ProcessExit, ProcessExitWithCode};
use sidekicks_contracts::session::controls::events::{SessionNotice, SessionNoticePostedPayload};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::record::Record;
use sidekicks_contracts::wire::text::FreeFormText;
use tokio_util::task::AbortOnDropHandle;

use crate::crash_window::{CrashOutcome, CrashWindow};
use crate::error_description::describe_error;
use crate::provider::driver::claude::DESCRIPTOR;
use crate::provider::driver::claude::delivery::run_engine::ClaudeRunEngine;
use crate::provider::driver::claude::run::routes::ClaudeRunRoutes;
use crate::provider::driver::claude::session::errors::record_unheard_claude_failure;
use crate::provider::driver::claude::session::establishment::ClaudeSessionEstablishment;
use crate::provider::driver::claude::session::establishment::context::CLAUDE_OUTPUT_STYLE_ROW_ID;
use crate::provider::driver::claude::session::process::ClaudeProcessEnd;
use crate::provider::driver::claude::session::slots::{ClaudeCloseStart, ClaudeSessionSlots};
use crate::provider::driver::claude::session::state::LiveClaudeSession;
use crate::provider::driver::contract::{DriverError, DriverResumeResult, bound_failure_detail};
use crate::provider::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use crate::provider::driver::error_causes::UNSPECIFIED_PROVIDER_FAILURE_DETAIL;
use crate::provider::driver::ports::DriverPorts;
use crate::provider::driver::session_control::{ProviderBuildChange, ResumeSessionParams};
use crate::session::run::inbound::InboundDelivery;
use crate::settle_all::settle_all;

// Every session's crash window and what waits to start it again.
#[derive(Default)]
struct ClaudeRestartTable {
    crash_windows: HashMap<SessionId, CrashWindow>,
    pending_restarts: HashMap<SessionId, AbortOnDropHandle<()>>,
    // The build each busy session moves to once its turn settles.
    pending_build_moves: HashMap<SessionId, ProviderBuildChange>,
    // Set once the daemon stops: from then on no session is started again.
    is_stopped: bool,
}

/// Every Claude Code session's restarts after an exit, and its moves to a new build.
pub(crate) struct ClaudeSessionRestarts {
    slots: ClaudeSessionSlots,
    routes: Arc<ClaudeRunRoutes>,
    engine: Arc<dyn ClaudeRunEngine>,
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
        engine: Arc<dyn ClaudeRunEngine>,
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
        // The restart resumes on the build installed now, so a move that waited is done.
        self.lock().pending_build_moves.remove(&session_id);
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
                    &error,
                );
            }
        }
        if let Some(reviewer_denials) = self.ports.reviewer_denials.port() {
            let bindings: HashSet<_> = runs.into_iter().map(|run| run.binding_id).collect();
            for binding_id in &bindings {
                reviewer_denials.release_held_presses(binding_id);
            }
        }
        if let Some(process_gone) = self.ports.process_gone.port() {
            process_gone.process_gone(session_id);
        }
        let outcome = {
            let mut table = self.lock();
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
                    let _own = restarts.lock().pending_restarts.remove(&session_id);
                    restarts.restart(&live).await;
                });
                self.lock()
                    .pending_restarts
                    .insert(session_id, AbortOnDropHandle::new(pending));
            }
        }
    }

    /// Forgets the session's crashes, so the next counts from the first, and drops a restart still
    /// waiting; the person's own restart.
    pub(crate) fn clear_crash_window(&self, session_id: SessionId) {
        let mut table = self.lock();
        table.pending_restarts.remove(&session_id);
        if let Some(window) = table.crash_windows.get_mut(&session_id) {
            window.clear();
        }
    }

    /// Forgets a closed session's crash window and anything it had waiting.
    pub(crate) fn forget_session(&self, session_id: SessionId) {
        let mut table = self.lock();
        table.pending_restarts.remove(&session_id);
        table.crash_windows.remove(&session_id);
        table.pending_build_moves.remove(&session_id);
    }

    /// Drops every restart and build move still waiting and starts none from here, as the daemon
    /// stops.
    pub(crate) fn stop(&self) {
        let mut table = self.lock();
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
                self.lock()
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
        let Some(change) = self.lock().pending_build_moves.remove(&live.session_id) else {
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
    /// restart that brought it back, which ends a crash loop's banner.
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
        let close = {
            let is_stopped = {
                let mut table = self.lock();
                table.pending_build_moves.remove(&session_id);
                table.is_stopped
            };
            let is_own = self
                .slots
                .live_session(session_id)
                .is_some_and(|held| Arc::ptr_eq(&held.channel, &live.channel));
            if is_stopped || !is_own {
                return Ok(());
            }
            match self.slots.begin_close(session_id) {
                ClaudeCloseStart::Closing(close) => close,
                // A create, resume or close took the session first and owns it now.
                ClaudeCloseStart::Empty | ClaudeCloseStart::Wait(_) => return Ok(()),
            }
        };
        let relaunch = compose_claude_relaunch(live);
        self.routes.retire_run_routes(session_id);
        close.channel().close().await;
        close.finish();
        if let Some(process_gone) = self.ports.process_gone.port() {
            process_gone.process_gone(session_id);
        }
        let result = self.resume(relaunch).await;
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

    // The wait passed: the session resumes unless a create, resume or close reached it meanwhile.
    async fn restart(&self, live: &LiveClaudeSession) {
        let session_id = live.session_id;
        if self.lock().is_stopped || self.slots.holds_slot(session_id) {
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
            Some(establishment) => establishment.resume(params).await,
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
            },
        )
        .await;
    }

    // Posts `notice` on the session; the process that would order it among its rows is gone.
    async fn post_notice(&self, session_id: SessionId, notice: SessionNotice) {
        drop(
            self.engine
                .deliver(
                    None,
                    None,
                    InboundDelivery::SessionNotice {
                        session_id,
                        notice: SessionNoticePostedPayload::Notice(notice),
                    },
                )
                .await,
        );
    }

    fn lock(&self) -> MutexGuard<'_, ClaudeRestartTable> {
        self.table.lock().unwrap_or_else(PoisonError::into_inner)
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
// included, under the account it was admitted on; `None` when the model it moved to has no name
// a resume carries.
fn compose_claude_relaunch(live: &LiveClaudeSession) -> Option<ResumeSessionParams> {
    let settings = live
        .settings
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    let legs = &live.spawn_bound_legs;
    // The style the session ran with, read where a new session's would be.
    let output_style = settings
        .output_style
        .and_then(|style| FreeFormText::new(style).ok());
    let style_row = ProviderDeclarationId::new(CLAUDE_OUTPUT_STYLE_ROW_ID.to_owned())
        .expect("the output style row's id fits the id pattern");
    let row_values: ProviderRowValues = Record::new(BTreeMap::from([(
        style_row,
        ProviderRowValue::Value(output_style),
    )]))
    .expect("the output style row's id is no reserved key");
    Some(ResumeSessionParams {
        session_id: live.session_id,
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
        options: Vec::new(),
        row_values,
        callback_tools: legs.callback_tools.clone(),
        subagent_policy: legs.subagent_policy.clone(),
        tool_servers: Some(legs.tool_servers.clone()),
        output_schema: legs.output_schema.clone(),
        provider_account_id: live.admitted_provider_account_id.clone(),
        on_callback_tool_call: legs.on_callback_tool_call.clone(),
        on_mcp_server_status: legs.on_mcp_server_status.clone(),
    })
}
