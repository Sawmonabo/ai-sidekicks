//! A run engine for the drivers' tests, reached through the run host and inbound dispatch ports:
//! it records each call a driver makes, in order, and answers as the real one would on success.

use std::collections::{HashMap, VecDeque};
use std::error::Error;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use futures::FutureExt;
use futures::future::BoxFuture;
use serde_json::Value;
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::provider::driver::output_speed::ProviderOutputSpeedState;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::control::ProcessExit;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::turn::ProviderTurnId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::{Notify, oneshot};

use crate::driver::test_registry::new_run_id;
use crate::port::inbound_dispatch::InboundDispatch;
use crate::port::run_host::{DaemonTurnHeld, RunHost, RunHostError};
use crate::run::delivery::{
    InboundDelivery, InboundOutcome, LateAppendableRow, MachineScopedRow, RunSetupRefusal,
    SessionScopedRow, UnstampedRow,
};
use crate::run::start_request::DaemonTurnStartRequest;
use crate::run::state_entry::{RunStateEntry, RunStateReport};
use crate::run::turn_end::{ProviderTurnEnd, StartedTurn, TurnOutcome};
use crate::runtime_binding::store::RuntimeBinding;

/// The refusal of every daemon turn a test asked the engine to refuse, before any run exists.
#[derive(Debug, thiserror::Error)]
#[error("the test refuses the daemon turn of run {run_id}")]
struct DaemonTurnsRefused {
    run_id: RunId,
}

/// One delivery as the recording engine kept it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct RecordedDelivery {
    /// The delivery's kind, as the run engine names it.
    pub(crate) kind: &'static str,
    /// The binding it was attributed on, where it names one.
    pub(crate) binding_id: Option<RuntimeBindingId>,
    /// A run's move, for a run lifecycle delivery.
    pub(crate) change: Option<RunStateReport>,
    /// The turn's end a run lifecycle delivery carries.
    pub(crate) turn_end: Option<TurnOutcome>,
    /// The number of the turn a run lifecycle delivery ends.
    pub(crate) ended_turn_number: Option<SafeInt<1>>,
    /// Whether it is the end of the daemon's own interrupt.
    pub(crate) is_daemon_interrupt_end: bool,
    /// The turn a steer delivery's message joined.
    pub(crate) steered_turn_number: Option<SafeInt<1>>,
    /// The queue item whose message a steer delivery says the provider took.
    pub(crate) message_id: Option<QueueItemId>,
    /// The run the delivery names.
    pub(crate) run_id: Option<RunId>,
    /// The run a child run delivery starts beneath, or a parent correction moves its run under.
    pub(crate) parent_run_id: Option<RunId>,
    /// The helper a child run delivery is for.
    pub(crate) subagent: Option<crate::run::delivery::ChildRunSubagent>,
    /// The row a session row or after-run row delivery appends.
    pub(crate) row: Option<LateAppendableRow>,
    /// The prose a session row or after-run row delivery stores beside its row.
    pub(crate) content: Option<String>,
    /// The session a notice names.
    pub(crate) session_id: Option<SessionId>,
    /// The payload of a notice, a row on no binding or a row that takes no stamp, as its event
    /// would carry it.
    pub(crate) payload: Option<Value>,
}

/// One call the driver made on the run engine, in order.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum EngineCall {
    /// A delivery.
    Deliver(Box<RecordedDelivery>),
    /// A turn opened on the run, with the queue item whose message opened it.
    StartTurn(RunId, Option<QueueItemId>),
    /// A step counted on the run.
    CountStep(RunId),
    /// A turn's end that moves no run.
    RecordTurnEnd(RunId, TurnOutcome),
    /// A turn's end the daemon wrote with no provider frame, by the turn's number.
    RecordDaemonTurnEnd(RunId, SafeInt<1>, TurnOutcome),
    /// A turn the daemon or the provider started itself, as the minted run.
    StartDaemonTurn(RunId),
    /// A run's turn ended on its process's exit.
    EndTurnOnProcessExit(RunId),
    /// A run's turn ended as its session closed.
    EndTurnOnClose(RunId),
}

