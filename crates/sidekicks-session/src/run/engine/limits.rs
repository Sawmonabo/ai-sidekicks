//! The daemon's own stop of a run at a limit: the step limit on a run whose provider does not bound
//! a turn's steps, and the spend and token limits the budget accountant holds each run and session
//! to. The engine decides the stop: it records the limit's reached event while the run is live,
//! remembers the turn the stop cuts, and hands the interrupt to the interventions service, which
//! ends the run with the limit.

use std::borrow::Cow;
use std::error::Error;
use std::sync::{Arc, LazyLock, Weak};

use futures::future::join_all;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::orchestration::InterruptReason;
use sidekicks_contracts::run::control::StopTrigger;
use sidekicks_contracts::run::events::RunStateChangeState;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::RunLimit;
use sidekicks_contracts::session::controls::events::{
    AgentRunStepLimitReachedPayload, AgentRunTokenLimitReachedPayload,
};
use sidekicks_contracts::session::cost::TokensPerRun;
use sidekicks_contracts::wire::integer::SafeInt;
use tokio::sync::oneshot;
use tracing::Instrument as _;

use crate::interventions::store::is_limit_interrupt_pending;
use crate::run::engine::live::{CutGuard, StepInterruptGuard};
use crate::run::engine::turns::{WriteWithResend, set_step_limit_reached};
use crate::run::engine::{LiveAppend, RunEngine, RunEngineError, refused_statement_index, settled};
use crate::run::limit_interrupter::{HandedCut, LimitInterruptFailure, LimitInterrupter};
use crate::run::read::RunRead;
use crate::run::refusals::RunRefusal;
use crate::run::transitions::is_transition_allowed;
use sidekicks_provider::run::state_entry::RunStateEntry;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::connection::read_pool::ReadLength;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::events::session::appender::SessionEventDraft;

// A token-limit stop's guard that the run never reached its limit before follows the version guard.
const TOKEN_LIMIT_ONCE_GUARD_INDEX: usize = 1;

// Refuses a token-limit stop once the run reached its limit; the reached event names no run
// version, so the guard reads the run and the type alone.
static SELECT_TOKEN_LIMIT_REACHED_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT 1 FROM session_events
  WHERE category = '{}'
    AND type = '{}'
    AND run_id = @run_id
  LIMIT 1",
        SessionEventType::AgentRunTokenLimitReached
            .category()
            .as_str(),
        SessionEventType::AgentRunTokenLimitReached.as_str()
    )
});

/// A limit the daemon stops a run at by itself, with what its reached event records.
#[derive(Clone, Copy)]
pub enum LimitStop {
    /// The open turn took the steps its bound allows.
    Step {
        /// The bound reached.
        count: SafeInt<1>,
        /// The turn that reached it.
        turn_number: SafeInt<1>,
    },
    /// The interrupt alone: the spend limit, which has no run-level reached event since the
    /// interrupt the interventions service records is the stop's record, and the retry of any
    /// limit whose reached event landed before its interrupt failed.
    Interrupt {
        /// The limit the run is stopped at.
        limit: RunLimit,
    },
    /// The run passed its token limit.
    Token {
        /// The limit passed.
        token_limit: TokensPerRun,
    },
}

impl LimitStop {
    fn limit(self) -> RunLimit {
        match self {
            Self::Step { .. } => RunLimit::StepLimit,
            Self::Interrupt { limit } => limit,
            Self::Token { .. } => RunLimit::TokenLimit,
        }
    }

    // The run's own reached event, which the interrupt alone has none of.
    fn reached_event(self, run: &RunRead, run_id: RunId) -> Option<SessionEvent> {
        let session_id = run.session_id;
        match self {
            Self::Step { count, .. } => Some(SessionEvent::AgentRunStepLimitReached(
                AgentRunStepLimitReachedPayload {
                    session_id,
                    run_id,
                    count,
                },
            )),
            Self::Token { token_limit } => Some(SessionEvent::AgentRunTokenLimitReached(
                AgentRunTokenLimitReachedPayload {
                    session_id,
                    run_id,
                    token_limit,
                },
            )),
            Self::Interrupt { .. } => None,
        }
    }
}

