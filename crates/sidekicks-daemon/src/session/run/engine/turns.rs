//! A run's turns: each start numbered its run's newest start plus one inside its write, each end
//! written once, riding the run change it ends with or on its own, and the steps of a turn counted
//! against its step bound.

use std::borrow::Cow;
use std::error::Error;
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
use sidekicks_contracts::transcript::turn_attribution::TURN_END_EVENT_TYPES;
use sidekicks_contracts::wire::integer::SafeInt;

use crate::database::connection::read_pool::ReadLength;
use crate::database::sql_list::sql_list_of;
use crate::database::statement::{StatementBindings, WriteStatement, text_binding};
use crate::database::stored_column::safe_int_column;
use crate::events::session::appender::{SessionEventDraft, SessionEventDraftError};
use crate::interventions::store::run_at_version_statement;
use crate::session::run::engine::limits::LimitStop;
use crate::session::run::engine::live::{LiveRuns, lock};
use crate::session::run::engine::{
    LIVE_APPEND_VERSION_GUARD_INDEX, RunEngine, RunEngineError, refused_statement_index,
    safe_run_version, with_cleanup_failures,
};
use crate::session::run::read::RunRead;
use crate::session::run::restart::{TurnCut, limit_turn_cause, read_turn_cuts};
use crate::session::run::state_change::{
    RunStateChange, RunStateChangeCompanions, RunStateChangeError,
};
use crate::session::run::transitions::RUN_TERMINAL_STATES_SQL;

// The position among a run change's companions of the guard that the turn it ends has no end yet:
// the turn's end rides first, so its guard leads the companions.
const TURN_END_GUARD_COMPANION_INDEX: usize = 0;

// A lone turn end's guard is the first statement of its write, before any guard on its run.
const LONE_TURN_END_GUARD_INDEX: usize = 0;

// A turn start's guard that no start holds its number yet follows the version guard.
const TURN_START_GUARD_INDEX: usize = 1;

// Reads of a run's newest turn start before a start that keeps losing its number to another, or
// whose run keeps moving under it, gives up.
const TURN_START_ATTEMPTS: usize = 3;

// The number the run's next turn start takes, its newest start's plus one or 1, by the event's own
// run columns.
static SELECT_NEXT_TURN_NUMBER_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT COALESCE(MAX(turn_number), 0) + 1 FROM session_events
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

/// The three turn ends as an SQL list, in the order the unique index on turn ends spells them.
pub(crate) static TURN_END_TYPES_SQL: LazyLock<String> =
    LazyLock::new(|| sql_list_of(TURN_END_EVENT_TYPES));

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

// The run's newest started turn that holds no end.
static SELECT_OPEN_TURN_SQL: LazyLock<String> =
    LazyLock::new(|| open_turns_sql("@run_id", "ORDER BY started.turn_number DESC\n  LIMIT 1"));

// Every started turn of the run that holds no end, oldest first.
static SELECT_OPEN_TURNS_SQL: LazyLock<String> =
    LazyLock::new(|| open_turns_sql("@run_id", "ORDER BY started.turn_number"));

// Matches the run while it has not ended or a turn of it holds no end yet.
static RUN_LIVE_OR_TURN_OPEN_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT 1 FROM runs WHERE run_id = @run_id
  AND (state NOT IN ({}) OR EXISTS ({}))",
        *RUN_TERMINAL_STATES_SQL,
        open_turns_sql("@run_id", "LIMIT 1")
    )
});

/// A turn's end its provider's end frame reported.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ProviderTurnEnd {
    /// The turn's number within its run, as its start was numbered.
    pub(crate) turn_number: SafeInt<1>,
    /// How it ended, with the cause the delivery knows from the frame; a limit stop's cut of the
    /// turn replaces it.
    pub(crate) outcome: TurnOutcome,
}

/// The steps of a run's open turn, counted against its step bound, and whether the turn has
/// reached its step limit: its reached event being written or landed, or the limit's interrupt
/// handed on it.
pub(super) struct StepCount {
    turn_number: SafeInt<1>,
    bound: SafeInt<1>,
    steps: u64,
    is_reached: bool,
}

