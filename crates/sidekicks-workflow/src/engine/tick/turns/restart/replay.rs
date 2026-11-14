//! The restart's replay of a reloaded run's events onto a fresh walk: every settlement, retry,
//! park, cancel and Resume the log holds walked again in log order, each settled step's outputs
//! read back, so the walk's rounds, loops and joins stand as they stood when the daemon stopped,
//! with the ending a cancel or a failure decided and each wave of branches it canceled.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

use serde_json::Value;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::document::WorkflowVersionId;
use sidekicks_contracts::workflow::definition::item::WorkflowItem;
use sidekicks_contracts::workflow::run::events::{
    WorkflowRunFailedOutcome, WorkflowRunResumedPayload,
};
use sidekicks_contracts::workflow::run::snapshot::WorkflowRunEpoch;
use sidekicks_contracts::workflow::run::step::events::WorkflowPhaseCancellationReason;
use sidekicks_contracts::workflow::run::step::events::suspended::WorkflowPhaseSuspendedPayload;
use sidekicks_contracts::workflow::run::step::record::{WorkflowPayloadRef, WorkflowStepKey};

use super::super::resuming::{RepinTarget, move_run};
use crate::engine::ports::StepPayloadArtifacts;
use crate::engine::start::{ReloadedRepin, ReplayedEvent, StartedReusedStep};
use crate::engine::tick::commit::{RunEnding, StoredRunVariable};
use crate::engine::tick::live_runs::LiveRun;
use crate::engine::tick::step_failure::RunStop;
use crate::engine::tick::walk::{
    KeptStep, ReusedSeedStep, ReusedStepRecord, WalkSkipReason, WalkTurn,
};
use crate::expressions::lineage::{StepKey, StepOutput};
use crate::kinds::PersonAsk;
use crate::kinds::step_context::{StepRecords, StepRunVariable};
use crate::runs::projection::{step_key, suspended_step};
use crate::runs::step_payload::{read_step_payload, split_step_outputs, stored_output_lengths};

/// A reloaded run walked again: its live run, its kept failures and the steps a park canceled, both
/// still in its walk, and what its log says of its steps still to settle.
pub(super) struct ReplayedRun {
    /// The run on its replayed walk, its outputs, epoch, approval pauses, stop and decided ending.
    pub(super) live: LiveRun,
    /// The failed steps the run keeps live, by a park or under its decided ending, which a Resume
    /// of a park runs again.
    pub(super) failed_parks: Vec<WorkflowStepKey>,
    /// The steps its park canceled before they settled, in the order they were canceled.
    pub(super) park_canceled: Vec<WorkflowStepKey>,
    /// The waves of running steps still winding down, in the order they were decided.
    pub(super) waves: Vec<ReplayedWave>,
    /// The steps a first-to-arrive merge's win canceled before they settled, by execution index.
    pub(super) merge_losers: HashSet<u64>,
    /// The instant of each held step's last hold report, by execution index.
    pub(super) last_hold_reports: HashMap<u64, WireInstant>,
    /// The instant each retry attempt not yet settled was readied at, by execution index.
    pub(super) retried_at: HashMap<u64, WireInstant>,
    /// The log lines and run variables each step parked on a spent account had recorded, by
    /// execution index.
    pub(super) parked_records: HashMap<u64, StepRecords>,
    /// What each step waiting on a person asks, by execution index.
    pub(super) asks: HashMap<u64, ReplayedAsk>,
    /// The sequence of the run's newest replayed event.
    pub(super) newest_sequence: SafeInt<0>,
}

/// A wave of running steps one turn canceled together, as its `workflow.phase.canceling` events
/// name it: the step whose turn decided it, why, and its members still winding down, in order.
pub(super) struct ReplayedWave {
    /// The step whose turn decided the wave.
    pub(super) deciding: WorkflowStepKey,
    /// Why its members were canceled.
    pub(super) reason: WorkflowPhaseCancellationReason,
    /// Its members, none settled yet.
    pub(super) members: Vec<WorkflowStepKey>,
}

