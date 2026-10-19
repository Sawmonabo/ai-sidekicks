//! How a run ends outside its provider's own report: for an interrupt accepted earlier, when the
//! provider process under it exits on its own, and when a restart left it live and recovery could
//! not resume it; and how a restart ends the open turns of a run that had already ended. Each run's
//! end carries the end of its open turn in the same write; a process's exit and a restart's settle
//! end every older open turn on its own first, oldest first. A turn a limit cut ends with that
//! limit, read from the engine's own cut first, then from the limit's intervention row, the cut's
//! one mark in the log, so the live path and a restart give a turn one cause, except where the
//! turn's end races its stop's row.

use std::borrow::Cow;
use std::iter;
use std::sync::LazyLock;

use rusqlite::named_params;
use rusqlite::types::Value;
use sidekicks_contracts::event::envelope::EventCategory;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::provider::driver::recovery::RecoveryCondition;
use sidekicks_contracts::run::control::{ProcessExit, RunFailureCategory};
use sidekicks_contracts::run::events::{TurnEndCause, TurnEndOrigin};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::RunLimit;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::wire::integer::SafeInt;
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
    RestartFacts, RestartSettlement, RestartTurnEnd, applied_pending_interrupts_of,
    decide_restart_settlement, limit_turn_cause, no_pending_interrupt_statement,
    no_waiting_item_statement, read_restart_facts, read_run_stops, settlement_by_stops,
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
    /// Ends the run for an applied or degraded interrupt accepted at `accepted_run_version`, with
    /// `verdict` in the same write: `interrupted` for a person's, and for the daemon's own the end
    /// `limit` gives, with `cut_turn`, the turn its row names, ended interrupted with the limit of
    /// its cuts the engine holds, else of the log's rows, else `limit`; on a run that reads ended,
    /// that turn still takes the limit's end, written on its own. Returns `true`, or `false` with
    /// no change of the run written when it ended since that version, the caller then recording
    /// the verdict alone; fails as the reads and [`RunEngine::transition`] do.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the run queue ends the run of each interrupt the service applies"
        )
    )]
    pub(crate) async fn end_run_for_interrupt(
        &self,
        run_id: RunId,
        accepted_run_version: i64,
        limit: Option<RunLimit>,
        cut_turn: Option<SafeInt<1>>,
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
                let turn_end = match cut_turn {
                    Some(turn_number) => {
                        let limit_end = TurnOutcome::Interrupted(Some(limit_turn_cause(limit)));
                        Some(TurnEnd {
                            turn_number,
                            origin: TurnEndOrigin::Daemon,
                            outcome: self
                                .cut_outcome_of_ended_run(run_id, turn_number, limit_end)
                                .await?,
                        })
                    }
                    None => None,
                };
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

    /// Whether `run_id` has ended since `run_version`, read from its terminal records, a run
    /// ended and continued since included. Fails as the read fails.
    pub(crate) async fn has_ended_since(
        &self,
        run_id: RunId,
        run_version: i64,
    ) -> Result<bool, RunEngineError> {
        self.pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, RunEngineError>(reader.prepare_cached(&SELECT_TERMINAL_SINCE_SQL)?.exists(
                    named_params! {
                        "@run_id": run_id.text().as_str(),
                        "@run_version": run_version,
                    },
                )?)
            })
            .await
    }

    /// Ends the turns a provider process left when it ended on its own: the run, and each live run
    /// the provider dispatched beneath it as its own subagent, each in its own write: a live run
    /// settles by its stops, else fails with the exit, and every open turn ends interrupted with
    /// the limit that cut it, else failed with the exit. Every run is ended before the failures
    /// return, together.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the provider's event delivery, when a provider process exits"
        )
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

    /// One run's end when its provider process exited. A live run settles as a restart settles
    /// it by its stops, else fails with the exit: its newest open turn's end rides that write and
    /// every older one is written before it, each pending interrupt applied in it, refused once an
    /// interrupt it did not read is pending, which reads the run again and decides once more. A
    /// run resting, ended or queued keeps its state and its rows, its open turns ended on their
    /// own. A turn a limit cut, by the engine's cut or a row of the log, ends interrupted with
    /// that limit, every other `agent.turn.failed` with the exit. Fails as the reads fail and as
    /// [`RunEngine::transition`] does, the second refusal returned.
    async fn fail_on_process_exit(
        &self,
        run_id: RunId,
        process_exit: &ProcessExit,
    ) -> Result<(), RunEngineError> {
        let uncut_end = TurnOutcome::Failed(Some(TurnEndCause::ProcessExit));
        let mut is_read_again = false;
        loop {
            let run = self.require_run(run_id).await?;
            let open_turns = self.read_open_turns(run_id).await?;
            let turn_cuts = self.read_run_turn_cuts(run_id).await?;
            if run.state.is_terminal() || run.state == RunState::Queued {
                if let Some(turn_end) = self
                    .end_open_turns(run_id, &run, &open_turns, &turn_cuts, uncut_end, false)
                    .await?
                {
                    self.record_turn_end_alone(run_id, &run, turn_end, false)
                        .await?;
                }
                return Ok(());
            }
            let (pending_interrupts, owed_limit) = self
                .pool
                .read(ReadLength::Short, move |reader| {
                    Ok::<_, RunEngineError>(read_run_stops(reader, &run_id)?)
                })
                .await?;
            let change = settlement_change(
                run_id,
                settlement_by_stops(&pending_interrupts, owed_limit),
                || RunStateChange {
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
                },
            );
            let mut companions =
                applied_pending_interrupts_of(run_id, run.session_id, &pending_interrupts)?;
            companions
                .statements
                .push(no_pending_interrupt_statement(&run_id));
            let turn_end = self
                .end_open_turns(run_id, &run, &open_turns, &turn_cuts, uncut_end, false)
                .await?;
            match self
                .change_with_turn_end(change, companions, &run, turn_end)
                .await
            {
                // An interrupt moved or asked for since the read: read the run and its stops
                // again, once.
                Err(RunEngineError::Change(RunStateChangeError::CompanionRefused { .. }))
                    if !is_read_again =>
                {
                    is_read_again = true;
                }
                settled => return settled.map(drop),
            }
        }
    }

    /// Settles a run a restart left live that recovery could not resume, without a driver, as
    /// [`decide_restart_settlement`] decides, a run it leaves returned as it is: its end, every
    /// pending interrupt applied, and its open turns' ends, each a limit's row names with that
    /// limit and every other with `daemonRestart`, guarded on no interrupt appearing since, a
    /// `failed` end carrying `failure_detail`. Fails as [`RunEngine::transition`] does.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the daemon's recovery pass at start")
    )]
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
        let change = settlement_change(run_id, Some(decision.settlement), || RunStateChange {
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
        });
        // Every pending interrupt the settle read is applied by this end, and one that arrived
        // since refuses it.
        let mut companions =
            applied_pending_interrupts_of(run_id, run.run.session_id, &facts.pending_interrupts)?;
        companions
            .statements
            .push(no_pending_interrupt_statement(&run_id));
        let is_queued = run.run.state == RunState::Queued;
        if is_queued {
            companions
                .statements
                .push(no_waiting_item_statement(&run_id));
        }
        let turn_end = match decision.open_turn_end {
            Some(uncut_end) => {
                let open_turns = self.read_open_turns(run_id).await?;
                self.end_open_turns(
                    run_id,
                    &run.run,
                    &open_turns,
                    &facts.turn_cuts,
                    daemon_restart_outcome(uncut_end),
                    false,
                )
                .await?
            }
            None => None,
        };
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

    /// Ends after a restart every open turn of each ended run in `run_ids`, oldest first, each on
    /// its own as the daemon's report held to its run's version, interrupted with the limit of a
    /// row naming it else `daemonRestart`, a run that reads live left to its own ends. Every run
    /// is tried before the failures, from the reads and the writes, return together.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the daemon's recovery pass at start")
    )]
    pub(crate) async fn end_open_turns_of_ended_runs(
        &self,
        run_ids: &[RunId],
    ) -> Result<(), RunEngineError> {
        let mut outcomes = Vec::with_capacity(run_ids.len());
        for &run_id in run_ids {
            let ended = match self.require_run(run_id).await {
                Ok(run) => self.end_open_turns_of_ended_run(run_id, &run).await,
                Err(error) => Err(error),
            };
            outcomes.push(ended);
        }
        settled(
            outcomes,
            "ending the open turns of runs that had ended before the restart",
        )
    }

    // The open turns of `run_id`, read as `run`, each ended on its own after a restart while the
    // run is still ended at that version.
    async fn end_open_turns_of_ended_run(
        &self,
        run_id: RunId,
        run: &RunRead,
    ) -> Result<(), RunEngineError> {
        if !run.state.is_terminal() {
            return Ok(());
        }
        let turn_cuts = self.read_run_turn_cuts(run_id).await?;
        let open_turns = self.read_open_turns(run_id).await?;
        let uncut_end = daemon_restart_outcome(RestartTurnEnd::Interrupted);
        if let Some(turn_end) = self
            .end_open_turns(run_id, run, &open_turns, &turn_cuts, uncut_end, true)
            .await?
        {
            self.record_turn_end_alone(run_id, run, turn_end, true)
                .await?;
        }
        Ok(())
    }
}

// The change that ends `run_id` as `settlement` decides; `None` or a `failed` settlement takes
// `failed_change`.
fn settlement_change(
    run_id: RunId,
    settlement: Option<RestartSettlement>,
    failed_change: impl FnOnce() -> RunStateChange,
) -> RunStateChange {
    match settlement {
        Some(RestartSettlement::Interrupted { trigger }) => RunStateChange::new(
            run_id,
            RunStateEntry::Interrupted {
                intended_close: None,
                trigger,
            },
        ),
        Some(RestartSettlement::Stopped { trigger }) => RunStateChange::new(
            run_id,
            RunStateEntry::Stopped {
                intended_close: None,
                trigger: Some(trigger),
            },
        ),
        Some(RestartSettlement::Failed) | None => failed_change(),
    }
}

// How a restart ends an open turn no limit cut: as `uncut_end` with `daemonRestart`.
fn daemon_restart_outcome(uncut_end: RestartTurnEnd) -> TurnOutcome {
    let cause = Some(TurnEndCause::DaemonRestart);
    match uncut_end {
        RestartTurnEnd::Interrupted => TurnOutcome::Interrupted(cause),
        RestartTurnEnd::Failed => TurnOutcome::Failed(cause),
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
mod tests;
