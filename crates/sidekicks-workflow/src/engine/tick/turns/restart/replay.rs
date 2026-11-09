//! The restart's replay of a reloaded run's events onto a fresh walk: every settlement, retry,
//! park, cancel and Resume the log holds walked again in log order, each settled step's outputs
//! read back, so the walk's rounds, loops and joins stand as they stood when the daemon stopped.

use std::collections::{HashMap, HashSet};

use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::item::WorkflowItem;
use sidekicks_contracts::workflow::run::events::WorkflowRunFailedOutcome;
use sidekicks_contracts::workflow::run::snapshot::WorkflowRunEpoch;
use sidekicks_contracts::workflow::run::step::events::WorkflowPhaseSuspendedPayload;
use sidekicks_contracts::workflow::run::step::record::{WorkflowPayloadRef, WorkflowStepKey};

use crate::engine::ports::StepPayloadArtifacts;
use crate::engine::start::{ReplayedEvent, StartedReusedStep};
use crate::engine::tick::live_runs::LiveRun;
use crate::engine::tick::step_failure::RunStop;
use crate::engine::tick::walk::{ReusedSeedStep, ReusedStepRecord, WalkSkipReason, WalkTurn};
use crate::expressions::lineage::{StepKey, StepOutput};
use crate::runs::projection::{step_key, suspended_step};
use crate::runs::step_payload::{read_step_payload, split_step_outputs, stored_output_lengths};

/// A reloaded run walked again: its live run, its failed parks and the steps a park canceled, both
/// still in its walk, and what its log says of its steps still to settle.
pub(super) struct ReplayedRun {
    /// The run on its replayed walk, its outputs, epoch and approval pauses.
    pub(super) live: LiveRun,
    /// The failed steps its park keeps, which its Resume runs again.
    pub(super) failed_parks: Vec<WorkflowStepKey>,
    /// The steps its park canceled before they settled, in the order they were canceled.
    pub(super) park_canceled: Vec<WorkflowStepKey>,
    /// The steps that were winding down, by execution index.
    pub(super) winding_down: HashSet<u64>,
    /// The instant of each held step's last hold report, by execution index.
    pub(super) last_hold_reports: HashMap<u64, WireInstant>,
    /// The sequence of the run's newest replayed event.
    pub(super) newest_sequence: SafeInt<0>,
}

/// The earlier steps a node run or a retry replays, as its own reused skips name them, each with
/// its outputs read back through `payloads`, in log order, all from `session_id`, the run's
/// session, where each skip stored them again. Fails with the reason when an output does not read.
pub(super) async fn reused_seeds(
    events: &[ReplayedEvent],
    session_id: SessionId,
    payloads: &dyn StepPayloadArtifacts,
) -> Result<Vec<StartedReusedStep>, String> {
    let mut seeds = Vec::new();
    for replayed in events {
        let SessionEvent::WorkflowStepSkipped(skipped) = &replayed.event else {
            continue;
        };
        let Some(from) = &skipped.reused_from else {
            continue;
        };
        let output_lengths = stored_output_lengths(&skipped.output_item_counts);
        let outputs = read_outputs(payloads, &skipped.output_ref, &output_lengths).await?;
        seeds.push(StartedReusedStep {
            seed: ReusedSeedStep {
                node_id: skipped.node_id.clone(),
                output_lengths,
                record: ReusedStepRecord {
                    from: from.clone(),
                    input_ref: skipped.input_ref.clone(),
                    output_ref: skipped.output_ref.clone(),
                    pin_hash: skipped.pin_hash.clone(),
                    outputs,
                },
            },
            session_id,
        });
    }
    Ok(seeds)
}

/// The run's execution as its newest Resume left it, 0 before any.
pub(super) fn replayed_epoch(events: &[ReplayedEvent]) -> WorkflowRunEpoch {
    events
        .iter()
        .rev()
        .find_map(|replayed| {
            if let SessionEvent::WorkflowRunResumed(resumed) = &replayed.event {
                Some(resumed.epoch)
            } else {
                None
            }
        })
        .unwrap_or(WorkflowRunEpoch(SafeInt::ZERO))
}

