//! How a run ends outside its provider's own report: for an interrupt accepted earlier, when the
//! provider process under it exits on its own, and when a restart left it live and recovery could
//! not resume it. Each run's end carries the end of its open turn in the same write; a process's
//! exit and a restart's settle end every older open turn on its own first, oldest first.

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
use crate::session::run::engine::live::lock;
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
    /// daemon's own at `limit`, with the end of the newest turn the limit cut by a stop that read
    /// the run at or before that version, else of the newest open turn started at or before it,
    /// `agent.turn.interrupted` with the limit as its cause, in the same write, so the provider's
    /// later end of that turn is dropped. Returns `false` with no change of the run written when
    /// the run has ended since that version, even if it was continued after, which is what the
    /// interrupt asked for; the caller then records the verdict alone. On a run that reads ended,
    /// that turn still takes the limit's end, written on its own. Fails as
    /// [`RunEngine::transition`] does.
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
                let cut_turn =
                    lock(&self.live).newest_cut_turn(&run_id, limit, accepted_run_version);
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

    /// Ends the turns a provider process left when it ended on its own: the run, and each live run
    /// the provider dispatched beneath it as its own subagent, each in its own write, ends `failed`
    /// with `process_exit`, every open turn of it `agent.turn.failed` with the process's exit as
    /// its cause, or interrupted with the limit of a stop that cut it. Every run is ended before
    /// the failures return, together.
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

    // One run's end when its provider process exited, with its newest open turn's end in the same
    // write and every older one's before it.
    async fn fail_on_process_exit(
        &self,
        run_id: RunId,
        process_exit: &ProcessExit,
    ) -> Result<(), RunEngineError> {
        let run = self.require_run(run_id).await?;
        let open_turns = self.read_open_turns(run_id).await?;
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
        let turn_end = self
            .end_open_turns(run_id, &run, &open_turns, |_turn_number| {
                TurnOutcome::Failed(Some(TurnEndCause::ProcessExit))
            })
            .await?;
        self.change_with_turn_end(failed, RunStateChangeCompanions::default(), &run, turn_end)
            .await
            .map(drop)
    }

    /// Settles one run a restart left live that recovery could not resume, without calling any
    /// driver, as [`decide_restart_settlement`] decides: its end and its newest open turn's end in
    /// one write, every older open turn ended on its own before it, the turns a limit cut with the
    /// limit's cause and every other with `daemonRestart`, a pending interrupt moved to `applied`
    /// in that write, otherwise guarded on no interrupt having appeared since; a `failed` end
    /// carries `failure_detail`. A run the decision leaves is returned as it is. Fails as
    /// [`RunEngine::transition`] does.
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
        let turn_end = match decision.open_turn_end {
            Some(turn_end) => {
                let (ended_as, cause): (fn(Option<TurnEndCause>) -> TurnOutcome, _) = match turn_end
                {
                    RestartTurnEnd::Interrupted { cause } => (TurnOutcome::Interrupted, cause),
                    RestartTurnEnd::Failed { cause } => (TurnOutcome::Failed, cause),
                };
                let open_turns = self.read_open_turns(run_id).await?;
                // The turns the limit cut that are still open take the cause, and where none is,
                // the newest open turn, which the limit's interrupt would cut.
                let mut cause_turns: Vec<_> = decision
                    .cut_turns
                    .iter()
                    .copied()
                    .filter(|turn_number| open_turns.contains(turn_number))
                    .collect();
                if cause_turns.is_empty() {
                    cause_turns.extend(open_turns.last().copied());
                }
                self.end_open_turns(run_id, &run.run, &open_turns, |turn_number| {
                    ended_as(Some(if cause_turns.contains(&turn_number) {
                        cause
                    } else {
                        TurnEndCause::DaemonRestart
                    }))
                })
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
