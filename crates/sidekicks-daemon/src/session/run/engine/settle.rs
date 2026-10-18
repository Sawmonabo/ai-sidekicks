//! How a run ends outside its provider's own report: for an interrupt accepted earlier, when the
//! provider process under it exits on its own, and when a restart left it live and recovery could
//! not resume it. Each run's end carries the end of its open turn in the same write.

use std::borrow::Cow;
use std::iter;
use std::sync::LazyLock;

use rusqlite::types::Value;
use sidekicks_contracts::event::envelope::EventCategory;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::provider::driver::recovery::RecoveryCondition;
use sidekicks_contracts::run::control::{ProcessExit, RunFailureCategory};
use sidekicks_contracts::run::events::{TurnEndCause, TurnEndOrigin};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::RunLimit;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::database::connection::read_pool::ReadLength;
use crate::database::statement::{StatementBindings, WriteStatement, text_binding};
use crate::provider::driver::contract::bound_failure_detail;
use crate::session::run::engine::limits::limit_run_end;
use crate::session::run::engine::turns::{TurnEnd, TurnOutcome};
use crate::session::run::engine::{RunEngine, RunEngineError, settled};
use crate::session::run::read::{LiveRun, RunRead, RunStateReader};
use crate::session::run::refusals::RunRefusal;
use crate::session::run::restart::{
    RestartFacts, RestartSettlement, RestartTurnEnd, applied_pending_interrupt_of,
    decide_restart_settlement, limit_turn_cause, no_pending_interrupt_statement,
    no_waiting_item_statement, read_restart_facts,
};
use crate::session::run::state_change::{
    RunStateChange, RunStateChangeCompanions, RunStateChangeError, RunStateEntry,
};
use crate::session::run::transitions::RUN_TERMINAL_EVENT_TYPES_SQL;

// The position among an interrupt end's companions of its guard that the run has not ended since
// the interrupt was accepted: the first of the caller's companions, before the verdict's.
const INTERRUPT_END_SINCE_GUARD_COMPANION_INDEX: usize = 0;

// A queued run's settle guards first that no interrupt appeared, then that no message waits for it.
const QUEUED_RUN_WAITING_ITEM_GUARD_COMPANION_INDEX: usize = 1;

// The failure a restart records when the words it was given fit nothing.
static RESTART_FAILURE_FALLBACK: LazyLock<FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>> =
    LazyLock::new(|| {
        FreeFormText::new("The run could not be resumed after the service restarted".to_owned())
            .expect("the fallback is non-blank and within the cap")
    });

// A terminal record of the run past a version, read by the event's own run columns and the
// stored category word, spelled as the unique index on terminal records spells its predicate.
static SELECT_TERMINAL_SINCE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT 1 FROM session_events
  WHERE category = '{}'
    AND type IN ({})
    AND run_id = @run_id
    AND run_version > @run_version
  LIMIT 1",
        EventCategory::RunLifecycle.as_str(),
        *RUN_TERMINAL_EVENT_TYPES_SQL
    )
});

