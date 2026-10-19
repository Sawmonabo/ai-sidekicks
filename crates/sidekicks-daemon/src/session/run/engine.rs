//! The run engine: every run state change goes through it, each checked against the table and
//! written with the run's row, and each terminal followed by the terminal hooks of the setup gates.
//! It also starts the runs of the turns the daemon starts on a session itself and of a provider's
//! own subagents, continues an interrupted run on its next turn, numbers and ends each turn, counts
//! a turn's steps where the run's provider does not bound them, stops a run at a limit, records the
//! markers a provider reports on a live run, and tells a session when a run's provider does not run
//! it at the fast output level it carried.

mod limits;
mod live;
mod settle;
mod start;
#[cfg(test)]
pub(crate) mod tests;
pub(crate) mod turns;

use std::error::Error;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, Weak};

use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::provider::driver::methods::PROVIDER_WIRE_TOKEN_MAX_LEN;
use sidekicks_contracts::provider::driver::output_speed::ProviderOutputSpeedState;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::events::{
    AgentRunProviderInitializedPayload, AgentRunWorkerShuttingDownPayload, TurnEndOrigin,
};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::controls::events::{SessionNotice, SessionNoticePostedPayload};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;
use tokio::sync::{SetOnce, SetOnceError};

use crate::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool, ReadLength};
use crate::database::statement::WriteStatement;
use crate::events::log_service::{EventLogAppendReceipt, EventLogService};
use crate::events::session::appender::{
    SessionEventAppendError, SessionEventAppender, SessionEventDraft, SessionEventDraftError,
    SessionEventLinkage,
};
use crate::events::session::version::SESSION_EVENT_VERSION;
use crate::interventions::store::run_at_version_statement;
use crate::ipc::domain_error::DomainError;
#[cfg(test)]
use crate::pause_point::PausePoint;
use crate::policy::execution_posture_service::ExecutionPostureService;
use crate::provider::driver::registry::ProviderRegistry;
use crate::session::run::agent::{RUN_AGENT_STATEMENT_CAPACITY, RunAgentReadError};
use crate::session::run::daemon_turn::DaemonTurnQueueError;
use crate::session::run::engine::live::{
    ContinuingRun, EndingGuard, EndingWrite, LiveRuns, StartingRun, lock,
};
use crate::session::run::engine::turns::{ProviderTurnEnd, TurnEnd, WriteWithResend};
use crate::session::run::limit_interrupter::{LimitInterruptFailure, LimitInterrupter};
use crate::session::run::read::{RunRead, read_run_provider, read_run_through, safe_run_version};
use crate::session::run::refusals::{RunRefusal, ended_run_refusal};
use crate::session::run::setup_gates::{
    RunSetupGate, RunSetupGateError, RunSetupGates, RunTerminalContext, RunTerminalReleaseError,
};
use crate::session::run::state_change::{
    RunStateChange, RunStateChangeCompanions, RunStateChangeError, RunStateChangeWriter,
    refused_statement_index,
};
use crate::settle_all::{SettleFailures, settle_all};

/// The statements the engine's reads prepare on a pooled connection: the run's row, the live
/// provider subagents beneath a run, the ended runs with an open turn, a run's pending interrupts
/// and whether its interrupt at one limit is pending, the limit its log still owes, its open turns'
/// cuts and the queued messages waiting for it, the number a run's next turn takes, its newest open
/// turn and every open turn, its provider, whether it ended since a version, and the two agent
/// reads.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's start"))]
pub(crate) const RUN_ENGINE_STATEMENT_CAPACITY: usize = 13 + RUN_AGENT_STATEMENT_CAPACITY;

// Reads of a live run before a guarded append gives up on a run that keeps moving under it.
const LIVE_APPEND_ATTEMPTS: usize = 3;

// The guard on the version a live append was built from is the first statement of its write.
const LIVE_APPEND_VERSION_GUARD_INDEX: usize = 0;

/// Where an interrupt of a run goes: claimed by the engine for a run no driver has, whose end is
/// left to the interrupt's own outcome; to the driver, which has the run to stop; or nowhere, the
/// run having ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum InterruptRoute {
    /// The engine took the interrupt; the run is never started.
    Claimed,
    /// The driver has the run and stops it.
    Driver,
    /// The run has ended.
    Ended,
}