/// A run engine that records each call and answers as the real one would on success: each
/// delivery with the outcome its kind gets, every ask admitted, every child run started unless a
/// test asked it refused, every turn opened and numbered within its run.
#[derive(Default)]
pub(crate) struct RecordingRunEngine {
    calls: Mutex<Vec<EngineCall>>,
    delivery_holds: Mutex<VecDeque<oneshot::Receiver<()>>>,
    ask_holds: Mutex<VecDeque<oneshot::Receiver<()>>>,
    refused_child_runs: Mutex<VecDeque<(RunId, RunSetupRefusal)>>,
    turn_start_holds: Mutex<VecDeque<oneshot::Receiver<()>>>,
    daemon_turn_start_holds: Mutex<VecDeque<oneshot::Receiver<()>>>,
    turns_numbered: Mutex<HashMap<RunId, u64>>,
    fails_daemon_turns: AtomicBool,
    daemon_turns_held: AtomicUsize,
    refuses_overlapping_daemon_turns: AtomicBool,
    daemon_turns_starting: AtomicUsize,
    leaves_turns_unnumbered: AtomicBool,
    session_legs: Mutex<HashMap<SessionId, RuntimeBinding>>,
    changed: Notify,
}

impl RecordingRunEngine {
    /// Every call so far, in order.
    pub(crate) fn calls(&self) -> Vec<EngineCall> {
        lock(&self.calls).clone()
    }

    /// The deliveries so far, in order.
    pub(crate) fn deliveries(&self) -> Vec<RecordedDelivery> {
        self.calls()
            .into_iter()
            .filter_map(|call| match call {
                EngineCall::Deliver(delivery) => Some(*delivery),
                EngineCall::StartTurn(..)
                | EngineCall::CountStep(_)
                | EngineCall::RecordTurnEnd(..)
                | EngineCall::RecordDaemonTurnEnd(..)
                | EngineCall::StartDaemonTurn(_)
                | EngineCall::EndTurnOnProcessExit(_)
                | EngineCall::EndTurnOnClose(_) => None,
            })
            .collect()
    }

    /// The run moves delivered so far, on every run, in order.
    pub(crate) fn run_moves(&self) -> Vec<RunStateReport> {
        self.deliveries()
            .into_iter()
            .filter_map(|delivery| delivery.change)
            .collect()
    }

    /// The state entries delivered so far for `run_id`, in order.
    pub(crate) fn moves_of_run(&self, run_id: RunId) -> Vec<RunStateEntry> {
        self.run_moves()
            .into_iter()
            .filter(|change| change.run_id == run_id)
            .map(|change| change.entry)
            .collect()
    }

    /// Whether each run lifecycle delivery for `run_id` so far ends the daemon's own interrupt, in
    /// order.
    pub(crate) fn daemon_interrupt_ends_of_run(&self, run_id: RunId) -> Vec<bool> {
        self.deliveries()
            .into_iter()
            .filter(|delivery| {
                delivery.kind == "runLifecycle"
                    && delivery.change.as_ref().map(|change| change.run_id) == Some(run_id)
            })
            .map(|delivery| delivery.is_daemon_interrupt_end)
            .collect()
    }

    /// The run of the first turn the daemon or the provider started on a session itself, if any.
    pub(crate) fn first_daemon_turn_run(&self) -> Option<RunId> {
        self.calls().into_iter().find_map(|call| match call {
            EngineCall::StartDaemonTurn(run_id) => Some(run_id),
            EngineCall::Deliver(_)
            | EngineCall::StartTurn(..)
            | EngineCall::CountStep(_)
            | EngineCall::RecordTurnEnd(..)
            | EngineCall::RecordDaemonTurnEnd(..)
            | EngineCall::EndTurnOnProcessExit(_)
            | EngineCall::EndTurnOnClose(_) => None,
        })
    }

    /// The turns ended through the engine as their process exited or their session closed, in
    /// order.
    pub(crate) fn turn_ends(&self) -> Vec<EngineCall> {
        self.calls()
            .into_iter()
            .filter(|call| {
                matches!(
                    call,
                    EngineCall::EndTurnOnProcessExit(_) | EngineCall::EndTurnOnClose(_)
                )
            })
            .collect()
    }

