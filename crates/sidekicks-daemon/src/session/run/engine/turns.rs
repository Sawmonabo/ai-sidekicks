//! A run's turns: each start numbered its run's newest start plus one inside its write, each end
//! written once, riding the run change it ends with or on its own, and the steps of a turn counted
//! on a run whose provider does not bound them.

use std::borrow::Cow;
use std::sync::{Arc, LazyLock};

use rusqlite::types::Value;
use rusqlite::{OptionalExtension as _, named_params};
use sidekicks_contracts::event::envelope::{EventCategory, SourcePosition};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::run::events::{
    AgentTurnCompletedPayload, AgentTurnFailedPayload, AgentTurnInterruptedPayload,
    AgentTurnStartedPayload, TurnEndCause, TurnEndOrigin,
};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::RunLimit;
use sidekicks_contracts::wire::integer::SafeInt;

use crate::database::connection::read_pool::ReadLength;
use crate::database::statement::{StatementBindings, WriteStatement, text_binding};
use crate::events::session::appender::{SessionEventDraft, SessionEventDraftError};
use crate::interventions::store::run_at_version_statement;
use crate::session::run::engine::limits::LimitStop;
use crate::session::run::engine::live::lock;
use crate::session::run::engine::{
    LIVE_APPEND_VERSION_GUARD_INDEX, RunEngine, RunEngineError, refused_statement_index,
    safe_run_version, with_cleanup_failures,
};
use crate::session::run::read::RunRead;
use crate::session::run::restart::limit_turn_cause;
use crate::session::run::state_change::{
    RunStateChange, RunStateChangeCompanions, RunStateChangeError,
};

// The position among a run change's companions of the guard that the turn it ends has no end yet:
// the turn's end rides first, so its guard leads the companions.
const TURN_END_GUARD_COMPANION_INDEX: usize = 0;

// A lone turn end's guard is the first statement of its write.
const LONE_TURN_END_GUARD_INDEX: usize = 0;

// A turn start's guard that no start holds its number yet follows the version guard.
const TURN_START_GUARD_INDEX: usize = 1;

// A run's first turn.
const FIRST_TURN_NUMBER: SafeInt<1> = SafeInt::new(1).expect("1 is a turn number");

// Reads of a run's newest turn start before a start that keeps losing its number to another, or
// whose run keeps moving under it, gives up.
const TURN_START_ATTEMPTS: usize = 3;

// The run's newest turn start, by the event's own run columns.
static SELECT_NEWEST_TURN_START_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT MAX(turn_number) FROM session_events
  WHERE category = '{}'
    AND type = '{}'
    AND run_id = @run_id",
        EventCategory::RunLifecycle.as_str(),
        SessionEventType::AgentTurnStarted.as_str()
    )
});

// Refuses a start once any start of the run holds its number or a later one, spelled as the
// unique index on turn starts spells its predicate.
static SELECT_TURN_START_FROM_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT 1 FROM session_events
  WHERE category = '{}'
    AND type = '{}'
    AND run_id = @run_id
    AND turn_number >= @turn_number
  LIMIT 1",
        EventCategory::RunLifecycle.as_str(),
        SessionEventType::AgentTurnStarted.as_str()
    )
});

// The three turn ends, in the order the unique index on turn ends spells them.
static TURN_END_TYPES_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "'{}', '{}', '{}'",
        SessionEventType::AgentTurnCompleted.as_str(),
        SessionEventType::AgentTurnInterrupted.as_str(),
        SessionEventType::AgentTurnFailed.as_str()
    )
});

// Refuses an end once the turn holds one.
static SELECT_TURN_END_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT 1 FROM session_events
  WHERE category = '{}'
    AND type IN ({})
    AND run_id = @run_id
    AND turn_number = @turn_number
  LIMIT 1",
        EventCategory::RunLifecycle.as_str(),
        *TURN_END_TYPES_SQL
    )
});

// The run's newest started turn that holds no end, started at or before `@started_by` where one is
// bound.
static SELECT_OPEN_TURN_SQL: LazyLock<String> = LazyLock::new(|| {
    let category = EventCategory::RunLifecycle.as_str();
    format!(
        "SELECT started.turn_number FROM session_events AS started
  WHERE started.category = '{category}'
    AND started.type = '{}'
    AND started.run_id = @run_id
    AND (@started_by IS NULL OR started.run_version <= @started_by)
    AND NOT EXISTS (
      SELECT 1 FROM session_events AS ended
       WHERE ended.category = '{category}'
         AND ended.type IN ({})
         AND ended.run_id = started.run_id
         AND ended.turn_number = started.turn_number)
  ORDER BY started.turn_number DESC
  LIMIT 1",
        SessionEventType::AgentTurnStarted.as_str(),
        *TURN_END_TYPES_SQL
    )
});