/// The end a limit gives its run: step and spend rest it interrupted with the limit, the token
/// limit stops it.
pub(super) fn limit_run_end(limit: RunLimit) -> RunStateEntry {
    match limit {
        RunLimit::StepLimit => RunStateEntry::Interrupted {
            intended_close: None,
            trigger: Some(InterruptReason::StepLimit),
        },
        RunLimit::SpendLimit => RunStateEntry::Interrupted {
            intended_close: None,
            trigger: Some(InterruptReason::SpendLimit),
        },
        RunLimit::TokenLimit => RunStateEntry::Stopped {
            intended_close: None,
            trigger: Some(StopTrigger::TokenLimit),
        },
    }
}

impl RunEngine {
    /// Stops `run_id` at the session's spend limit, the interrupt handed to the interventions
    /// service. Fails as the stop fails; the caller calls again at the next usage report, which
    /// sends the interrupt again unless the spend limit's interrupt of the run is still pending.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the budget accountant calls it when a session's spend reaches its limit"
        )
    )]
    pub(crate) async fn stop_at_spend_limit(
        self: &Arc<Self>,
        run_id: RunId,
    ) -> Result<(), RunEngineError> {
        self.stop_at_limit(
            run_id,
            LimitStop::Interrupt {
                limit: RunLimit::SpendLimit,
            },
        )
        .await
    }

    /// Stops `run_id` at its token limit, once per run: `agent.run.tokenLimit.reached` written,
    /// then the interrupt handed to the interventions service. Fails as the stop fails; the caller
    /// calls again at the next usage report, which sends the interrupt alone once the reached
    /// event has landed.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the budget accountant calls it when a run's tokens pass its limit"
        )
    )]
    pub(crate) async fn stop_at_token_limit(
        self: &Arc<Self>,
        run_id: RunId,
        token_limit: TokensPerRun,
    ) -> Result<(), RunEngineError> {
        self.stop_at_limit(run_id, LimitStop::Token { token_limit })
            .await
    }

    /// The daemon's own stop of a live run at a limit, run as a task of its own so it finishes
    /// whatever its caller does: it cuts a turn (a step stop's own, else the newest open turn, its
    /// cut held beside any other stop's of that turn), writes the limit's reached event where it
    /// has one, and hands the interrupt naming that turn to the interventions service unless the
    /// limit's interrupt of the run is pending or another step hand is in flight, a stop that
    /// stops nothing or whose hand leaves no pending row withdrawing its cut, since that row is the
    /// cut's one mark. Fails with [`RunEngineError::LimitInterrupterGone`] when no live
    /// interventions service is held or the daemon's shutdown ends the stop's task, else with
    /// [`RunEngineError::LimitInterrupt`] or the read or write that failed, the reached event and
    /// the limit kept for the stop's retry.
    pub(super) async fn stop_at_limit(
        self: &Arc<Self>,
        run_id: RunId,
        stop: LimitStop,
    ) -> Result<(), RunEngineError> {
        // A resend of the step limit's interrupt another hand has in flight is left to it before
        // it reads or cuts anything.
        if let LimitStop::Interrupt {
            limit: RunLimit::StepLimit,
        } = stop
            && lock(&self.live).step_interrupts_in_flight.contains(&run_id)
        {
            return Ok(());
        }
        if let Err(gone) = self.live_limit_interrupter(run_id) {
            self.release_step_reach(run_id, stop);
            return Err(gone);
        }
        let engine = Arc::clone(self);
        let limit = stop.limit();
        let span = tracing::Span::current();
        // The task sends the stop's result to this future's receiver, whose guard logs an error
        // its caller's drop leaves unread.
        let (sender, receiver) = oneshot::channel::<Result<(), RunEngineError>>();
        let mut answer = LimitStopAnswer {
            receiver,
            run_id,
            limit,
            span: span.clone(),
        };
        let stopping = tokio::spawn(
            async move {
                let stopped = engine.run_limit_stop(run_id, stop).await;
                // A caller gone has closed its receiver, so the send hands the result back and the
                // task logs an error; only a panic after the caller dropped is left to the panic
                // hook.
                if let Err(Err(error)) = sender.send(stopped) {
                    log_unread_limit_stop_failure(&tracing::Span::current(), run_id, limit, &error);
                }
            }
            .instrument(span),
        );
        match (&mut answer.receiver).await {
            Ok(stopped) => stopped,
            // The task sends before it returns, so it ended without sending only by a panic or a
            // cancel.
            Err(_unsent) => match stopping.await {
                Ok(()) => unreachable!("the task sends before it returns"),
                Err(error) => match error.try_into_panic() {
                    Ok(panic) => std::panic::resume_unwind(panic),
                    // Only the runtime's shutdown cancels the task, and no caller then waits on it.
                    Err(_canceled) => Err(RunEngineError::LimitInterrupterGone { run_id }),
                },
            },
        }
    }

    // The body of `stop_at_limit`, run on the stop's own task.
    async fn run_limit_stop(&self, run_id: RunId, stop: LimitStop) -> Result<(), RunEngineError> {
        let limit = stop.limit();
        // The turn the stop cuts, if any; `None` once the run reads ended, which stops nothing and
        // cuts no turn.
        let read = async {
            self.wait_while_continuing(&run_id).await;
            let run = self.require_run(run_id).await?;
            if run.state.is_terminal() {
                return Ok(None);
            }
            Ok::<_, RunEngineError>(Some(match stop {
                LimitStop::Step { turn_number, .. } => Some(turn_number),
                LimitStop::Interrupt { .. } | LimitStop::Token { .. } => {
                    self.read_open_turn(run_id).await?
                }
            }))
        };
        let cut_turn = match read.await {
            Ok(Some(cut_turn)) => cut_turn,
            stopped_nothing => {
                self.release_step_reach(run_id, stop);
                return stopped_nothing.map(drop);
            }
        };
        let (stop, own_cut, cut, is_memory_own) = {
            let mut live = lock(&self.live);
            let own_cut = live.new_cut(limit);
            // A token limit's reached event lands once per run; a step limit's once per turn,
            // which the turn's own count decides.
            let stop = match stop {
                LimitStop::Token { .. } if live.reached_limits.contains(&(run_id, limit)) => {
                    LimitStop::Interrupt { limit }
                }
                LimitStop::Step { .. } | LimitStop::Interrupt { .. } | LimitStop::Token { .. } => {
                    stop
                }
            };
            // In before the write, so a run that ends while its reached event is written forgets
            // the limit with it.
            let is_memory_own = !matches!(stop, LimitStop::Interrupt { .. })
                && live.reached_limits.insert((run_id, limit));
            // Each stop's cut goes in beside any other of the turn, which ends with the
            // higher-ranked of them.
            let cut = cut_turn.map(|turn_number| {
                let key = (run_id, turn_number);
                live.cut_turns.entry(key).or_default().push(own_cut);
                key
            });
            (stop, own_cut, cut, is_memory_own)
        };
        // From here the cut is withdrawn on every path that leaves no pending row naming it, the
        // daemon's own shutdown of the stop's task included.
        let mut cut_guard = CutGuard {
            live: &self.live,
            key: cut,
            stop_id: own_cut.stop_id,
        };
        #[cfg(test)]
        self.cut_pause.pass().await;
        let mut reached = match cut_guard.key {
            Some((_, turn_number)) => match self.read_open_turns(run_id).await {
                Ok(open_turns) if open_turns.contains(&turn_number) => {
                    self.reach_limit(run_id, stop).await
                }
                // The turn ended before its cut went in: a step stop, whose bound was that turn's,
                // reached nothing and leaves its cut to the cleanup; any other stop still goes, its
                // cut withdrawn first, so its row names no turn.
                Ok(_) => match stop {
                    LimitStop::Step { .. } => Ok(LimitReach::TurnEnded),
                    LimitStop::Interrupt { .. } | LimitStop::Token { .. } => {
                        cut_guard.withdraw();
                        self.reach_limit(run_id, stop).await
                    }
                },
                Err(error) => Err(error),
            },
            None => self.reach_limit(run_id, stop).await,
        };
        // The limit's own interrupt still pending ends the run, so this stop sends none. A token
        // stop whose reached event the once-per-run guard refused has read it already.
        if matches!(reached, Ok(LimitReach::Live))
            && matches!(stop, LimitStop::Step { .. } | LimitStop::Interrupt { .. })
        {
            match self.has_pending_limit_interrupt(run_id, limit).await {
                Ok(true) => reached = Ok(LimitReach::InterruptPending),
                Ok(false) => {}
                Err(error) => {
                    // No row names the cut, so the guard withdraws it; what the stop wrote and
                    // took stays for its retry, as after a failed hand.
                    return Err(error);
                }
            }
        }
        if !matches!(reached, Ok(LimitReach::Live)) {
            // A stop that stops nothing gives back what it took: its cut, wherever it sits among
            // the turn's, its turn's reach and the memory it added; a run that reads ended, or
            // whose limit's interrupt is pending, forgets the limit whichever stop added it. A step
            // stop whose reached event landed beside that pending interrupt keeps its turn's
            // reach, so no later step writes that event again, and its turn ends as its provider
            // ends it.
            let is_step_reach_kept = matches!(
                (stop, &reached),
                (LimitStop::Step { .. }, Ok(LimitReach::InterruptPending))
            );
            let mut live = lock(&self.live);
            cut_guard.withdraw_locked(&mut live);
            if let LimitStop::Step { turn_number, .. } = stop {
                set_step_limit_reached(&mut live, &run_id, turn_number, is_step_reach_kept);
            }
            if matches!(
                reached,
                Ok(LimitReach::Ended | LimitReach::InterruptPending)
            ) || is_memory_own
            {
                live.reached_limits.remove(&(run_id, limit));
            }
            return reached.map(drop);
        }
        let cut = cut_guard.key;
        // A turn the step limit's interrupt alone cuts once it is handed reaches no stop of its
        // own after, as a turn whose step reached the bound does.
        let reached_turn = match stop {
            LimitStop::Interrupt {
                limit: RunLimit::StepLimit,
            } => cut.map(|(_, turn_number)| turn_number),
            LimitStop::Step { .. } | LimitStop::Interrupt { .. } | LimitStop::Token { .. } => None,
        };
        let row_cut = cut.map(|(_, turn_number)| HandedCut {
            turn_number,
            stop_id: own_cut.stop_id,
        });
        match self
            .hand_limit_interrupt(run_id, limit, reached_turn, row_cut)
            .await
        {
            Ok(true) => cut_guard.keep(),
            // The step limit's interrupt another hand has in flight stops the run and its row
            // names that hand's turn, so a stop of any kind left to it cut nothing.
            Ok(false) => drop(cut_guard),
            Err(error) => {
                // A hand that left its row pending keeps the cut that row names; any other
                // failure leaves no row, so the guard withdraws the cut, the reached event and
                // the limit kept for the retry.
                if matches!(
                    error,
                    RunEngineError::LimitInterrupt {
                        source: LimitInterruptFailure::RowPending { .. },
                        ..
                    }
                ) {
                    cut_guard.keep();
                }
                return Err(error);
            }
        }
        Ok(())
    }

    // Hands the interventions service the interrupt of `run_id` at `limit`, its row naming the turn
    // of `row_cut`, and, once it is handed, forgets the limit and marks `reached_turn`'s count
    // reached; answers whether it went. The step limit's goes one hand at a time, so one that
    // finds another in flight is left to it. Fails as the service is gone or fails, the limit
    // kept for the retry.
    async fn hand_limit_interrupt(
        &self,
        run_id: RunId,
        limit: RunLimit,
        reached_turn: Option<SafeInt<1>>,
        row_cut: Option<HandedCut>,
    ) -> Result<bool, RunEngineError> {
        let interrupter = self.live_limit_interrupter(run_id)?;
        let _in_flight = match limit {
            RunLimit::StepLimit => {
                if !lock(&self.live).step_interrupts_in_flight.insert(run_id) {
                    return Ok(false);
                }
                Some(StepInterruptGuard {
                    live: &self.live,
                    run_id,
                })
            }
            RunLimit::SpendLimit | RunLimit::TokenLimit => None,
        };
        interrupter
            .interrupt_for_limit(run_id, limit, row_cut)
            .await
            .map_err(|source| RunEngineError::LimitInterrupt { run_id, source })?;
        let mut live = lock(&self.live);
        live.reached_limits.remove(&(run_id, limit));
        if let Some(turn_number) = reached_turn {
            set_step_limit_reached(&mut live, &run_id, turn_number, true);
        }
        Ok(true)
    }

    /// Forgets what the engine kept for the interrupt of `run_id` at `limit` whose hand answered
    /// with its row pending and then failed late, leaving no row pending: the stop's own `cut` is
    /// withdrawn, as a hand that failed in time withdraws it, and a step or token limit is owed
    /// again on a live run, so its next step, usage report or return from a wait hands the
    /// interrupt again; the spend limit is never owed, the budget accountant's next call sending
    /// it. Fails as the run's read fails, the cut withdrawn and the limit left owed.
    pub(crate) async fn forget_late_limit_hand(
        &self,
        run_id: RunId,
        limit: RunLimit,
        cut: Option<HandedCut>,
    ) -> Result<(), RunEngineError> {
        // Owed under the lock before the run is read, so a run that ends meanwhile forgets the
        // limit with the rest of what it held.
        let is_owed = {
            let mut live = lock(&self.live);
            if let Some(cut) = cut {
                live.withdraw_cut((run_id, cut.turn_number), cut.stop_id);
            }
            match limit {
                RunLimit::StepLimit | RunLimit::TokenLimit => {
                    live.reached_limits.insert((run_id, limit))
                }
                RunLimit::SpendLimit => false,
            }
        };
        if is_owed && self.require_run(run_id).await?.state.is_terminal() {
            lock(&self.live).reached_limits.remove(&(run_id, limit));
        }
        Ok(())
    }

    /// Hands the interventions service again, on a task of its own carrying the caller's span, the
    /// interrupt of each limit `run_id` owes, once its provider runs again after a wait or a
    /// pause, where no step or usage report comes to hand it; a failure is logged, the next step,
    /// usage report or restart handing the limit once more. A person's call that returned the run
    /// to `running` calls it only once the provider runs, so its answer never waits on a hand and
    /// no interrupt reaches a provider before its resume.
    pub(crate) fn hand_owed_limit_interrupts(self: &Arc<Self>, run_id: RunId) {
        let engine = Arc::clone(self);
        tokio::spawn(
            async move {
                WriteWithResend {
                    written: (),
                    resend_failure: engine.stop_at_owed_limits(run_id).await.err(),
                }
                .log_resend_failure(run_id);
            }
            .instrument(tracing::Span::current()),
        );
    }

    /// Hands the interventions service again the interrupt of each limit `run_id` owes, as its
    /// next step or usage report would: every limit is handed at once, the failures returned
    /// together.
    pub(super) async fn stop_at_owed_limits(
        self: &Arc<Self>,
        run_id: RunId,
    ) -> Result<(), RunEngineError> {
        let owed: Vec<RunLimit> = lock(&self.live)
            .reached_limits
            .iter()
            .filter(|(owing_run_id, _)| *owing_run_id == run_id)
            .map(|(_, limit)| *limit)
            .collect();
        let outcomes = join_all(
            owed.into_iter()
                .map(|limit| self.stop_at_limit(run_id, LimitStop::Interrupt { limit })),
        )
        .await;
        settled(outcomes, "handing the interrupts a run owes at its limits")
    }

    // A step stop that wrote nothing leaves its turn's count to reach the bound again.
    fn release_step_reach(&self, run_id: RunId, stop: LimitStop) {
        if let LimitStop::Step { turn_number, .. } = stop {
            set_step_limit_reached(&mut lock(&self.live), &run_id, turn_number, false);
        }
    }

    // Whether the interrupt of `run_id` at `limit` has no outcome yet. Fails as the read fails.
    async fn has_pending_limit_interrupt(
        &self,
        run_id: RunId,
        limit: RunLimit,
    ) -> Result<bool, RunEngineError> {
        self.pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, RunEngineError>(is_limit_interrupt_pending(reader, &run_id, limit)?)
            })
            .await
    }

    // The interventions service the engine was handed, while it runs. Fails with
    // `LimitInterrupterGone` when none was handed or it has shut down.
    fn live_limit_interrupter(
        &self,
        run_id: RunId,
    ) -> Result<Arc<dyn LimitInterrupter>, RunEngineError> {
        self.limit_interrupter
            .get()
            .and_then(Weak::upgrade)
            .ok_or(RunEngineError::LimitInterrupterGone { run_id })
    }

    // Writes the reached event of `stop` while the run is live, where the stop has one; the
    // interrupt alone writes nothing and only reads that the run is live. Answers whether the
    // interrupt goes: not on a run that has ended, nor on one whose token limit was reached
    // before while a limit's interrupt of it is still pending.
    async fn reach_limit(
        &self,
        run_id: RunId,
        stop: LimitStop,
    ) -> Result<LimitReach, RunEngineError> {
        let limit = stop.limit();
        let to_state = limit_run_end(limit).state();
        match stop {
            LimitStop::Interrupt { .. } => {
                let run = self.require_run(run_id).await?;
                if run.state.is_terminal() {
                    return Ok(LimitReach::Ended);
                }
                refuse_unless_allowed(run_id, &run, to_state)?;
                Ok(LimitReach::Live)
            }
            LimitStop::Step { .. } | LimitStop::Token { .. } => {
                let recorded = self
                    .append_while_live(run_id, |run| {
                        refuse_unless_allowed(run_id, run, to_state)?;
                        let reached = stop
                            .reached_event(run, run_id)
                            .expect("a step or token stop has its reached event");
                        let statements = match stop {
                            LimitStop::Token { .. } => {
                                vec![no_token_limit_reached_statement(&run_id)]
                            }
                            LimitStop::Step { .. } | LimitStop::Interrupt { .. } => Vec::new(),
                        };
                        Ok(LiveAppend {
                            draft: SessionEventDraft::of_session(run.session_id, &reached)?,
                            preceding_events: Vec::new(),
                            statements,
                        })
                    })
                    .await;
                match recorded {
                    Ok(Some(_)) => Ok(LimitReach::Live),
                    Ok(None) => Ok(LimitReach::Ended),
                    Err(RunEngineError::Append(error))
                        if matches!(stop, LimitStop::Token { .. })
                            && refused_statement_index(&error)
                                == Some(TOKEN_LIMIT_ONCE_GUARD_INDEX) =>
                    {
                        // The run, live at the version the guard passed, reached its token limit
                        // before: that reached event stands, and the interrupt goes alone unless
                        // the token limit's own interrupt of the run is still pending, which ends
                        // it.
                        let is_pending = self.has_pending_limit_interrupt(run_id, limit).await?;
                        Ok(if is_pending {
                            LimitReach::InterruptPending
                        } else {
                            LimitReach::Live
                        })
                    }
                    Err(error) => Err(error),
                }
            }
        }
    }
}