    /// Holds the next delivery's outcome, recorded at once, until the returned sender fires or
    /// drops.
    pub(crate) fn hold_next_delivery(&self) -> oneshot::Sender<()> {
        hold_next(&self.delivery_holds)
    }

    /// Holds the next ask's admission until the returned sender fires or drops.
    pub(crate) fn hold_next_ask(&self) -> oneshot::Sender<()> {
        hold_next(&self.ask_holds)
    }

    /// Holds the next turn's opening until the returned sender fires or drops.
    pub(crate) fn hold_next_turn_start(&self) -> oneshot::Sender<()> {
        hold_next(&self.turn_start_holds)
    }

    /// Holds the next daemon turn's start, before its run's turn opens, until the returned sender
    /// fires or drops.
    pub(crate) fn hold_next_daemon_turn_start(&self) -> oneshot::Sender<()> {
        hold_next(&self.daemon_turn_start_holds)
    }

    /// Refuses the next child run at its setup for `reason`, answering the returned run as ended.
    pub(crate) fn refuse_next_child_run(&self, reason: RunSetupRefusal) -> RunId {
        let run_id = new_run_id();
        lock(&self.refused_child_runs).push_back((run_id, reason));
        run_id
    }

    /// Makes every later daemon turn's start fail before any run exists.
    pub(crate) fn fail_daemon_turns(&self) {
        self.fails_daemon_turns.store(true, Ordering::SeqCst);
    }

    /// Refuses the next `count` daemon turns' starts with [`DaemonTurnHeld`], before any run
    /// exists, as the engine refuses one while the session's turn is held for another run.
    pub(crate) fn refuse_next_daemon_turns_held(&self, count: usize) {
        self.daemon_turns_held.store(count, Ordering::SeqCst);
    }

    /// Refuses each later daemon turn's start with [`DaemonTurnHeld`] while another daemon turn's
    /// start has not returned, as the engine takes no second lead run while one is live.
    pub(crate) fn refuse_daemon_turns_while_one_starts(&self) {
        self.refuses_overlapping_daemon_turns
            .store(true, Ordering::SeqCst);
    }

    /// Makes every later turn open with no number, as a turn the engine could not number.
    pub(crate) fn leave_turns_unnumbered(&self) {
        self.leaves_turns_unnumbered.store(true, Ordering::SeqCst);
    }

    /// Makes `leg` the stored leg `session_id`'s reads answer; a session with none never ran.
    pub(crate) fn set_session_leg(&self, session_id: SessionId, leg: RuntimeBinding) {
        lock(&self.session_legs).insert(session_id, leg);
    }

    /// Waits until `found` finds what it looks for in the calls so far, checked again at each new
    /// call, and answers it.
    pub(crate) async fn wait_until<Found>(
        &self,
        mut found: impl FnMut(&[EngineCall]) -> Option<Found>,
    ) -> Found {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if let Some(found) = found(&self.calls()) {
                return found;
            }
            changed.await;
        }
    }

    fn record(&self, call: EngineCall) {
        lock(&self.calls).push(call);
        self.changed.notify_waiters();
    }
}

