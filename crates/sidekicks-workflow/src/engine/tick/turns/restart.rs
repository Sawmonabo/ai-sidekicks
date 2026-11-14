//! The tick's restart: each unfinished run of a session recovery rebuilt taken back into the live
//! set before the loop starts, its walk replayed from the log, and the crash sweep queued as its
//! next batch, so the loop's first turn writes every row the sweep moves on an event of its own.
//! A step that was running fails as crashed and parks its run; a step winding down settles
//! canceled; a held step is held again, or canceled where the sweep parks its run; a waiting step
//! keeps its wait, asked again where its ask is gone; a pending step is dispatched again where its
//! run goes on, a retry attempt once what is left of its wait has passed. A run with no step
//! waiting, parked or held ends crashed, its pending steps canceled, and a run whose version or log
//! no longer reads ends crashed with the reason, each of its steps canceled on an event of its own.
#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's restart, which hands each recovered session's runs to the tick"
    )
)]

mod replay;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use sidekicks_contracts::question::QuestionWaitOutcome;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::workflow::definition::item::{WorkflowItem, WorkflowStepError};
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::snapshot::WorkflowRunEpoch;
use sidekicks_contracts::workflow::run::status::{WorkflowStepStatus, WorkflowWaitCause};
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;
use sidekicks_std::scheduler::armed_instant::InstantJob as _;

use self::replay::{ReplayedRun, replay_run, replayed_epoch, reused_seeds};
use super::starting::{seeded_run, trigger_inputs};
use super::{EngineTick, arm_retry};
use crate::engine::event_record::{EngineFault, EngineIntent, EngineOutcome};
use crate::engine::start::{ReloadedRun, ReloadedScope, ReloadedStep};
use crate::engine::tick::commit::{RunEnding, RunLiveStep, RunTurnCommit};
use crate::engine::tick::live_runs::{LiveRun, LiveStep, ParkCanceledStep};
use crate::engine::tick::run_status::{RunPersonWait, RunStepCounts};
use crate::engine::tick::step_failure::{RunStop, crashed_step_failure, step_retry};
use crate::engine::tick::walk::WalkReady;
use crate::engine::tick::{ParkedAgentRun, StepReport, StepReportKind, StepSettlement};
use crate::engine::waits::OpenedPersonWait;
use crate::kinds::step_context::StepRecords;
use crate::kinds::{PersonAsk, uncoded_step_error};
use crate::runs::gate_resolution::RunEventKeys;
use crate::runs::step_payload::read_step_payload;
use crate::secrets::redaction::RunRedaction;

/// A reloaded run that cannot be driven again: what its crashed ending writes.
struct UnrunnableRun<'run> {
    keys: RunEventKeys,
    run_id: WorkflowRunId,
    is_admitted: bool,
    person_wait: RunPersonWait,
    posts_results: bool,
    epoch: WorkflowRunEpoch,
    steps: &'run [ReloadedStep],
}

impl EngineTick {
    /// Takes back `runs`, the unfinished runs of a session recovery rebuilt, in order, before the
    /// loop runs: each run's sweep is its next batch, which the loop's first turn writes before
    /// it reads the deadline clock, and with no sweep to write the clock is read here.
    pub(crate) async fn restart(&mut self, runs: Vec<ReloadedRun>) {
        for reloaded in runs {
            self.take_back(reloaded).await;
        }
        if self.batched.is_empty() {
            Arc::clone(&self.deadlines).rearm().await;
            self.admission.weigh();
        } else {
            self.needs_deadline_read = true;
        }
    }

    /// Takes back `reloaded`: its walk replayed, its steps made live from their rows and its sweep
    /// queued; a run whose scope, log or rows do not line up ends crashed with the reason.
    async fn take_back(&mut self, reloaded: ReloadedRun) {
        let ReloadedRun {
            keys,
            run_id,
            is_admitted,
            person_wait,
            posts_results,
            steps,
            events,
            drive,
        } = reloaded;
        let unrunnable = UnrunnableRun {
            keys,
            run_id,
            is_admitted,
            person_wait: person_wait.clone(),
            posts_results,
            epoch: replayed_epoch(&events),
            steps: &steps,
        };
        let ReloadedScope {
            scope,
            graph,
            covered,
            sealed,
            repins,
        } = match drive {
            Ok(reloaded_scope) => reloaded_scope,
            Err(error) => return self.end_unrunnable(unrunnable, error).await,
        };
        let record = self.recorder.for_run(run_id, Arc::clone(&scope.redaction));
        let replayed = match reused_seeds(&events, scope.session_id, &*self.payloads).await {
            Ok(reused) => {
                let live = seeded_run(scope, graph, (covered, sealed), reused, record);
                replay_run(live, &events, repins, &*self.payloads).await
            }
            Err(reason) => Err(reason),
        };
        let replayed = match replayed {
            Ok(replayed) => replayed,
            Err(reason) => return self.end_unrunnable(unrunnable, unfollowed(&reason)).await,
        };
        let kept = match self.kept_steps(&replayed, &steps).await {
            Ok(kept) => kept,
            Err(reason) => return self.end_unrunnable(unrunnable, unfollowed(&reason)).await,
        };
        self.sweep(replayed, kept, is_admitted, person_wait).await;
    }

