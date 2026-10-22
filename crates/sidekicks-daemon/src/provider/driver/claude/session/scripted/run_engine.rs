//! A run engine that records each call the driver makes and answers as the real one would on
//! success.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use futures::FutureExt;
use futures::future::BoxFuture;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::output_speed::ProviderOutputSpeedState;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::control::ProcessExit;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use tokio::sync::oneshot;

use super::mint_run_id;
use crate::mutex_lock::lock;
use crate::provider::driver::claude::delivery::run_engine::ClaudeRunEngine;
use crate::session::run::engine::RunEngineError;
use crate::session::run::engine::turns::{ProviderTurnEnd, StartedTurn, TurnOutcome};
use crate::session::run::inbound::{InboundDelivery, InboundOutcome};
use crate::session::run::start_request::DaemonTurnStartRequest;
use crate::session::run::state_change::RunStateChange;

/// One delivery as the recording engine kept it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct RecordedDelivery {
    /// The delivery's kind, as the run engine names it.
    pub(crate) kind: &'static str,
    /// The binding it was attributed on, where it names one.
    pub(crate) binding_id: Option<RuntimeBindingId>,
    /// A run's move, for a run lifecycle delivery.
    pub(crate) change: Option<RunStateChange>,
    /// The turn's end a run lifecycle delivery carries.
    pub(crate) turn_end: Option<TurnOutcome>,
    /// Whether it is the end of the daemon's own interrupt.
    pub(crate) is_daemon_interrupt_end: bool,
    /// The run a child run delivery starts beneath.
    pub(crate) parent_run_id: Option<RunId>,
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
    /// A turn the daemon or Claude Code started itself, as the minted run.
    StartDaemonTurn(RunId),
    /// A run's turn ended on its process's exit.
    EndTurnOnProcessExit(RunId),
}

/// A run engine that records each call and answers as the real one would on success: every ask is
/// admitted, every child run started, every turn opened and numbered.
#[derive(Default)]
pub(crate) struct RecordingRunEngine {
    calls: Mutex<Vec<EngineCall>>,
    ask_holds: Mutex<VecDeque<oneshot::Receiver<()>>>,
    turn_start_holds: Mutex<VecDeque<oneshot::Receiver<()>>>,
    turns_started: AtomicU64,
    fails_daemon_turns: AtomicBool,
    leaves_turns_unnumbered: AtomicBool,
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
                | EngineCall::EndTurnOnProcessExit(_) => None,
            })
            .collect()
    }

    /// The run moves delivered so far, in order.
    pub(crate) fn run_moves(&self) -> Vec<RecordedDelivery> {
        self.deliveries()
            .into_iter()
            .filter(|delivery| delivery.change.is_some())
            .collect()
    }

    /// Holds the next ask's admission until the returned sender fires or drops.
    pub(crate) fn hold_next_ask(&self) -> oneshot::Sender<()> {
        let (release, held) = oneshot::channel();
        lock(&self.ask_holds).push_back(held);
        release
    }

    /// Holds the next turn's opening until the returned sender fires or drops.
    pub(crate) fn hold_next_turn_start(&self) -> oneshot::Sender<()> {
        let (release, held) = oneshot::channel();
        lock(&self.turn_start_holds).push_back(held);
        release
    }

    /// Makes every later daemon turn's start fail before any run exists.
    pub(crate) fn fail_daemon_turns(&self) {
        self.fails_daemon_turns.store(true, Ordering::SeqCst);
    }

    /// Makes every later turn open with no number, as a turn the engine could not number.
    pub(crate) fn leave_turns_unnumbered(&self) {
        self.leaves_turns_unnumbered.store(true, Ordering::SeqCst);
    }

    fn record(&self, call: EngineCall) {
        lock(&self.calls).push(call);
    }
}