/// Walks `live`, a run before any step, through `events` in log order, each settled step's
/// outputs read back through `payloads`. Fails with the reason when the log names a step the walk
/// does not hold, a failure whose route it never wrote, an ending that is not a park, a re-pin, or
/// an output that does not read.
pub(super) async fn replay_run(
    live: LiveRun,
    events: &[ReplayedEvent],
    payloads: &dyn StepPayloadArtifacts,
) -> Result<ReplayedRun, String> {
    let mut replay = Replay {
        run: ReplayedRun {
            live,
            failed_parks: Vec::new(),
            park_canceled: Vec::new(),
            winding_down: HashSet::new(),
            last_hold_reports: HashMap::new(),
            newest_sequence: SafeInt::ZERO,
        },
        failing: Vec::new(),
        payloads,
    };
    for replayed in events {
        replay.run.newest_sequence = replayed.sequence;
        replay.apply(replayed).await?;
        replay.flush();
    }
    if !replay.failing.is_empty() {
        return Err("a failed step's route was never written".to_owned());
    }
    Ok(replay.run)
}

/// A replay under way: the run so far, and the failed steps whose route the log has yet to name.
struct Replay<'payloads> {
    run: ReplayedRun,
    failing: Vec<WorkflowStepKey>,
    payloads: &'payloads dyn StepPayloadArtifacts,
}

