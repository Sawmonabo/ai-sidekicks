//! An agent step's driver: the step's params are evaluated into its agent run's request, the run is
//! created in the step's turn in the entry line, taken once the evaluation has finished and every
//! sibling readied before it has taken its own, which is the step's one entry to the memory gate,
//! and the run is followed through its admission, its start and its progress to its outcome. A
//! run kept while its account was spent is taken again once its resume is written, enters the
//! memory gate again as a creation does, and is followed from its admission through its progress,
//! settling with the records its params kept.

use std::sync::Arc;

use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::workflow::definition::item::WorkflowItem;
use sidekicks_contracts::workflow::run::step::record::{WorkflowPayloadRef, WorkflowStepKey};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::run::execute;
use super::{
    StepDispatch, fill_step_failure, scrub_outputs, settle_launch_failure, stop_agent_run,
};
use crate::engine::event_record::{EngineFault, EngineIntent, EngineOutcome};
use crate::engine::ports::{AgentStepOutcome, AgentStepRun, PortError};
use crate::engine::tick::admission::{GateWaitEnd, SiblingEntry, wait_at_gate};
use crate::engine::tick::node_settings::{
    main_input_lengths, main_output_count, place_on_first_output, shape_outputs,
};
use crate::engine::tick::{
    ParkedAgentRun, ReadyStep, RunScope, RunSnapshot, StepReportKind, StepSettlement,
};
use crate::kinds::step_context::StepRecords;
use crate::kinds::{StepFailure, StepOutcome, uncoded_step_error};

/// What a step reads whose agent run left the memory gate's line unadmitted yet read as completed.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
const WITHDRAWN_RUN_COMPLETED: &str = concat!(
    "the step's agent run left the memory gate's line before it was admitted, ",
    "yet read as completed"
);

/// What following an agent run watches besides its outcome.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
enum AgentRunWatch {
    /// Its start, reported as `Started` with `input_ref` and its level where it differs from the
    /// workflow's `permission_level`, then its progress.
    Start {
        /// The input as the step's `pending` row stores it.
        input_ref: WorkflowPayloadRef,
        /// The level the workflow's steps run at.
        permission_level: PermissionLevel,
    },
    /// Its progress from now on, for a run that started before it parked.
    Progress,
    /// Nothing more, for a run that left the gate unadmitted or was canceled there.
    Outcome,
}

/// Where an agent run's wait at the memory gate left its step.
struct GateLeave {
    /// Whether the gate admitted the run, so its start or progress is watched.
    is_admitted: bool,
    /// Whether the run left the gate's line unadmitted, so a completion reads as a failure.
    is_withdrawn: bool,
    /// When the hold a cancel at the gate ended began.
    hold_started_at: Option<WireInstant>,
}

/// What an agent run's settlement is shaped from besides its outcome.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
struct AgentRunEnd {
    /// Whether the run left the gate's line unadmitted, so a completion reads as a failure.
    is_withdrawn: bool,
    /// When the hold a cancel at the gate ended began.
    hold_started_at: Option<WireInstant>,
    /// The length of each main input, which shapes the outputs' lineage.
    main_input_lengths: Vec<usize>,
    /// The log lines and run variables the step's params recorded.
    records: StepRecords,
}