/// A turn's end its provider's end frame reported.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(test), expect(dead_code, reason = "the provider's event delivery"))]
pub(crate) struct ProviderTurnEnd {
    /// The turn's number within its run, as its start was numbered.
    pub(crate) turn_number: SafeInt<1>,
    /// How it ended, with the cause the delivery knows from the frame, such as the step limit of a
    /// provider that bounds a turn's steps itself; a limit stop's cut of the turn replaces it.
    pub(crate) outcome: TurnOutcome,
}

/// The steps of a run's open turn, counted on a run whose provider does not bound them.
pub(super) struct StepCount {
    turn_number: SafeInt<1>,
    bound: SafeInt<1>,
    steps: u64,
    is_stopping: bool,
}

/// A turn's end as the log records it: the turn, who reported the end, and how it ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct TurnEnd {
    /// The turn.
    pub(super) turn_number: SafeInt<1>,
    /// Who reported the end.
    pub(super) origin: TurnEndOrigin,
    /// How it ended.
    pub(super) outcome: TurnOutcome,
}

/// How a turn ended, with why where the daemon knows it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TurnOutcome {
    /// `agent.turn.completed`.
    #[expect(dead_code, reason = "the provider's event delivery")]
    Completed,
    /// `agent.turn.interrupted`.
    Interrupted(Option<TurnEndCause>),
    /// `agent.turn.failed`.
    Failed(Option<TurnEndCause>),
}

impl TurnEnd {
    // The end's event on `run_id`, at the version `run` read.
    fn draft(
        self,
        run_id: RunId,
        run: &RunRead,
    ) -> Result<SessionEventDraft, SessionEventDraftError> {
        let session_id = run.session_id;
        let run_version = safe_run_version(run.version);
        let Self {
            turn_number,
            origin,
            outcome,
        } = self;
        let event = match outcome {
            TurnOutcome::Completed => SessionEvent::AgentTurnCompleted(AgentTurnCompletedPayload {
                session_id,
                run_id,
                run_version,
                turn_number,
            }),
            TurnOutcome::Interrupted(cause) => {
                SessionEvent::AgentTurnInterrupted(AgentTurnInterruptedPayload {
                    session_id,
                    run_id,
                    run_version,
                    turn_number,
                    origin,
                    cause,
                })
            }
            TurnOutcome::Failed(cause) => SessionEvent::AgentTurnFailed(AgentTurnFailedPayload {
                session_id,
                run_id,
                run_version,
                turn_number,
                origin,
                cause,
            }),
        };
        SessionEventDraft::of_session(session_id, &event)
    }
}