impl StepCount {
    /// The count of `turn_number` at its start, bounded at `bound` steps.
    pub(super) fn new(turn_number: SafeInt<1>, bound: SafeInt<1>) -> Self {
        Self {
            turn_number,
            bound,
            steps: 0,
            is_reached: false,
        }
    }
}

/// A write the engine made for a provider's report, or nothing where the owed limits alone were
/// handed, with the failure of the limit interrupts it then handed again, which the caller logs
/// and goes on from: the next step, usage report, turn end, return from a wait or restart hands
/// that interrupt once more.
#[derive(Debug)]
#[must_use = "a failed resend is logged"]
pub(crate) struct WriteWithResend<Written> {
    /// What was written.
    pub(crate) written: Written,
    /// Why a limit's interrupt handed again failed, where it did.
    pub(crate) resend_failure: Option<RunEngineError>,
}

impl<Written> WriteWithResend<Written> {
    /// What was written, the failure of the interrupts handed again logged for the next hand.
    pub(crate) fn log_resend_failure(self, run_id: RunId) -> Written {
        if let Some(error) = &self.resend_failure {
            tracing::warn!(
                run_id = %run_id,
                error = error as &(dyn Error + 'static),
                "a limit's interrupt handed again failed"
            );
        }
        self.written
    }
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
    #[cfg_attr(not(test), expect(dead_code, reason = "the provider's event delivery"))]
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
    /// turn`, which the caller resolves when the turn opens; the engine counts the turn's steps
    /// against it, whatever the provider. Fails with `RunRefusal::NotFound` for an unknown run and
    /// with the append's failure.
    #[expect(dead_code, reason = "the provider's event delivery")]
    pub(crate) async fn start_turn(
        &self,
        run_id: RunId,
        position: Option<SourcePosition>,
        step_bound: Option<SafeInt<1>>,
    ) -> Result<Option<SafeInt<1>>, RunEngineError> {
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
        match step_bound {
            Some(bound) => {
                live.step_counts
                    .insert(run_id, StepCount::new(turn_number, bound));
            }
            None => {
                live.step_counts.remove(&run_id);
            }
        }
        Ok(Some(turn_number))
    }

    /// Counts one step of the open turn on `run_id`, which the driver's delivery reports, whatever
    /// the provider: the step that reaches the turn's bound writes the turn's step limit reached
    /// event and stops the run at the step limit, and while that stop's interrupt is not yet
    /// handed, a later step of any turn hands it again unless a hand of it is in flight or it is
    /// pending. A run with no count armed is left as it is. Fails as the stop fails; a failed stop
    /// is tried again at the next step or turn end, the interrupt alone once the turn's reached
    /// event has landed.
    #[cfg_attr(not(test), expect(dead_code, reason = "the provider's event delivery"))]
    pub(crate) async fn count_step(self: &Arc<Self>, run_id: RunId) -> Result<(), RunEngineError> {
        let stop = {
            let mut live = lock(&self.live);
            let Some(count) = live.step_counts.get_mut(&run_id) else {
                return Ok(());
            };
            count.steps += 1;
            let reaching_turn = (count.steps >= count.bound.get() && !count.is_reached)
                .then_some((count.bound, count.turn_number));
            // Marked as the reach is decided, so a step delivered beside this one reaches no stop
            // of its own; the stop clears it where its reached event does not land.
            if reaching_turn.is_some() {
                count.is_reached = true;
            }
            match reaching_turn {
                Some((bound, turn_number)) => LimitStop::Step {
                    count: bound,
                    turn_number,
                },
                None if live.reached_limits.contains(&(run_id, RunLimit::StepLimit)) => {
                    LimitStop::Interrupt {
                        limit: RunLimit::StepLimit,
                    }
                }
                None => return Ok(()),
            }
        };
        self.stop_at_limit(run_id, stop).await
    }

    /// Writes the end its provider reported for a turn of `run_id` that changes no run (one beside
    /// a live run, or a late end on an ended run, whose cut the log's rows give where the engine
    /// holds none), answering whether it was written, a duplicate dropped; a live run's turn ended
    /// any other way than interrupted then expires each interrupt left on the run with no outcome,
    /// which did not take. It then hands again a step limit's interrupt a stop could not hand,
    /// that failure returned beside. Fails with
    /// `RunRefusal::NotFound` for an unknown run and with the read's or the append's failure.
    #[cfg_attr(not(test), expect(dead_code, reason = "the provider's event delivery"))]
    pub(crate) async fn record_turn_end(
        self: &Arc<Self>,
        run_id: RunId,
        turn_end: ProviderTurnEnd,
    ) -> Result<WriteWithResend<bool>, RunEngineError> {
        let run = self.require_run(run_id).await?;
        // A turn of a live run its provider ended any other way than interrupted shows that an
        // interrupt left with no outcome did not take.
        let is_live_turn_uninterrupted =
            !run.state.is_terminal() && !matches!(turn_end.outcome, TurnOutcome::Interrupted(_));
        let turn_end = if run.state.is_terminal() {
            let ProviderTurnEnd {
                turn_number,
                outcome,
            } = turn_end;
            TurnEnd {
                turn_number,
                origin: TurnEndOrigin::Provider,
                outcome: self
                    .cut_outcome_of_ended_run(run_id, turn_number, outcome)
                    .await?,
            }
        } else {
            self.provider_turn_end(&run_id, turn_end)
        };
        let is_written = self
            .record_turn_end_alone(run_id, &run, turn_end, false)
            .await?;
        if is_written && is_live_turn_uninterrupted {
            self.settle_after_uninterrupted_turn_end(run_id).await?;
        }
        Ok(WriteWithResend {
            written: is_written,
            resend_failure: self.hand_owed_step_interrupt(run_id).await.err(),
        })
    }

    /// Hands the interventions service again the step limit's interrupt of `run_id` that a stop
    /// wrote the reached event of and could not hand: the run's newest open turn is cut with the
    /// limit, and the run rests at the step limit. A run that owes no such interrupt, or whose
    /// interrupt another hand has in flight, is left as it is; one whose step limit's interrupt is
    /// still pending owes it no more. Fails as the stop at the limit fails, the interrupt still
    /// owed.
    pub(super) async fn hand_owed_step_interrupt(
        self: &Arc<Self>,
        run_id: RunId,
    ) -> Result<(), RunEngineError> {
        if !lock(&self.live)
            .reached_limits
            .contains(&(run_id, RunLimit::StepLimit))
        {
            return Ok(());
        }
        self.stop_at_limit(
            run_id,
            LimitStop::Interrupt {
                limit: RunLimit::StepLimit,
            },
        )
        .await
    }

    /// The end the log records for a turn end its provider reported on a run that reads live: as
    /// reported, or interrupted with the limit where the engine holds a limit stop's cut of it.
    pub(super) fn provider_turn_end(&self, run_id: &RunId, turn_end: ProviderTurnEnd) -> TurnEnd {
        let ProviderTurnEnd {
            turn_number,
            outcome,
        } = turn_end;
        let held_limit = lock(&self.live).current_limit(&(*run_id, turn_number));
        TurnEnd {
            turn_number,
            origin: TurnEndOrigin::Provider,
            outcome: cut_outcome(held_limit, turn_number, &[], outcome),
        }
    }

    /// The end the daemon writes for `turn_number` of `run_id` with no provider frame: `outcome`,
    /// or interrupted with the limit of its cut, the engine's own first, then one in `turn_cuts`,
    /// the cuts the log's rows mark.
    pub(super) fn daemon_turn_end(
        &self,
        run_id: &RunId,
        turn_number: SafeInt<1>,
        turn_cuts: &[TurnCut],
        outcome: TurnOutcome,
    ) -> TurnEnd {
        let held_limit = lock(&self.live).current_limit(&(*run_id, turn_number));
        TurnEnd {
            turn_number,
            origin: TurnEndOrigin::Daemon,
            outcome: cut_outcome(held_limit, turn_number, turn_cuts, outcome),
        }
    }

    /// How `turn_number` of `run_id` ends once its run reads ended or this end ends it:
    /// interrupted with the limit of the engine's cut of it, else of the cut the log's rows mark,
    /// else `outcome`; the log is read only where the engine holds no cut, as after a restart.
    /// Fails as the read fails.
    pub(super) async fn cut_outcome_of_ended_run(
        &self,
        run_id: RunId,
        turn_number: SafeInt<1>,
        outcome: TurnOutcome,
    ) -> Result<TurnOutcome, RunEngineError> {
        let held_limit = lock(&self.live).current_limit(&(run_id, turn_number));
        let turn_cuts = match held_limit {
            Some(_) => Vec::new(),
            None => self.read_run_turn_cuts(run_id).await?,
        };
        Ok(cut_outcome(held_limit, turn_number, &turn_cuts, outcome))
    }

    /// Every open turn of `run_id` a limit's intervention row marks as cut, oldest first. Fails
    /// when the read fails or a stored turn number or limit is not one.
    pub(super) async fn read_run_turn_cuts(
        &self,
        run_id: RunId,
    ) -> Result<Vec<TurnCut>, RunEngineError> {
        self.pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, RunEngineError>(read_turn_cuts(reader, &run_id)?)
            })
            .await
    }

    /// Ends every turn in `open_turns`, oldest first, as [`RunEngine::daemon_turn_end`] reports it
    /// with `turn_cuts` and `uncut_end`: each older one written on its own, held to the run's
    /// version where `is_run_version_held`, and the newest returned for the caller to write. Fails
    /// with the first write that fails, the ends before it kept.
    pub(super) async fn end_open_turns(
        &self,
        run_id: RunId,
        run: &RunRead,
        open_turns: &[SafeInt<1>],
        turn_cuts: &[TurnCut],
        uncut_end: TurnOutcome,
        is_run_version_held: bool,
    ) -> Result<Option<TurnEnd>, RunEngineError> {
        let Some((&newest_turn, older_turns)) = open_turns.split_last() else {
            return Ok(None);
        };
        for &turn_number in older_turns {
            let turn_end = self.daemon_turn_end(&run_id, turn_number, turn_cuts, uncut_end);
            self.record_turn_end_alone(run_id, run, turn_end, is_run_version_held)
                .await?;
        }
        Ok(Some(self.daemon_turn_end(
            &run_id,
            newest_turn,
            turn_cuts,
            uncut_end,
        )))
    }

    /// Writes `turn_end` on its own, guarded on the turn holding no end and, where
    /// `is_run_version_held`, on the run still at the version `run` read, and returns whether it
    /// was written; a duplicate is dropped. Fails with the append's failure, a run moved since
    /// among them.
    pub(super) async fn record_turn_end_alone(
        &self,
        run_id: RunId,
        run: &RunRead,
        turn_end: TurnEnd,
        is_run_version_held: bool,
    ) -> Result<bool, RunEngineError> {
        let mut guards = vec![no_turn_end_statement(&run_id, turn_end.turn_number)];
        if is_run_version_held {
            guards.push(run_at_version_statement(&run_id, run.version));
        }
        let appended = self
            .append(turn_end.draft(run_id, run)?, guards, Vec::new())
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
                match self
                    .record_turn_end_alone(run_id, run, turn_end, false)
                    .await
                {
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

    /// The number of the newest turn of `run_id` that holds no end; `None` when none is open.
    /// Fails when the read fails or a stored turn number is not one.
    pub(super) async fn read_open_turn(
        &self,
        run_id: RunId,
    ) -> Result<Option<SafeInt<1>>, RunEngineError> {
        self.pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, RunEngineError>(
                    reader
                        .prepare_cached(&SELECT_OPEN_TURN_SQL)?
                        .query_row(named_params! { "@run_id": run_id.text().as_str() }, |row| {
                            safe_int_column(row, 0)
                        })
                        .optional()?,
                )
            })
            .await
    }

    /// The numbers of every turn of `run_id` that holds no end, oldest first. Fails when the read
    /// fails or a stored turn number is not one.
    pub(super) async fn read_open_turns(
        &self,
        run_id: RunId,
    ) -> Result<Vec<SafeInt<1>>, RunEngineError> {
        self.pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, RunEngineError>(
                    reader
                        .prepare_cached(&SELECT_OPEN_TURNS_SQL)?
                        .query_map(named_params! { "@run_id": run_id.text().as_str() }, |row| {
                            safe_int_column(row, 0)
                        })?
                        .collect::<Result<_, _>>()?,
                )
            })
            .await
    }

    // The number the run's next turn start takes: its newest start's plus one, or 1.
    async fn read_next_turn_number(&self, run_id: RunId) -> Result<SafeInt<1>, RunEngineError> {
        self.pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, RunEngineError>(
                    reader
                        .prepare_cached(&SELECT_NEXT_TURN_NUMBER_SQL)?
                        .query_row(named_params! { "@run_id": run_id.text().as_str() }, |row| {
                            safe_int_column(row, 0)
                        })?,
                )
            })
            .await
    }

    // What the engine held for a turn whose end is written or dropped. A step limit's interrupt
    // its stop could not hand stays owed by the run.
    fn forget_turn(&self, run_id: &RunId, turn_number: SafeInt<1>) {
        self.forget_cut_turn(run_id, turn_number);
        let mut live = lock(&self.live);
        if live
            .step_counts
            .get(run_id)
            .is_some_and(|count| count.turn_number == turn_number)
        {
            live.step_counts.remove(run_id);
        }
    }

    /// Forgets every cut of `turn_number` on `run_id`, once its end is written.
    pub(super) fn forget_cut_turn(&self, run_id: &RunId, turn_number: SafeInt<1>) {
        lock(&self.live).cut_turns.remove(&(*run_id, turn_number));
    }
}

