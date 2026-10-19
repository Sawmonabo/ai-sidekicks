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

    /// The daemon's own stop of a live run at a limit: the turn it cuts and the limit it reaches
    /// are remembered before the limit's reached event is written while the run is live (a token
    /// limit's once per run, none for the spend limit or a stop retried at a limit whose reached
    /// event landed), then the interrupt goes to the interventions service. The stop waits out a
    /// continue of the run; a run that has ended, or that holds a limit's interrupt still pending,
    /// is left with the cuts as they were, and one the limit's end may not leave its state from
    /// is refused with nothing written. Fails with [`RunEngineError::LimitInterrupterGone`],
    /// nothing written, when the engine holds no live interventions service, and with
    /// [`RunEngineError::LimitInterrupt`] when the service fails, the reached event, the cut and
    /// the memory kept for the stop's retry.
    pub(super) async fn stop_at_limit(
        &self,
        run_id: RunId,
        stop: LimitStop,
    ) -> Result<(), RunEngineError> {
        let limit_interrupter = self.live_limit_interrupter(run_id)?;
        let limit = stop.limit();
        self.wait_while_continuing(&run_id).await;
        let run = self.require_run(run_id).await?;
        let open_turn = self.read_open_turn(run_id, None).await?;
        let (stop, own_cut, cut, is_memory_own) = {
            let mut live = lock(&self.live);
            let own_cut = live.new_cut(limit, run.version);
            let stop = if live.reached_limits.contains(&(run_id, limit)) {
                LimitStop::Interrupt { limit }
            } else {
                stop
            };
            // In before the write, so a run that ends while its reached event is written forgets
            // the limit with it.
            let is_memory_own = !matches!(stop, LimitStop::Interrupt { .. })
                && live.reached_limits.insert((run_id, limit));
            let cut = open_turn.map(|turn_number| {
                let key = (run_id, turn_number);
                (key, live.cut_turns.insert(key, own_cut))
            });
            (stop, own_cut, cut, is_memory_own)
        };
        let reached = match cut {
            Some(((_, turn_number), _)) => match self.read_open_turns(run_id).await {
                Ok(open_turns) => {
                    if !open_turns.contains(&turn_number) {
                        // The turn ended before its cut went in, so it keeps none.
                        lock(&self.live).restore_cut((run_id, turn_number), own_cut, None);
                    }
                    self.reach_limit(run_id, stop).await
                }
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
        limit_interrupter
            .interrupt_for_limit(run_id, limit)
            .await
            .map_err(|source| RunEngineError::LimitInterrupt { run_id, source })?;
        lock(&self.live).reached_limits.remove(&(run_id, limit));
        Ok(())
    }

    /// The interventions service the engine was handed, while it runs. Fails with
    /// [`RunEngineError::LimitInterrupterGone`] when none was handed or it has shut down.
    pub(super) fn live_limit_interrupter(
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
mod tests {
    use std::sync::atomic::Ordering;

    use rstest::rstest;
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::run::intervention::RunLimit;
    use sidekicks_contracts::session::cost::TokensPerRun;
    use sidekicks_contracts::wire::integer::SafeInt;

    use super::LimitStop;
    use crate::database::writer::test_file::{TestDatabase, test_session_id};
    use crate::events::log_service::tests::open_log;
    use crate::session::run::engine::live::lock;
    use crate::session::run::engine::tests::{
        DRIVER_HOLD, SETTLE_WAIT, append, continue_request, hand_limit_interrupter, held_driver,
        insert_running_run, started_turn, stored_events, stored_run_state, test_engine,
        turn_started_at,
    };
    use crate::session::run::engine::turns::{ProviderTurnEnd, TurnOutcome};
    use crate::session::run::engine::{RunEngine, RunEngineError};
    use crate::session::run::state_change::RunStateChangeCompanions;
    use crate::uuid_v7::mint_uuid_v7;

    fn step_stop() -> LimitStop {
        LimitStop::Step {
            count: SafeInt::new(40).expect("40 is a step bound"),
        }
    }

    fn token_limit() -> TokensPerRun {
        TokensPerRun(SafeInt::new(500_000).expect("the test's limit is a safe integer"))
    }

    fn turn(number: u64) -> SafeInt<1> {
        SafeInt::new(number).expect("the test's turn numbers count from 1")
    }

    fn events(
        expected: &[(&str, Option<&str>, Option<&str>)],
    ) -> Vec<(String, Option<String>, Option<String>)> {
        expected
            .iter()
            .map(|(event_type, cause, origin)| {
                (
                    (*event_type).to_owned(),
                    cause.map(str::to_owned),
                    origin.map(str::to_owned),
                )
            })
            .collect()
    }

    // A person's interrupt accepted at `accepted_run_version` ends the run, and a continue runs it
    // again.
    async fn interrupt_and_continue(engine: &RunEngine, run_id: RunId, accepted_run_version: i64) {
        let ended = engine
            .end_run_for_interrupt(
                run_id,
                accepted_run_version,
                None,
                RunStateChangeCompanions::default(),
            )
            .await
            .expect("the person's interrupt ends the run");
        assert!(ended);
        engine
            .continue_run(continue_request(run_id, started_turn))
            .await
            .expect("the continue runs the run again");
    }

    // Killed by the run's end forgetting the cut before the cut turn's end is written, and by a
    // stop that finds the run ended leaving its own cut in place of the earlier one or removing
    // both: either way the provider's end of the cut turn is written with another cause or none.
    #[tokio::test]
    async fn a_cut_turn_keeps_its_limit_past_the_runs_end_and_a_stop_that_found_it_ended() {
        let database = TestDatabase::new();
        let log = open_log(&database, None).await;
        let home = tempfile::tempdir().expect("the test makes a home folder");
        let session_id = test_session_id();
        let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        insert_running_run(&database, session_id, run_id);
        let engine = test_engine(&database, log.service, home.path());
        let _interventions = hand_limit_interrupter(&engine, 0);
        append(
            &engine,
            session_id,
            &turn_started_at(session_id, run_id, 1, 1),
        )
        .await;

        engine
            .stop_at_limit(run_id, step_stop())
            .await
            .expect("the limit's interrupt is accepted");
        // A person's interrupt, accepted while the limit's is pending, ends the run first.
        let ended = engine
            .end_run_for_interrupt(run_id, 1, None, RunStateChangeCompanions::default())
            .await
            .expect("the person's interrupt ends the run");
        assert!(ended);
        // A token stop of the same turn finds the run ended and stops nothing.
        engine
            .stop_at_token_limit(run_id, token_limit())
            .await
            .expect("a stop of a run that has ended is left");
        let turn_ended = engine
            .record_turn_end(
                run_id,
                ProviderTurnEnd {
                    turn_number: turn(1),
                    outcome: TurnOutcome::Interrupted(None),
                },
            )
            .await
            .expect("the provider's end of the cut turn is written");

        assert!(turn_ended);
        assert_eq!(
            stored_events(&database, &run_id),
            events(&[
                ("agent.turn.started", None, None),
                ("agent.run.stepLimit.reached", None, None),
                ("agent.run.interrupted", None, None),
                (
                    "agent.turn.interrupted",
                    Some("stepLimit"),
                    Some("provider")
                ),
            ])
        );
        assert!(
            lock(&engine.live).cut_turns.is_empty(),
            "the cut leaves with its turn's end"
        );
    }

    // Killed by the cuts keyed by run alone, where turn 2's cut replaces turn 1's, which its
    // provider then ends with no cause.
    #[tokio::test]
    async fn a_later_turns_cut_keeps_the_limit_of_an_earlier_cut_turn() {
        let database = TestDatabase::new();
        let log = open_log(&database, None).await;
        let home = tempfile::tempdir().expect("the test makes a home folder");
        let session_id = test_session_id();
        let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        insert_running_run(&database, session_id, run_id);
        let engine = test_engine(&database, log.service, home.path());
        let _interventions = hand_limit_interrupter(&engine, 0);
        append(
            &engine,
            session_id,
            &turn_started_at(session_id, run_id, 1, 1),
        )
        .await;

        // Turn 1 is cut, a person's interrupt ends the run before the provider ends the turn, and
        // a continue runs turn 2, which is cut too.
        engine
            .stop_at_limit(run_id, step_stop())
            .await
            .expect("the limit's interrupt is accepted");
        interrupt_and_continue(&engine, run_id, 1).await;
        append(
            &engine,
            session_id,
            &turn_started_at(session_id, run_id, 2, 3),
        )
        .await;
        engine
            .stop_at_limit(run_id, step_stop())
            .await
            .expect("the limit's interrupt is accepted");
        let turn_ended = engine
            .record_turn_end(
                run_id,
                ProviderTurnEnd {
                    turn_number: turn(1),
                    outcome: TurnOutcome::Interrupted(None),
                },
            )
            .await
            .expect("the provider's late end of turn 1 is written");

        assert!(turn_ended);
        assert_eq!(
            stored_events(&database, &run_id),
            events(&[
                ("agent.turn.started", None, None),
                ("agent.run.stepLimit.reached", None, None),
                ("agent.run.interrupted", None, None),
                ("agent.run.running", None, None),
                ("agent.turn.started", None, None),
                ("agent.run.stepLimit.reached", None, None),
                (
                    "agent.turn.interrupted",
                    Some("stepLimit"),
                    Some("provider")
                ),
            ])
        );
        let cuts: Vec<_> = lock(&engine.live).cut_turns.keys().copied().collect();
        assert_eq!(
            cuts,
            [(run_id, turn(2))],
            "turn 2's cut waits for its own end"
        );
    }

    // Killed by a retried token stop writing its reached event again, which the once-per-run
    // guard refuses so no interrupt goes, and by a retry sending no interrupt.
    #[tokio::test]
    async fn a_token_stop_retried_after_a_failed_interrupt_sends_the_interrupt_alone() {
        let database = TestDatabase::new();
        let log = open_log(&database, None).await;
        let home = tempfile::tempdir().expect("the test makes a home folder");
        let session_id = test_session_id();
        let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        insert_running_run(&database, session_id, run_id);
        let engine = test_engine(&database, log.service, home.path());
        let interventions = hand_limit_interrupter(&engine, 1);
        append(
            &engine,
            session_id,
            &turn_started_at(session_id, run_id, 1, 1),
        )
        .await;

        let refused = engine.stop_at_token_limit(run_id, token_limit()).await;
        assert!(
            matches!(refused, Err(RunEngineError::LimitInterrupt { .. })),
            "the first stop answers {refused:?}"
        );
        engine
            .stop_at_token_limit(run_id, token_limit())
            .await
            .expect("the retried stop's interrupt is accepted");
        assert_eq!(interventions.calls.load(Ordering::SeqCst), 2);
        // The interventions service ends the run with the limit it accepted at version 1.
        let ended = engine
            .end_run_for_interrupt(
                run_id,
                1,
                Some(RunLimit::TokenLimit),
                RunStateChangeCompanions::default(),
            )
            .await
            .expect("the run ends at its limit");

        assert!(ended);
        assert_eq!(
            stored_events(&database, &run_id),
            events(&[
                ("agent.turn.started", None, None),
                ("agent.run.tokenLimit.reached", None, None),
                ("agent.turn.interrupted", Some("tokenLimit"), Some("daemon")),
                ("agent.run.stopped", None, None),
            ])
        );
        assert_eq!(
            stored_run_state(&database, &run_id),
            ("stopped".to_owned(), 2)
        );
    }

    // Killed by a token stop that finds the run's reached event standing sending no interrupt
    // while no limit's interrupt is pending: a run a person's interrupt overtook and a continue
    // ran again would run on past its token limit.
    #[tokio::test]
    async fn a_token_stop_after_an_overtaken_limit_and_a_continue_stops_the_run() {
        let database = TestDatabase::new();
        let log = open_log(&database, None).await;
        let home = tempfile::tempdir().expect("the test makes a home folder");
        let session_id = test_session_id();
        let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        insert_running_run(&database, session_id, run_id);
        let engine = test_engine(&database, log.service, home.path());
        let interventions = hand_limit_interrupter(&engine, 0);
        append(
            &engine,
            session_id,
            &turn_started_at(session_id, run_id, 1, 1),
        )
        .await;

        engine
            .stop_at_token_limit(run_id, token_limit())
            .await
            .expect("the limit's interrupt is accepted");
        // A person's interrupt ends the run before the limit's end, which then finds it ended,
        // and a continue runs turn 2.
        let ended = engine
            .end_run_for_interrupt(run_id, 1, None, RunStateChangeCompanions::default())
            .await
            .expect("the person's interrupt ends the run");
        assert!(ended);
        let limit_ended = engine
            .end_run_for_interrupt(
                run_id,
                1,
                Some(RunLimit::TokenLimit),
                RunStateChangeCompanions::default(),
            )
            .await
            .expect("the overtaken limit's end is left");
        assert!(!limit_ended);
        engine
            .continue_run(continue_request(run_id, started_turn))
            .await
            .expect("the continue runs the run again");
        append(
            &engine,
            session_id,
            &turn_started_at(session_id, run_id, 2, 3),
        )
        .await;
        engine
            .stop_at_token_limit(run_id, token_limit())
            .await
            .expect("the next usage report's stop sends the interrupt alone");
        assert_eq!(interventions.calls.load(Ordering::SeqCst), 2);
        let stopped = engine
            .end_run_for_interrupt(
                run_id,
                3,
                Some(RunLimit::TokenLimit),
                RunStateChangeCompanions::default(),
            )
            .await
            .expect("the run ends at its token limit");

        assert!(stopped);
        assert_eq!(
            stored_events(&database, &run_id),
            events(&[
                ("agent.turn.started", None, None),
                ("agent.run.tokenLimit.reached", None, None),
                ("agent.run.interrupted", None, None),
                ("agent.run.running", None, None),
                ("agent.turn.started", None, None),
                ("agent.turn.interrupted", Some("tokenLimit"), Some("daemon")),
                ("agent.run.stopped", None, None),
            ])
        );
        assert_eq!(
            stored_run_state(&database, &run_id),
            ("stopped".to_owned(), 4)
        );
    }

    // Killed by the interrupt alone reading a run being continued as ended, which sends no
    // interrupt and leaves the continued run past the session's spend limit.
    #[tokio::test]
    async fn a_spend_stop_retried_during_a_continue_interrupts_the_continued_run() {
        let database = TestDatabase::new();
        let log = open_log(&database, None).await;
        let home = tempfile::tempdir().expect("the test makes a home folder");
        let session_id = test_session_id();
        let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        insert_running_run(&database, session_id, run_id);
        let engine = test_engine(&database, log.service, home.path());
        let interventions = hand_limit_interrupter(&engine, 1);
        append(
            &engine,
            session_id,
            &turn_started_at(session_id, run_id, 1, 1),
        )
        .await;

        let refused = engine.stop_at_spend_limit(run_id).await;
        assert!(
            matches!(refused, Err(RunEngineError::LimitInterrupt { .. })),
            "the first stop answers {refused:?}"
        );
        let ended = engine
            .end_run_for_interrupt(run_id, 1, None, RunStateChangeCompanions::default())
            .await
            .expect("the person's interrupt ends the run");
        assert!(ended);
        let (start_driver, driver_has_started, release_driver) = held_driver();
        let request = continue_request(run_id, start_driver);
        let stop_during_continue = async {
            driver_has_started
                .await
                .expect("the driver's start is reached");
            let release = async {
                tokio::time::sleep(DRIVER_HOLD).await;
                release_driver
                    .send(())
                    .expect("the continue still waits in its driver");
            };
            tokio::join!(engine.stop_at_spend_limit(run_id), release).0
        };
        let (continued, stopped) = tokio::time::timeout(SETTLE_WAIT, async {
            tokio::join!(engine.continue_run(request), stop_during_continue)
        })
        .await
        .expect("the continue and the stop settle");

        continued.expect("the continue runs the run again");
        stopped.expect("the retried stop's interrupt is accepted");
        assert_eq!(interventions.calls.load(Ordering::SeqCst), 2);
    }

    // Killed by the pending check counting any interrupt, any limit's, or one whose outcome is in:
    // a second token interrupt then goes while the first is pending, or none goes once the only
    // interrupt left is another limit's or a failed one.
    #[rstest]
    #[case::token_limit_accepted("tokenLimit", "accepted", 1)]
    #[case::token_limit_failed("tokenLimit", "failed", 2)]
    #[case::step_limit_accepted("stepLimit", "accepted", 2)]
    #[tokio::test]
    async fn a_token_stop_past_its_reached_event_waits_only_on_its_own_pending_interrupt(
        #[case] limit: &str,
        #[case] state: &str,
        #[case] expected_calls: usize,
    ) {
        let database = TestDatabase::new();
        let log = open_log(&database, None).await;
        let home = tempfile::tempdir().expect("the test makes a home folder");
        let session_id = test_session_id();
        let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        insert_running_run(&database, session_id, run_id);
        let engine = test_engine(&database, log.service, home.path());
        let interventions = hand_limit_interrupter(&engine, 0);
        append(
            &engine,
            session_id,
            &turn_started_at(session_id, run_id, 1, 1),
        )
        .await;
        engine
            .stop_at_token_limit(run_id, token_limit())
            .await
            .expect("the limit's interrupt is accepted");
        database
            .reader()
            .execute(
                "INSERT INTO interventions (id, target_run_id, type, state, payload)
                 VALUES ('interrupt', ?1, 'interrupt', ?2, json_object('limit', ?3))",
                [run_id.text().as_str(), state, limit],
            )
            .expect("the test records the run's interrupt");

        engine
            .stop_at_token_limit(run_id, token_limit())
            .await
            .expect("the next usage report's stop is left or sends the interrupt alone");

        assert_eq!(interventions.calls.load(Ordering::SeqCst), expected_calls);
    }
}