impl RunEngine {
    /// Opens a turn on the live run `run_id`, numbered its newest start plus one inside the write,
    /// a start that lost its number to another numbered again, and returns its number; `None` with
    /// nothing written once the run has ended. `step_bound` is the turn's effective `Max steps per
    /// turn`, which the caller resolves when the turn opens; on a run whose provider does not bound
    /// a turn's steps itself the engine counts them against it. Fails with
    /// `RunRefusal::NotFound` for an unknown run and with the append's failure; with a bound, also
    /// with [`RunEngineError::ProviderUnknown`] when no provider is known for the run and with
    /// [`RunEngineError::Provider`] when no registered driver answers its provider.
    #[expect(dead_code, reason = "the provider's event delivery")]
    pub(crate) async fn start_turn(
        &self,
        run_id: RunId,
        position: Option<SourcePosition>,
        step_bound: Option<SafeInt<1>>,
    ) -> Result<Option<SafeInt<1>>, RunEngineError> {
        let counted_bound = match step_bound {
            Some(bound) => {
                let provider = self.provider_of(run_id).await?;
                let descriptor = self
                    .providers
                    .descriptor(&provider)
                    .map_err(RunEngineError::Provider)?;
                (!descriptor.bounds_turn_steps).then_some(bound)
            }
            None => None,
        };
        self.wait_while_continuing(&run_id).await;
        let mut attempt = 1;
        let turn_number = loop {
            let run = self.require_run(run_id).await?;
            if run.state.is_terminal() {
                return Ok(None);
            }
            let turn_number = self.read_next_turn_number(run_id).await?;
            let draft = SessionEventDraft::of_session(
                run.session_id,
                &SessionEvent::AgentTurnStarted(AgentTurnStartedPayload {
                    session_id: run.session_id,
                    run_id,
                    run_version: safe_run_version(run.version),
                    turn_number,
                    position,
                }),
            )?;
            let transactional_prelude = vec![
                run_at_version_statement(&run_id, run.version),
                no_turn_start_from_statement(&run_id, turn_number),
            ];
            match self.append(draft, transactional_prelude, Vec::new()).await {
                Ok(_receipt) => break turn_number,
                Err(error)
                    if attempt < TURN_START_ATTEMPTS
                        && matches!(
                            refused_statement_index(&error),
                            Some(LIVE_APPEND_VERSION_GUARD_INDEX | TURN_START_GUARD_INDEX)
                        ) => {}
                Err(error) => return Err(error.into()),
            }
            attempt += 1;
        };
        let mut live = lock(&self.live);
        match counted_bound {
            Some(bound) => {
                live.step_counts.insert(
                    run_id,
                    StepCount {
                        turn_number,
                        bound,
                        steps: 0,
                        is_stopping: false,
                    },
                );
            }
            None => {
                live.step_counts.remove(&run_id);
            }
        }
        // The step limit's reached event lands once per turn, so a new turn's stop writes its own.
        live.reached_limits.remove(&(run_id, RunLimit::StepLimit));
        Ok(Some(turn_number))
    }

    /// Counts one step of the open turn on `run_id`, which the driver's delivery reports for a run
    /// whose provider does not bound a turn's steps; the step that reaches the turn's bound stops
    /// the run at the step limit. A run with no count armed is left as it is. Fails as the stop
    /// fails; a failed stop is tried again at the next step, the interrupt alone once the turn's
    /// reached event has landed.
    #[cfg_attr(not(test), expect(dead_code, reason = "the provider's event delivery"))]
    pub(crate) async fn count_step(&self, run_id: RunId) -> Result<(), RunEngineError> {
        let (turn_number, stop) = {
            let mut live = lock(&self.live);
            let Some(count) = live.step_counts.get_mut(&run_id) else {
                return Ok(());
            };
            if count.is_stopping {
                return Ok(());
            }
            count.steps += 1;
            if count.steps < count.bound.get() {
                return Ok(());
            }
            count.is_stopping = true;
            (count.turn_number, LimitStop::Step { count: count.bound })
        };
        let stopped = self.stop_at_limit(run_id, stop).await;
        if stopped.is_err()
            && let Some(count) = lock(&self.live)
                .step_counts
                .get_mut(&run_id)
                .filter(|count| count.turn_number == turn_number)
        {
            count.is_stopping = false;
        }
        stopped
    }

    /// Writes the end its provider reported for a turn of `run_id` that changes no run: a turn
    /// that ended beside a live run, or a late end after the run ended. Returns whether it was
    /// written; a duplicate of an end the turn holds is dropped. Fails with
    /// `RunRefusal::NotFound` for an unknown run and with the append's failure.
    #[cfg_attr(not(test), expect(dead_code, reason = "the provider's event delivery"))]
    pub(crate) async fn record_turn_end(
        &self,
        run_id: RunId,
        turn_end: ProviderTurnEnd,
    ) -> Result<bool, RunEngineError> {
        let run = self.require_run(run_id).await?;
        let turn_end = self.provider_turn_end(&run_id, turn_end);
        self.record_turn_end_alone(run_id, &run, turn_end).await
    }

    /// The end the log records for a turn end its provider reported: as reported, or interrupted
    /// with the limit where a limit stop cut that turn.
    pub(super) fn provider_turn_end(&self, run_id: &RunId, turn_end: ProviderTurnEnd) -> TurnEnd {
        let ProviderTurnEnd {
            turn_number,
            outcome,
        } = turn_end;
        let cut_by = lock(&self.live)
            .cut_turns
            .get(&(*run_id, turn_number))
            .copied();
        let outcome = match cut_by {
            Some(limit) => TurnOutcome::Interrupted(Some(limit_turn_cause(limit))),
            None => outcome,
        };
        TurnEnd {
            turn_number,
            origin: TurnEndOrigin::Provider,
            outcome,
        }
    }