/// Sets whether the count of `turn_number` on `run_id` in `live` has reached its step limit: set
/// once the limit's interrupt is handed on it, so it reaches no stop of its own, and cleared where
/// its own reach wrote nothing, so a later step reaches it again. A count since armed for another
/// turn is left as it is.
pub(super) fn set_step_limit_reached(
    live: &mut LiveRuns,
    run_id: &RunId,
    turn_number: SafeInt<1>,
    is_reached: bool,
) {
    if let Some(count) = live
        .step_counts
        .get_mut(run_id)
        .filter(|count| count.turn_number == turn_number)
    {
        count.is_reached = is_reached;
    }
}

// How `turn_number` ends: interrupted with `held_limit`, the higher-ranked limit of the engine's
// cuts of it, else with the limit of its cut in `turn_cuts`, else `outcome`.
fn cut_outcome(
    held_limit: Option<RunLimit>,
    turn_number: SafeInt<1>,
    turn_cuts: &[TurnCut],
    outcome: TurnOutcome,
) -> TurnOutcome {
    let cut_limit = held_limit.or_else(|| {
        turn_cuts
            .iter()
            .find(|cut| cut.turn_number == turn_number)
            .map(|cut| cut.limit)
    });
    match cut_limit {
        Some(limit) => TurnOutcome::Interrupted(Some(limit_turn_cause(limit))),
        None => outcome,
    }
}

