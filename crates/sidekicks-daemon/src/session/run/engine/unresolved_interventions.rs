//! The engine's part in the interventions a run's end, or a turn's end that is not interrupted,
//! leaves with no outcome: read into the write that ends the run or the turn and settled there, so
//! no daemon death between the end and the settle leaves one open, and the run queue's hold each
//! person's interrupt among them took let go once that write lands. After a restart, an ended run
//! a daemon gone down still left holding one is settled the same way from its log.

use std::sync::Weak;

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::InterventionId;
use sidekicks_contracts::run::state::RunState;
use tokio::sync::SetOnceError;

use crate::database::connection::read_pool::ReadLength;
use crate::interventions::interrupt_queue::{InterruptChoice, InterruptQueue};
use crate::interventions::unresolved::{
    UnresolvedSettle, UnresolvedSettleMoment, read_ended_runs_with_unresolved,
    read_unresolved_interventions, settle_unresolved,
};
use crate::session::run::engine::turns::TurnEnd;
use crate::session::run::engine::{RunEngine, RunEngineError, refused_statement_index, settled};
use crate::session::run::read::RunRead;
use crate::session::run::state_change::{
    RunStateChange, RunStateChangeCompanions, RunStateChangeError,
};

impl RunEngine {
    /// Hands the engine the run queue whose hold of a person's interrupt a run's end or a turn's
    /// end lets go once it settles that interrupt, once, while the daemon wires its services and
    /// before any run can end. Fails with the handle when one was handed already.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the daemon's start, which hands the engine the run queue"
        )
    )]
    pub(crate) fn set_interrupt_queue(
        &self,
        queue: Weak<dyn InterruptQueue>,
    ) -> Result<(), SetOnceError<Weak<dyn InterruptQueue>>> {
        self.interrupt_queue.set(queue)
    }

    /// The settle `moment` gives every intervention on `run_id` with no outcome, less the rows
    /// `settled_by_writer` names. Fails as the read fails or an event cannot be drafted.
    pub(super) async fn read_unresolved_settle(
        &self,
        run_id: RunId,
        moment: UnresolvedSettleMoment,
        settled_by_writer: &[InterventionId],
    ) -> Result<UnresolvedSettle, RunEngineError> {
        let unresolved = self
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, RunEngineError>(read_unresolved_interventions(reader, &run_id)?)
            })
            .await?;
        Ok(settle_unresolved(&unresolved, moment, settled_by_writer)?)
    }

    /// Writes `change`, a run's end, with `companions` and the settle of every intervention left
    /// with no outcome on the run but those the companions settle, read again once when one of
    /// them moved since its read. Answers the run as the end left it and the choices whose queue
    /// holds go; fails as the change's write does.
    pub(super) async fn write_run_end(
        &self,
        change: RunStateChange,
        companions: RunStateChangeCompanions,
    ) -> Result<(RunRead, Vec<InterruptChoice>), RunEngineError> {
        let run_id = change.run_id;
        let moment = UnresolvedSettleMoment::RunEnded(RunState::from(change.entry.state()));
        let writer_statements = companions.statements.len();
        let mut is_read_again = false;
        loop {
            let UnresolvedSettle {
                statements,
                events,
                released_choices,
            } = self
                .read_unresolved_settle(run_id, moment, &companions.settled_interventions)
                .await?;
            let mut with_settle = companions.clone();
            with_settle.statements.extend(statements);
            with_settle.preceding_events.extend(events);
            match self.changes.write(change.clone(), with_settle).await {
                Ok(run) => return Ok((run, released_choices)),
                // A row the settle read moved since, by its own dispatch's outcome.
                Err(RunStateChangeError::CompanionRefused {
                    companion_index, ..
                }) if companion_index >= writer_statements && !is_read_again => {
                    is_read_again = true;
                }
                Err(error) => return Err(error.into()),
            }
        }
    }

    /// Writes `change`, a move of a live run that ends a turn its provider reported as anything but
    /// interrupted, with `turn_end` and the expiry of every interrupt left with no outcome on the
    /// run, read again once when one of them moved since its read, then lets go the run queue's
    /// hold of each person's. Fails as [`RunEngine::change_with_turn_end`] does, or as a release
    /// fails with the change kept.
    pub(super) async fn change_with_uninterrupted_turn_end(
        &self,
        change: RunStateChange,
        run: &RunRead,
        turn_end: Option<TurnEnd>,
    ) -> Result<RunRead, RunEngineError> {
        let run_id = change.run_id;
        let mut is_read_again = false;
        loop {
            let UnresolvedSettle {
                statements,
                events,
                released_choices,
            } = self
                .read_unresolved_settle(run_id, UnresolvedSettleMoment::TurnEndedUninterrupted, &[])
                .await?;
            let companions = RunStateChangeCompanions {
                statements,
                preceding_events: events,
                ..RunStateChangeCompanions::default()
            };
            match self
                .change_with_turn_end(change.clone(), companions, run, turn_end)
                .await
            {
                Ok(changed) => {
                    self.release_interrupt_holds(run_id, released_choices)
                        .await?;
                    return Ok(changed);
                }
                // A row the settle read moved since, by its own dispatch's outcome.
                Err(RunEngineError::Change(RunStateChangeError::CompanionRefused { .. }))
                    if !is_read_again =>
                {
                    is_read_again = true;
                }
                Err(error) => return Err(error),
            }
        }
    }

    /// Expires every interrupt left with no outcome on the live run `run_id` once a turn its
    /// provider reported as anything but interrupted has ended on its own write, in one write of
    /// its own, read again once when one of them moved since its read, then lets go the run
    /// queue's hold of each person's. Fails as the read, the write or a release fails.
    pub(super) async fn settle_after_uninterrupted_turn_end(
        &self,
        run_id: RunId,
    ) -> Result<(), RunEngineError> {
        let mut is_read_again = false;
        loop {
            let UnresolvedSettle {
                statements,
                mut events,
                released_choices,
            } = self
                .read_unresolved_settle(run_id, UnresolvedSettleMoment::TurnEndedUninterrupted, &[])
                .await?;
            let Some(last) = events.pop() else {
                return Ok(());
            };
            match self.append(last, statements, events).await {
                Ok(_receipt) => {
                    return self.release_interrupt_holds(run_id, released_choices).await;
                }
                Err(error) if refused_statement_index(&error).is_some() && !is_read_again => {
                    is_read_again = true;
                }
                Err(error) => return Err(error.into()),
            }
        }
    }

    /// Lets go the run queue's hold of `run_id` once for each of `choices`, after the write that
    /// settled their interrupts landed; an engine never handed the queue, or whose queue has shut
    /// down, holds none. Fails with every release that failed, each one tried.
    pub(super) async fn release_interrupt_holds(
        &self,
        run_id: RunId,
        choices: Vec<InterruptChoice>,
    ) -> Result<(), RunEngineError> {
        if choices.is_empty() {
            return Ok(());
        }
        let Some(queue) = self.interrupt_queue.get().and_then(Weak::upgrade) else {
            return Ok(());
        };
        let mut outcomes = Vec::with_capacity(choices.len());
        for choice in choices {
            outcomes.push(
                queue
                    .release_interrupt(run_id, choice)
                    .await
                    .map_err(|source| RunEngineError::InterruptRelease { run_id, source }),
            );
        }
        settled(
            outcomes,
            "letting go the run queue's holds of a run's settled interrupts",
        )
    }

    /// Settles every intervention left with no outcome on `run_id` once it reads ended, after
    /// every terminal write of it in flight has landed: for a dispatch that answered nothing after
    /// its run's end had read the rows, and for the daemon's recovery pass. A run still live is
    /// left to its own end. Answers whether the run had ended; fails as the reads, the write or a
    /// queue release fail.
    pub(crate) async fn settle_unresolved_of_ended_run(
        &self,
        run_id: RunId,
    ) -> Result<bool, RunEngineError> {
        self.wait_for_ending_writes(&run_id).await;
        let mut is_read_again = false;
        loop {
            let run = self.require_run(run_id).await?;
            if !run.state.is_terminal() {
                return Ok(false);
            }
            let UnresolvedSettle {
                statements,
                mut events,
                released_choices,
            } = self
                .read_unresolved_settle(run_id, UnresolvedSettleMoment::RunEnded(run.state), &[])
                .await?;
            let Some(last) = events.pop() else {
                return Ok(true);
            };
            match self.append(last, statements, events).await {
                Ok(_receipt) => {
                    self.release_interrupt_holds(run_id, released_choices)
                        .await?;
                    return Ok(true);
                }
                Err(error) if refused_statement_index(&error).is_some() && !is_read_again => {
                    is_read_again = true;
                }
                Err(error) => return Err(error.into()),
            }
        }
    }

    /// Settles, after a restart, every ended run that a daemon gone down between its end and the
    /// settle left holding an intervention with no outcome, as its end would have. Every run is
    /// tried before the failures return together.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the daemon's recovery pass at start")
    )]
    pub(crate) async fn settle_unresolved_of_ended_runs(&self) -> Result<(), RunEngineError> {
        let run_ids = self
            .pool
            .read(ReadLength::Short, |reader| {
                Ok::<_, RunEngineError>(read_ended_runs_with_unresolved(reader)?)
            })
            .await?;
        let mut outcomes = Vec::with_capacity(run_ids.len());
        for run_id in run_ids {
            outcomes.push(self.settle_unresolved_of_ended_run(run_id).await.map(drop));
        }
        settled(
            outcomes,
            "settling the interventions ended runs left with no outcome",
        )
    }
}
