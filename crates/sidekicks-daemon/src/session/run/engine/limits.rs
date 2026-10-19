//! The daemon's own stop of a run at a limit: the step limit on a run whose provider does not bound
//! a turn's steps, and the spend and token limits the budget accountant holds each run and session
//! to. The engine decides the stop: it records the limit's reached event while the run is live,
//! remembers the turn the stop cuts, and hands the interrupt to the interventions service, which
//! ends the run with the limit.

use std::borrow::Cow;
use std::sync::{Arc, LazyLock, Weak};

use rusqlite::{Connection, named_params};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::orchestration::InterruptReason;
use sidekicks_contracts::run::control::StopTrigger;
use sidekicks_contracts::run::events::RunStateChangeState;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::{InterventionState, InterventionType, RunLimit};
use sidekicks_contracts::session::controls::events::{
    AgentRunStepLimitReachedPayload, AgentRunTokenLimitReachedPayload,
};
use sidekicks_contracts::session::cost::TokensPerRun;
use sidekicks_contracts::wire::integer::SafeInt;

use crate::database::connection::read_pool::ReadLength;
use crate::database::statement::{StatementBindings, WriteStatement, text_binding};
use crate::events::session::appender::SessionEventDraft;
use crate::session::run::engine::live::lock;
use crate::session::run::engine::{LiveAppend, RunEngine, RunEngineError, refused_statement_index};
use crate::session::run::limit_interrupter::LimitInterrupter;
use crate::session::run::read::RunRead;
use crate::session::run::refusals::RunRefusal;
use crate::session::run::state_change::RunStateEntry;
use crate::session::run::transitions::is_transition_allowed;

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

// Whether an interrupt of the run at one limit has no outcome yet.
static SELECT_LIMIT_INTERRUPT_PENDING_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT EXISTS (
  SELECT 1 FROM interventions
   WHERE target_run_id = @run_id
     AND type = '{}'
     AND state IN ('{}', '{}')
     AND json_extract(payload, '$.limit') = @limit)",
        <&'static str>::from(InterventionType::Interrupt),
        <&'static str>::from(InterventionState::Requested),
        <&'static str>::from(InterventionState::Accepted)
    )
});