impl Replay<'_> {
    /// Walks the run through `replayed`.
    #[expect(
        clippy::wildcard_enum_match_arm,
        reason = "the reload reads only the replayed event types, each handled here"
    )]
    async fn apply(&mut self, replayed: &ReplayedEvent) -> Result<(), String> {
        let live = &mut self.run.live;
        match &replayed.event {
            SessionEvent::WorkflowRunStarted(_) => {
                let started = live.walk.start();
                self.take(started);
            }
            SessionEvent::WorkflowStepCompleted(completed) => {
                let step = step_key!(completed);
                self.settle(&step, &completed.output_ref, &completed.output_item_counts)
                    .await?;
            }
            SessionEvent::WorkflowStepFailed(failed) => {
                let step = step_key!(failed);
                if let Some(passed_on) = &failed.passed_on {
                    self.settle(&step, &passed_on.output_ref, &passed_on.output_item_counts)
                        .await?;
                } else {
                    self.unsettled(&step)?;
                    self.failing.push(step);
                }
            }
            SessionEvent::WorkflowPhaseRetried(retried) => {
                let next = step_key!(retried);
                let position = self
                    .failing
                    .iter()
                    .position(|failed| {
                        failed.node_id == next.node_id
                            && failed.attempt.get() + 1 == next.attempt.get()
                    })
                    .ok_or_else(|| "a retry follows no failed step".to_owned())?;
                let failed = self.failing.remove(position);
                if live.walk.retry(&failed).step != next {
                    return Err("a retry's attempt is not the one the walk readies".to_owned());
                }
            }
            SessionEvent::WorkflowRunFailed(failed) => match failed.outcome {
                WorkflowRunFailedOutcome::Parked => {
                    self.run.failed_parks.append(&mut self.failing);
                    live.stop = Some(RunStop::Park);
                }
                WorkflowRunFailedOutcome::Ended => {
                    return Err("an unfinished run's log holds its failed ending".to_owned());
                }
            },
            SessionEvent::WorkflowStepCanceled(canceled) => {
                let step = step_key!(canceled);
                let index = step.execution_index.get();
                self.run.winding_down.remove(&index);
                self.run.last_hold_reports.remove(&index);
                // A step the walk canceled itself never stayed in it.
                if live.walk.is_unsettled(&step) {
                    if live.stop.is_some() || !self.failing.is_empty() {
                        self.run.park_canceled.push(step);
                    } else {
                        live.walk.drop_step(&step);
                    }
                }
            }
            SessionEvent::WorkflowRunResumed(resumed) => {
                if resumed.repinned_to_workflow_version_id.is_some() {
                    return Err("a Resume moved the run to another version".to_owned());
                }
                live.epoch = resumed.epoch;
                live.approval_pauses = 0;
                self.run
                    .failed_parks
                    .sort_by_key(|step| step.execution_index.get());
                let again = self
                    .run
                    .failed_parks
                    .drain(..)
                    .chain(self.run.park_canceled.drain(..));
                for step in again {
                    live.walk.retry(&step);
                }
                live.stop = None;
            }
            SessionEvent::WorkflowPhaseSuspended(suspended) => {
                if matches!(suspended, WorkflowPhaseSuspendedPayload::Approval { .. }) {
                    live.approval_pauses += 1;
                }
                let index = suspended_step(suspended).execution_index.get();
                self.run.last_hold_reports.remove(&index);
            }
            SessionEvent::WorkflowPhaseWaitingOnMemory(held) => {
                self.run
                    .last_hold_reports
                    .insert(held.execution_index.get(), replayed.at.clone());
            }
            SessionEvent::WorkflowPhaseAdmitted(admitted) => {
                self.run
                    .last_hold_reports
                    .remove(&admitted.execution_index.get());
            }
            SessionEvent::WorkflowPhaseCanceling(canceling) => {
                self.run
                    .winding_down
                    .insert(canceling.execution_index.get());
            }
            // The walk makes each skip itself; a reused one's outputs came with its seed.
            SessionEvent::WorkflowStepSkipped(_) => {}
            _ => unreachable!("the reload reads only the replayed event types"),
        }
        Ok(())
    }

    /// Fails unless the walk holds `step` unsettled.
    fn unsettled(&self, step: &WorkflowStepKey) -> Result<(), String> {
        if self.run.live.walk.is_unsettled(step) {
            Ok(())
        } else {
            Err(format!(
                "the log settles a step of node {} the walk does not hold",
                step.node_id.as_str()
            ))
        }
    }

    /// Settles `step` in the walk on the outputs `output_ref` stores, split by `counts`, which move
    /// into the run's outputs beside its sources.
    async fn settle(
        &mut self,
        step: &WorkflowStepKey,
        output_ref: &WorkflowPayloadRef,
        counts: &[SafeInt<0>],
    ) -> Result<(), String> {
        self.unsettled(step)?;
        let output_lengths = stored_output_lengths(counts);
        let outputs = read_outputs(self.payloads, output_ref, &output_lengths).await?;
        let live = &mut self.run.live;
        let sources = live
            .walk
            .unsettled()
            .find(|ready| ready.step == *step)
            .map(|ready| ready.sources)
            .expect("the walk holds the step unsettled");
        let walked = live.walk.settle(step, &output_lengths);
        live.outputs.record(
            StepKey {
                node_id: step.node_id.clone(),
                execution_index: step.execution_index.get(),
            },
            StepOutput { sources, outputs },
        );
        let index = step.execution_index.get();
        self.run.winding_down.remove(&index);
        self.run.last_hold_reports.remove(&index);
        self.take(walked);
        Ok(())
    }

    /// Keeps what the walk answered: each reused skip's outputs as its step's. A readied step
    /// stays in the walk until the log settles it; the losers of a win and the steps the walk
    /// canceled follow as their own cancels.
    fn take(&mut self, walked: WalkTurn) {
        let live = &mut self.run.live;
        for mut skip in walked.skipped {
            if let WalkSkipReason::Reused(reused) = &mut skip.reason {
                let outputs = std::mem::take(&mut reused.outputs);
                live.outputs.record(
                    StepKey {
                        node_id: skip.step.node_id.clone(),
                        execution_index: skip.step.execution_index.get(),
                    },
                    StepOutput {
                        sources: skip.sources.clone(),
                        outputs,
                    },
                );
            }
        }
    }

    /// Flushes the walk while no step is live in it, as a quiet run's turn does.
    fn flush(&mut self) {
        loop {
            let flushed = self.run.live.walk.flush();
            if flushed.ready.is_empty()
                && flushed.skipped.is_empty()
                && flushed.wins.is_empty()
                && flushed.canceled.is_empty()
            {
                return;
            }
            self.take(flushed);
        }
    }
}

/// The outputs `output_ref` stores, read through `payloads` and split by `output_lengths`. Fails
/// with the reason when they do not read.
async fn read_outputs(
    payloads: &dyn StepPayloadArtifacts,
    output_ref: &WorkflowPayloadRef,
    output_lengths: &[usize],
) -> Result<Vec<Vec<WorkflowItem>>, String> {
    let items = read_step_payload(payloads, output_ref)
        .await
        .map_err(|error| error.to_string())?;
    split_step_outputs(items, output_lengths).map_err(|error| error.to_string())
}
