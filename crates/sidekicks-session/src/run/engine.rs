//! The run engine: every run state change goes through it, each checked against the table and
//! written with the run's row, and each terminal followed by the terminal hooks of the setup gates.
//! It also starts the runs of the turns the daemon starts on a session itself and of a provider's
//! own subagents, continues an interrupted run on its next turn, resumes a paused run once its
//! driver took the resume, numbers and ends each turn, counts a turn's steps against its step
//! bound, stops a run at a limit, records the markers a provider reports on a live run, tells a
//! session when a run's provider does not run it at the fast output level it carried, and re-arms
//! and finalizes the live runs a restart's resume found again, moves a lead a failed continue
//! left `running` back to `paused`, records an undo's confirmed cut as the run's rollback, holding
//! back a turn opening that meets an undo's write in progress, and moves a child run under the run
//! whose call started it.

mod continued_lead;
mod ending;
pub mod errors;
mod host;
mod interrupt_hands;
mod limits;
mod live;
mod parent_correction;
mod provider_started;
mod resumed;
mod running_wait;
pub mod settle;
mod start;
#[cfg(any(test, feature = "test-support"))]
pub mod test_fixture;
#[cfg(test)]
pub(crate) mod tests;
pub(crate) mod turns;
pub mod undo;
mod unresolved_interventions;
pub(crate) mod usage_tallies;

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, Weak};

use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::provider::driver::output_speed::ProviderOutputSpeedState;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::events::{
    AgentRunProviderInitializedPayload, AgentRunWorkerShuttingDownPayload, TurnEndOrigin,
};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::controls::events::{SessionNotice, SessionNoticePostedPayload};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::turn_attribution::{EpochPosition, transcript_run_stamp_at};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::run::delivery::{RunMarker, RunSetupRefusal};
use sidekicks_provider::run::posture::ExecutionPostureService;
use sidekicks_provider::run::state_entry::RunStateEntry;
use sidekicks_provider::run::turn_end::{ProviderTurnEnd, TurnOutcome};
use sidekicks_provider::runtime_binding::store::read_binding;
use sidekicks_std::mutex_lock::lock;
#[cfg(any(test, feature = "test-support"))]
use sidekicks_std::pause_point::PausePoint;
use sidekicks_std::settle_all::{SettleFailures, settle_all};
use sidekicks_store::database::connection::read_pool::{DatabaseReadPool, ReadLength};
use sidekicks_store::database::statement::WriteStatement;
use sidekicks_store::events::log_service::{EventLogAppendReceipt, EventLogService};
use sidekicks_store::events::session::append_lock::SessionAppendHold;
use sidekicks_store::events::session::appender::{
    SessionEventAppendError, SessionEventAppender, SessionEventDraft, SessionEventLinkage,
};
use sidekicks_store::events::session::read::{DamagedFromSequenceReader, session_read_bound};
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;
use sidekicks_workspace::run_setup_gates::{RunSetupGate, RunSetupGates};
use tokio::sync::{SetOnce, SetOnceError};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::interventions::interrupt_queue::InterruptQueue;
use crate::interventions::store::run_at_version_statement;
use crate::plan_holds::PlanHolds;
use crate::run::agent::RUN_AGENT_STATEMENT_CAPACITY;
use crate::run::binding_cursors::epoch_binding_of;
use crate::run::engine::errors::RunEngineError;
use crate::run::engine::live::{ContinuingRun, LiveRuns, ProviderChangeGuard, StartingRun};
use crate::run::engine::turns::{TurnEnd, WriteWithResend};
use crate::run::epochs::EpochBinding;
use crate::run::limit_interrupter::LimitInterrupter;
use crate::run::provider_choice::held::HeldChoiceAnswers;
use crate::run::read::{RunRead, RunStateReader, read_run_through, safe_run_version};
use crate::run::refusals::{RunRefusal, ended_run_refusal};
use crate::run::session_posture::SessionPostureSource;
use crate::run::state_change::{RunStateChange, RunWriteCompanions, RunWriter};
use crate::run::superseded::read_superseded_turns_guarded;
use crate::transcript::turn_attribution::{RunTurnReads, TurnAttributionError};