    /// Writes `turn_end` on its own, guarded on the turn holding no end, and returns whether it
    /// was written; a duplicate is dropped. Fails with the append's failure.
    pub(super) async fn record_turn_end_alone(
        &self,
        run_id: RunId,
        run: &RunRead,
        turn_end: TurnEnd,
    ) -> Result<bool, RunEngineError> {
        let appended = self
            .append(
                turn_end.draft(run_id, run)?,
                vec![no_turn_end_statement(&run_id, turn_end.turn_number)],
                Vec::new(),
            )
            .await;
        let is_written = match appended {
            Ok(_receipt) => true,
            Err(error) if refused_statement_index(&error) == Some(LONE_TURN_END_GUARD_INDEX) => {
                false
            }
            Err(error) => return Err(error.into()),
        };
        self.forget_turn(&run_id, turn_end.turn_number);
        Ok(is_written)
    }

    /// Writes `change` with `companions` and, where it ends a turn, that turn's end as the event
    /// before the change's own, guarded on the turn holding no end. A turn that already holds its
    /// end drops this one and the change is written alone; a change the run refuses still ends
    /// its turn, written on its own before the refusal returns. Fails as [`RunEngine::transition`]
    /// does, a refusing companion numbered among `companions` alone.
    pub(super) async fn change_with_turn_end(
        &self,
        change: RunStateChange,
        companions: RunStateChangeCompanions,
        run: &RunRead,
        turn_end: Option<TurnEnd>,
    ) -> Result<RunRead, RunEngineError> {
        let Some(turn_end) = turn_end else {
            return self.change(change, companions).await;
        };
        let run_id = change.run_id;
        let mut with_end = companions.clone();
        with_end.statements.insert(
            TURN_END_GUARD_COMPANION_INDEX,
            no_turn_end_statement(&run_id, turn_end.turn_number),
        );
        // Drafted at each attempt, so a change retried on a run that moved carries the end at the
        // version it is written from.
        with_end.leading_event = Some(Arc::new(move |attempted: &RunRead| {
            turn_end.draft(run_id, attempted)
        }));
        match self.change(change.clone(), with_end).await {
            Ok(changed) => {
                self.forget_turn(&run_id, turn_end.turn_number);
                Ok(changed)
            }
            Err(RunEngineError::Change(RunStateChangeError::CompanionRefused {
                companion_index: TURN_END_GUARD_COMPANION_INDEX,
                ..
            })) => {
                // The turn holds its end already, so this one is a duplicate: the run's change
                // goes on alone.
                self.forget_turn(&run_id, turn_end.turn_number);
                self.change(change, companions).await
            }
            // One of the caller's own companions refused, numbered as the caller placed it: each
            // from the turn end's guard's place on sits one later in the write.
            Err(RunEngineError::Change(RunStateChangeError::CompanionRefused {
                companion_index,
                source,
            })) => Err(RunEngineError::Change(
                RunStateChangeError::CompanionRefused {
                    companion_index: companion_index
                        - usize::from(companion_index > TURN_END_GUARD_COMPANION_INDEX),
                    source,
                },
            )),
            Err(refused @ RunEngineError::Refused(_)) => {
                match self.record_turn_end_alone(run_id, run, turn_end).await {
                    Ok(_is_written) => Err(refused),
                    Err(error) => Err(with_cleanup_failures(
                        refused,
                        [Err(error)],
                        "refusing a run change and writing the end of the turn it ended",
                    )),
                }
            }
            Err(error) => Err(error),
        }
    }