impl ClaudeRunEngine for RecordingRunEngine {
    fn deliver<'engine>(
        &'engine self,
        _provider_account_id: Option<ProviderAccountId>,
        _raw_wire_type: Option<&str>,
        delivery: InboundDelivery<'_>,
    ) -> BoxFuture<'engine, Option<InboundOutcome>> {
        let recorded = record_delivery(&delivery);
        let (outcome, hold) = match &delivery {
            InboundDelivery::PermissionAsk { .. } => (
                InboundOutcome::AskAdmitted,
                lock(&self.ask_holds).pop_front(),
            ),
            InboundDelivery::ChildRun { .. } => (
                InboundOutcome::ChildRunStarted {
                    run_id: mint_run_id(),
                },
                None,
            ),
            InboundDelivery::SessionRow { .. } | InboundDelivery::UnstampedRow { .. } => (
                InboundOutcome::Appended {
                    event_id: FreeFormText::new(mint_uuid_v7().to_string())
                        .expect("a minted UUID is an event id"),
                },
                None,
            ),
            InboundDelivery::TurnBoundary { .. }
            | InboundDelivery::RunLifecycle { .. }
            | InboundDelivery::RunContinued { .. }
            | InboundDelivery::RunMarker { .. }
            | InboundDelivery::LiveRunState { .. }
            | InboundDelivery::ThinkingUpdate { .. }
            | InboundDelivery::SessionNotice { .. }
            | InboundDelivery::SessionEvent { .. } => (InboundOutcome::Published, None),
        };
        self.record(EngineCall::Deliver(Box::new(recorded)));
        async move {
            if let Some(hold) = hold {
                hold.await.unwrap_or(());
            }
            Some(outcome)
        }
        .boxed()
    }

    fn start_turn(
        &self,
        run_id: RunId,
        _step_bound: Option<SafeInt<1>>,
    ) -> BoxFuture<'_, Result<Option<StartedTurn>, RunEngineError>> {
        self.record(EngineCall::StartTurn(run_id));
        let turn_number = self.turns_started.fetch_add(1, Ordering::SeqCst) + 1;
        let hold = lock(&self.turn_start_holds).pop_front();
        let is_unnumbered = self.leaves_turns_unnumbered.load(Ordering::SeqCst);
        async move {
            if let Some(hold) = hold {
                hold.await.unwrap_or(());
            }
            if is_unnumbered {
                return Ok(None);
            }
            Ok(Some(StartedTurn {
                turn_number: SafeInt::new(turn_number).expect("a turn number is positive"),
                event_id: FreeFormText::new(format!("turn-{turn_number}"))
                    .expect("an event id fits"),
            }))
        }
        .boxed()
    }

    fn count_step(&self, run_id: RunId) -> BoxFuture<'_, Result<(), RunEngineError>> {
        self.record(EngineCall::CountStep(run_id));
        async { Ok(()) }.boxed()
    }

    fn record_turn_end(
        &self,
        run_id: RunId,
        turn_end: ProviderTurnEnd,
    ) -> BoxFuture<'_, Result<bool, RunEngineError>> {
        self.record(EngineCall::RecordTurnEnd(run_id, turn_end.outcome));
        async { Ok(true) }.boxed()
    }

    fn record_settled_output_speed(
        &self,
        _session_id: SessionId,
        _run_id: RunId,
        _state: ProviderOutputSpeedState,
    ) -> BoxFuture<'_, Result<(), RunEngineError>> {
        async { Ok(()) }.boxed()
    }

    fn start_daemon_turn(
        &self,
        request: DaemonTurnStartRequest,
    ) -> BoxFuture<'_, Result<RunId, RunEngineError>> {
        let run_id = mint_run_id();
        if self.fails_daemon_turns.load(Ordering::SeqCst) {
            return async move { Err(RunEngineError::NoResolvedPosture { run_id }) }.boxed();
        }
        self.record(EngineCall::StartDaemonTurn(run_id));
        async move {
            (request.start_turn)(run_id)
                .await
                .map_err(|source| RunEngineError::Driver { run_id, source })?;
            Ok(run_id)
        }
        .boxed()
    }

    fn end_turn_on_process_exit(
        &self,
        run_id: RunId,
        _process_exit: ProcessExit,
    ) -> BoxFuture<'_, Result<(), RunEngineError>> {
        self.record(EngineCall::EndTurnOnProcessExit(run_id));
        async { Ok(()) }.boxed()
    }
}

fn record_delivery(delivery: &InboundDelivery<'_>) -> RecordedDelivery {
    let mut recorded = RecordedDelivery {
        kind: "",
        binding_id: None,
        change: None,
        turn_end: None,
        is_daemon_interrupt_end: false,
        parent_run_id: None,
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
        InboundDelivery::SessionNotice { .. } => recorded.kind = "sessionNotice",
        InboundDelivery::SessionEvent { .. } => recorded.kind = "sessionEvent",
        InboundDelivery::PermissionAsk { binding } => {
            recorded.kind = "permissionAsk";
            recorded.binding_id = Some(binding.binding_id.clone());
        }
        InboundDelivery::SessionRow { binding, .. } => {
            recorded.kind = "sessionRow";
            recorded.binding_id = Some(binding.binding_id.clone());
        }
        InboundDelivery::UnstampedRow { binding, .. } => {
            recorded.kind = "unstampedRow";
            recorded.binding_id = Some(binding.binding_id.clone());
        }
    }
    recorded
}