/// A limit the daemon stops a run at by itself, with what its reached event records.
#[derive(Clone, Copy)]
pub(super) enum LimitStop {
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
    /// sends the interrupt again.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the budget accountant calls it when a session's spend reaches its limit"
        )
    )]
    pub(crate) async fn stop_at_spend_limit(&self, run_id: RunId) -> Result<(), RunEngineError> {
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
        &self,
        run_id: RunId,
        token_limit: TokensPerRun,
    ) -> Result<(), RunEngineError> {
        self.stop_at_limit(run_id, LimitStop::Token { token_limit })
            .await
    }

    /// The daemon's own stop of a live run at a limit: the turn it cuts (a step stop's own turn,
    /// else the newest open turn) and the limit it reaches are remembered before the limit's
    /// reached event is written while the run is live (a token limit's once per run, none for the
    /// spend limit or a stop retried at a limit whose reached event landed), then the interrupt
    /// goes to the interventions service. The stop waits out a continue of the run. A run that has
    /// ended, a step stop whose turn ended before its cut went in, and a token stop whose
    /// once-per-run guard refused while the token limit's own interrupt is still pending are left
    /// with the cuts as they were and nothing written; a run the limit's end may not leave its
    /// state from is refused with nothing written. Fails with
    /// [`RunEngineError::LimitInterrupterGone`], nothing written, when the engine holds no live
    /// interventions service, and with [`RunEngineError::LimitInterrupt`] when the service fails,
    /// the reached event, the cut and the memory kept for the stop's retry.
    pub(super) async fn stop_at_limit(
        &self,
        run_id: RunId,
        stop: LimitStop,
    ) -> Result<(), RunEngineError> {
        self.live_limit_interrupter(run_id)?;
        let limit = stop.limit();
        self.wait_while_continuing(&run_id).await;
        let run = self.require_run(run_id).await?;
        let cut_turn = match stop {
            LimitStop::Step { turn_number, .. } => Some(turn_number),
            LimitStop::Interrupt { .. } | LimitStop::Token { .. } => {
                self.read_open_turn(run_id, None).await?
            }
        };
        let (stop, own_cut, cut, is_memory_own) = {
            let mut live = lock(&self.live);
            let own_cut = live.new_cut(limit, run.version);
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
            let cut = cut_turn.map(|turn_number| {
                let key = (run_id, turn_number);
                (key, live.cut_turns.insert(key, own_cut))
            });
            (stop, own_cut, cut, is_memory_own)
        };
        let reached = match cut {
            Some((key, earlier)) => match self.read_open_turns(run_id).await {
                Ok(open_turns) if open_turns.contains(&key.1) => {
                    self.reach_limit(run_id, stop).await
                }
                // The turn ended before its cut went in, so it keeps the cut it had: a step stop,
                // whose bound was that turn's, reached nothing and leaves that to the cleanup; any
                // other stop still goes, so it puts the cut back first.
                Ok(_) => match stop {
                    LimitStop::Step { .. } => Ok(LimitReach::TurnEnded),
                    LimitStop::Interrupt { .. } | LimitStop::Token { .. } => {
                        lock(&self.live).restore_cut(key, own_cut, earlier);
                        self.reach_limit(run_id, stop).await
                    }
                },
                Err(error) => Err(error),
            },
            None => self.reach_limit(run_id, stop).await,
        };
        if !matches!(reached, Ok(LimitReach::Live)) {
            // A stop that stops nothing puts back what it took: the cut it made, where no turn's
            // end or later stop changed it since, and the memory it added; a run that reads ended
            // forgets the limit whichever stop added it.
            let mut live = lock(&self.live);
            if let Some((key, earlier)) = cut {
                live.restore_cut(key, own_cut, earlier);
            }
            if matches!(reached, Ok(LimitReach::Ended)) || is_memory_own {
                live.reached_limits.remove(&(run_id, limit));
            }
            return reached.map(drop);
        }
        if let LimitStop::Step { turn_number, .. } = stop {
            self.mark_step_limit_reached(&run_id, turn_number);
        }
        self.hand_limit_interrupt(run_id, limit).await
    }

    // Hands the interventions service the interrupt of `run_id` at `limit` and, once it is handed,
    // forgets the limit. Fails as the service is gone or fails, the limit kept for the retry.
    async fn hand_limit_interrupt(
        &self,
        run_id: RunId,
        limit: RunLimit,
    ) -> Result<(), RunEngineError> {
        self.live_limit_interrupter(run_id)?
            .interrupt_for_limit(run_id, limit)
            .await
            .map_err(|source| RunEngineError::LimitInterrupt { run_id, source })?;
        lock(&self.live).reached_limits.remove(&(run_id, limit));
        Ok(())
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
        let to_state = limit_run_end(stop.limit()).state();
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
                        let limit = stop.limit();
                        let is_pending = self
                            .pool
                            .read(ReadLength::Short, move |reader| {
                                Ok::<_, RunEngineError>(is_limit_interrupt_pending(
                                    reader, &run_id, limit,
                                )?)
                            })
                            .await?;
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

// Whether the interrupt of `run_id` at `limit` has no outcome yet, read on `reader`.
fn is_limit_interrupt_pending(
    reader: &Connection,
    run_id: &RunId,
    limit: RunLimit,
) -> rusqlite::Result<bool> {
    reader
        .prepare_cached(&SELECT_LIMIT_INTERRUPT_PENDING_SQL)?
        .query_row(
            named_params! {
                "@run_id": run_id.text().as_str(),
                "@limit": <&'static str>::from(limit),
            },
            |row| row.get(0),
        )
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