/// The statements the engine's reads prepare on a pooled connection: the run's row, the workspace
/// a run's execution context bound it in, the live
/// provider subagents beneath a run, the ended runs with an open turn, a run's pending interrupts
/// and whether its interrupt at one limit is pending, the limit its log still owes, its open turns'
/// cuts and the queued messages waiting for it, the number a run's next turn takes, its newest open
/// turn and every open turn, its provider, whether it is a provider subagent, whether it ended
/// since a version, its interventions with no outcome and one session's ended runs still holding
/// one, the two agent reads, and the run end's reads of its held questions open or waiting for it
/// (`UNSETTLED_HELD_OF_RUN_SQL`), its plans still holding a request (its plan holds' read) and its
/// open choices (the newest request of each dialog and whether it was settled since), a driver's
/// read of a session's stored leg (the session's runs and their bindings), whether a run ended at
/// its setup, a restart's re-arm of a live run (its newest open turn with its steps, and the
/// session's step bound), a provider subagent's node by its provider's id, the run a provider's
/// helper was dispatched beneath, a turn start's reads of the message that opened it and of
/// where its run stands (the run's rollbacks, and its turn starts and steers), and a late row's
/// reads of the tool call it closes, of its run's superseded turns and of its binding.
pub const RUN_ENGINE_STATEMENT_CAPACITY: usize = 34 + RUN_AGENT_STATEMENT_CAPACITY;

// Reads of a live run before a guarded append gives up on a run that keeps moving under it.
const LIVE_APPEND_ATTEMPTS: usize = 3;

// The guard on the version a live append was built from is the first statement of its write.
const LIVE_APPEND_VERSION_GUARD_INDEX: usize = 0;

/// How the start of a run its provider started beneath a live parent went: running at its
/// session's posture, or refused at its setup and ended `failed`, the subagent left for its driver
/// to stop.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SubagentRunStart {
    /// The run is `running`, stamped with the posture its gates resolved.
    Running(RunId),
    /// A setup gate refused the run, which ended `failed` with no posture stamped, for the
    /// refusal its failure cause records.
    Refused(RunId, RunSetupRefusal),
}

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

/// What the run engine reads and writes through.
pub struct RunEngineDeps {
    /// The read pool every run read borrows a connection from.
    pub pool: Arc<DatabaseReadPool>,
    /// Answers where a damaged session's log reads stop, for the reads of where a run stands.
    pub read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
    /// The event log every run event is appended to.
    pub event_log: Arc<EventLogService>,
    /// The posture gate, registered as the first setup gate; every start reads the run's resolved
    /// posture from it.
    pub execution_postures: Arc<ExecutionPostureService>,
    /// The registered drivers: a provider's fixed facts and its driver, by the provider's id.
    pub providers: Arc<ProviderRegistry>,
    /// The plans a run's end reopens as it lets their held requests go.
    pub plan_holds: Arc<dyn PlanHolds>,
    /// The answers to a provider's choice that got no reply back, which the run's choice resolver
    /// holds and a run's end writes as its choice's settlement once a report showed one taken.
    pub held_choice_answers: Arc<HeldChoiceAnswers>,
}

// An interrupt that waits before it is routed: for a continue to settle, or for a start past its
// gates to settle.
enum RoutedInterrupt {
    Continuing(Arc<ContinuingRun>),
    Settling(Arc<StartingRun>),
}

// A row a live append writes, with the events before it, the statements that go in its write
// after the version guard, and the instant it records where its statements carry that instant too.
struct LiveAppend {
    draft: SessionEventDraft,
    preceding_events: Vec<SessionEventDraft>,
    statements: Vec<WriteStatement>,
    occurred_at: Option<WireInstant>,
}