    /// The number of the newest turn of `run_id` that holds no end, started at or before the run
    /// version `started_by` where one is given; `None` when no such turn is open. Fails when the
    /// read fails.
    pub(super) async fn read_open_turn(
        &self,
        run_id: RunId,
        started_by: Option<i64>,
    ) -> Result<Option<SafeInt<1>>, RunEngineError> {
        let open_turn: Option<i64> = self
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, RunEngineError>(
                    reader
                        .prepare_cached(&SELECT_OPEN_TURN_SQL)?
                        .query_row(
                            named_params! {
                                "@run_id": run_id.text().as_str(),
                                "@started_by": started_by,
                            },
                            |row| row.get(0),
                        )
                        .optional()?,
                )
            })
            .await?;
        Ok(open_turn.map(stored_turn_number))
    }

    // The number the run's next turn start takes: its newest start's plus one, or 1.
    async fn read_next_turn_number(&self, run_id: RunId) -> Result<SafeInt<1>, RunEngineError> {
        let newest: Option<i64> = self
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, RunEngineError>(
                    reader
                        .prepare_cached(&SELECT_NEWEST_TURN_START_SQL)?
                        .query_row(named_params! { "@run_id": run_id.text().as_str() }, |row| {
                            row.get(0)
                        })?,
                )
            })
            .await?;
        Ok(newest.map_or(FIRST_TURN_NUMBER, |newest| stored_turn_number(newest + 1)))
    }

    // What the engine held for a turn whose end is written or dropped.
    fn forget_turn(&self, run_id: &RunId, turn_number: SafeInt<1>) {
        self.forget_cut_turn(run_id, turn_number);
        let mut live = lock(&self.live);
        if live
            .step_counts
            .get(run_id)
            .is_some_and(|count| count.turn_number == turn_number)
        {
            live.step_counts.remove(run_id);
            live.reached_limits.remove(&(*run_id, RunLimit::StepLimit));
        }
    }

    /// Forgets the cut of `turn_number` on `run_id`, once its end is written or the stop did not
    /// cut it.
    pub(super) fn forget_cut_turn(&self, run_id: &RunId, turn_number: SafeInt<1>) {
        lock(&self.live).cut_turns.remove(&(*run_id, turn_number));
    }
}

// A turn number the log stored, which the engine wrote from a turn number.
fn stored_turn_number(stored: i64) -> SafeInt<1> {
    u64::try_from(stored)
        .ok()
        .and_then(SafeInt::new)
        .expect("a stored turn number counts up from 1 within the safe integers")
}

// Refuses a start numbered `turn_number` once a start holds it or a later number.
fn no_turn_start_from_statement(run_id: &RunId, turn_number: SafeInt<1>) -> WriteStatement {
    turn_guard(SELECT_TURN_START_FROM_SQL.as_str(), run_id, turn_number)
}

// Refuses an end of the turn once it holds one.
fn no_turn_end_statement(run_id: &RunId, turn_number: SafeInt<1>) -> WriteStatement {
    turn_guard(SELECT_TURN_END_SQL.as_str(), run_id, turn_number)
}