/// What a step waiting on a person asks, when it began waiting, and for an approval the pause
/// number its snapshot point takes.
pub(super) struct ReplayedAsk {
    /// What the person is asked.
    pub(super) ask: PersonAsk,
    /// When the step began waiting.
    pub(super) started_at: WireInstant,
    /// The pause number of an approval's snapshot point, `None` for a form or a reply.
    pub(super) pause_number: Option<u64>,
}

/// The earlier steps a node run or a retry replays, every one its started event among `events`
/// names, each with its outputs read back through `payloads`, all from `session_id`, the run's
/// session, where its start stored them. Fails with the reason when an output does not read.
pub(super) async fn reused_seeds(
    events: &[ReplayedEvent],
    session_id: SessionId,
    payloads: &dyn StepPayloadArtifacts,
) -> Result<Vec<StartedReusedStep>, String> {
    let Some(started) = events.iter().find_map(|replayed| {
        if let SessionEvent::WorkflowRunStarted(started) = &replayed.event {
            Some(started)
        } else {
            None
        }
    }) else {
        return Ok(Vec::new());
    };
    let mut seeds = Vec::with_capacity(started.reused_steps.len());
    for reused in &started.reused_steps {
        let output_lengths = stored_output_lengths(&reused.output_item_counts);
        let outputs = read_outputs(payloads, &reused.output_ref, &output_lengths).await?;
        seeds.push(StartedReusedStep {
            seed: ReusedSeedStep {
                node_id: reused.node_id.clone(),
                output_lengths,
                record: ReusedStepRecord {
                    from: reused.reused_from.clone(),
                    input_ref: reused.input_ref.clone(),
                    output_ref: reused.output_ref.clone(),
                    pin_hash: reused.pin_hash.clone(),
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
/// outputs read back through `payloads`, and each Resume that moved it to another version onto
/// that version's entry in `repins`. Fails with the reason when the log names a step the walk
/// does not hold, a failure whose route it never wrote, an ending that ended the run, a re-pin
/// whose version or kept step it cannot follow, or an output that does not read.
pub(super) async fn replay_run(
    live: LiveRun,
    events: &[ReplayedEvent],
    repins: Vec<ReloadedRepin>,
    payloads: &dyn StepPayloadArtifacts,
) -> Result<ReplayedRun, String> {
    let mut replay = Replay {
        run: ReplayedRun {
            live,
            failed_parks: Vec::new(),
            park_canceled: Vec::new(),
            waves: Vec::new(),
            merge_losers: HashSet::new(),
            last_hold_reports: HashMap::new(),
            retried_at: HashMap::new(),
            parked_records: HashMap::new(),
            asks: HashMap::new(),
            newest_sequence: SafeInt::ZERO,
        },
        failing: Vec::new(),
        output_lengths: HashMap::new(),
        repins: repins.into_iter(),
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

/// A replay under way: the run so far, the failed steps whose route the log has yet to name, the
/// output lengths of each step it settled by execution index, and the re-pins still to follow.
struct Replay<'payloads> {
    run: ReplayedRun,
    failing: Vec<WorkflowStepKey>,
    output_lengths: HashMap<u64, Vec<usize>>,
    repins: std::vec::IntoIter<ReloadedRepin>,
    payloads: &'payloads dyn StepPayloadArtifacts,
}

impl Replay<'_> {
    /// Walks the run through `replayed`.
    #[expect(
        clippy::wildcard_enum_match_arm,
        reason = "the reload reads only the replayed event types, each handled here"
    )]
    async fn apply(&mut self, replayed: &ReplayedEvent) -> Result<(), String> {
        match &replayed.event {
            SessionEvent::WorkflowRunStarted(_) => {
                let started = self.run.live.walk.start();
                self.take(started);
            }
            SessionEvent::WorkflowRunCanceling(canceling) => {
                let live = &mut self.run.live;
                live.stop = Some(RunStop::End);
                live.ending = Some(RunEnding::Canceled {
                    reason: canceling.reason.clone(),
                    error: canceling.error.clone(),
                });
            }
            SessionEvent::WorkflowRunFailing(failing) => {
                let ending_step = WorkflowStepKey {
                    workflow_run_id: failing.workflow_run_id,
                    node_id: failing.ending_step.node_id.clone(),
                    attempt: failing.ending_step.attempt,
                    execution_index: failing.ending_step.execution_index,
                };
                // The ending step keeps its failed row; a parked one is kept already.
                if let Some(position) = self.failing.iter().position(|step| *step == ending_step) {
                    let failed = self.failing.remove(position);
                    self.run.failed_parks.push(failed);
                }
                let live = &mut self.run.live;
                live.stop = Some(RunStop::End);
                live.ending = Some(RunEnding::Failed {
                    step: ending_step,
                    error: failing.error.clone(),
                });
            }
            SessionEvent::WorkflowStepCompleted(completed) => {
                let step = step_key!(completed);
                self.settle(&step, &completed.output_ref, &completed.output_item_counts)
                    .await?;
                if let Some(run_variables_ref) = &completed.run_variables_ref {
                    let set = read_run_variables(self.payloads, run_variables_ref).await?;
                    let variables = Arc::make_mut(&mut self.run.live.run_variables);
                    for (name, variable) in set {
                        variables.insert(name, variable.value);
                    }
                }
            }
            SessionEvent::WorkflowStepFailed(failed) => {
                let step = step_key!(failed);
                if let Some(passed_on) = &failed.passed_on {
                    self.settle(&step, &passed_on.output_ref, &passed_on.output_item_counts)
                        .await?;
                } else {
                    self.unsettled(&step)?;
                    self.run.retried_at.remove(&step.execution_index.get());
                    // A stopped run keeps a failure live as it is, its route written with no event.
                    if self.run.live.stop.is_some() {
                        self.run.failed_parks.push(step);
                    } else {
                        self.failing.push(step);
                    }
                }
            }
            SessionEvent::WorkflowPhaseRetried(retried) => {
                let next = step_key!(retried);
                let is_retried = |failed: &WorkflowStepKey| {
                    failed.node_id == next.node_id && failed.attempt.get() + 1 == next.attempt.get()
                };
                let failed = if let Some(position) = self.failing.iter().position(is_retried) {
                    self.failing.remove(position)
                } else if let Some(position) = self.run.failed_parks.iter().position(is_retried) {
                    self.run.failed_parks.remove(position)
                } else {
                    return Err("a retry follows no failed step".to_owned());
                };
                if self.run.live.walk.retry(&failed).step != next {
                    return Err("a retry's attempt is not the one the walk readies".to_owned());
                }
                self.run
                    .retried_at
                    .insert(next.execution_index.get(), replayed.at.clone());
            }
            SessionEvent::WorkflowRunFailed(failed) => match failed.outcome {
                WorkflowRunFailedOutcome::Parked => {
                    self.run.failed_parks.append(&mut self.failing);
                    self.run.live.stop = Some(RunStop::Park);
                }
                WorkflowRunFailedOutcome::Ended => {
                    return Err("an unfinished run's log holds its failed ending".to_owned());
                }
            },
            SessionEvent::WorkflowStepCanceled(canceled) => {
                let step = step_key!(canceled);
                self.forget(&step);
                let is_parked = self.run.live.ending.is_none()
                    && (self.run.live.stop == Some(RunStop::Park) || !self.failing.is_empty());
                let live = &mut self.run.live;
                // A step the walk canceled itself never stayed in it.
                if live.walk.is_unsettled(&step) {
                    if is_parked {
                        self.run.park_canceled.push(step);
                    } else {
                        live.walk.drop_step(&step);
                    }
                }
            }
            SessionEvent::WorkflowRunResumed(resumed) => {
                if let Some(joined) = resumed.repinned_to_workflow_version_id {
                    return self.repin(resumed, joined);
                }
                // A run leaving a wait keeps its execution; only the person's Resume opens one.
                if resumed.epoch == self.run.live.epoch {
                    return Ok(());
                }
                let live = &mut self.run.live;
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
                let pause_number =
                    matches!(suspended, WorkflowPhaseSuspendedPayload::Approval { .. }).then(
                        || {
                            self.run.live.approval_pauses += 1;
                            self.run.live.approval_pauses
                        },
                    );
                let index = suspended_step(suspended).execution_index.get();
                self.run.last_hold_reports.remove(&index);
                if let WorkflowPhaseSuspendedPayload::Account {
                    log_ref,
                    run_variables_ref,
                    ..
                } = suspended
                {
                    let records = read_parked_records(
                        self.payloads,
                        log_ref.as_ref(),
                        run_variables_ref.as_ref(),
                    )
                    .await?;
                    self.run.parked_records.insert(index, records);
                } else if let Some(ask) = suspended_ask(suspended) {
                    let asked = ReplayedAsk {
                        ask,
                        started_at: replayed.at.clone(),
                        pause_number,
                    };
                    self.run.asks.insert(index, asked);
                }
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
                let deciding = WorkflowStepKey {
                    workflow_run_id: canceling.workflow_run_id,
                    node_id: canceling.deciding_step.node_id.clone(),
                    attempt: canceling.deciding_step.attempt,
                    execution_index: canceling.deciding_step.execution_index,
                };
                let reason = canceling.cancellation_reason;
                let member = step_key!(canceling);
                let waves = &mut self.run.waves;
                match waves
                    .iter_mut()
                    .find(|wave| wave.deciding == deciding && wave.reason == reason)
                {
                    Some(wave) => wave.members.push(member),
                    None => waves.push(ReplayedWave {
                        deciding,
                        reason,
                        members: vec![member],
                    }),
                }
            }
            // The walk makes each skip itself; a reused one's outputs came with its seed.
            SessionEvent::WorkflowStepSkipped(skipped) => {
                self.output_lengths.insert(
                    skipped.execution_index.get(),
                    stored_output_lengths(&skipped.output_item_counts),
                );
            }
            _ => unreachable!("the reload reads only the replayed event types"),
        }
        Ok(())
    }

    /// Moves the run to `joined` as the Resume `resumed` did: its next execution opened, its walk
    /// rebuilt on the version's graph over the steps the event kept, and its failed parks and the
    /// steps its park canceled run again. Fails when the re-pin's version was not read or a kept
    /// step's outputs are not the run's.
    fn repin(
        &mut self,
        resumed: &WorkflowRunResumedPayload,
        joined: WorkflowVersionId,
    ) -> Result<(), String> {
        let target = self
            .repins
            .next()
            .filter(|repin| repin.workflow_version_id == joined)
            .ok_or_else(|| {
                "a Resume moved the run to a version the restart did not read".to_owned()
            })?;
        let live = &mut self.run.live;
        let kept = resumed
            .kept_steps
            .iter()
            .map(|kept| {
                let output_lengths = self
                    .output_lengths
                    .get(&kept.execution_index.get())
                    .cloned()
                    .ok_or_else(|| {
                        format!(
                            "a re-pin keeps a step of node {} the run never settled",
                            kept.node_id.as_str()
                        )
                    })?;
                Ok(KeptStep {
                    step: WorkflowStepKey {
                        workflow_run_id: live.scope.run_id,
                        node_id: kept.node_id.clone(),
                        attempt: kept.attempt,
                        execution_index: kept.execution_index,
                    },
                    output_lengths,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        if resumed.epoch != live.epoch {
            live.approval_pauses = 0;
        }
        live.epoch = resumed.epoch;
        let mut failed_parks = std::mem::take(&mut self.run.failed_parks);
        failed_parks.sort_by_key(|step| step.execution_index.get());
        let park_canceled = std::mem::take(&mut self.run.park_canceled);
        let ReloadedRepin {
            workflow_version_id,
            workflow_name,
            nodes,
            graph,
        } = target;
        // A re-pin covers every place of its version.
        let covered = Arc::from(vec![true; graph.node_count()]);
        move_run(
            live,
            RepinTarget {
                workflow_version_id,
                workflow_name,
                nodes,
                graph,
                covered,
                kept,
            },
            &failed_parks,
            park_canceled,
        );
        let started = live.walk.start();
        self.take(started);
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
        self.output_lengths
            .insert(step.execution_index.get(), output_lengths);
        live.outputs.record(
            StepKey {
                node_id: step.node_id.clone(),
                execution_index: step.execution_index.get(),
            },
            StepOutput { sources, outputs },
        );
        self.forget(step);
        self.take(walked);
        Ok(())
    }

    /// Forgets what the replay kept of `step`, which settled: its hold, its retry, its wait, its
    /// merge loss and its place in a wave, the wave dropped once it has no member left.
    fn forget(&mut self, step: &WorkflowStepKey) {
        let index = step.execution_index.get();
        self.run.last_hold_reports.remove(&index);
        self.run.retried_at.remove(&index);
        self.run.parked_records.remove(&index);
        self.run.asks.remove(&index);
        self.run.merge_losers.remove(&index);
        for wave in &mut self.run.waves {
            wave.members.retain(|member| member != step);
        }
        self.run.waves.retain(|wave| !wave.members.is_empty());
    }

    /// Keeps what the walk answered: each reused skip's outputs as its step's, and each loser of a
    /// win the run followed, which a stopped run does not. A readied step stays in the walk until
    /// the log settles it; the losers of a win and the steps the walk canceled follow as their own
    /// cancels.
    fn take(&mut self, walked: WalkTurn) {
        let WalkTurn { skipped, wins, .. } = walked;
        if self.run.live.stop.is_none() {
            for win in wins {
                let losers = win.losers.iter().map(|loser| loser.execution_index.get());
                self.run.merge_losers.extend(losers);
            }
        }
        let live = &mut self.run.live;
        for mut skip in skipped {
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

/// What the person wait `suspended` asks, `None` for a wait on an account or a chain's question.
fn suspended_ask(suspended: &WorkflowPhaseSuspendedPayload) -> Option<PersonAsk> {
    match suspended {
        WorkflowPhaseSuspendedPayload::Approval { prompt, .. } => Some(PersonAsk::Approval {
            prompt: prompt.clone(),
        }),
        WorkflowPhaseSuspendedPayload::Form {
            prompt,
            input_schema,
            ..
        } => Some(PersonAsk::Form {
            prompt: prompt.clone(),
            input_schema: input_schema.clone(),
        }),
        WorkflowPhaseSuspendedPayload::Reply { prompt, .. } => Some(PersonAsk::Reply {
            prompt: prompt.clone(),
        }),
        WorkflowPhaseSuspendedPayload::Account { .. }
        | WorkflowPhaseSuspendedPayload::Chain { .. } => None,
    }
}

/// The records a step parked on a spent account stored with its wait: the lines `log_ref` holds
/// and the run variables `run_variables_ref` holds, read through `payloads`. Fails with the reason
/// when either does not read.
async fn read_parked_records(
    payloads: &dyn StepPayloadArtifacts,
    log_ref: Option<&WorkflowPayloadRef>,
    run_variables_ref: Option<&WorkflowPayloadRef>,
) -> Result<StepRecords, String> {
    let mut records = StepRecords::default();
    if let Some(log_ref) = log_ref {
        let items = read_step_payload(payloads, log_ref)
            .await
            .map_err(|error| error.to_string())?;
        for item in items {
            let line = item
                .json
                .0
                .get("line")
                .and_then(Value::as_str)
                .ok_or_else(|| "a parked step's stored log line does not read".to_owned())?;
            records.log_lines.push(line.to_owned());
        }
    }
    if let Some(run_variables_ref) = run_variables_ref {
        records.run_variables = read_run_variables(payloads, run_variables_ref).await?;
    }
    Ok(records)
}

/// The run variables `run_variables_ref` stores, one item each, read through `payloads`. Fails
/// with the reason when they do not read.
async fn read_run_variables(
    payloads: &dyn StepPayloadArtifacts,
    run_variables_ref: &WorkflowPayloadRef,
) -> Result<BTreeMap<String, StepRunVariable>, String> {
    read_step_payload(payloads, run_variables_ref)
        .await
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(|item| {
            let stored: StoredRunVariable =
                serde_json::from_value(item.json.0).map_err(|error| error.to_string())?;
            Ok((
                stored.name,
                StepRunVariable {
                    value: stored.value,
                    is_kept: stored.is_kept,
                },
            ))
        })
        .collect()
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