impl RunEngine {
    /// Ends the run for an applied or degraded interrupt accepted at `accepted_run_version`,
    /// committing `verdict`, the interrupt's row move and its event, in the same write, and returns
    /// `true`: `interrupted` for a person's interrupt, and the end the limit gives its run for the
    /// daemon's own at `limit`, with the end of the turn the limit cut, `agent.turn.interrupted`
    /// with the limit as its cause, in the same write, so the provider's later end of that turn is
    /// dropped. Returns `false` with no change of the run written when the run has ended since
    /// that version, even if it was continued after, which is what the interrupt asked for; the
    /// caller then records the verdict alone. On a run that reads ended, the limit's turn end is
    /// written on its own for the newest open turn started at or before that version, if any, so a
    /// turn of a run continued since never takes it. Fails as [`RunEngine::transition`] does.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the interventions service ends the run of each interrupt it applies with it"
        )
    )]
    pub(crate) async fn end_run_for_interrupt(
        &self,
        run_id: RunId,
        accepted_run_version: i64,
        limit: Option<RunLimit>,
        verdict: RunStateChangeCompanions,
    ) -> Result<bool, RunEngineError> {
        let mut companions = verdict;
        companions.statements.insert(
            INTERRUPT_END_SINCE_GUARD_COMPANION_INDEX,
            no_terminal_since_statement(&run_id, accepted_run_version),
        );
        let ended = match limit {
            None => {
                let interrupted = RunStateEntry::Interrupted {
                    intended_close: None,
                    trigger: None,
                };
                self.change(RunStateChange::new(run_id, interrupted), companions)
                    .await
            }
            Some(limit) => {
                let run = self.require_run(run_id).await?;
                let cut_turn = self
                    .live()
                    .cut_turns
                    .get(&run_id)
                    .map(|cut| cut.turn_number);
                let turn_number = match cut_turn {
                    Some(turn_number) => Some(turn_number),
                    None => {
                        self.read_open_turn(run_id, Some(accepted_run_version))
                            .await?
                    }
                };
                let turn_end = turn_number.map(|turn_number| TurnEnd {
                    turn_number,
                    origin: TurnEndOrigin::Daemon,
                    outcome: TurnOutcome::Interrupted(Some(limit_turn_cause(limit))),
                });
                self.change_with_turn_end(
                    RunStateChange::new(run_id, limit_run_end(limit)),
                    companions,
                    &run,
                    turn_end,
                )
                .await
            }
        };
        match ended {
            Ok(_run) => Ok(true),
            Err(
                RunEngineError::Refused(RunRefusal::AlreadyEnded { .. })
                | RunEngineError::Change(RunStateChangeError::CompanionRefused {
                    companion_index: INTERRUPT_END_SINCE_GUARD_COMPANION_INDEX,
                    ..
                }),
            ) => Ok(false),
            Err(error) => Err(error),
        }
    }

    /// Ends the turn a provider process left when it ended on its own: the run, and each live run
    /// the provider dispatched beneath it as its own subagent, each in its own write, ends `failed`
    /// with `process_exit`, its open turn `agent.turn.failed` with the process's exit as its cause.
    /// Every run is ended before the failures return, together.
    #[expect(
        dead_code,
        reason = "the provider's event delivery, when a provider process exits"
    )]
    pub(crate) async fn end_turn_on_process_exit(
        &self,
        run_id: RunId,
        process_exit: ProcessExit,
    ) -> Result<(), RunEngineError> {
        let subagents = self
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, RunEngineError>(
                    RunStateReader::new(reader).list_live_provider_subagents(&run_id)?,
                )
            })
            .await?;
        let mut outcomes = Vec::with_capacity(1 + subagents.len());
        for ended_run_id in iter::once(run_id).chain(subagents) {
            outcomes.push(self.fail_on_process_exit(ended_run_id, &process_exit).await);
        }
        settled(
            outcomes,
            "ending the turns of a run and its provider's subagents on their process's exit",
        )
    }

    // One run's end when its provider process exited, with its open turn's end in the same write.
    async fn fail_on_process_exit(
        &self,
        run_id: RunId,
        process_exit: &ProcessExit,
    ) -> Result<(), RunEngineError> {
        let run = self.require_run(run_id).await?;
        let open_turn = self.read_open_turn(run_id, None).await?;
        let failed = RunStateChange {
            failure_category: Some(RunFailureCategory::ProviderFailure),
            ..RunStateChange::new(
                run_id,
                RunStateEntry::Failed {
                    intended_close: None,
                    failure_cause: None,
                    provider_failure_detail: None,
                    process_exit: Some(process_exit.clone()),
                },
            )
        };
        let turn_end = open_turn.map(|turn_number| TurnEnd {
            turn_number,
            origin: TurnEndOrigin::Daemon,
            outcome: TurnOutcome::Failed(Some(TurnEndCause::ProcessExit)),
        });
        self.change_with_turn_end(failed, RunStateChangeCompanions::default(), &run, turn_end)
            .await
            .map(drop)
    }

    /// Settles one run a restart left live that recovery could not resume, without calling any
    /// driver, as [`decide_restart_settlement`] decides: its end and its open turn's end in one
    /// write, a pending interrupt moved to `applied` in that write, otherwise guarded on no
    /// interrupt having appeared since; a `failed` end carries `failure_detail`. A run the decision
    /// leaves is returned as it is. Fails as [`RunEngine::transition`] does.
    #[expect(dead_code, reason = "the daemon's recovery pass at start")]
    pub(crate) async fn settle_run_after_restart(
        &self,
        run: &LiveRun,
        failure_detail: &str,
    ) -> Result<RunRead, RunEngineError> {
        let read = run.clone();
        let facts = self
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, RunEngineError>(read_restart_facts(reader, &read)?)
            })
            .await?;
        self.settle_run_from_facts(run, &facts, failure_detail)
            .await
    }

    // The settle of `run` as `facts`, read before its write, decide it.
    async fn settle_run_from_facts(
        &self,
        run: &LiveRun,
        facts: &RestartFacts,
        failure_detail: &str,
    ) -> Result<RunRead, RunEngineError> {
        let Some(decision) = decide_restart_settlement(run, facts) else {
            return Ok(run.run.clone());
        };
        let run_id = run.run_id;
        let change = match decision.settlement {
            RestartSettlement::Interrupted { trigger } => RunStateChange::new(
                run_id,
                RunStateEntry::Interrupted {
                    intended_close: None,
                    trigger,
                },
            ),
            RestartSettlement::Stopped { trigger } => RunStateChange::new(
                run_id,
                RunStateEntry::Stopped {
                    intended_close: None,
                    trigger: Some(trigger),
                },
            ),
            RestartSettlement::Failed => RunStateChange {
                failure_category: Some(RunFailureCategory::ProviderFailure),
                recovery_condition: Some(RecoveryCondition::RecoveryNeeded),
                ..RunStateChange::new(
                    run_id,
                    RunStateEntry::Failed {
                        intended_close: None,
                        failure_cause: None,
                        provider_failure_detail: Some(bound_failure_detail(
                            failure_detail,
                            RESTART_FAILURE_FALLBACK.clone(),
                        )),
                        process_exit: None,
                    },
                )
            },
        };
        let mut companions = match &facts.pending_interrupt {
            // The person's pending interrupt stays theirs, and the daemon's own at a limit keeps
            // its cause; either is applied by this end.
            Some(pending_interrupt) => applied_pending_interrupt_of(run, pending_interrupt)?,
            None => RunStateChangeCompanions {
                statements: vec![no_pending_interrupt_statement(&run_id)],
                ..RunStateChangeCompanions::default()
            },
        };
        let is_queued = run.run.state == RunState::Queued;
        if is_queued {
            companions
                .statements
                .push(no_waiting_item_statement(&run_id));
        }
        let open_turn = match decision.open_turn_end {
            Some(_) => self.read_open_turn(run_id, None).await?,
            None => None,
        };
        let turn_end = decision
            .open_turn_end
            .zip(open_turn)
            .map(|(turn_end, turn_number)| TurnEnd {
                turn_number,
                origin: TurnEndOrigin::Daemon,
                outcome: match turn_end {
                    RestartTurnEnd::Interrupted { cause } => TurnOutcome::Interrupted(Some(cause)),
                    RestartTurnEnd::Failed { cause } => TurnOutcome::Failed(Some(cause)),
                },
            });
        match self
            .change_with_turn_end(change, companions, &run.run, turn_end)
            .await
        {
            // A message queued for the run since its facts were read starts it, so it is left.
            Err(RunEngineError::Change(RunStateChangeError::CompanionRefused {
                companion_index: QUEUED_RUN_WAITING_ITEM_GUARD_COMPANION_INDEX,
                ..
            })) if is_queued => Ok(run.run.clone()),
            settled => settled,
        }
    }
}

