//! The daemon's own stop of a run at a limit: the step limit on a run whose provider does not bound
//! a turn's steps, and the spend and token limits the budget accountant holds each run and session
//! to. The engine decides the stop: it records the limit's reached event while the run is live,
//! remembers the turn the stop cuts, and hands the interrupt to the interventions service, which
//! ends the run with the limit.

use std::borrow::Cow;
use std::sync::{LazyLock, Weak};

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

use crate::database::statement::{StatementBindings, WriteStatement, text_binding};
use crate::events::session::appender::SessionEventDraft;
use crate::session::run::engine::{LiveAppend, RunEngine, RunEngineError, refused_statement_index};
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

/// The turn a limit stop cut, kept until that turn's end is written or the run ends.
pub(super) struct CutTurn {
    /// The limit that cut it.
    pub(super) limit: RunLimit,
    /// The turn.
    pub(super) turn_number: SafeInt<1>,
}

/// A limit the daemon stops a run at by itself, with what its reached event records. Spend has no
/// run-level reached event: the interrupt the interventions service records is the stop's record.
#[derive(Clone, Copy)]
pub(super) enum LimitStop {
    /// The open turn took the steps its bound allows.
    Step {
        /// The bound reached.
        count: SafeInt<1>,
    },
    /// The session reached its spend limit.
    Spend,
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
            Self::Spend => RunLimit::SpendLimit,
            Self::Token { .. } => RunLimit::TokenLimit,
        }
    }

    // The run's own reached event, which spend has none of.
    fn reached_event(self, run: &RunRead, run_id: RunId) -> Option<SessionEvent> {
        let session_id = run.session_id;
        match self {
            Self::Step { count } => Some(SessionEvent::AgentRunStepLimitReached(
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
            Self::Spend => None,
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
    /// service. Fails as the stop fails.
    #[expect(
        dead_code,
        reason = "the budget accountant calls it when a session's spend reaches its limit"
    )]
    pub(crate) async fn stop_at_spend_limit(&self, run_id: RunId) -> Result<(), RunEngineError> {
        self.stop_at_limit(run_id, LimitStop::Spend).await
    }

    /// Stops `run_id` at its token limit, once per run: `agent.run.tokenLimit.reached` written,
    /// then the interrupt handed to the interventions service. Fails as the stop fails.
    #[expect(
        dead_code,
        reason = "the budget accountant calls it when a run's tokens pass its limit"
    )]
    pub(crate) async fn stop_at_token_limit(
        &self,
        run_id: RunId,
        token_limit: TokensPerRun,
    ) -> Result<(), RunEngineError> {
        self.stop_at_limit(run_id, LimitStop::Token { token_limit })
            .await
    }

    /// The daemon's own stop of a live run at a limit. The limit's reached event is written while
    /// the run is live, a token limit's once per run; the turn the stop cuts is remembered, so an
    /// end its provider reports before the limit's end is written interrupted with the limit; then
    /// the interrupt goes to the interventions service. A run that has ended is left as it is, and
    /// so is a run that already reached its token limit; one the limit's end may not leave its
    /// state from is refused with nothing written. Fails with
    /// [`RunEngineError::LimitInterrupterGone`], nothing written, when the engine holds no live
    /// interventions service, and with the service's failure, the cut forgotten.
    pub(super) async fn stop_at_limit(
        &self,
        run_id: RunId,
        stop: LimitStop,
    ) -> Result<(), RunEngineError> {
        let limit_interrupter = self
            .limit_interrupter
            .get()
            .and_then(Weak::upgrade)
            .ok_or(RunEngineError::LimitInterrupterGone { run_id })?;
        let limit = stop.limit();
        let to_state = limit_run_end(limit).state();
        let open_turn = self.read_open_turn(run_id, None).await?;
        let is_live = match stop {
            LimitStop::Spend => {
                let run = self.require_run(run_id).await?;
                if run.state.is_terminal() {
                    false
                } else {
                    refuse_unless_allowed(run_id, &run, to_state)?;
                    true
                }
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
                            LimitStop::Step { .. } | LimitStop::Spend => Vec::new(),
                        };
                        Ok(LiveAppend {
                            draft: SessionEventDraft::of_session(run.session_id, &reached)?,
                            preceding_events: Vec::new(),
                            statements,
                        })
                    })
                    .await;
                match recorded {
                    Ok(recorded) => recorded.is_some(),
                    Err(RunEngineError::Append(error))
                        if matches!(stop, LimitStop::Token { .. })
                            && refused_statement_index(&error)
                                == Some(TOKEN_LIMIT_ONCE_GUARD_INDEX) =>
                    {
                        // The run reached its token limit before, and that stop is the one that
                        // stands.
                        false
                    }
                    Err(error) => return Err(error),
                }
            }
        };
        if !is_live {
            return Ok(());
        }
        if let Some(turn_number) = open_turn {
            self.live()
                .cut_turns
                .insert(run_id, CutTurn { limit, turn_number });
        }
        match limit_interrupter.interrupt_for_limit(run_id, limit).await {
            Ok(()) => Ok(()),
            Err(source) => {
                // The turn was not cut, so its provider's end is written as reported.
                if let Some(turn_number) = open_turn {
                    self.forget_cut_turn(&run_id, turn_number);
                }
                Err(RunEngineError::LimitInterrupt { run_id, source })
            }
        }
    }
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
