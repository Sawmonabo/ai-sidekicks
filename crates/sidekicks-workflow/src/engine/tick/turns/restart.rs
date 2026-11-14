//! The tick's restart: each unfinished run of a session recovery rebuilt taken back into the live
//! set, at the engine's start or for a session settled later, its walk replayed from the log with
//! the ending its cancel or failure decided and the waves it canceled, and the crash sweep queued
//! as its next batch, so the loop's next turn writes every row the sweep moves on an event of its
//! own. A step that was running fails as crashed and parks its run; a wave's members settle as
//! their wave; a held or pending step of a stopped run, or one a merge's win lost, is canceled; a
//! held step of any other run is held again and a pending one dispatched, a retry attempt once
//! what is left of its wait has passed; a waiting step keeps its wait, asked again where its ask
//! is gone. A run with no step left ends crashed, and a run whose version or log no longer reads
//! ends crashed with the reason, each of its steps canceled on an event of its own.
#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's restart, which hands each recovered session's runs to the tick"
    )
)]

mod replay;
mod unrunnable;
mod waits;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::workflow::definition::item::{WorkflowItem, WorkflowStepError};
use sidekicks_contracts::workflow::run::status::{WorkflowStepStatus, WorkflowWaitCause};
use sidekicks_contracts::workflow::run::step::events::WorkflowPhaseCancellationReason;
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;
use sidekicks_std::scheduler::armed_instant::InstantJob as _;

use self::replay::{ReplayedRun, replay_run, replayed_epoch, reused_seeds};
use self::unrunnable::UnrunnableRun;
use super::EngineTick;
use super::reports::stop_agent_run;
use super::retries::{arm_retry, retry_wait_left};
use super::starting::{seeded_run, trigger_inputs};
use crate::engine::event_record::EngineFault;
use crate::engine::start::{ReloadedRun, ReloadedScope, ReloadedStep};
use crate::engine::tick::branch_cancellation::BranchWave;
use crate::engine::tick::commit::RunEnding;
use crate::engine::tick::live_runs::{LiveRun, LiveStep, ParkCanceledStep};
use crate::engine::tick::run_status::RunPersonWait;
use crate::engine::tick::step_failure::{RunStop, crashed_step_failure, step_retry};
use crate::engine::tick::walk::WalkReady;
use crate::engine::tick::{StepReport, StepReportKind, StepSettlement};
use crate::kinds::uncoded_step_error;
use crate::runs::step_payload::read_step_payload;