impl InboundDispatch for RecordingRunEngine {
    fn dispatch<'dispatch>(
        &'dispatch self,
        delivery: InboundDelivery<'_>,
    ) -> BoxFuture<'dispatch, Result<InboundOutcome, Box<dyn Error + Send + Sync>>> {
        let recorded = record_delivery(&delivery);
        let (outcome, ask_hold) = match &delivery {
            InboundDelivery::PermissionAsk { .. } => (
                InboundOutcome::AskAdmitted,
                lock(&self.ask_holds).pop_front(),
            ),
            InboundDelivery::ChildRun { .. } => (
                match lock(&self.refused_child_runs).pop_front() {
                    Some((run_id, reason)) => InboundOutcome::ChildRunRefused { run_id, reason },
                    None => InboundOutcome::ChildRunStarted {
                        run_id: new_run_id(),
                    },
                },
                None,
            ),
            InboundDelivery::SessionRow { .. }
            | InboundDelivery::TurnSteered { .. }
            | InboundDelivery::AfterRunRow { .. }
            | InboundDelivery::UnstampedRow { .. }
            | InboundDelivery::ThinkingUpdate { .. }
            | InboundDelivery::RunMarker { .. }
            | InboundDelivery::ChildRunParentCorrected { .. }
            | InboundDelivery::SessionNotice { .. }
            | InboundDelivery::SessionEvent { .. }
            | InboundDelivery::MachineEvent { .. } => (
                InboundOutcome::Appended {
                    event_id: minted_event_id(),
                },
                None,
            ),
            InboundDelivery::RunLifecycle { change, .. } => (
                InboundOutcome::Transitioned {
                    state: change.entry.state().into(),
                },
                None,
            ),
            // A continued run runs again.
            InboundDelivery::RunContinued { .. } => (
                InboundOutcome::Transitioned {
                    state: RunState::Running,
                },
                None,
            ),
            InboundDelivery::TurnBoundary { .. } => (InboundOutcome::TurnOpened, None),
            InboundDelivery::LiveRunState { .. } => (InboundOutcome::Published, None),
        };
        let delivery_hold = lock(&self.delivery_holds).pop_front();
        self.record(EngineCall::Deliver(Box::new(recorded)));
        async move {
            for hold in [delivery_hold, ask_hold].into_iter().flatten() {
                hold.await.unwrap_or(());
            }
            Ok(outcome)
        }
        .boxed()
    }
}

impl RunHost for RecordingRunEngine {
    fn start_turn(
        &self,
        run_id: RunId,
        _provider_turn_id: Option<ProviderTurnId>,
        _step_bound: Option<SafeInt<1>>,
        opening: Option<QueueItemId>,
    ) -> BoxFuture<'_, Result<Option<StartedTurn>, RunHostError>> {
        self.record(EngineCall::StartTurn(run_id, opening));
        // Numbered within its run, as the engine numbers a run's turns; an unnumbered turn takes
        // no number.
        let turn_number = (!self.leaves_turns_unnumbered.load(Ordering::SeqCst)).then(|| {
            let mut numbered = lock(&self.turns_numbered);
            let last = numbered.entry(run_id).or_default();
            *last += 1;
            *last
        });
        let hold = lock(&self.turn_start_holds).pop_front();
        async move {
            if let Some(hold) = hold {
                hold.await.unwrap_or(());
            }
            Ok(turn_number.map(|turn_number| StartedTurn {
                turn_number: SafeInt::new(turn_number).expect("a turn number is positive"),
                event_id: minted_event_id(),
            }))
        }
        .boxed()
    }

    fn count_step(&self, run_id: RunId) -> BoxFuture<'_, Result<(), RunHostError>> {
        self.record(EngineCall::CountStep(run_id));
        async { Ok(()) }.boxed()
    }

    fn record_turn_end(
        &self,
        run_id: RunId,
        turn_end: ProviderTurnEnd,
    ) -> BoxFuture<'_, Result<bool, RunHostError>> {
        self.record(EngineCall::RecordTurnEnd(run_id, turn_end.outcome));
        async { Ok(true) }.boxed()
    }

    fn record_daemon_turn_end(
        &self,
        run_id: RunId,
        turn_number: SafeInt<1>,
        outcome: TurnOutcome,
    ) -> BoxFuture<'_, Result<bool, RunHostError>> {
        self.record(EngineCall::RecordDaemonTurnEnd(
            run_id,
            turn_number,
            outcome,
        ));
        async { Ok(true) }.boxed()
    }

    fn record_settled_output_speed(
        &self,
        _session_id: SessionId,
        _run_id: RunId,
        _state: ProviderOutputSpeedState,
    ) -> BoxFuture<'_, Result<(), RunHostError>> {
        async { Ok(()) }.boxed()
    }

    fn start_daemon_turn(
        &self,
        request: DaemonTurnStartRequest,
    ) -> BoxFuture<'_, Result<RunId, RunHostError>> {
        let run_id = new_run_id();
        if self.fails_daemon_turns.load(Ordering::SeqCst) {
            return async move { Err(DaemonTurnsRefused { run_id }.into()) }.boxed();
        }
        let is_held = self
            .daemon_turns_held
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
                left.checked_sub(1)
            })
            .is_ok();
        let is_overlapping = self.refuses_overlapping_daemon_turns.load(Ordering::SeqCst)
            && self.daemon_turns_starting.load(Ordering::SeqCst) > 0;
        if is_held || is_overlapping {
            let session_id = request.session_id;
            return async move { Err(DaemonTurnHeld { session_id }.into()) }.boxed();
        }
        self.record(EngineCall::StartDaemonTurn(run_id));
        let hold = lock(&self.daemon_turn_start_holds).pop_front();
        self.daemon_turns_starting.fetch_add(1, Ordering::SeqCst);
        async move {
            if let Some(hold) = hold {
                hold.await.unwrap_or(());
            }
            let started = (request.start_turn)(run_id).await;
            self.daemon_turns_starting.fetch_sub(1, Ordering::SeqCst);
            started?;
            Ok(run_id)
        }
        .boxed()
    }

    fn end_turn_on_process_exit(
        &self,
        run_id: RunId,
        _process_exit: ProcessExit,
    ) -> BoxFuture<'_, Result<(), RunHostError>> {
        self.record(EngineCall::EndTurnOnProcessExit(run_id));
        async { Ok(()) }.boxed()
    }

    fn end_turn_on_close(&self, run_id: RunId) -> BoxFuture<'_, Result<(), RunHostError>> {
        self.record(EngineCall::EndTurnOnClose(run_id));
        async { Ok(()) }.boxed()
    }

    fn read_session_leg(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<Option<RuntimeBinding>, RunHostError>> {
        let leg = lock(&self.session_legs).get(&session_id).cloned();
        async move { Ok(leg) }.boxed()
    }
}