// The receiving end of a limit stop's result, held by the stop's caller: dropped before it reads
// the result, it logs an error the task sent before its close went in, the log line a child of the
// stop's span as the task's is.
struct LimitStopAnswer {
    receiver: oneshot::Receiver<Result<(), RunEngineError>>,
    run_id: RunId,
    limit: RunLimit,
    span: tracing::Span,
}

impl Drop for LimitStopAnswer {
    fn drop(&mut self) {
        self.receiver.close();
        if let Ok(Err(error)) = self.receiver.try_recv() {
            log_unread_limit_stop_failure(&self.span, self.run_id, self.limit, &error);
        }
    }
}

// Logs a limit stop's error that no caller reads, as a child of the stop's span: a root line when
// no span was current at the stop.
fn log_unread_limit_stop_failure(
    parent: &tracing::Span,
    run_id: RunId,
    limit: RunLimit,
    error: &RunEngineError,
) {
    tracing::warn!(
        parent: parent,
        run_id = %run_id,
        limit = <&'static str>::from(limit),
        error = error as &(dyn Error + 'static),
        "run_limit_stop_failed"
    );
}

// What a limit stop found when it reached its limit.
enum LimitReach {
    // The run is live at the limit, so its interrupt goes to the interventions service.
    Live,
    // The run has ended, so nothing is stopped.
    Ended,
    // A step stop's turn ended before its cut went in, so its bound was never reached.
    TurnEnded,
    // The limit's own interrupt of the run is still pending, and it ends the run.
    InterruptPending,
}

// Refuses a limit's end from a state the table does not let the run leave for it.
fn refuse_unless_allowed(
    run_id: RunId,
    run: &RunRead,
    to_state: RunStateChangeState,
) -> Result<(), RunEngineError> {
    if is_transition_allowed(run.state, to_state) {
        return Ok(());
    }
    Err(RunRefusal::InvalidTransition {
        run_id,
        from_state: run.state,
        to_state,
        source: None,
    }
    .into())
}

// Refuses a token-limit stop once the run reached its limit.
fn no_token_limit_reached_statement(run_id: &RunId) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(SELECT_TOKEN_LIMIT_REACHED_SQL.as_str()),
        bindings: StatementBindings::Named(vec![text_binding("@run_id", run_id.text().as_str())]),
        expected_row_count: Some(0),
    }
}

#[cfg(test)]
mod tests;