impl EngineTick {
    /// Takes back `runs`, the unfinished runs of a session recovery rebuilt, in order: each run's
    /// sweep is its next batch, which the loop's next turn writes before it reads the deadline
    /// clock, and with no sweep to write the clock is read here. A run the tick already holds is
    /// left as it is.
    pub(crate) async fn restart(&mut self, runs: Vec<ReloadedRun>) {
        for reloaded in runs {
            if !self.runs.contains_key(&reloaded.run_id) {
                self.take_back(reloaded).await;
            }
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
    /// Fails with the reason when the walk and the rows disagree on a step, a person's wait names
    /// no wait or no ask, or an input does not read.
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
            let node_id = ready.step.node_id.as_str();
            let row = by_index
                .get(&ready.step.execution_index.get())
                .filter(|row| row.step == ready.step)
                .ok_or_else(|| format!("no row holds the step of node {node_id}"))?;
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
                    "the step of node {node_id} stands otherwise in its row than in the log"
                ));
            }
            let is_person_wait = row.status == WorkflowStepStatus::Waiting
                && matches!(
                    row.wait_cause,
                    Some(
                        WorkflowWaitCause::Approval
                            | WorkflowWaitCause::Form
                            | WorkflowWaitCause::Reply
                    )
                );
            let is_asked = replayed
                .asks
                .contains_key(&ready.step.execution_index.get());
            if is_person_wait && (row.wait_id.is_none() || !is_asked) {
                return Err(format!(
                    "the wait of the step of node {node_id} names no wait or no ask"
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
        let kept_unsettled = kept
            .iter()
            .filter(|(_, row, _)| unrunnable::is_kept_row(row))
            .count();
        if kept_unsettled
            != rows
                .iter()
                .filter(|row| unrunnable::is_kept_row(row))
                .count()
        {
            return Err("a step's row stands unsettled where the log settled it".to_owned());
        }
        Ok(kept)
    }

    /// Makes the kept steps of `replayed` live and queues its sweep. A running step fails as
    /// crashed, which parks a run whose ending is undecided; a wave's members settle as their
    /// wave. A held or pending step of a stopped run, or one a merge's win lost, is canceled, a
    /// park's kept for the Resume; any other run's held step is held again and its pending step
    /// dispatched, each taking back the agent run it made, and a retry attempt waits out what is
    /// left of its wait. A waiting step keeps its wait. Every agent run a step the sweep settles
    /// had made is stopped. A run left with no step ends crashed in the same write.
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
            waves,
            merge_losers,
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
        let winding_down: HashMap<u64, WorkflowPhaseCancellationReason> = waves
            .iter()
            .flat_map(|wave| {
                let members = wave.members.iter();
                members.map(|member| (member.execution_index.get(), wave.reason))
            })
            .collect();
        let mut crashing: Vec<WorkflowStepKey> = Vec::new();
        let mut canceling: Vec<WorkflowStepKey> = Vec::new();
        let mut held: Vec<WorkflowStepKey> = Vec::new();
        let mut pending: Vec<WorkflowStepKey> = Vec::new();
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
            live_step.is_winding_down = winding_down.contains_key(&index);
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
                    if !self
                        .take_wait_back(&mut live, &mut live_step, row, stored)
                        .await
                    {
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
        let is_stopped = live.stop.is_some() || !crashing.is_empty();
        let is_parked = is_stopped && live.ending.is_none();
        crashing.sort_by_key(|step| step.execution_index.get());
        for step in crashing {
            self.stop_stored_run(&live, &step).await;
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
        live.waves = waves
            .into_iter()
            .map(|wave| BranchWave::new(wave.deciding, wave.reason, wave.members))
            .collect();
        for step in canceling {
            self.stop_stored_run(&live, &step).await;
            let index = step.execution_index.get();
            let live_step = live.steps.get_mut(&index).expect("a wave's member is live");
            live_step.is_park_canceled = is_parked
                && winding_down[&index] == WorkflowPhaseCancellationReason::SiblingFailure;
            live.next_batch
                .push(canceled_report(step, now.clone(), None));
        }
        for step in held {
            let index = step.execution_index.get();
            let is_lost = merge_losers.contains(&index);
            if is_stopped || is_lost {
                self.stop_stored_run(&live, &step).await;
            }
            let live_step = live.steps.get_mut(&index).expect("a held step is live");
            if is_stopped || is_lost {
                // The cut hold ends at its last report.
                live_step.is_park_canceled = is_parked && !is_lost;
                live_step.is_merge_canceled = is_lost;
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
                live.taken_back.insert(index);
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
        for step in pending {
            let index = step.execution_index.get();
            let is_lost = merge_losers.contains(&index);
            if is_stopped || is_lost {
                self.stop_stored_run(&live, &step).await;
                let live_step = live.steps.get_mut(&index).expect("a pending step is live");
                live_step.is_park_canceled = is_parked && !is_lost;
                live_step.is_merge_canceled = is_lost;
                live.next_batch
                    .push(canceled_report(step, now.clone(), None));
                continue;
            }
            live.taken_back.insert(index);
            // A retry attempt waits out what is left of its wait, a past one dispatched at once.
            let left = retried_at.get(&index).map_or(Duration::ZERO, |readied_at| {
                let node = live
                    .scope
                    .nodes
                    .get(&step.node_id)
                    .expect("a live step's node is one of the run's");
                retry_wait_left(readied_at, step_retry(node).wait)
            });
            if left.is_zero() {
                live.held.dispatches.push(step);
            } else {
                arm_retry(&mut self.retries, step, left, live.scope.cancel.clone());
            }
        }
        // A run with no step left lost nothing at the stop that it could go on with.
        if live.steps.is_empty() && live.park_canceled.is_empty() && live.ending.is_none() {
            live.stop = Some(RunStop::End);
            live.ending = Some(RunEnding::Crashed { error: None });
        }
        live.follow_cap(&self.deadlines, false);
        let is_batched = !live.next_batch.is_empty()
            || !live.held.dispatches.is_empty()
            || !live.pausing.is_empty()
            || live.ending.is_some();
        self.runs.insert(run_id, live);
        if is_batched {
            self.batched.push(run_id);
        }
    }

    /// Stops the agent run `step` of `live` made before the stop, where it made one, since the
    /// queue's recovery starts it again and the sweep settles the step; a run that cannot be read
    /// is recorded as a stop not sent.
    async fn stop_stored_run(&self, live: &LiveRun, step: &WorkflowStepKey) {
        match self.dispatch.reattach_agent_run(step).await {
            Ok(run) => stop_agent_run(live, step, run).await,
            Err(error) => {
                live.record
                    .fault(Some(step), EngineFault::AgentRunStopFailed, error.as_ref())
                    .await;
            }
        }
    }
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

/// The error a run's crashed ending stores where its log could not be followed back, saying
/// `reason`.
fn unfollowed(reason: &str) -> WorkflowStepError {
    uncoded_step_error(format!(
        "The run could not be taken back after the daemon stopped: {reason}."
    ))
}