// Holds only while the run has written no terminal after `run_version`.
fn no_terminal_since_statement(run_id: &RunId, run_version: i64) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(SELECT_TERMINAL_SINCE_SQL.as_str()),
        bindings: StatementBindings::Named(vec![
            text_binding("@run_id", run_id.text().as_str()),
            (Cow::Borrowed("@run_version"), Value::Integer(run_version)),
        ]),
        expected_row_count: Some(0),
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::params;
    use sidekicks_contracts::event::session::SessionEvent;
    use sidekicks_contracts::run::events::{
        AgentRunInterruptedNewState, AgentRunInterruptedPayload, AgentTurnStartedPayload,
    };
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::run::intervention::RunLimit;
    use sidekicks_contracts::run::state::RunState;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::integer::SafeInt;

    use crate::database::writer::test_file::{TestDatabase, test_session_id};
    use crate::events::log_service::tests::open_log;
    use crate::events::session::appender::SessionEventDraft;
    use crate::session::run::engine::RunEngine;
    use crate::session::run::engine::limits::CutTurn;
    use crate::session::run::engine::tests::{stored_events, stored_run_state, test_engine};
    use crate::session::run::engine::turns::{ProviderTurnEnd, TurnOutcome};
    use crate::session::run::projection::RUNS_TABLE_SQL;
    use crate::session::run::read::{LiveRun, RunRead};
    use crate::session::run::restart::{QUEUE_ITEMS_TABLE_SQL, RestartFacts};
    use crate::session::run::state_change::RunStateChangeCompanions;
    use crate::uuid_v7::mint_uuid_v7;

    // The interventions table with the columns a settle's guard reads.
    const INTERVENTIONS_TABLE_SQL: &str = "