    /// Each step the replayed walk of `replayed` holds unsettled beside its row among `rows` and
    /// its inputs: a trigger step's read back from its stored input, any other's from its sources.
    /// Fails with the reason when the walk and the rows disagree on a step or an input does not
    /// read.
    async fn kept_steps<'rows>(
        &self,
        replayed: &ReplayedRun,
        rows: &'rows [ReloadedStep],
    ) -> Result<Vec<(WalkReady, &'rows ReloadedStep, Vec<Vec<WorkflowItem>>)>, String> {
        let live = &replayed.live;
        let by_index: HashMap<u64, &ReloadedStep> = rows
            .iter()
            .map(|row| (row.step.execution_index.get(), row))
            .collect();
        let unsettled: Vec<WalkReady> = live.walk.unsettled().collect();
        let mut kept = Vec::with_capacity(unsettled.len());
        for ready in unsettled {
            let row = by_index
                .get(&ready.step.execution_index.get())
                .filter(|row| row.step == ready.step)
                .ok_or_else(|| {
                    format!(
                        "no row holds the step of node {}",
                        ready.step.node_id.as_str()
                    )
                })?;
            let is_failed_park = replayed.failed_parks.contains(&ready.step);
            let is_park_canceled = replayed.park_canceled.contains(&ready.step);
            let is_lined_up = match row.status {
                WorkflowStepStatus::Failed => is_failed_park,
                WorkflowStepStatus::Canceled => is_park_canceled,
                WorkflowStepStatus::Pending
                | WorkflowStepStatus::WaitingMemory
                | WorkflowStepStatus::Running
                | WorkflowStepStatus::Waiting => !is_failed_park && !is_park_canceled,
                WorkflowStepStatus::Succeeded | WorkflowStepStatus::Skipped => false,
            };
            if !is_lined_up {
                return Err(format!(
                    "the step of node {} stands otherwise in its row than in the log",
                    ready.step.node_id.as_str()
                ));
            }
            let inputs = if ready.step.node_id == live.scope.trigger.node_id {
                let node = live
                    .scope
                    .nodes
                    .get(&ready.step.node_id)
                    .expect("the trigger is one of the run's nodes");
                let items = read_step_payload(&*self.payloads, &row.input_ref)
                    .await
                    .map_err(|error| error.to_string())?;
                trigger_inputs(self.spec(node), items)
            } else {
                live.walk
                    .ready_inputs(&ready.step, &ready.sources, &live.outputs)
            };
            kept.push((ready, *row, inputs));
        }
        let kept_unsettled = kept.iter().filter(|(_, row, _)| is_kept_row(row)).count();
        if kept_unsettled != rows.iter().filter(|row| is_kept_row(row)).count() {
            return Err("a step's row stands unsettled where the log settled it".to_owned());
        }
        Ok(kept)
    }

    /// Makes the kept steps of `replayed` live and queues its sweep: a running step fails as
    /// crashed, a step winding down settles canceled, a held step is held again or, where the
    /// run parks, canceled at its last hold report; an account wait takes its agent run back, a
    /// form's or a reply's wait its question, and a wait whose resume does not read stays off the
    /// clock. A run the sweep leaves with no step waiting, parked or held ends crashed in the same
    /// write, its pending steps canceled; any other dispatches its pending steps again.
    async fn sweep(
        &mut self,
        replayed: ReplayedRun,
        kept: Vec<(WalkReady, &ReloadedStep, Vec<Vec<WorkflowItem>>)>,
        is_admitted: bool,
        person_wait: RunPersonWait,
    ) {
        let ReplayedRun {
            mut live,
            failed_parks: _,
            park_canceled,
            winding_down,
            last_hold_reports,
            retried_at,
            mut parked_records,
            mut asks,
            newest_sequence,
        } = replayed;
        let run_id = live.scope.run_id;
        live.person_wait = person_wait;
        if is_admitted {
            live.counts.admitted();
        }
        let mut crashing: Vec<WorkflowStepKey> = Vec::new();
        let mut canceling: Vec<WorkflowStepKey> = Vec::new();
        let mut held: Vec<WorkflowStepKey> = Vec::new();
        let mut pending: Vec<WorkflowStepKey> = Vec::new();
        let mut is_waiting = false;
        let mut canceled_by_park = Vec::new();
        for (ready, row, inputs) in kept {
            let index = ready.step.execution_index.get();
            if row.status == WorkflowStepStatus::Canceled {
                canceled_by_park.push(ParkCanceledStep {
                    step: ready.step,
                    inputs,
                    input_ref: row.input_ref.clone(),
                });
                continue;
            }
            let mut live_step =
                LiveStep::readied(ready, inputs, row.input_ref.clone(), newest_sequence);
            live_step.status = row.status;
            live_step.wait_cause = row.wait_cause;
            live_step.wait_id = row.wait_id;
            live_step.wait_deadline_at.clone_from(&row.wait_deadline_at);
            live_step.is_winding_down = winding_down.contains(&index);
            live.counts.moved(None, (row.status, row.wait_cause));
            match row.status {
                WorkflowStepStatus::Failed => live.counts.parked(),
                WorkflowStepStatus::Running if live_step.is_winding_down => {
                    canceling.push(live_step.step.clone());
                }
                WorkflowStepStatus::Running => crashing.push(live_step.step.clone()),
                WorkflowStepStatus::WaitingMemory => {
                    live_step.last_hold_report_at = last_hold_reports.get(&index).cloned();
                    held.push(live_step.step.clone());
                }
                WorkflowStepStatus::Pending => pending.push(live_step.step.clone()),
                WorkflowStepStatus::Waiting => {
                    let stored = (parked_records.remove(&index), asks.remove(&index));
                    if self
                        .take_wait_back(&mut live, &mut live_step, row, stored)
                        .await
                    {
                        is_waiting = true;
                    } else {
                        crashing.push(live_step.step.clone());
                    }
                }
                WorkflowStepStatus::Succeeded
                | WorkflowStepStatus::Skipped
                | WorkflowStepStatus::Canceled => {}
            }
            live.steps.insert(index, live_step);
        }
        // The park's cancels are run again by the Resume in the order they were made.
        for step in park_canceled {
            if let Some(position) = canceled_by_park.iter().position(|kept| kept.step == step) {
                live.park_canceled.push(canceled_by_park.remove(position));
            }
        }
        let now = WireInstant::now();
        let is_parking = live.stop == Some(RunStop::Park) || !crashing.is_empty();
        crashing.sort_by_key(|step| step.execution_index.get());
        for step in crashing {
            let failure = crashed_step_failure(&step);
            live.next_batch.push(StepReport {
                step,
                at: now.clone(),
                kind: StepReportKind::Settled(StepSettlement::Failed {
                    failure,
                    log_lines: Vec::new(),
                }),
            });
        }
        for step in canceling {
            if let Some(live_step) = live.steps.get_mut(&step.execution_index.get()) {
                live_step.is_park_canceled = is_parking;
            }
            live.next_batch
                .push(canceled_report(step, now.clone(), None));
        }
        // Pending steps alone do not keep a run going.
        let is_going = is_waiting || is_parking || !held.is_empty();
        for step in held {
            let live_step = live
                .steps
                .get_mut(&step.execution_index.get())
                .expect("a held step is live");
            if is_parking {
                // The cut hold ends at its last report.
                live_step.is_park_canceled = true;
                let at = live_step
                    .last_hold_report_at
                    .clone()
                    .unwrap_or_else(|| now.clone());
                live_step.last_hold_report_at = Some(at.clone());
                live.next_batch
                    .push(canceled_report(step, at.clone(), Some(at)));
            } else {
                // A new hold, on an event naming the sweep's place in the log.
                live_step.last_hold_report_at = None;
                live.next_batch.push(StepReport {
                    step: step.clone(),
                    at: now.clone(),
                    kind: StepReportKind::WaitingOnMemory {
                        hold_started_at: now.clone(),
                    },
                });
                live.held.dispatches.push(step);
            }
        }
        if !is_going {
            live.stop = Some(RunStop::End);
            live.ending = Some(RunEnding::Crashed { error: None });
            for step in pending {
                live.next_batch
                    .push(canceled_report(step, now.clone(), None));
            }
        } else if !is_parking {
            // A retry attempt waits out what is left of its wait, a past one dispatched at once.
            for step in pending {
                let left = retried_at.get(&step.execution_index.get()).map_or(
                    Duration::ZERO,
                    |readied_at| {
                        let node = live
                            .scope
                            .nodes
                            .get(&step.node_id)
                            .expect("a live step's node is one of the run's");
                        retry_wait_left(readied_at, step_retry(node).wait)
                    },
                );
                if left.is_zero() {
                    live.held.dispatches.push(step);
                } else {
                    arm_retry(&mut self.retries, step, left, live.scope.cancel.clone());
                }
            }
        }
        live.follow_cap(&self.deadlines, false);
        let is_batched = !live.next_batch.is_empty() || !live.held.dispatches.is_empty();
        self.runs.insert(run_id, live);
        if is_batched {
            self.batched.push(run_id);
        }
    }

    /// Takes the wait of `live_step`, a waiting step of `live`, back from `row` and what its
    /// suspension `stored`: an account wait's agent run with the records it kept, its resume where
    /// it reads, and a form's or a reply's open question; a wait whose resume does not read keeps
    /// its run off the clock, a form or reply whose question is no longer open is asked again, and
    /// an approval's card is raised again, which a card still standing ignores. Answers `false`
    /// where the agent run is not there to take back, which the sweep fails as crashed.
    async fn take_wait_back(
        &self,
        live: &mut LiveRun,
        live_step: &mut LiveStep,
        row: &ReloadedStep,
        (records, ask): (Option<StepRecords>, Option<(PersonAsk, WireInstant)>),
    ) -> bool {
        let step = live_step.step.clone();
        match row.wait_cause {
            Some(WorkflowWaitCause::Account) => {
                match &row.resume_at {
                    Some(Ok(resume_at)) => live_step.resume_at = Some(resume_at.clone()),
                    Some(Err(unreadable)) => {
                        live.record
                            .fault(Some(&step), EngineFault::ResumeUnreadable, unreadable)
                            .await;
                        self.deadlines.skip_run(live.scope.run_id);
                    }
                    None => {}
                }
                match self.dispatch.reattach_agent_run(&step).await {
                    Ok(run) => {
                        live_step.parked_agent_run = Some(ParkedAgentRun {
                            run,
                            records: records.unwrap_or_default(),
                        });
                        true
                    }
                    Err(error) => {
                        live.record
                            .fault(Some(&step), EngineFault::WaitNotReattached, error.as_ref())
                            .await;
                        false
                    }
                }
            }
            Some(WorkflowWaitCause::Form | WorkflowWaitCause::Reply) => {
                let wait_id = row
                    .wait_id
                    .expect("a form's or a reply's wait names its wait");
                let reattached = self
                    .person_waits
                    .questions
                    .reattach(live.scope.session_id, wait_id)
                    .await;
                match reattached {
                    Ok(Some(_)) => {}
                    Ok(None) => self.ask_again(live, &step, row, ask).await,
                    Err(error) => {
                        live.record
                            .fault(Some(&step), EngineFault::WaitNotReattached, error.as_ref())
                            .await;
                    }
                }
                true
            }
            Some(WorkflowWaitCause::Approval) => {
                self.ask_again(live, &step, row, ask).await;
                true
            }
            Some(WorkflowWaitCause::Chain) | None => true,
        }
    }

    /// Asks the person again what `step`'s wait asks, its `ask` as its suspension stored it, under
    /// the wait id and deadline `row` stores, writing nothing: the wait's `Waiting on you` was
    /// posted when it began. A failed ask is recorded and the wait stays.
    async fn ask_again(
        &self,
        live: &LiveRun,
        step: &WorkflowStepKey,
        row: &ReloadedStep,
        ask: Option<(PersonAsk, WireInstant)>,
    ) {
        let (ask, started_at) = ask.expect("a person's wait's suspension stores what it asks");
        let opened = OpenedPersonWait {
            wait_id: row.wait_id.expect("a person's wait names its wait"),
            cause: row.wait_cause.expect("a waiting step names its cause"),
            started_at,
            deadline_at: row.wait_deadline_at.clone(),
        };
        let asked = self
            .person_waits
            .ask_person(&live.scope, step, &opened, &ask, None)
            .await;
        if let Err(error) = asked {
            live.record
                .fault(Some(step), EngineFault::WaitNotReattached, error.as_ref())
                .await;
        }
    }

    /// Ends `run`, which cannot be driven again, crashed with `error` in one write that cancels
    /// each unsettled step on a `workflow.step.canceled` of its own and settles the question a
    /// form's or a reply's wait holds, then withdraws each approval's card; a refused write leaves
    /// its rows for the next restart, off the clock.
    async fn end_unrunnable(&mut self, run: UnrunnableRun<'_>, error: WorkflowStepError) {
        let UnrunnableRun {
            keys,
            run_id,
            is_admitted,
            person_wait,
            posts_results,
            epoch,
            steps,
        } = run;
        let record = self
            .recorder
            .for_run(run_id, Arc::new(RunRedaction::new(&[])));
        let unsettled: Vec<&ReloadedStep> = steps.iter().filter(|row| is_kept_row(row)).collect();
        let mut counts = RunStepCounts::default();
        for row in &unsettled {
            counts.moved(None, (row.status, row.wait_cause));
        }
        if is_admitted {
            counts.admitted();
        }
        let session_id = keys.session_id;
        let mut commit = RunTurnCommit::new(
            keys,
            run_id,
            epoch,
            counts,
            person_wait,
            Arc::clone(&self.payloads),
        );
        let now = WireInstant::now();
        let mut cards = Vec::new();
        for row in &unsettled {
            commit.canceled_at_restart(&row.step, &now, (row.status, row.wait_cause));
            let Some(wait_id) = row.wait_id else {
                continue;
            };
            match row.wait_cause {
                Some(WorkflowWaitCause::Form | WorkflowWaitCause::Reply) => {
                    commit.settle_wait_question(&wait_id, QuestionWaitOutcome::Ended, &now);
                }
                Some(WorkflowWaitCause::Approval) => cards.push((row.step.clone(), wait_id)),
                Some(WorkflowWaitCause::Account | WorkflowWaitCause::Chain) | None => {}
            }
        }
        commit.end(RunEnding::Crashed { error: Some(error) }, posts_results);
        match commit
            .append(
                &self.appender,
                &record,
                std::iter::empty::<RunLiveStep<'_>>(),
            )
            .await
        {
            Ok(_) => {
                self.binder.note_context_changed(session_id);
                if let Err(error) = self.binder.sweep_released_run(session_id).await {
                    let fault = EngineFault::RemovedTreeSweepFailed;
                    record.fault(None, fault, &error).await;
                }
                for (step, wait_id) in cards {
                    let intent = EngineIntent::WithdrawingCard { wait_id };
                    let pending = record.intent(Some(&step), intent).await;
                    let outcome = match self.person_waits.cards.withdraw(session_id, wait_id).await
                    {
                        Ok(()) => EngineOutcome::Done,
                        Err(_failed) => EngineOutcome::Failed { code: None },
                    };
                    record.outcome(pending, outcome).await;
                }
            }
            Err(failure) => {
                self.deadlines.skip_run(run_id);
                self.dropped_waits
                    .extend(unsettled.iter().filter_map(|row| row.wait_id));
                record
                    .fault(None, EngineFault::TurnWriteFailed, &failure.error)
                    .await;
            }
        }
        self.recorder.end_run(run_id);
    }
}