/// Owns every run state change, the setup gates a run passes before its provider starts it, a
/// run's turns and the daemon's own stops at a limit.
pub struct RunEngine {
    pool: Arc<DatabaseReadPool>,
    read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
    appender: Arc<SessionEventAppender>,
    changes: RunWriter,
    gates: RunSetupGates,
    execution_postures: Arc<ExecutionPostureService>,
    providers: Arc<ProviderRegistry>,
    plan_holds: Arc<dyn PlanHolds>,
    held_choice_answers: Arc<HeldChoiceAnswers>,
    // The interventions service, which carries out the interrupt of each limit stop. It holds the
    // engine, so the engine holds it weakly.
    limit_interrupter: SetOnce<Weak<dyn LimitInterrupter>>,
    // The run queue, whose hold of a person's interrupt a run's end or a turn's end lets go once it
    // settles that interrupt; held weakly, as the queue holds the engine.
    interrupt_queue: SetOnce<Weak<dyn InterruptQueue>>,
    // Where a run its provider started reads the posture its session's open process runs at; held
    // weakly, as that source reaches the engine through the drivers' ports.
    session_postures: SetOnce<Weak<dyn SessionPostureSource>>,
    live: Mutex<LiveRuns>,
    // The tasks that carry a run's interrupt out apart from the call that asked for it, and the
    // daemon's stop that cuts them.
    interrupt_hands: TaskTracker,
    interrupt_hands_stop: CancellationToken,
    // Where a test holds a limit stop once its cut is in and before it reads whether its turn is
    // still open.
    #[cfg(test)]
    cut_pause: PausePoint,
    // Where a test holds a resume's read of its run, once the run is held as being resumed.
    #[cfg(test)]
    resume_read_pause: PausePoint,
    // Where a test holds a restart's settle of a run between its facts' read and its write.
    #[cfg(any(test, feature = "test-support"))]
    restart_facts_pause: PausePoint,
    // The engine's own allocation, which a call a driver makes through its port takes to hand a
    // limit's stop to a task of its own.
    this: Weak<RunEngine>,
}

impl RunEngine {
    /// An engine over `deps`, built inside the allocation `this` points to, the posture gate
    /// registered as its first setup gate.
    pub fn new(deps: RunEngineDeps, this: Weak<RunEngine>) -> Self {
        let RunEngineDeps {
            pool,
            read_damaged_from_sequence,
            event_log,
            execution_postures,
            providers,
            plan_holds,
            held_choice_answers,
        } = deps;
        let appender = Arc::new(SessionEventAppender::new(
            event_log,
            SESSION_EVENT_VERSION.clone(),
        ));
        let mut gates = RunSetupGates::default();
        gates.register(Arc::clone(&execution_postures) as Arc<dyn RunSetupGate>);
        Self {
            changes: RunWriter::new(Arc::clone(&pool), Arc::clone(&appender)),
            pool,
            read_damaged_from_sequence,
            appender,
            gates,
            execution_postures,
            providers,
            plan_holds,
            held_choice_answers,
            limit_interrupter: SetOnce::new(),
            interrupt_queue: SetOnce::new(),
            session_postures: SetOnce::new(),
            live: Mutex::new(LiveRuns::default()),
            interrupt_hands: TaskTracker::new(),
            interrupt_hands_stop: CancellationToken::new(),
            #[cfg(test)]
            cut_pause: PausePoint::default(),
            #[cfg(test)]
            resume_read_pause: PausePoint::default(),
            #[cfg(any(test, feature = "test-support"))]
            restart_facts_pause: PausePoint::default(),
            this,
        }
    }

    // The engine's own allocation, which outlives every call made on it.
    fn shared(&self) -> Arc<Self> {
        self.this
            .upgrade()
            .expect("the engine lives in its allocation while a call runs on it")
    }

    /// Where a test holds a resume's read of its run, once the run is held as being resumed.
    #[cfg(test)]
    pub(crate) fn resume_read_pause(&self) -> &PausePoint {
        &self.resume_read_pause
    }

    /// Where a test holds a restart's settle of a run between its facts' read and its write.
    #[cfg(any(test, feature = "test-support"))]
    pub fn restart_facts_pause(&self) -> &PausePoint {
        &self.restart_facts_pause
    }

    /// The held answers this engine's run ends read, for a test's resolver to hold its answers in.
    #[cfg(any(test, feature = "test-support"))]
    pub fn held_choice_answers(&self) -> &Arc<HeldChoiceAnswers> {
        &self.held_choice_answers
    }

    /// The limit turn `turn_number` of `run_id` ends with by the cuts the engine holds of it, if
    /// any, so a test reads what a cut or a re-arm left.
    #[cfg(any(test, feature = "test-support"))]
    pub fn held_cut_limit(
        &self,
        run_id: RunId,
        turn_number: sidekicks_contracts::wire::integer::SafeInt<1>,
    ) -> Option<sidekicks_contracts::run::intervention::RunLimit> {
        lock(&self.live).current_limit(&(run_id, turn_number))
    }