/// A marker a provider reports on a live run, which changes no state; the engine reads the run's
/// session and version when it records it. A turn's start is no marker: [`RunEngine::start_turn`]
/// numbers it.
#[derive(Clone, Debug, PartialEq, Eq)]
#[expect(dead_code, reason = "the provider's event delivery")]
pub(crate) enum RunMarker {
    /// The provider process reported its start for the run (`agent.run.providerInitialized`).
    ProviderInitialized {
        /// The run.
        run_id: RunId,
        /// The provider.
        provider: ProviderId,
        /// The model it runs, where it named one.
        model: Option<FreeFormText<PROVIDER_WIRE_TOKEN_MAX_LEN>>,
    },
    /// The provider said its worker is shutting down mid-run (`agent.run.workerShuttingDown`).
    WorkerShuttingDown {
        /// The run.
        run_id: RunId,
        /// The provider's reason, where it sent one.
        reason: Option<FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>>,
    },
}

impl RunMarker {
    fn run_id(&self) -> RunId {
        match self {
            Self::ProviderInitialized { run_id, .. } | Self::WorkerShuttingDown { run_id, .. } => {
                *run_id
            }
        }
    }

    fn into_event(self, run: &RunRead) -> SessionEvent {
        let session_id = run.session_id;
        let run_version = safe_run_version(run.version);
        match self {
            Self::ProviderInitialized {
                run_id,
                provider,
                model,
            } => SessionEvent::AgentRunProviderInitialized(AgentRunProviderInitializedPayload {
                session_id,
                run_id,
                run_version,
                provider,
                model,
            }),
            Self::WorkerShuttingDown { run_id, reason } => {
                SessionEvent::AgentRunWorkerShuttingDown(AgentRunWorkerShuttingDownPayload {
                    session_id,
                    run_id,
                    run_version,
                    reason,
                })
            }
        }
    }
}

