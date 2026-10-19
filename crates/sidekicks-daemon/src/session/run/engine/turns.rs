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
static SELECT_OPEN_TURN_SQL: LazyLock<String> =
    LazyLock::new(|| open_turns_sql("ORDER BY started.turn_number DESC\n  LIMIT 1"));

// Every started turn of the run that holds no end, oldest first.
static SELECT_OPEN_TURNS_SQL: LazyLock<String> =
    LazyLock::new(|| open_turns_sql("ORDER BY started.turn_number"));

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
    /// fails; a failed stop is tried again at the next step or at the turn's end, the interrupt
    /// alone once the turn's reached event has landed.
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
    /// written; a duplicate of an end the turn holds is dropped. The end of a turn a step stop cut
    /// whose interrupt failed hands that interrupt over again. Fails with `RunRefusal::NotFound`
    /// for an unknown run, with the append's failure and as that interrupt fails.
    #[cfg_attr(not(test), expect(dead_code, reason = "the provider's event delivery"))]
    pub(crate) async fn record_turn_end(
        &self,
        run_id: RunId,
        turn_end: ProviderTurnEnd,
    ) -> Result<bool, RunEngineError> {
        let run = self.require_run(run_id).await?;
        let is_interrupt_owed = self.is_step_interrupt_owed(&run_id, turn_end.turn_number);
        let turn_end = self.provider_turn_end(&run_id, turn_end);
        let is_written = self.record_turn_end_alone(run_id, &run, turn_end).await?;
        if is_interrupt_owed {
            self.hand_owed_step_interrupt(run_id).await?;
        }
        Ok(is_written)
    }

    /// Whether the step limit's interrupt of `run_id` is owed once `turn_number` ends: its stop
    /// wrote that turn's reached event, its interrupt failed, and no stop is in flight.
    pub(super) fn is_step_interrupt_owed(&self, run_id: &RunId, turn_number: SafeInt<1>) -> bool {
        let live = lock(&self.live);
        live.reached_limits
            .contains(&(*run_id, RunLimit::StepLimit))
            && live
                .step_counts
                .get(run_id)
                .is_some_and(|count| count.turn_number == turn_number && !count.is_stopping)
    }

    /// Hands the interventions service the step limit's interrupt that a cut turn's end left owed,
    /// so the run rests at the step limit. Fails as the interrupt fails.
    pub(super) async fn hand_owed_step_interrupt(
        &self,
        run_id: RunId,
    ) -> Result<(), RunEngineError> {
        self.live_limit_interrupter(run_id)?
            .interrupt_for_limit(run_id, RunLimit::StepLimit)
            .await
            .map_err(|source| RunEngineError::LimitInterrupt { run_id, source })
    }

    /// The end the log records for a turn end its provider reported: as reported, or interrupted
    /// with the limit where a limit stop cut that turn.
    pub(super) fn provider_turn_end(&self, run_id: &RunId, turn_end: ProviderTurnEnd) -> TurnEnd {
        let ProviderTurnEnd {
            turn_number,
            outcome,
        } = turn_end;
        TurnEnd {
            turn_number,
            origin: TurnEndOrigin::Provider,
            outcome: self.cut_outcome(run_id, turn_number, outcome),
        }
    }

    /// The end the daemon writes for `turn_number` of `run_id` with no provider frame: `outcome`,
    /// or interrupted with the limit where a limit stop cut that turn.
    pub(super) fn daemon_turn_end(
        &self,
        run_id: &RunId,
        turn_number: SafeInt<1>,
        outcome: TurnOutcome,
    ) -> TurnEnd {
        TurnEnd {
            turn_number,
            origin: TurnEndOrigin::Daemon,
            outcome: self.cut_outcome(run_id, turn_number, outcome),
        }
    }

    // How `turn_number` of `run_id` ends: interrupted with the limit of a stop that cut it, else
    // `outcome`.
    fn cut_outcome(
        &self,
        run_id: &RunId,
        turn_number: SafeInt<1>,
        outcome: TurnOutcome,
    ) -> TurnOutcome {
        match lock(&self.live).cut_turns.get(&(*run_id, turn_number)) {
            Some(cut) => TurnOutcome::Interrupted(Some(limit_turn_cause(cut.limit))),
            None => outcome,
        }
    }

    /// Ends every turn in `open_turns`, oldest first, each with the outcome `outcome_of` gives its
    /// number as [`RunEngine::daemon_turn_end`] reports it: each older one written on its own, and
    /// the newest returned for the run's end to carry in its own write. Fails with the first write
    /// that fails, the ends before it kept.
    pub(super) async fn end_open_turns(
        &self,
        run_id: RunId,
        run: &RunRead,
        open_turns: &[SafeInt<1>],
        outcome_of: impl Fn(SafeInt<1>) -> TurnOutcome,
    ) -> Result<Option<TurnEnd>, RunEngineError> {
        let Some((&newest_turn, older_turns)) = open_turns.split_last() else {
            return Ok(None);
        };
        for &turn_number in older_turns {
            let turn_end = self.daemon_turn_end(&run_id, turn_number, outcome_of(turn_number));
            self.record_turn_end_alone(run_id, run, turn_end).await?;
        }
        Ok(Some(self.daemon_turn_end(
            &run_id,
            newest_turn,
            outcome_of(newest_turn),
        )))
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

    /// The numbers of every turn of `run_id` that holds no end, oldest first. Fails when the read
    /// fails.
    pub(super) async fn read_open_turns(
        &self,
        run_id: RunId,
    ) -> Result<Vec<SafeInt<1>>, RunEngineError> {
        let open_turns: Vec<i64> = self
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, RunEngineError>(
                    reader
                        .prepare_cached(&SELECT_OPEN_TURNS_SQL)?
                        .query_map(
                            named_params! {
                                "@run_id": run_id.text().as_str(),
                                "@started_by": None::<i64>,
                            },
                            |row| row.get(0),
                        )?
                        .collect::<Result<_, _>>()?,
                )
            })
            .await?;
        Ok(open_turns.into_iter().map(stored_turn_number).collect())
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

// The run's started turns that hold no end, started at or before `@started_by` where one is bound,
// ordered and bounded by `tail`.
fn open_turns_sql(tail: &str) -> String {
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
  {tail}",
        SessionEventType::AgentTurnStarted.as_str(),
        *TURN_END_TYPES_SQL
    )
}

/// A turn number the log stored, which the engine wrote from a turn number; one that is not
/// breaks that invariant and panics.
pub(crate) fn stored_turn_number(stored: i64) -> SafeInt<1> {
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
mod tests;