// Queues a hold on the next call that takes one from `holds`, released when the returned sender
// fires or drops.
fn hold_next(holds: &Mutex<VecDeque<oneshot::Receiver<()>>>) -> oneshot::Sender<()> {
    let (release, held) = oneshot::channel();
    lock(holds).push_back(held);
    release
}

fn record_delivery(delivery: &InboundDelivery<'_>) -> RecordedDelivery {
    let mut recorded = RecordedDelivery {
        kind: "",
        binding_id: None,
        change: None,
        turn_end: None,
        ended_turn_number: None,
        is_daemon_interrupt_end: false,
        steered_turn_number: None,
        message_id: None,
        run_id: None,
        parent_run_id: None,
        subagent: None,
        row: None,
        content: None,
        session_id: None,
        payload: None,
    };
    match delivery {
        InboundDelivery::TurnBoundary { binding_id } => {
            recorded.kind = "turnBoundary";
            recorded.binding_id = Some(binding_id.clone());
        }
        InboundDelivery::TurnSteered {
            binding_id,
            turn_number,
            message_id,
        } => {
            recorded.kind = "turnSteered";
            recorded.binding_id = Some(binding_id.clone());
            recorded.steered_turn_number = Some(*turn_number);
            recorded.message_id = Some(*message_id);
        }
        InboundDelivery::RunLifecycle {
            binding,
            change,
            turn_end,
            is_daemon_interrupt_end,
        } => {
            recorded.kind = "runLifecycle";
            recorded.binding_id = Some(binding.binding_id.clone());
            recorded.change = Some(change.clone());
            recorded.turn_end = turn_end.map(|turn_end| turn_end.outcome);
            recorded.ended_turn_number = turn_end.map(|turn_end| turn_end.turn_number);
            recorded.is_daemon_interrupt_end = *is_daemon_interrupt_end;
        }
        InboundDelivery::RunContinued { binding, run_id } => {
            recorded.kind = "runContinued";
            recorded.binding_id = Some(binding.binding_id.clone());
            recorded.run_id = Some(*run_id);
        }
        InboundDelivery::ChildRun {
            binding,
            parent_run_id,
            subagent,
        } => {
            recorded.kind = "childRun";
            recorded.binding_id = Some(binding.binding_id.clone());
            recorded.parent_run_id = Some(*parent_run_id);
            recorded.subagent = Some(subagent.clone());
        }
        InboundDelivery::ChildRunParentCorrected {
            binding,
            child_run_id,
            parent_run_id,
        } => {
            recorded.kind = "childRunParentCorrected";
            recorded.binding_id = Some(binding.binding_id.clone());
            recorded.run_id = Some(*child_run_id);
            recorded.parent_run_id = Some(*parent_run_id);
        }
        InboundDelivery::RunMarker { binding, .. } => {
            recorded.kind = "runMarker";
            recorded.binding_id = Some(binding.binding_id.clone());
        }
        InboundDelivery::LiveRunState { binding, .. } => {
            recorded.kind = "liveRunState";
            recorded.binding_id = Some(binding.binding_id.clone());
        }
        InboundDelivery::ThinkingUpdate { binding, .. } => {
            recorded.kind = "thinkingUpdate";
            recorded.binding_id = Some(binding.binding_id.clone());
        }
        InboundDelivery::SessionNotice { session_id, notice } => {
            recorded.kind = "sessionNotice";
            recorded.session_id = Some(*session_id);
            recorded.payload = Some(payload_of(notice));
        }
        InboundDelivery::SessionEvent { row } => {
            recorded.kind = "sessionEvent";
            recorded.payload = Some(match row {
                SessionScopedRow::SideQuestionAnswered(payload) => payload_of(payload),
                SessionScopedRow::UsageTokenCountRecorded(payload) => payload_of(payload),
                SessionScopedRow::UsageCostUpdated(costs) => payload_of(costs),
                SessionScopedRow::AdvisorChanged(payload) => payload_of(payload),
                SessionScopedRow::OutputStyleChanged(payload) => payload_of(payload),
                SessionScopedRow::GoalUpdated(payload) => payload_of(payload),
                SessionScopedRow::GoalCleared(payload) => payload_of(payload),
            });
        }
        InboundDelivery::MachineEvent { row } => {
            recorded.kind = "machineEvent";
            recorded.payload = Some(match row {
                MachineScopedRow::UsageRateLimitUpdated(payload) => payload_of(payload),
            });
        }
        InboundDelivery::PermissionAsk { binding } => {
            recorded.kind = "permissionAsk";
            recorded.binding_id = Some(binding.binding_id.clone());
        }
        InboundDelivery::SessionRow {
            binding,
            row,
            content,
        } => {
            recorded.kind = "sessionRow";
            recorded.binding_id = Some(binding.binding_id.clone());
            recorded.row = Some(row.clone());
            recorded.content.clone_from(content);
        }
        InboundDelivery::AfterRunRow {
            binding_id,
            row,
            content,
        } => {
            recorded.kind = "afterRunRow";
            recorded.binding_id = Some(binding_id.clone());
            recorded.row = Some(row.clone());
            recorded.content.clone_from(content);
        }
        InboundDelivery::UnstampedRow { binding, row } => {
            recorded.kind = "unstampedRow";
            recorded.binding_id = Some(binding.binding_id.clone());
            recorded.payload = Some(match row {
                UnstampedRow::ApprovalReviewerFlagged(payload) => payload_of(payload),
                UnstampedRow::AgentRunRefusalChoiceRequested(payload) => payload_of(payload),
                UnstampedRow::AgentRunRefusalChoiceResolved(payload) => payload_of(payload),
                UnstampedRow::AgentRunUsageCreditsChoiceRequested(payload) => payload_of(payload),
                UnstampedRow::AgentRunUsageCreditsChoiceResolved(payload) => payload_of(payload),
            });
        }
    }
    recorded
}

// A fresh id of an event the engine wrote.
fn minted_event_id() -> FreeFormText<EVENT_FIELD_MAX_LEN> {
    FreeFormText::new(mint_uuid_v7().to_string()).expect("a minted UUID is an event id")
}

// A row's payload as its event carries it.
fn payload_of(payload: &impl serde::Serialize) -> Value {
    serde_json::to_value(payload).expect("a contract payload serializes")
}