/// Why the run engine did not do what it was asked; what each step wrote before the failure is
/// kept, and the failure says which step failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum RunEngineError {
    /// The run is unknown, has ended, or may not make the move asked of it.
    #[error(transparent)]
    Refused(RunRefusal),
    /// A run state change was not written for a reason other than a refusal of the run.
    #[error("the run state change was not written")]
    Change(#[source] RunStateChangeError),
    /// A terminal hook failed after the run ended; the end is kept.
    #[error(transparent)]
    Released(#[from] RunTerminalReleaseError),
    /// A setup gate refused the run.
    #[error("a setup gate refused run {run_id}")]
    Gate {
        /// The run.
        run_id: RunId,
        /// The gate's failure.
        #[source]
        source: RunSetupGateError,
    },
    /// The run passed its gates with no posture resolved for it.
    #[error("run {run_id} passed its gates with no resolved posture")]
    NoResolvedPosture {
        /// The run.
        run_id: RunId,
    },
    /// The driver's start of the run or of its turn, or its interrupt of that turn, failed.
    #[error("the provider's driver failed for run {run_id}")]
    Driver {
        /// The run.
        run_id: RunId,
        /// The driver's failure.
        #[source]
        source: Box<dyn Error + Send + Sync>,
    },
    /// The interventions service was never handed to the engine or has shut down, so the run the
    /// daemon stopped at a limit was not interrupted.
    #[error("no interventions service interrupts run {run_id}, stopped at a limit")]
    LimitInterrupterGone {
        /// The run.
        run_id: RunId,
    },
    /// The interventions service did not interrupt the run the daemon stopped at a limit; the
    /// limit's reached event stands, so the stop's retry sends the interrupt alone, and the cut of
    /// the run's turn stands only while the failure left the interrupt's row pending.
    #[error("run {run_id}, stopped at a limit, was not interrupted")]
    LimitInterrupt {
        /// The run.
        run_id: RunId,
        /// The service's failure.
        #[source]
        source: LimitInterruptFailure,
    },
    /// No registered driver answers the run's provider (`provider.notFound`).
    #[error(transparent)]
    Provider(DomainError),
    /// Neither the run nor a parent whose provider process it runs in has a runtime binding, so
    /// no provider is known for it.
    #[error("no provider is known for run {run_id}, which has no runtime binding")]
    ProviderUnknown {
        /// The run.
        run_id: RunId,
    },
    /// The daemon turn's run was not queued.
    #[error(transparent)]
    DaemonTurn(#[from] DaemonTurnQueueError),
    /// The run's agent could not be read from its session's log.
    #[error("the run's agent could not be read")]
    Agent(#[from] RunAgentReadError),
    /// An event breaks a check of its type.
    #[error("the run's event could not be drafted")]
    Draft(#[from] SessionEventDraftError),
    /// The event log did not keep an append, or a guard in its write refused it.
    #[error("the run's event was not appended")]
    Append(#[from] SessionEventAppendError),
    /// SQLite refused a read, or a stored column does not read as its type.
    #[error("the run could not be read")]
    Read(#[from] rusqlite::Error),
    /// The read pool did not run a read.
    #[error("the read pool did not run the run's read")]
    Pool(#[from] DatabaseReadError),
    /// A step failed and so did the cleanup after it, every failure kept, the step's own first.
    #[error(transparent)]
    Several(Box<SettleFailures<RunEngineError>>),
}

impl From<RunRefusal> for RunEngineError {
    fn from(refusal: RunRefusal) -> Self {
        Self::Refused(refusal)
    }
}

impl From<RunStateChangeError> for RunEngineError {
    fn from(error: RunStateChangeError) -> Self {
        match error {
            RunStateChangeError::Refused(refusal) => Self::Refused(refusal),
            other @ (RunStateChangeError::CompanionRefused { .. }
            | RunStateChangeError::Draft(_)
            | RunStateChangeError::Append(_)
            | RunStateChangeError::Database(_)
            | RunStateChangeError::Pool(_)) => Self::Change(other),
        }
    }
}

/// What the run engine reads and writes through.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's start"))]
pub(crate) struct RunEngineDeps {
    /// The read pool every run read borrows a connection from.
    pub(crate) pool: Arc<DatabaseReadPool>,
    /// The event log every run event is appended to.
    pub(crate) event_log: Arc<EventLogService>,
    /// The posture gate, registered as the first setup gate; every start reads the run's resolved
    /// posture from it.
    pub(crate) execution_postures: Arc<ExecutionPostureService>,
    /// The registered drivers: a provider's fixed facts and its driver, by the provider's id.
    pub(crate) providers: Arc<ProviderRegistry>,
}

// An interrupt that waits before it is routed: for a continue to settle, or for a start past its
// gates to settle.
enum RoutedInterrupt {
    Continuing(Arc<ContinuingRun>),
    Settling(Arc<StartingRun>),
}

// A row a live append writes, with the events before it and the statements that go in its write
// after the version guard.
struct LiveAppend {
    draft: SessionEventDraft,
    preceding_events: Vec<SessionEventDraft>,
    statements: Vec<WriteStatement>,
}

/// Owns every run state change, the setup gates a run passes before its provider starts it, a
/// run's turns and the daemon's own stops at a limit.
pub(crate) struct RunEngine {
    pool: Arc<DatabaseReadPool>,
    appender: Arc<SessionEventAppender>,
    changes: RunStateChangeWriter,
    gates: RunSetupGates,
    execution_postures: Arc<ExecutionPostureService>,
    providers: Arc<ProviderRegistry>,
    // The interventions service, which carries out the interrupt of each limit stop. It holds the
    // engine, so the engine holds it weakly.
    limit_interrupter: SetOnce<Weak<dyn LimitInterrupter>>,
    live: Mutex<LiveRuns>,
    // Where a test holds a limit stop once its cut is in and before it reads whether its turn is
    // still open.
    #[cfg(test)]
    cut_pause: PausePoint,
}

impl RunEngine {
    /// An engine over `deps`, the posture gate registered as its first setup gate.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's start"))]
    pub(crate) fn new(deps: RunEngineDeps) -> Self {
        let RunEngineDeps {
            pool,
            event_log,
            execution_postures,
            providers,
        } = deps;
        let appender = Arc::new(SessionEventAppender::new(
            event_log,
            SESSION_EVENT_VERSION.clone(),
        ));
        let mut gates = RunSetupGates::default();
        gates.register(Arc::clone(&execution_postures) as Arc<dyn RunSetupGate>);
        Self {
            changes: RunStateChangeWriter::new(Arc::clone(&pool), Arc::clone(&appender)),
            pool,
            appender,
            gates,
            execution_postures,
            providers,
            limit_interrupter: SetOnce::new(),
            live: Mutex::new(LiveRuns::default()),
            #[cfg(test)]
            cut_pause: PausePoint::default(),
        }
    }

    /// Hands the engine the interventions service that carries out each limit stop's interrupt,
    /// once, while the daemon wires its services and before any run can reach a limit. Fails with
    /// the handle when one was handed already.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the daemon's start, which hands the engine the interventions service"
        )
    )]
    pub(crate) fn set_limit_interrupter(
        &self,
        limit_interrupter: Weak<dyn LimitInterrupter>,
    ) -> Result<(), SetOnceError<Weak<dyn LimitInterrupter>>> {
        self.limit_interrupter.set(limit_interrupter)
    }

    /// Adds a setup gate after those already registered; its terminal hook runs before theirs.
    /// Gates are registered while the daemon wires its services, before the engine is shared.
    #[expect(
        dead_code,
        reason = "the daemon's start, which registers each feature's setup gate"
    )]
    pub(crate) fn register_setup_gate(&mut self, gate: Arc<dyn RunSetupGate>) {
        self.gates.register(gate);
    }

    /// Routes an interrupt of `run_id` so it never reaches a driver that does not have the run. A
    /// run in its setup gates, or left live by a start that failed without writing its end, is
    /// claimed at once and never started. A run past its gates and still starting answers once its
    /// start has settled and its `running` write landed: `Ended` when the run ended meanwhile,
    /// `Driver` when the driver has it, and `Claimed` when the start failed and its end could not
    /// be written. A run being continued answers once its continue settles, `Driver` while it runs
    /// and `Ended` once it ended. Any other run is the driver's to stop. Fails when the run's read
    /// fails.
    pub(crate) async fn route_interrupt(
        &self,
        run_id: RunId,
    ) -> Result<InterruptRoute, RunEngineError> {
        let routed = {
            let live = lock(&self.live);
            if let Some(continuing) = live.continuing.get(&run_id) {
                RoutedInterrupt::Continuing(Arc::clone(continuing))
            } else {
                match live.starting.get(&run_id) {
                    None => return Ok(InterruptRoute::Driver),
                    Some(starting) if starting.is_claimable() => {
                        starting.is_interrupted.store(true, Ordering::Release);
                        return Ok(InterruptRoute::Claimed);
                    }
                    Some(starting) => RoutedInterrupt::Settling(Arc::clone(starting)),
                }
            }
        };
        match routed {
            RoutedInterrupt::Continuing(continuing) => {
                continuing.settled.wait().await;
                Ok(match self.read_run(run_id).await? {
                    Some(run) if !run.state.is_terminal() => InterruptRoute::Driver,
                    Some(_) | None => InterruptRoute::Ended,
                })
            }
            RoutedInterrupt::Settling(starting) => {
                let has_driver_run = *starting.settled.wait().await;
                Ok(if starting.has_ended() {
                    InterruptRoute::Ended
                } else if has_driver_run {
                    InterruptRoute::Driver
                } else {
                    InterruptRoute::Claimed
                })
            }
        }
    }

    /// Moves the run as `change` asks, with `companions` in the same write, and returns the run as
    /// the change left it. A terminal runs every terminal hook once it has committed; a hook's
    /// failure is returned after all have run, with the change kept. Once the run is back to
    /// `running` from a wait or a pause, the interrupt of every limit it owes is handed again, each
    /// failure returned beside the run. Refuses as [`RunStateChangeWriter::write`] does; a running
    /// change's posture is the start's to stamp.
    pub(crate) async fn transition(
        self: &Arc<Self>,
        change: RunStateChange,
        companions: RunStateChangeCompanions,
    ) -> Result<WriteWithResend<RunRead>, RunEngineError> {
        let run_id = change.run_id;
        let entered = RunState::from(change.entry.state());
        // The state the move leaves, read only for a move into `running` that names none.
        let left = match change.expected_state {
            Some(expected) => Some(expected),
            None if entered == RunState::Running => {
                self.read_run(run_id).await?.map(|run| run.state)
            }
            None => None,
        };
        let written = self.change(change, companions).await?;
        let resend_failure = match left {
            Some(left) => self
                .hand_owed_limit_interrupts_after_wait(run_id, left, entered)
                .await
                .and_then(Result::err),
            None => None,
        };
        Ok(WriteWithResend {
            written,
            resend_failure,
        })
    }

    /// Moves the run as its provider reported, as [`RunEngine::transition`] does, with the end of
    /// the turn the change ends where the provider reported one, unless the run has already
    /// ended: then a terminal is refused with [`RunRefusal::AlreadyEnded`] and any other change
    /// with [`RunRefusal::InvalidTransition`] from the ended state, the turn's end written on its
    /// own. A change for a run whose driver is still starting it waits until that start has
    /// settled, since a provider can answer before `running` is written, so a driver's start never
    /// waits on its own run's change. A change for a run being continued waits for its continue
    /// the same way, but a terminal before its next turn started belongs to the turn that ended it
    /// and is refused at once. A send's re-open of an ended run is the daemon's, never a
    /// provider's. Once a turn's end is written with the change, a step limit's interrupt a stop
    /// of the run could not hand is handed again, and once the run is back to `running` from a
    /// wait or a pause, the interrupt of every limit it owes, each failure returned beside the run
    /// as the change left it.
    #[cfg_attr(not(test), expect(dead_code, reason = "the provider's event delivery"))]
    pub(crate) async fn apply_provider_state_change(
        self: &Arc<Self>,
        change: RunStateChange,
        turn_end: Option<ProviderTurnEnd>,
    ) -> Result<WriteWithResend<RunRead>, RunEngineError> {
        let run_id = change.run_id;
        let to_state = change.entry.state();
        let settling = lock(&self.live)
            .starting
            .get(&run_id)
            .filter(|starting| !starting.is_claimable())
            .cloned();
        if let Some(starting) = settling {
            starting.settled.wait().await;
        }
        let continuing = lock(&self.live).continuing.get(&run_id).cloned();
        if let Some(continuing) = continuing {
            if !continuing.is_turn_started.load(Ordering::Acquire)
                && RunState::from(to_state).is_terminal()
                && let Some(ended) = self
                    .read_run(run_id)
                    .await?
                    .filter(|run| run.state.is_terminal())
            {
                return Err(self.refuse_ended(run_id, change, &ended, turn_end).await);
            }
            continuing.settled.wait().await;
        }
        let run = self.require_run(run_id).await?;
        if run.state.is_terminal() {
            return Err(self.refuse_ended(run_id, change, &run, turn_end).await);
        }
        let is_turn_ended = turn_end.is_some();
        let left = run.state;
        let turn_end = turn_end.map(|end| self.provider_turn_end(&run_id, end));
        let changed = self
            .change_with_turn_end(change, RunStateChangeCompanions::default(), &run, turn_end)
            .await?;
        let resend_failure = match self
            .hand_owed_limit_interrupts_after_wait(run_id, left, RunState::from(to_state))
            .await
        {
            Some(handed) => handed.err(),
            None if is_turn_ended => self.hand_owed_step_interrupt(run_id).await.err(),
            None => None,
        };
        Ok(WriteWithResend {
            written: changed,
            resend_failure,
        })
    }

    // The refusal of a provider's change of a run that has ended; the turn end it reported still
    // ends its turn, with its cut's limit where a cut names it, written once on its own.
    async fn refuse_ended(
        &self,
        run_id: RunId,
        change: RunStateChange,
        ended: &RunRead,
        turn_end: Option<ProviderTurnEnd>,
    ) -> RunEngineError {
        let refusal =
            RunEngineError::from(ended_run_refusal(run_id, change.entry.state(), ended.state));
        let Some(ProviderTurnEnd {
            turn_number,
            outcome,
        }) = turn_end
        else {
            return refusal;
        };
        let written = match self
            .cut_outcome_of_ended_run(run_id, turn_number, outcome)
            .await
        {
            Ok(outcome) => {
                let turn_end = TurnEnd {
                    turn_number,
                    origin: TurnEndOrigin::Provider,
                    outcome,
                };
                self.record_turn_end_alone(run_id, ended, turn_end, false)
                    .await
            }
            Err(error) => Err(error),
        };
        match written {
            Ok(_) => refusal,
            Err(error) => with_cleanup_failures(
                refusal,
                [Err(error)],
                "refusing a provider's change of an ended run and writing its turn's end",
            ),
        }
    }

    /// Records `marker` on its run at the run's current version and returns the id of the event
    /// written, or `None` with nothing written when the run has ended. Fails with
    /// [`RunRefusal::NotFound`] for a run the daemon has no row for.
    #[expect(dead_code, reason = "the provider's event delivery")]
    pub(crate) async fn append_run_marker(
        &self,
        marker: RunMarker,
    ) -> Result<Option<FreeFormText<EVENT_FIELD_MAX_LEN>>, RunEngineError> {
        let run_id = marker.run_id();
        let recorded = self
            .append_while_live(run_id, |run| {
                Ok(LiveAppend {
                    draft: SessionEventDraft::of_session(
                        run.session_id,
                        &marker.clone().into_event(run),
                    )?,
                    preceding_events: Vec::new(),
                    statements: Vec::new(),
                })
            })
            .await?;
        Ok(recorded.map(|(_run, receipt)| receipt.id))
    }

    /// Compares a run's settled output speed with the fast level it carried and, where the
    /// provider runs it at another state, appends one `fastOutputUnavailable` notice naming the
    /// run, with the provider's reason. Only the first report for a started run is compared; a
    /// later one finds nothing. Fails when the notice is not appended.
    #[expect(dead_code, reason = "the provider's event delivery")]
    pub(crate) async fn record_settled_output_speed(
        &self,
        session_id: SessionId,
        run_id: RunId,
        state: &ProviderOutputSpeedState,
    ) -> Result<(), RunEngineError> {
        let Some(carried) = lock(&self.live).carried_output_speeds.remove(&run_id) else {
            return Ok(());
        };
        if state.declared.as_str() == carried.as_str() {
            return Ok(());
        }
        let notice = SessionNotice::FastOutputUnavailable {
            session_id,
            run_id,
            reason: state.reason.clone().map(|reason| {
                FreeFormText::new(reason.into_string())
                    .expect("an output-speed reason fits the longer failure detail cap")
            }),
        };
        self.appender
            .append(
                SessionEventDraft::of_session(
                    session_id,
                    &SessionEvent::SessionNoticePosted(SessionNoticePostedPayload::Notice(notice)),
                )?,
                SessionEventLinkage::default(),
            )
            .await?;
        Ok(())
    }

    // Writes `change`, keeping a terminal write in flight for a continue to wait on, and runs the
    // terminal hooks once a terminal has committed.
    async fn change(
        &self,
        change: RunStateChange,
        companions: RunStateChangeCompanions,
    ) -> Result<RunRead, RunEngineError> {
        let run_id = change.run_id;
        let ending = RunState::from(change.entry.state())
            .is_terminal()
            .then(|| self.track_ending(run_id));
        let written = self.changes.write(change, companions).await;
        drop(ending);
        let run = written?;
        if run.state.is_terminal() {
            self.forget_ended_run(&run_id);
            self.gates
                .release_for_terminal(&RunTerminalContext {
                    run_id,
                    session_id: run.session_id,
                    terminal_state: run.state,
                    run_version: run.version,
                })
                .await?;
        }
        Ok(run)
    }

    // Keeps a terminal write of `run_id` in flight, after any before it, until the guard drops.
    fn track_ending(&self, run_id: RunId) -> EndingGuard<'_> {
        let mut live = lock(&self.live);
        let entry = Arc::new(EndingWrite {
            previous: live.ending.get(&run_id).cloned(),
            landed: SetOnce::new(),
        });
        live.ending.insert(run_id, Arc::clone(&entry));
        EndingGuard {
            live: &self.live,
            run_id,
            entry,
        }
    }

    // Waits until every terminal write of `run_id` in flight now has landed or been refused.
    async fn wait_for_ending_writes(&self, run_id: &RunId) {
        let mut next = lock(&self.live).ending.get(run_id).cloned();
        while let Some(write) = next {
            write.landed.wait().await;
            next = write.previous.clone();
        }
    }

    // What the engine held for a run that has ended. A cut stays until its turn's end is written,
    // which its provider can report after the run's end.
    fn forget_ended_run(&self, run_id: &RunId) {
        let mut live = lock(&self.live);
        live.carried_output_speeds.remove(run_id);
        live.step_counts.remove(run_id);
        live.reached_limits
            .retain(|(reached_run_id, _)| reached_run_id != run_id);
        live.mark_starting_run_ended(run_id);
    }

    // The provider the run runs on, from the newest runtime binding of the run or of the nearest
    // parent whose provider process it runs in.
    async fn provider_of(&self, run_id: RunId) -> Result<ProviderId, RunEngineError> {
        self.pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, RunEngineError>(read_run_provider(reader, &run_id)?)
            })
            .await?
            .ok_or(RunEngineError::ProviderUnknown { run_id })
    }

    // A run being continued reads ended until its continue is written. The wait ends when the
    // continue's guard settles, which it does on every exit of the continue, its drop included.
    async fn wait_while_continuing(&self, run_id: &RunId) {
        let continuing = lock(&self.live).continuing.get(run_id).cloned();
        if let Some(continuing) = continuing {
            continuing.settled.wait().await;
        }
    }

    // Appends the row `build` makes from the run as it reads now, guarded on that read's version
    // so a move in between reads the run again. Returns the read it appended at and the receipt,
    // or `None` with nothing written once the run has ended.
    async fn append_while_live(
        &self,
        run_id: RunId,
        mut build: impl FnMut(&RunRead) -> Result<LiveAppend, RunEngineError>,
    ) -> Result<Option<(RunRead, EventLogAppendReceipt)>, RunEngineError> {
        self.wait_while_continuing(&run_id).await;
        let mut attempt = 1;
        loop {
            let run = self.require_run(run_id).await?;
            if run.state.is_terminal() {
                return Ok(None);
            }
            let LiveAppend {
                draft,
                preceding_events,
                statements,
            } = build(&run)?;
            let mut transactional_prelude = vec![run_at_version_statement(&run_id, run.version)];
            transactional_prelude.extend(statements);
            match self
                .append(draft, transactional_prelude, preceding_events)
                .await
            {
                Ok(receipt) => return Ok(Some((run, receipt))),
                Err(error)
                    if attempt < LIVE_APPEND_ATTEMPTS
                        && refused_statement_index(&error)
                            == Some(LIVE_APPEND_VERSION_GUARD_INDEX) => {}
                Err(error) => return Err(error.into()),
            }
            attempt += 1;
        }
    }

    // One append of `draft` after `preceding_events`, with `transactional_prelude` in its write.
    async fn append(
        &self,
        draft: SessionEventDraft,
        transactional_prelude: Vec<WriteStatement>,
        preceding_events: Vec<SessionEventDraft>,
    ) -> Result<EventLogAppendReceipt, SessionEventAppendError> {
        self.appender
            .append(
                draft,
                SessionEventLinkage {
                    transactional_prelude,
                    preceding_events,
                    ..SessionEventLinkage::default()
                },
            )
            .await
    }

    async fn read_run(&self, run_id: RunId) -> Result<Option<RunRead>, RunEngineError> {
        read_run_through(&self.pool, run_id).await
    }

    async fn require_run(&self, run_id: RunId) -> Result<RunRead, RunEngineError> {
        self.read_run(run_id)
            .await?
            .ok_or(RunEngineError::Refused(RunRefusal::NotFound { run_id }))
    }
}

// A step's failure with the failures of the cleanups that ran after it, every one kept: the step's
// own alone when every cleanup passed.
fn with_cleanup_failures(
    failure: RunEngineError,
    cleanups: impl IntoIterator<Item = Result<(), RunEngineError>>,
    operation: &'static str,
) -> RunEngineError {
    let mut failures = vec![failure];
    failures.extend(cleanups.into_iter().filter_map(Result::err));
    if failures.len() == 1 {
        failures.remove(0)
    } else {
        RunEngineError::Several(Box::new(SettleFailures::Many {
            operation,
            failures,
        }))
    }
}

// Every step's outcome folded into one: done, the one failure as it came, or every failure.
fn settled(
    outcomes: Vec<Result<(), RunEngineError>>,
    operation: &'static str,
) -> Result<(), RunEngineError> {
    settle_all(outcomes, operation)
        .map(drop)
        .map_err(|failures| match failures {
            SettleFailures::One(failure) => failure,
            many @ SettleFailures::Many { .. } => RunEngineError::Several(Box::new(many)),
        })
}