impl StepDispatch {
    /// Drives `ready`, an agent step of the run of `scope`, reading `snapshot`, to its settlement:
    /// launches it and evaluates its params into its run's request, then takes its turn in the
    /// entry line through its sibling `entry` and creates the run in it, then reports the run's
    /// hold, admission, start and progress and settles with its outcome. A step canceled before
    /// its run is created creates none; one canceled after settles canceled once its stopped run
    /// has ended, and a stop that cannot be sent goes to the engine's record. A step the restart
    /// took back takes the run it made before the stop in place of a creation, and stops that run
    /// where it settles first.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(super) async fn drive_agent_step(
        self,
        scope: Arc<RunScope>,
        snapshot: RunSnapshot,
        ready: ReadyStep,
        entry: SiblingEntry,
        cancel: CancellationToken,
    ) {
        let (node, kind) = self.look_up_step(&scope, &ready.step);
        let step = ready.step.clone();
        // A step the restart took back first takes the run it made before the stop, which the
        // queue's recovery starts again, so a settlement before the run is handed over stops it.
        let stored = if ready.is_taken_back {
            Some(self.ports.agent_steps.reattach(&step).await)
        } else {
            None
        };
        let main_input_lengths = main_input_lengths(&kind.spec, &ready.inputs);
        let launched = self
            .launch(&scope, &snapshot, &ready, kind, cancel.clone())
            .await;
        let context = match launched {
            Ok(context) => context,
            Err(failure) => {
                // Every path gives its place up before it reports, so a slow report channel never
                // holds up a sibling.
                drop(entry);
                self.stop_unhanded_run(&scope, &step, stored).await;
                let settlement =
                    settle_launch_failure(failure, &cancel, &node.id, &scope.redaction);
                self.report(&step, &cancel, StepReportKind::Settled(settlement))
                    .await;
                return;
            }
        };
        let answer = execute(node, kind, &context, ready.inputs).await;
        // Taken once: a progress mark made while the params evaluate sends nothing, since nothing
        // may come before `Started`.
        let records = context.finish_records();
        // Closes the step's expressions before anything waits, so nothing of the evaluator stays
        // open for the run's life.
        drop(context);
        let fill = |failure| fill_step_failure(failure, &node.id, &scope.redaction);
        // `Err(None)` is a step canceled while its params evaluated.
        let evaluated = if cancel.is_cancelled() {
            Err(None)
        } else {
            match answer {
                Ok(StepOutcome::AgentRun(request)) => Ok(request),
                Ok(StepOutcome::Outputs(_) | StepOutcome::PersonWait(_)) => Err(Some(
                    StepFailure::Failed(Box::new(uncoded_step_error(format!(
                        "the agent step's kind {} answered no agent run",
                        kind.spec.kind.0.as_str()
                    )))),
                )),
                Err(failure) => Err(Some(failure)),
            }
        };
        let request = match evaluated {
            Ok(request) => request,
            Err(failure) => {
                drop(entry);
                self.stop_unhanded_run(&scope, &step, stored).await;
                let settlement = match failure {
                    None => StepSettlement::Canceled {
                        hold_started_at: None,
                        cancellation_reason: None,
                    },
                    Some(failure) => StepSettlement::Failed {
                        failure: fill(failure),
                        log_lines: records.log_lines,
                    },
                };
                self.report(&step, &cancel, StepReportKind::Settled(settlement))
                    .await;
                return;
            }
        };
        // A step canceled before its turn came holds no turn when it reports, so a slow report
        // channel never holds up the line.
        let Some(turn) = entry.wait_for_turn(&cancel).await else {
            self.stop_unhanded_run(&scope, &step, stored).await;
            let canceled = StepSettlement::Canceled {
                hold_started_at: None,
                cancellation_reason: None,
            };
            self.report(&step, &cancel, StepReportKind::Settled(canceled))
                .await;
            return;
        };
        let created = match stored {
            Some(Ok(Some(run))) => Ok(run),
            Some(Err(error)) => Err(error),
            Some(Ok(None)) | None => self.ports.agent_steps.run(request).await,
        };
        // The run holds its place in the gate's line now, so the turn behind this one may enter.
        drop(turn);
        let run = match created {
            Ok(run) => run,
            Err(error) => {
                let failure = StepFailure::Failed(Box::new(uncoded_step_error(format!(
                    "the step's agent run could not be created: {error}"
                ))));
                let failed = StepSettlement::Failed {
                    failure: fill(failure),
                    log_lines: records.log_lines,
                };
                self.report(&step, &cancel, StepReportKind::Settled(failed))
                    .await;
                return;
            }
        };
        let gate = self.leave_gate(&step, run.as_ref(), &cancel).await;
        let watched = if gate.is_admitted {
            AgentRunWatch::Start {
                input_ref: ready.input_ref,
                permission_level: snapshot.permission_level,
            }
        } else {
            AgentRunWatch::Outcome
        };
        let end = AgentRunEnd {
            is_withdrawn: gate.is_withdrawn,
            hold_started_at: gate.hold_started_at,
            main_input_lengths,
            records,
        };
        let settlement = self
            .follow_agent_run(&scope, &step, run, &cancel, watched, end)
            .await;
        self.report(&step, &cancel, StepReportKind::Settled(settlement))
            .await;
    }

    /// Stops `stored`, as the reattach of `step` of the run of `scope` read it, where the restart
    /// took the step back and it settles before its run is handed over.
    async fn stop_unhanded_run(
        &self,
        scope: &RunScope,
        step: &WorkflowStepKey,
        stored: Option<Result<Option<Box<dyn AgentStepRun>>, PortError>>,
    ) {
        if let Some(stored) = stored {
            let record = self
                .recorder
                .for_run(scope.run_id, Arc::clone(&scope.redaction));
            stop_agent_run(&record, step, stored).await;
        }
    }

    /// Takes `parked`, the kept agent run of `step` of the run of `scope`, whose resume from its
    /// spent account the tick has written, on its own task: the intent recorded, the run's turn
    /// taken again on its account and the outcome recorded, then the run's wait at the memory
    /// gate reported as a creation's is, and the run followed to its settlement under `cancel`
    /// with the records its params kept. A resume that cannot be sent fails the step with the
    /// port's error; a step canceled first stops its run and settles canceled.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) fn resume_agent_step(
        &self,
        scope: &Arc<RunScope>,
        step: WorkflowStepKey,
        inputs: &[Vec<WorkflowItem>],
        parked: ParkedAgentRun,
        cancel: CancellationToken,
    ) {
        let (_, kind) = self.look_up_step(scope, &step);
        let main_input_lengths = main_input_lengths(&kind.spec, inputs);
        tokio::spawn(self.clone().drive_resume(
            Arc::clone(scope),
            step,
            main_input_lengths,
            parked,
            cancel,
        ));
    }

    /// Drives the resume [`Self::resume_agent_step`] spawns to the step's settlement.
    async fn drive_resume(
        self,
        scope: Arc<RunScope>,
        step: WorkflowStepKey,
        main_input_lengths: Vec<usize>,
        parked: ParkedAgentRun,
        cancel: CancellationToken,
    ) {
        let ParkedAgentRun { run, records } = parked;
        let settlement = if cancel.is_cancelled() {
            if let Err(error) = run.cancel().await {
                self.record_fault(
                    &scope,
                    &step,
                    EngineFault::AgentRunStopFailed,
                    error.as_ref(),
                )
                .await;
            }
            StepSettlement::Canceled {
                hold_started_at: None,
                cancellation_reason: None,
            }
        } else {
            let record = self
                .recorder
                .for_run(scope.run_id, Arc::clone(&scope.redaction));
            let intent = EngineIntent::DispatchingResume {
                session_id: scope.session_id,
            };
            let pending = record.intent(Some(&step), intent).await;
            match run.resume().await {
                Ok(()) => {
                    record.outcome(pending, EngineOutcome::Done).await;
                    let gate = self.leave_gate(&step, run.as_ref(), &cancel).await;
                    // A resumed run started before it parked, so only its progress is watched.
                    let watched = if gate.is_admitted {
                        AgentRunWatch::Progress
                    } else {
                        AgentRunWatch::Outcome
                    };
                    let end = AgentRunEnd {
                        is_withdrawn: gate.is_withdrawn,
                        hold_started_at: gate.hold_started_at,
                        main_input_lengths,
                        records,
                    };
                    self.follow_agent_run(&scope, &step, run, &cancel, watched, end)
                        .await
                }
                Err(error) => {
                    record
                        .outcome(pending, EngineOutcome::Failed { code: None })
                        .await;
                    let failure = StepFailure::Failed(Box::new(uncoded_step_error(format!(
                        "the step's agent run could not be resumed: {error}"
                    ))));
                    StepSettlement::Failed {
                        failure: fill_step_failure(failure, &step.node_id, &scope.redaction),
                        log_lines: records.log_lines,
                    }
                }
            }
        };
        self.report(&step, &cancel, StepReportKind::Settled(settlement))
            .await;
    }

    /// Waits at the memory gate for `run`, the agent run of `step`, under `cancel`, reporting its
    /// hold and admission. A wait given up because the tick stopped taking reports cancels
    /// `cancel`, so following the run stops it and the settlement's failed send ends the driver.
    async fn leave_gate(
        &self,
        step: &WorkflowStepKey,
        run: &dyn AgentStepRun,
        cancel: &CancellationToken,
    ) -> GateLeave {
        let end = wait_at_gate(step.clone(), run.admission(), cancel, &self.reports).await;
        let (is_admitted, is_withdrawn, hold_started_at) = match end {
            GateWaitEnd::Admitted => (true, false, None),
            // The run's place closed before it was admitted; its outcome says how it ended.
            GateWaitEnd::Withdrawn { .. } => (false, true, None),
            // The step's cancel is set, so following the run stops it first.
            GateWaitEnd::Canceled { hold_started_at } => (false, false, hold_started_at),
            GateWaitEnd::ReportsClosed => {
                cancel.cancel();
                (false, false, None)
            }
        };
        GateLeave {
            is_admitted,
            is_withdrawn,
            hold_started_at,
        }
    }

    /// Follows `run`, the agent run of `step` of the run of `scope`, watching what `watched` names,
    /// to its outcome under `cancel`, and answers the step's settlement as `end` shapes it: a
    /// canceled step stops its run and settles canceled once the run has ended, and a stop that
    /// cannot be sent goes to the engine's record.
    async fn follow_agent_run(
        &self,
        scope: &RunScope,
        step: &WorkflowStepKey,
        run: Box<dyn AgentStepRun>,
        cancel: &CancellationToken,
        watched: AgentRunWatch,
        end: AgentRunEnd,
    ) -> StepSettlement {
        let is_resumed = matches!(watched, AgentRunWatch::Progress);
        let (mut input_ref, workflow_level) = match watched {
            AgentRunWatch::Start {
                input_ref,
                permission_level,
            } => (Some(input_ref), Some(permission_level)),
            AgentRunWatch::Progress | AgentRunWatch::Outcome => (None, None),
        };
        let AgentRunEnd {
            is_withdrawn,
            hold_started_at,
            main_input_lengths,
            records,
        } = end;
        let (node, kind) = self.look_up_step(scope, step);
        let fill = |failure| fill_step_failure(failure, &node.id, &scope.redaction);
        let mut is_stopped = false;
        // Scoped so the futures borrowing the run end before a spent account keeps the run.
        let ended = {
            let mut outcome = run.outcome();
            let mut started = input_ref.is_some().then(|| run.started());
            // A resumed run started before it parked, so its progress is watched at once.
            let mut progressed: Option<watch::Receiver<u64>> = is_resumed.then(|| run.progressed());
            loop {
                tokio::select! {
                    biased;
                    () = cancel.cancelled(), if !is_stopped => {
                        is_stopped = true;
                        started = None;
                        progressed = None;
                        // The outcome, awaited either way, still ends the step.
                        if let Err(error) = run.cancel().await {
                            self.record_fault(
                                scope,
                                step,
                                EngineFault::AgentRunStopFailed,
                                error.as_ref(),
                            )
                            .await;
                        }
                    }
                    start = async {
                        started
                            .as_mut()
                            .expect("the branch runs only while the start is watched")
                            .await
                    }, if started.is_some() => {
                        started = None;
                        // A run that ended before starting sends nothing; its outcome follows.
                        if let Ok(start) = start {
                            // Subscribed before `Started` is sent, so no turn end after the start
                            // is missed.
                            let run_progressed = run.progressed();
                            let started_kind = StepReportKind::Started {
                                input_ref: input_ref.take().expect("a run starts once"),
                                permission_level: (Some(start.permission_level)
                                    != workflow_level)
                                    .then_some(start.permission_level),
                                pin_hash: None,
                            };
                            if self.report(step, cancel, started_kind).await {
                                progressed = Some(run_progressed);
                            }
                        }
                    }
                    changed = async {
                        progressed
                            .as_mut()
                            .expect("the branch runs only while progress is watched")
                            .changed()
                            .await
                    }, if progressed.is_some() => {
                        match changed {
                            Ok(()) => {
                                self.report(step, cancel, StepReportKind::Progressed).await;
                            }
                            // A count that can no longer change would answer at once forever.
                            Err(_closed) => progressed = None,
                        }
                    }
                    ended = &mut outcome => break ended,
                }
            }
        };
        if is_stopped {
            StepSettlement::Canceled {
                hold_started_at,
                cancellation_reason: None,
            }
        } else {
            match ended {
                // A run that left the gate's line unadmitted never ran, whatever its end reads.
                Ok(AgentStepOutcome::Completed { .. }) if is_withdrawn => StepSettlement::Failed {
                    failure: fill(StepFailure::Failed(Box::new(uncoded_step_error(
                        WITHDRAWN_RUN_COMPLETED.to_owned(),
                    )))),
                    log_lines: records.log_lines,
                },
                Ok(AgentStepOutcome::Completed { items, cost }) => {
                    let mut outputs = place_on_first_output(
                        items,
                        main_output_count(kind.spec.outputs.as_slice()),
                    );
                    shape_outputs(node, &main_input_lengths, &mut outputs);
                    scrub_outputs(&mut outputs, &scope.redaction);
                    StepSettlement::Completed {
                        outputs,
                        cost,
                        log_lines: records.log_lines,
                        run_variables: records.run_variables,
                    }
                }
                Ok(AgentStepOutcome::AccountSpent {
                    provider_account_id,
                    resets_at,
                }) => StepSettlement::AccountSpent {
                    provider_account_id,
                    resets_at,
                    run,
                    records,
                },
                Ok(AgentStepOutcome::Failed { error }) => StepSettlement::Failed {
                    failure: fill(StepFailure::Failed(Box::new(error))),
                    log_lines: records.log_lines,
                },
                Err(error) => {
                    let failure = StepFailure::Failed(Box::new(uncoded_step_error(format!(
                        "the step's agent run's end could not be read: {error}"
                    ))));
                    StepSettlement::Failed {
                        failure: fill(failure),
                        log_lines: records.log_lines,
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;