/// Whether `row` is a step the run still has to settle.
fn is_kept_row(row: &ReloadedStep) -> bool {
    matches!(
        row.status,
        WorkflowStepStatus::Pending
            | WorkflowStepStatus::WaitingMemory
            | WorkflowStepStatus::Running
            | WorkflowStepStatus::Waiting
    )
}

/// The cancel of `step` at `at` the sweep settles it with, its cut hold begun at `hold_started_at`
/// where the memory gate held it.
fn canceled_report(
    step: WorkflowStepKey,
    at: WireInstant,
    hold_started_at: Option<WireInstant>,
) -> StepReport {
    StepReport {
        step,
        at,
        kind: StepReportKind::Settled(StepSettlement::Canceled {
            hold_started_at,
            cancellation_reason: None,
        }),
    }
}

/// What is left at the restart of a retry's `wait` begun at `readied_at`, zero once it has passed.
fn retry_wait_left(readied_at: &WireInstant, wait: Duration) -> Duration {
    let elapsed = readied_at
        .timestamp()
        .and_then(|at| Duration::try_from(jiff::Timestamp::now().duration_since(at)).ok())
        .unwrap_or(Duration::ZERO);
    wait.saturating_sub(elapsed)
}

/// The error a run's crashed ending stores where its log could not be followed back, saying
/// `reason`.
fn unfollowed(reason: &str) -> WorkflowStepError {
    uncoded_step_error(format!(
        "The run could not be taken back after the daemon stopped: {reason}."
    ))
}