CREATE TABLE interventions (
  id             TEXT PRIMARY KEY,
  target_run_id  TEXT NOT NULL,
  type           TEXT NOT NULL,
  state          TEXT NOT NULL DEFAULT 'requested',
  payload        TEXT NOT NULL DEFAULT '{}',
  device_id      TEXT
) STRICT;
";

    async fn append(engine: &RunEngine, session_id: SessionId, event: &SessionEvent) {
        engine
            .append(
                SessionEventDraft::of_session(session_id, event)
                    .expect("the event passes its checks"),
                Vec::new(),
                Vec::new(),
            )
            .await
            .expect("the test's event is appended");
    }

    fn run_version(version: u64) -> SafeInt<0> {
        SafeInt::new(version).expect("the test's run versions are safe integers")
    }

    fn interrupted_at(session_id: SessionId, run_id: RunId, version: u64) -> SessionEvent {
        SessionEvent::AgentRunInterrupted(AgentRunInterruptedPayload {
            session_id,
            run_id,
            run_version: run_version(version),
            previous_state: RunState::Running,
            new_state: AgentRunInterruptedNewState::Value,
            failure_category: None,
            recovery_condition: None,
            intended_close: None,
            trigger: None,
        })
    }

    fn turn_started_at(
        session_id: SessionId,
        run_id: RunId,
        turn: u64,
        version: u64,
    ) -> SessionEvent {
        SessionEvent::AgentTurnStarted(AgentTurnStartedPayload {
            session_id,
            run_id,
            run_version: run_version(version),
            turn_number: SafeInt::new(turn).expect("the test's turn numbers count from 1"),
            position: None,
        })
    }

    // Killed by the limit's end leaving the cut turn's end to its provider, which writes it with
    // no cause; by the since-guard's refusal read at the position the turn end's guard shifts it
    // to, which answers a run ended since with an error; by dropping that guard, which ends a run
    // continued after the interrupt was accepted; and by the open-turn read taking a turn started
    // after the accepted version, which marks a later turn of a run continued since, or leaving
    // out one started at that version.
    #[tokio::test]
    async fn a_limit_end_writes_its_cut_turn_end_and_leaves_a_run_that_ended_since() {
        let database = TestDatabase::new();
        let log = open_log(&database, None).await;
        let home = tempfile::tempdir().expect("the test makes a home folder");
        let session_id = test_session_id();
        let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        let turn_one = SafeInt::new(1).expect("1 is a turn number");
        // Interrupted at version 3, continued at 4, and running turn 1 at 5.
        database
            .reader()
            .execute_batch(RUNS_TABLE_SQL)
            .expect("the test makes the runs table");
        database
            .reader()
            .execute(
                "INSERT INTO runs (run_id, session_id, state, run_version)
                 VALUES (?1, ?2, 'running', 5)",
                params![run_id.text().as_str(), session_id.text().as_str()],
            )
            .expect("the test writes the run");
        let engine = test_engine(&database, log.service, home.path());
        append(&engine, session_id, &interrupted_at(session_id, run_id, 3)).await;
        append(
            &engine,
            session_id,
            &turn_started_at(session_id, run_id, 1, 5),
        )
        .await;
        let seeded = stored_events(&database, &run_id);

        // A stop cut turn 1 for an interrupt accepted before the run's end at version 3.
        engine.live().cut_turns.insert(
            run_id,
            CutTurn {
                limit: RunLimit::StepLimit,
                turn_number: turn_one,
            },
        );
        let ended_since = engine
            .end_run_for_interrupt(
                run_id,
                2,
                Some(RunLimit::StepLimit),
                RunStateChangeCompanions::default(),
            )
            .await
            .expect("a run that ended since the interrupt is left");
        assert!(!ended_since);
        assert_eq!(stored_events(&database, &run_id), seeded);
        assert_eq!(
            stored_run_state(&database, &run_id),
            ("running".to_owned(), 5)
        );

        // With no cut held, the read finds turn 1, started at the accepted version.
        engine.forget_cut_turn(&run_id, turn_one);
        let ended = engine
            .end_run_for_interrupt(
                run_id,
                5,
                Some(RunLimit::StepLimit),
                RunStateChangeCompanions::default(),
            )
            .await
            .expect("the run ends at its limit");
        assert!(ended);
        let late_end = engine
            .record_turn_end(
                run_id,
                ProviderTurnEnd {
                    turn_number: turn_one,
                    outcome: TurnOutcome::Interrupted(None),
                },
            )
            .await
            .expect("the provider's late end is read");
        assert!(
            !late_end,
            "the provider's late end of the cut turn is dropped"
        );
        assert_eq!(
            stored_events(&database, &run_id),
            [
                ("agent.run.interrupted".to_owned(), None),
                ("agent.turn.started".to_owned(), None),
                (
                    "agent.turn.interrupted".to_owned(),
                    Some("stepLimit".to_owned())
                ),
                ("agent.run.interrupted".to_owned(), None),
            ]
        );
        assert_eq!(
            stored_run_state(&database, &run_id),
            ("interrupted".to_owned(), 6)
        );

        // Continued at 7 on turn 2, which a person's interrupt at 8 left with no end, before the
        // limit accepted at 5 is ended again.
        append(
            &engine,
            session_id,
            &turn_started_at(session_id, run_id, 2, 7),
        )
        .await;
        append(&engine, session_id, &interrupted_at(session_id, run_id, 8)).await;
        database
            .reader()
            .execute(
                "UPDATE runs SET state = 'interrupted', run_version = 8 WHERE run_id = ?1",
                [run_id.text().as_str()],
            )
            .expect("the test ends the run again");
        let continued = stored_events(&database, &run_id);
        let ended_again = engine
            .end_run_for_interrupt(
                run_id,
                5,
                Some(RunLimit::StepLimit),
                RunStateChangeCompanions::default(),
            )
            .await
            .expect("a run that ended again is left");
        assert!(!ended_again);
        assert_eq!(
            stored_events(&database, &run_id),
            continued,
            "a turn started after the limit was accepted takes no limit end"
        );
    }

    // Killed by the waiting-item guard's refusal read at any other position, which answers a run
    // its queue still starts with an error, or by dropping the guard, which fails that run.
    #[tokio::test]
    async fn a_message_queued_while_a_restart_settles_a_queued_run_leaves_it_queued() {
        let database = TestDatabase::new();
        let log = open_log(&database, None).await;
        let home = tempfile::tempdir().expect("the test makes a home folder");
        let session_id = test_session_id();
        let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        let connection = database.reader();
        connection
            .execute_batch(RUNS_TABLE_SQL)
            .and_then(|()| connection.execute_batch(QUEUE_ITEMS_TABLE_SQL))
            .and_then(|()| connection.execute_batch(INTERVENTIONS_TABLE_SQL))
            .expect("the test makes its tables");
        connection
            .execute(
                "INSERT INTO runs (run_id, session_id, state, run_version)
                 VALUES (?1, ?2, 'queued', 0)",
                params![run_id.text().as_str(), session_id.text().as_str()],
            )
            .expect("the test queues the run");
        // Queued after the settle read the run had no message waiting.
        connection
            .execute(
                "INSERT INTO queue_items (id, session_id, state, target_run_id, created_at,
                   updated_at)
                 VALUES ('item', ?1, 'queued', ?2, '', '')",
                params![session_id.text().as_str(), run_id.text().as_str()],
            )
            .expect("the test queues a message for the run");
        let engine = test_engine(&database, log.service, home.path());
        let run = LiveRun {
            run_id,
            run: RunRead {
                version: 0,
                session_id,
                state: RunState::Queued,
            },
            parent_run_id: None,
            reached_by: None,
        };

        let settled = engine
            .settle_run_from_facts(
                &run,
                &RestartFacts {
                    pending_interrupt: None,
                    has_queued_item: false,
                },
                "the run could not be resumed",
            )
            .await
            .expect("a run its queue still starts is left");

        assert_eq!(settled, run.run);
        assert_eq!(
            stored_run_state(&database, &run_id),
            ("queued".to_owned(), 0)
        );
        assert!(stored_events(&database, &run_id).is_empty());
    }
}