    /// Hands the engine the interventions service that carries out each limit stop's interrupt,
    /// once, while the daemon wires its services and before any run can reach a limit. Fails with
    /// the handle when one was handed already.
    pub fn set_limit_interrupter(
        &self,
        limit_interrupter: Weak<dyn LimitInterrupter>,
    ) -> Result<(), SetOnceError<Weak<dyn LimitInterrupter>>> {
        self.limit_interrupter.set(limit_interrupter)
    }

    /// Hands the engine the source of each open session's posture, which a run its provider starts
    /// is gated at, once, while the daemon wires its services and before any provider runs. Fails
    /// with the handle when one was handed already.
    pub fn set_session_postures(
        &self,
        session_postures: Weak<dyn SessionPostureSource>,
    ) -> Result<(), SetOnceError<Weak<dyn SessionPostureSource>>> {
        self.session_postures.set(session_postures)
    }

    /// Adds a setup gate after those already registered; its terminal hook runs before theirs.
    /// Gates are registered while the daemon wires its services, before the engine is shared.
    pub fn register_setup_gate(&mut self, gate: Arc<dyn RunSetupGate>) {
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
    /// failure is returned after all have run, with the change kept. A move into `running` whose
    /// change names the state it leaves as a wait for an approval or for input, or `pausing`,
    /// where the provider never stopped, hands again the interrupt of every limit the run owes
    /// once it is written, on a task of its own; a move that names no state it leaves hands
    /// nothing, its caller handing them once the provider runs. Refuses as
    /// `RunWriter::write` does; a running change's posture is the start's to stamp.
    pub async fn transition(
        self: &Arc<Self>,
        change: RunStateChange,
        companions: RunWriteCompanions,
    ) -> Result<RunRead, RunEngineError> {
        let run_id = change.run_id;
        let is_back_to_running = RunState::from(change.entry.state()) == RunState::Running
            && matches!(
                change.expected_state,
                Some(RunState::WaitingForApproval | RunState::WaitingForInput | RunState::Pausing)
            );
        let written = self.change(change, companions, None).await?;
        if is_back_to_running {
            self.hand_owed_limit_interrupts(run_id);
        }
        Ok(written)
    }

    /// Moves the run as its provider reported, as [`RunEngine::transition`] does, with the end of
    /// the turn the change ends where the provider reported one, unless the run has already
    /// ended: then a terminal is refused with [`RunRefusal::AlreadyEnded`] and any other change
    /// with [`RunRefusal::InvalidTransition`] from the ended state, the turn's end written on its
    /// own. A change for a run whose driver is still starting it waits until that start has
    /// settled, since a provider can answer before `running` is written, so a driver's start never
    /// waits on its own run's change. A change for a run being continued waits for its continue
    /// the same way, but a terminal before its next turn started belongs to the turn that ended it
    /// and is refused at once; a resume that comes after this change has passed that check waits
    /// for it to be written. A send's re-open of an ended run is the daemon's, never a provider's,
    /// and so is a move from `running` back to `paused`: a pause that expects no state is taken
    /// only from `pausing`, and refused with [`RunRefusal::InvalidTransition`] from any other.
    /// A turn the provider ended any other way than interrupted expires, in the change's write,
    /// each interrupt left on the run with no outcome, which did not take, and lets go the run
    /// queue's hold of a person's. Once a turn's end is written with the change, a step limit's
    /// interrupt a stop of the run could not hand is handed again, and once the provider reports
    /// the run back to `running` from a wait, a pause or `pausing`, the interrupt of every limit it
    /// owes, each failure returned beside the run as the change left it.
    pub async fn apply_provider_state_change(
        self: &Arc<Self>,
        mut change: RunStateChange,
        turn_end: Option<ProviderTurnEnd>,
    ) -> Result<WriteWithResend<RunRead>, RunEngineError> {
        // A provider pauses a run only by ending the pause the daemon asked for; the table's
        // `running -> paused` row is the daemon's own move back after a failed continue.
        if matches!(change.entry, RunStateEntry::Paused) && change.expected_state.is_none() {
            change.expected_state = Some(RunState::Pausing);
        }
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
        // Marked past the check under its lock, so a resume that holds the run after it waits for
        // this change to be written first and never reads the run this change moves.
        let mark = loop {
            let continuing = {
                let mut live = lock(&self.live);
                match live.continuing.get(&run_id).cloned() {
                    Some(continuing) => continuing,
                    None => break live.mark_provider_change(run_id),
                }
            };
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
        };
        let mark = ProviderChangeGuard {
            live: &self.live,
            run_id,
            mark,
        };
        let run = self.require_run(run_id).await?;
        if run.state.is_terminal() {
            drop(mark);
            return Err(self.refuse_ended(run_id, change, &run, turn_end).await);
        }
        let is_turn_ended = turn_end.is_some();
        // A turn its provider ended any other way than interrupted shows that an interrupt left
        // with no outcome did not take; a run's end settles such rows itself.
        let is_turn_uninterrupted = turn_end
            .is_some_and(|end| !matches!(end.outcome, TurnOutcome::Interrupted(_)))
            && !RunState::from(to_state).is_terminal();
        let left = run.state;
        let turn_end = turn_end.map(|end| self.provider_turn_end(&run_id, end));
        let changed = if is_turn_uninterrupted {
            self.change_with_uninterrupted_turn_end(change, &run, turn_end)
                .await
        } else {
            self.change_with_turn_end(change, RunWriteCompanions::default(), &run, turn_end, None)
                .await
        };
        drop(mark);
        let changed = changed?;
        // A provider that reports `running` runs again, from a pause or `pausing` as well.
        let is_back_to_running = RunState::from(to_state) == RunState::Running
            && matches!(
                left,
                RunState::WaitingForApproval
                    | RunState::WaitingForInput
                    | RunState::Paused
                    | RunState::Pausing
            );
        let resend_failure = if is_back_to_running {
            self.stop_at_owed_limits(run_id).await.err()
        } else if is_turn_ended {
            self.hand_owed_step_interrupt(run_id).await.err()
        } else {
            None
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
                self.record_turn_end_alone(run_id, ended, turn_end, false, None)
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
                        &run_marker_event(marker.clone(), run),
                    )?,
                    preceding_events: Vec::new(),
                    statements: Vec::new(),
                    occurred_at: None,
                })
            })
            .await?;
        Ok(recorded.map(|(_run, receipt)| receipt.id))
    }

    /// Compares a run's settled output speed with the fast level it carried and, where the
    /// provider runs it at another state, appends one `fastOutputUnavailable` notice naming the
    /// run, with the provider's reason. Only the first report for a started run is compared; a
    /// later one finds nothing. Fails when the notice is not appended.
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

    /// Waits while `run_id` is being continued, since it reads ended until its continue is
    /// written; the wait ends when the continue's guard settles, on every exit of the continue.
    pub(crate) async fn wait_while_continuing(&self, run_id: &RunId) {
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
                occurred_at,
            } = build(&run)?;
            let mut transactional_prelude = vec![run_at_version_statement(&run_id, run.version)];
            transactional_prelude.extend(statements);
            let linkage = SessionEventLinkage {
                occurred_at,
                transactional_prelude,
                preceding_events,
                ..SessionEventLinkage::default()
            };
            match self.appender.append(draft, linkage).await {
                Ok(receipt) => return Ok(Some((run, receipt))),
                Err(error)
                    if attempt < LIVE_APPEND_ATTEMPTS
                        && error.refused_statement_index()
                            == Some(LIVE_APPEND_VERSION_GUARD_INDEX) => {}
                Err(error) => return Err(error.into()),
            }
            attempt += 1;
        }
    }

    /// One append of `draft` after `preceding_events`, with `transactional_prelude` in its write,
    /// under `hold` where the caller holds the session. Fails as the write fails or a statement of
    /// the prelude refuses it.
    pub(crate) async fn append(
        &self,
        draft: SessionEventDraft,
        transactional_prelude: Vec<WriteStatement>,
        preceding_events: Vec<SessionEventDraft>,
        hold: Option<&SessionAppendHold>,
    ) -> Result<EventLogAppendReceipt, SessionEventAppendError> {
        let linkage = SessionEventLinkage {
            transactional_prelude,
            preceding_events,
            ..SessionEventLinkage::default()
        };
        match hold {
            Some(hold) => self.appender.append_held(hold, draft, linkage).await,
            None => self.appender.append(draft, linkage).await,
        }
    }

    async fn read_run(&self, run_id: RunId) -> Result<Option<RunRead>, RunEngineError> {
        read_run_through(&self.pool, run_id).await
    }

    /// Whether `run_id` ended `failed` at its setup, before its provider started it, as a helper
    /// the daemon refused after its provider started it does; `false` for a run with no row. Fails
    /// as the read does.
    pub(crate) async fn is_failed_at_setup(&self, run_id: RunId) -> Result<bool, RunEngineError> {
        self.pool
            .read(ReadLength::Short, move |reader| {
                let runs = RunStateReader::new(reader);
                let Some(run) = runs.read_run(&run_id)? else {
                    return Ok(false);
                };
                Ok::<_, RunEngineError>(runs.is_failed_at_setup(&run.session_id, &run_id)?)
            })
            .await
    }

    /// Whether `run_id`'s latest tool call `tool_call_id` in `session_id`'s log opened in a turn
    /// an undo superseded, its late row arriving on the binding `binding_id`. A call of a run no
    /// undo cut, one that opened in a kept turn and one with no opening in the log are kept, and
    /// so is one whose binding has no row, which only a purged session leaves. Fails as the reads
    /// do.
    pub(crate) async fn read_tool_call_opening_turn(
        &self,
        session_id: SessionId,
        run_id: RunId,
        tool_call_id: String,
        binding_id: RuntimeBindingId,
    ) -> Result<ToolCallOpeningTurn, RunEngineError> {
        let read_damaged_from_sequence = Arc::clone(&self.read_damaged_from_sequence);
        self.pool
            .read(ReadLength::Short, move |reader| {
                let (turns, no_newer_rollback) = read_superseded_turns_guarded(
                    reader,
                    &*read_damaged_from_sequence,
                    &session_id,
                    &run_id,
                )
                .map_err(TurnAttributionError::from)?;
                // A run no undo cut supersedes nothing, so its row is kept without the opening's
                // read; the guard still refuses it once a cut lands before its append.
                let kept = ToolCallOpeningTurn::Kept { no_newer_rollback };
                if turns.cuts.is_empty() {
                    return Ok(kept);
                }
                let log_end = session_read_bound(&*read_damaged_from_sequence, &session_id, None);
                let Some(opening) = RunTurnReads::new(reader, &*read_damaged_from_sequence)
                    .read_tool_call_opening_before(&session_id, &run_id, &tool_call_id, log_end)?
                else {
                    return Ok(kept);
                };
                if transcript_run_stamp_at(&turns, opening)
                    .superseded
                    .is_none()
                {
                    return Ok(kept);
                }
                Ok::<_, RunEngineError>(match read_binding(reader, &binding_id)? {
                    Some(binding) => ToolCallOpeningTurn::Cut {
                        binding: epoch_binding_of(&binding),
                        source: opening,
                    },
                    None => kept,
                })
            })
            .await
    }

    /// The run `run_id` as it reads now; fails with [`RunRefusal::NotFound`] when it has no row,
    /// and as the read does.
    pub(crate) async fn require_run(&self, run_id: RunId) -> Result<RunRead, RunEngineError> {
        self.read_run(run_id)
            .await?
            .ok_or(RunEngineError::Refused(RunRefusal::NotFound { run_id }))
    }
}

/// Where a run's late row's tool call opened, read from the log.
pub(crate) enum ToolCallOpeningTurn {
    /// In a turn an undo superseded: the row is absorbed as from before the cut, at `source` on
    /// the `binding` it arrived on.
    Cut {
        /// The binding the row arrived on.
        binding: EpochBinding,
        /// Where the call opened.
        source: EpochPosition,
    },
    /// In a kept turn, or nowhere the log shows: the row is appended, with `no_newer_rollback` in
    /// its write, which refuses it once a rollback of the run the read did not take is in the
    /// log, so the read decides again.
    Kept {
        /// The guard the row's append carries.
        no_newer_rollback: WriteStatement,
    },
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

// The event a provider's marker on a live run is recorded as, at the session and version `run`
// read.
fn run_marker_event(marker: RunMarker, run: &RunRead) -> SessionEvent {
    let session_id = run.session_id;
    let run_version = safe_run_version(run.version);
    match marker {
        RunMarker::ProviderInitialized {
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
        RunMarker::WorkerShuttingDown { run_id, reason } => {
            SessionEvent::AgentRunWorkerShuttingDown(AgentRunWorkerShuttingDownPayload {
                session_id,
                run_id,
                run_version,
                reason,
            })
        }
    }
}
