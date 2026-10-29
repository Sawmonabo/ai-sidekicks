//! A live run a restart's resume found again: re-armed from its log before the resume, so the
//! engine holds its open turn's step count, the limit it owes and its turns' cuts as it held them
//! before the restart; and finalized after the resume from its state before the restart and what
//! its provider holds of its turn.

use std::sync::{Arc, LazyLock};

use rusqlite::{Connection, OptionalExtension as _, named_params};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_provider::driver::session_control::ProviderTurnAnswer;
use sidekicks_provider::run::state_entry::RunStateEntry;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::connection::read_pool::ReadLength;
use sidekicks_store::database::stored_column::safe_int_column;
use sidekicks_store::events::session::append_lock::SessionAppendHold;

use crate::console_state::read_session_max_steps_per_turn;
use crate::run::engine::settle::daemon_restart_outcome;
use crate::run::engine::turns::{StepCount, turn_holds_no_end_sql};
use crate::run::engine::{RunEngine, RunEngineError};
use crate::run::read::{LiveRun, RunRead};
use crate::run::refusals::RunRefusal;
use crate::run::restart::{
    RestartTurnEnd, ResumedRunMove, decide_resumed_move, decide_turn_gone_settlement,
    read_owed_limit, read_turn_cuts,
};
use crate::run::state_change::{RunStateChange, RunStateChangeCompanions};

// The run's newest open turn, with the tool calls of the run that ended after its start, each a
// step, and whether the step limit was reached after its start. A step is counted at its tool
// call's end, so a call still running at the restart is counted once, when it ends.
static SELECT_OPEN_TURN_STEPS_SQL: LazyLock<String> = LazyLock::new(|| {
    let started = SessionEventType::AgentTurnStarted;
    let completed = SessionEventType::AgentToolCallCompleted;
    let failed = SessionEventType::AgentToolCallFailed;
    let reached = SessionEventType::AgentRunStepLimitReached;
    format!(
        "SELECT started.turn_number,
    (SELECT COUNT(*) FROM session_events AS step
      WHERE step.run_id = started.run_id
        AND step.sequence > started.sequence
        AND ((step.category = '{completed_category}' AND step.type = '{completed}')
          OR (step.category = '{failed_category}' AND step.type = '{failed}'))),
    EXISTS (SELECT 1 FROM session_events AS reached
      WHERE reached.run_id = started.run_id
        AND reached.sequence > started.sequence
        AND reached.category = '{reached_category}'
        AND reached.type = '{reached}')
  FROM session_events AS started
  WHERE started.category = '{started_category}'
    AND started.type = '{started}'
    AND started.run_id = @run_id
    AND {no_end}
  ORDER BY started.turn_number DESC
  LIMIT 1",
        completed = completed.as_str(),
        completed_category = completed.category().as_str(),
        failed = failed.as_str(),
        failed_category = failed.category().as_str(),
        reached = reached.as_str(),
        reached_category = reached.category().as_str(),
        started = started.as_str(),
        started_category = started.category().as_str(),
        no_end = turn_holds_no_end_sql(),
    )
});

// The newest open turn of a run as its log shows it: its steps since its start, and whether its
// step limit was reached.
struct OpenTurnSteps {
    turn_number: SafeInt<1>,
    steps: u64,
    is_step_limit_reached: bool,
}