fn turn_guard(sql: &'static str, run_id: &RunId, turn_number: SafeInt<1>) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(sql),
        bindings: StatementBindings::Named(vec![
            text_binding("@run_id", run_id.text().as_str()),
            (
                Cow::Borrowed("@turn_number"),
                Value::Integer(i64::from(turn_number)),
            ),
        ]),
        expected_row_count: Some(0),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::Ordering;

    use serde_json::json;
    use sidekicks_contracts::event::session::SessionEvent;
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::run::intervention::RunLimit;
    use sidekicks_contracts::wire::integer::SafeInt;

    use super::{StepCount, no_turn_end_statement, no_turn_start_from_statement};
    use crate::database::writer::test_file::{TestDatabase, test_envelope, test_session_id};
    use crate::database::writer::{DatabaseWriter, DatabaseWriterOptions, WriteError};
    use crate::events::log_service::tests::open_log;
    use crate::events::session::insert::{SessionEventRow, monotonic_ns_now};
    use crate::session::run::engine::RunEngineError;
    use crate::session::run::engine::live::lock;
    use crate::session::run::engine::tests::{
        append, hand_limit_interrupter, insert_running_run, stored_events, stored_run_state,
        test_engine, turn_started_at,
    };
    use crate::session::run::state_change::RunStateChangeCompanions;
    use crate::uuid_v7::mint_uuid_v7;

    fn turn(number: u64) -> SafeInt<1> {
        SafeInt::new(number).expect("the test's turn numbers count from 1")
    }

    // Killed by the append not writing an event's turn number, which lets every guard pass on a
    // NULL column, by the start guard reading `=` for `>=`, which lets a start numbered below the
    // newest through, or by either guard spelling the category other than the stored word.
    #[tokio::test]
    async fn the_turn_guards_refuse_a_taken_number_and_a_second_end() {
        let database = TestDatabase::new();
        let writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
            .await
            .expect("the writer opens its database");
        let session_id = test_session_id();
        let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        let stored = |event: serde_json::Value| {
            let event: SessionEvent =
                serde_json::from_value(event).expect("the test writes a turn event");
            let envelope = test_envelope(session_id, &event);
            SessionEventRow {
                payload: serde_json::to_string(envelope.payload())
                    .expect("a JSON object serializes"),
                envelope: Arc::new(envelope),
                monotonic_ns: monotonic_ns_now(),
                content_payload: None,
            }
        };
        // Turn 1 started and completed, turn 3 started and open; no start holds 2.
        let turn_event = |event_type: &str, turn_number: u64| {
            stored(json!({
                "type": event_type,
                "payload": {
                    "sessionId": session_id,
                    "runId": run_id,
                    "runVersion": 2,
                    "turnNumber": turn_number,
                },
            }))
        };
        writer
            .append_events(
                vec![
                    turn_event("agent.turn.started", 1),
                    turn_event("agent.turn.completed", 1),
                    turn_event("agent.turn.started", 3),
                ],
                Vec::new(),
            )
            .await
            .expect("the turn rows are appended");

        for (guard, is_refused) in [
            (no_turn_start_from_statement(&run_id, turn(2)), true),
            (no_turn_start_from_statement(&run_id, turn(4)), false),
            (no_turn_end_statement(&run_id, turn(1)), true),
            (no_turn_end_statement(&run_id, turn(3)), false),
        ] {
            let written = writer.write(vec![guard]).await;
            assert_eq!(
                matches!(
                    written,
                    Err(WriteError::Refused {
                        statement_index: 0,
                        ..
                    })
                ),
                is_refused,
                "the guard answers {written:?}"
            );
        }
    }

    // Killed by a limit stop reading the run or writing before it finds the interventions service
    // gone, and by a failed stop leaving the count stopping, so the next step reaches no stop.
    #[tokio::test]
    async fn a_limit_stop_with_no_interventions_service_writes_nothing_and_is_tried_again() {
        let database = TestDatabase::new();
        let log = open_log(&database, None).await;
        let home = tempfile::tempdir().expect("the test makes a home folder");
        let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        let engine = test_engine(&database, log.service, home.path());

        let spend_stop = engine.stop_at_spend_limit(run_id).await;
        assert!(
            matches!(spend_stop, Err(RunEngineError::LimitInterrupterGone { .. })),
            "the spend stop answers {spend_stop:?}"
        );

        lock(&engine.live).step_counts.insert(
            run_id,
            StepCount {
                turn_number: turn(1),
                bound: turn(1),
                steps: 0,
                is_stopping: false,
            },
        );
        for step in 1..=2 {
            let counted = engine.count_step(run_id).await;
            assert!(
                matches!(counted, Err(RunEngineError::LimitInterrupterGone { .. })),
                "step {step} answers {counted:?}"
            );
        }
        assert!(stored_events(&database, &run_id).is_empty());
    }

    // Killed by a step stop retried after its interrupt failed writing the reached event again,
    // and by the failed interrupt leaving the count stopping, so the next step sends none.
    #[tokio::test]
    async fn a_step_stop_retried_after_a_failed_interrupt_writes_one_reached_event() {
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
        lock(&engine.live).step_counts.insert(
            run_id,
            StepCount {
                turn_number: turn(1),
                bound: turn(1),
                steps: 0,
                is_stopping: false,
            },
        );

        let refused = engine.count_step(run_id).await;
        assert!(
            matches!(refused, Err(RunEngineError::LimitInterrupt { .. })),
            "the first stop answers {refused:?}"
        );
        engine
            .count_step(run_id)
            .await
            .expect("the retried stop's interrupt is accepted");
        assert_eq!(interventions.calls.load(Ordering::SeqCst), 2);
        // The interventions service ends the run with the limit it accepted at version 1.
        let ended = engine
            .end_run_for_interrupt(
                run_id,
                1,
                Some(RunLimit::StepLimit),
                RunStateChangeCompanions::default(),
            )
            .await
            .expect("the run ends at its limit");

        assert!(ended);
        assert_eq!(
            stored_events(&database, &run_id),
            [
                ("agent.turn.started".to_owned(), None, None),
                ("agent.run.stepLimit.reached".to_owned(), None, None),
                (
                    "agent.turn.interrupted".to_owned(),
                    Some("stepLimit".to_owned()),
                    Some("daemon".to_owned())
                ),
                ("agent.run.interrupted".to_owned(), None, None),
            ]
        );
        assert_eq!(
            stored_run_state(&database, &run_id),
            ("interrupted".to_owned(), 2)
        );
    }
}