/// Holds when the turn start the enclosing query reads as `started` has no end, spelled in the
/// order the turn ends' unique index is declared so the probe reads that index.
pub(crate) fn turn_holds_no_end_sql() -> String {
    format!(
        "NOT EXISTS (
      SELECT 1 FROM session_events AS ended
       WHERE ended.category = '{}'
         AND ended.type IN ({})
         AND ended.run_id = started.run_id
         AND ended.turn_number = started.turn_number)",
        EventCategory::RunLifecycle.as_str(),
        *TURN_END_TYPES_SQL
    )
}

/// The started turns that hold no end of the run the SQL expression `run_id` names (a parameter
/// or a column of an outer query), ordered and bounded by `tail`.
pub(crate) fn open_turns_sql(run_id: &str, tail: &str) -> String {
    format!(
        "SELECT started.turn_number FROM session_events AS started
  WHERE started.category = '{}'
    AND started.type = '{}'
    AND started.run_id = {run_id}
    AND {}
  {tail}",
        EventCategory::RunLifecycle.as_str(),
        SessionEventType::AgentTurnStarted.as_str(),
        turn_holds_no_end_sql()
    )
}

/// Holds only while `run_id` has not ended or a turn of it is still open, so a piece of its reply
/// or reasoning is taken until the provider ends the turn it belongs to, even past the run's end.
pub(crate) fn run_live_or_turn_open_statement(run_id: &RunId) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(RUN_LIVE_OR_TURN_OPEN_SQL.as_str()),
        bindings: StatementBindings::Named(vec![text_binding("@run_id", run_id.text().as_str())]),
        expected_row_count: Some(1),
    }
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