impl RunEngine {
    /// Re-arms `run`, a live run a restart left, from its log before its conversation is resumed,
    /// as the engine held it before the restart: its newest open turn's step count rebuilt from
    /// the steps since the turn's start against the session's step bound, the limit its log still
    /// owes held to be handed again once its provider runs, and each open turn a limit's interrupt
    /// row names cut with that limit. A turn the engine holds a cut of already keeps it. Fails as
    /// the read fails or a stored turn number, count or limit does not read as its type.
    pub async fn rearm_after_restart(&self, run: &LiveRun) -> Result<(), RunEngineError> {
        let run_id = run.run_id;
        let session_id = run.run.session_id;
        let (open_turn, step_bound, turn_cuts, owed_limit) = self
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, RunEngineError>((
                    read_open_turn_steps(reader, &run_id)?,
                    read_session_max_steps_per_turn(reader, &session_id)?,
                    read_turn_cuts(reader, &run_id)?,
                    read_owed_limit(reader, &run_id)?,
                ))
            })
            .await?;
        let mut live = lock(&self.live);
        if let (Some(open_turn), Some(bound)) = (open_turn, step_bound) {
            live.step_counts.insert(
                run_id,
                StepCount::counted(
                    open_turn.turn_number,
                    bound,
                    open_turn.steps,
                    open_turn.is_step_limit_reached,
                ),
            );
        }
        for turn_cut in turn_cuts {
            let cut = live.new_cut(turn_cut.limit);
            live.cut_turns
                .entry((run_id, turn_cut.turn_number))
                .or_insert_with(|| vec![cut]);
        }
        if let Some(limit) = owed_limit {
            live.reached_limits.insert((run_id, limit));
        }
        Ok(())
    }

    /// Finalizes `run`, a live run as read after a resume that succeeded, from `state_before`,
    /// its state before the restart, and `answer`, what its provider holds of its turn, as
    /// `decide_resumed_move` decides, and returns the run as the finalize left it. A turn still
    /// running leaves the run as it is, a running one handing again, on a task of its own, the
    /// interrupt of each limit it owes; a turn its provider ended is left to its end frame; a
    /// `pausing` run whose turn ended becomes `paused`, its open turns ended interrupted with
    /// `daemonRestart` where the turn is gone; any other gone turn settles the run by its stops,
    /// else interrupted with `daemonRestart`, its open turns ended interrupted and its asks let go
    /// by the run's end. Each move is written from the state `run` read, under `hold` where the
    /// caller holds the run's session, so a run that moved since is left as it now is. Fails as
    /// [`RunEngine::transition`] does.
    pub async fn finalize_resumed_run(
        self: &Arc<Self>,
        run: &LiveRun,
        state_before: RunState,
        answer: ProviderTurnAnswer,
        hold: Option<&SessionAppendHold>,
    ) -> Result<RunRead, RunEngineError> {
        match decide_resumed_move(state_before, run.parent_run_id.is_some(), answer) {
            ResumedRunMove::Left => Ok(run.run.clone()),
            ResumedRunMove::Running => {
                self.hand_owed_limit_interrupts(run.run_id);
                Ok(run.run.clone())
            }
            ResumedRunMove::Paused { is_turn_gone } => {
                self.pause_resumed_run(run, is_turn_gone, hold).await
            }
            // A run whose turn is gone never fails here, so the failure detail is never read.
            ResumedRunMove::TurnGone => {
                self.settle_after_restart(run, decide_turn_gone_settlement, "", hold)
                    .await
            }
        }
    }

    // Moves `run`, `pausing` before the restart, to `paused` from the state it read, with its open
    // turns' ends where `is_turn_gone`, the newest in the move's write; a run that moved since is
    // left as it now is.
    async fn pause_resumed_run(
        &self,
        run: &LiveRun,
        is_turn_gone: bool,
        hold: Option<&SessionAppendHold>,
    ) -> Result<RunRead, RunEngineError> {
        let run_id = run.run_id;
        let turn_end = if is_turn_gone {
            let open_turns = self.read_open_turns(run_id).await?;
            let turn_cuts = self.read_run_turn_cuts(run_id).await?;
            self.end_open_turns(
                run_id,
                &run.run,
                &open_turns,
                &turn_cuts,
                daemon_restart_outcome(RestartTurnEnd::Interrupted),
                false,
                hold,
            )
            .await?
        } else {
            None
        };
        let change = RunStateChange {
            expected_state: Some(run.run.state),
            ..RunStateChange::new(run_id, RunStateEntry::Paused)
        };
        match self
            .change_with_turn_end(
                change,
                RunStateChangeCompanions::default(),
                &run.run,
                turn_end,
                hold,
            )
            .await
        {
            Err(RunEngineError::Refused(RunRefusal::InvalidTransition { from_state, .. }))
                if from_state != run.run.state =>
            {
                Ok(run.run.clone())
            }
            Err(RunEngineError::Refused(RunRefusal::AlreadyEnded { .. })) => Ok(run.run.clone()),
            paused => paused,
        }
    }
}

// The newest open turn of `run_id` read on `reader`, with its steps; `None` when no turn is open.
// Fails when SQLite refuses the read or a stored turn number or count does not read as one.
fn read_open_turn_steps(
    reader: &Connection,
    run_id: &RunId,
) -> rusqlite::Result<Option<OpenTurnSteps>> {
    reader
        .prepare_cached(&SELECT_OPEN_TURN_STEPS_SQL)?
        .query_row(named_params! { "@run_id": run_id.text().as_str() }, |row| {
            Ok(OpenTurnSteps {
                turn_number: safe_int_column(row, 0)?,
                steps: safe_int_column::<0>(row, 1)?.get(),
                is_step_limit_reached: row.get(2)?,
            })
        })
        .optional()
}

#[cfg(test)]
mod tests;
