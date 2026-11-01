//! A run engine for the drivers' tests, reached through the run host and inbound dispatch ports:
//! it records each call a driver makes, in order, and answers as the real one would on success.

use std::collections::{HashMap, VecDeque};
use std::error::Error;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use futures::FutureExt;
use futures::future::BoxFuture;
use serde_json::Value;
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::provider::driver::output_speed::ProviderOutputSpeedState;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::control::ProcessExit;
use sidekicks_contracts::run::id::RunId;
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
use crate::port::run_host::{RunHost, RunHostError};
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
    /// The run a child run delivery starts beneath.
    pub(crate) parent_run_id: Option<RunId>,
    /// The row a session row delivery appends.
    pub(crate) row: Option<LateAppendableRow>,
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
    /// A turn opened on the run.
    StartTurn(RunId),
    /// A step counted on the run.
    CountStep(RunId),
    /// A turn's end that moves no run.
    RecordTurnEnd(RunId, TurnOutcome),
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
                EngineCall::StartTurn(_)
                | EngineCall::CountStep(_)
                | EngineCall::RecordTurnEnd(..)
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

    /// The run of the first turn the daemon or the provider started on a session itself, if any.
    pub(crate) fn first_daemon_turn_run(&self) -> Option<RunId> {
        self.calls().into_iter().find_map(|call| match call {
            EngineCall::StartDaemonTurn(run_id) => Some(run_id),
            EngineCall::Deliver(_)
            | EngineCall::StartTurn(_)
            | EngineCall::CountStep(_)
            | EngineCall::RecordTurnEnd(..)
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
            | InboundDelivery::UnstampedRow { .. }
            | InboundDelivery::ThinkingUpdate { .. }
            | InboundDelivery::RunMarker { .. }
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
    ) -> BoxFuture<'_, Result<Option<StartedTurn>, RunHostError>> {
        self.record(EngineCall::StartTurn(run_id));
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
        self.record(EngineCall::StartDaemonTurn(run_id));
        let hold = lock(&self.daemon_turn_start_holds).pop_front();
        async move {
            if let Some(hold) = hold {
                hold.await.unwrap_or(());
            }
            (request.start_turn)(run_id).await?;
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
        parent_run_id: None,
        row: None,
        session_id: None,
        payload: None,
    };
    match delivery {
        InboundDelivery::TurnBoundary { binding_id } => {
            recorded.kind = "turnBoundary";
            recorded.binding_id = Some(binding_id.clone());
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
        InboundDelivery::RunContinued { binding, .. } => {
            recorded.kind = "runContinued";
            recorded.binding_id = Some(binding.binding_id.clone());
        }
        InboundDelivery::ChildRun {
            binding,
            parent_run_id,
        } => {
            recorded.kind = "childRun";
            recorded.binding_id = Some(binding.binding_id.clone());
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
                SessionScopedRow::AdvisorChanged(payload) => payload_of(payload),
                SessionScopedRow::OutputStyleChanged(payload) => payload_of(payload),
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
        InboundDelivery::SessionRow { binding, row, .. } => {
            recorded.kind = "sessionRow";
            recorded.binding_id = Some(binding.binding_id.clone());
            recorded.row = Some(row.clone());
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
