//! How the commit ends a step: a completed step's outputs, log and kept values stored; a failed
//! step's row and events, then what its node's failure route decides; a wait on a person stored
//! before anyone is asked; a wait on a spent account; and a cancel.

use std::collections::BTreeMap;

use serde_json::{Value, json};
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::jsonrpc::byte_length::json_utf8_byte_length;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::wire::AnyValue;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::item::WorkflowItem;
use sidekicks_contracts::workflow::run::events::WorkflowGateReachedPayload;
use sidekicks_contracts::workflow::run::status::{WorkflowStepStatus, WorkflowWaitCause};
use sidekicks_contracts::workflow::run::step::events::{
    WorkflowPassedOnOutput, WorkflowPhaseCancellationReason, WorkflowPhaseCompletedPayload,
    WorkflowPhaseFailedPayload, WorkflowPhaseSuspendedPayload, WorkflowStepCanceledPayload,
    WorkflowStepCompletedPayload, WorkflowStepFailedPayload,
};
use sidekicks_contracts::workflow::run::step::record::{
    WORKFLOW_STEP_PAYLOAD_INLINE_BYTE_CAP, WorkflowCost, WorkflowPayloadRef, WorkflowStepKey,
};

use super::{
    ReportedStep, RunTurnCommit, SettlementAnswer, SettlementWriteFailure, StepMove,
    held_milliseconds,
};
use crate::definitions::kept_values::kept_value_statements;
use crate::engine::event_record::StepEnding;
use crate::engine::tick::dispatch::error_members;
use crate::engine::tick::run_status::whole_milliseconds_between;
use crate::engine::tick::step_failure::{StepFailureRoute, route_step_failure, step_failure_error};
use crate::engine::tick::{ParkedAgentRun, StepSettlement};
use crate::engine::waits::{open_person_wait, suspended_payload};
use crate::kinds::step_context::StepRunVariable;
use crate::kinds::{PersonAsk, PersonWait, StepFailure};
use crate::runs::step_payload::{StepPayloadWriteError, join_step_outputs, write_step_payload};
use crate::runs::step_rows::{
    FailedStepRow, cancel_step, fail_step, succeed_step, wait_step_on_account, wait_step_on_person,
};

impl RunTurnCommit {
    /// Ends `step` at `at` as `settlement` says, for `reported`, and answers what the tick keeps.
    pub(super) async fn settle(
        &mut self,
        step: WorkflowStepKey,
        at: &WireInstant,
        settlement: StepSettlement,
        reported: &ReportedStep<'_>,
    ) -> Result<SettlementAnswer, SettlementWriteFailure> {
        match settlement {
            StepSettlement::Completed {
                outputs,
                cost,
                log_lines,
                run_variables,
            } => {
                let answer = self
                    .complete(step, at, outputs, cost, log_lines, run_variables)
                    .await?;
                self.counts.moved(
                    Some(reported.standing()),
                    (WorkflowStepStatus::Succeeded, None),
                );
                Ok(answer)
            }
            StepSettlement::Failed { failure, log_lines } => {
                self.fail(step, at, failure, log_lines, reported).await
            }
            StepSettlement::PersonWait {
                wait,
                admission,
                log_lines,
            } => {
                let PersonWait { ask, timeout } = wait;
                let opened = match open_person_wait(&ask, timeout, at.clone()) {
                    Ok(opened) => opened,
                    Err(failure) => return self.fail(step, at, failure, log_lines, reported).await,
                };
                let mut written = Vec::new();
                let log_ref = match self.write_log(&step, log_lines, &mut written).await {
                    Ok(log_ref) => log_ref,
                    Err(error) => return Err(write_failure(error, written)),
                };
                self.artifact_ids.extend(written);
                self.statements.push(wait_step_on_person(
                    &step,
                    opened.cause,
                    opened.wait_id,
                    &opened.started_at,
                    opened.deadline_at.as_ref(),
                    &log_ref,
                ));
                self.push(
                    at,
                    SessionEvent::WorkflowPhaseSuspended(suspended_payload(
                        self.keys.session_id,
                        &step,
                        &opened,
                        &ask,
                        &log_ref,
                    )),
                );
                if matches!(ask, PersonAsk::Approval { .. }) {
                    self.push(
                        at,
                        SessionEvent::WorkflowGateReached(run_payload!(
                            WorkflowGateReachedPayload,
                            self.keys,
                            step.workflow_run_id,
                        )),
                    );
                }
                self.counts.moved(
                    Some(reported.standing()),
                    (WorkflowStepStatus::Waiting, Some(opened.cause)),
                );
                let wait_opened = StepMove::WaitOpened {
                    cause: opened.cause,
                    deadline_at: opened.deadline_at.clone(),
                };
                self.moves
                    .push((step.clone(), StepMove::Settled(StepEnding::PersonWait)));
                self.moves.push((step, wait_opened));
                Ok(SettlementAnswer::PersonWait {
                    opened,
                    ask,
                    admission,
                })
            }
            StepSettlement::AccountSpent {
                provider_account_id,
                resets_at,
                run,
                records,
            } => {
                self.statements.push(wait_step_on_account(
                    &step,
                    &provider_account_id,
                    at,
                    resets_at.as_ref(),
                    cut_hold_milliseconds(reported.last_hold_report_at, at),
                ));
                let suspended =
                    account_suspended(self, &step, provider_account_id, resets_at.clone());
                self.push(at, suspended);
                self.counts.moved(
                    Some(reported.standing()),
                    (
                        WorkflowStepStatus::Waiting,
                        Some(WorkflowWaitCause::Account),
                    ),
                );
                self.moves
                    .push((step.clone(), StepMove::Settled(StepEnding::AccountSpent)));
                self.moves.push((
                    step,
                    StepMove::WaitOpened {
                        cause: WorkflowWaitCause::Account,
                        deadline_at: None,
                    },
                ));
                Ok(SettlementAnswer::AccountSpent {
                    parked: ParkedAgentRun { run, records },
                    resume_at: resets_at,
                })
            }
            StepSettlement::Canceled {
                hold_started_at,
                cancellation_reason,
            } => {
                let pool_wait_ms =
                    held_milliseconds(hold_started_at.as_ref(), reported.last_hold_report_at, at);
                let readying_event = self.cancel(
                    step,
                    at,
                    pool_wait_ms,
                    cancellation_reason,
                    reported.standing(),
                );
                Ok(SettlementAnswer::Canceled { readying_event })
            }
        }
    }

    /// Writes the cancel of `step`, standing as `standing` before it, at `at` with `pool_wait_ms`
    /// added to its pool wait: its row, `workflow.phase.failed` with `cancellation_reason` where
    /// its run's stop canceled it, then `workflow.step.canceled`, whose index it answers.
    pub(super) fn cancel(
        &mut self,
        step: WorkflowStepKey,
        at: &WireInstant,
        pool_wait_ms: u64,
        cancellation_reason: Option<WorkflowPhaseCancellationReason>,
        standing: (WorkflowStepStatus, Option<WorkflowWaitCause>),
    ) -> usize {
        self.statements.push(cancel_step(&step, at, pool_wait_ms));
        let session_id = self.keys.session_id;
        if cancellation_reason.is_some() {
            self.push(
                at,
                SessionEvent::WorkflowPhaseFailed(step_payload!(
                    WorkflowPhaseFailedPayload,
                    session_id,
                    step,
                    cancellation_reason: cancellation_reason,
                )),
            );
        }
        self.push(
            at,
            SessionEvent::WorkflowStepCanceled(step_payload!(
                WorkflowStepCanceledPayload,
                session_id,
                step,
                readied: Vec::new(),
            )),
        );
        let readying_event = self.events.len() - 1;
        self.counts
            .moved(Some(standing), (WorkflowStepStatus::Canceled, None));
        self.moves
            .push((step, StepMove::Settled(StepEnding::Canceled)));
        readying_event
    }

    /// Stores a completed step's outputs, log and cost, and each run variable it keeps for later
    /// runs, in the turn's write.
    async fn complete(
        &mut self,
        step: WorkflowStepKey,
        at: &WireInstant,
        outputs: Vec<Vec<WorkflowItem>>,
        cost: Option<WorkflowCost>,
        log_lines: Vec<String>,
        run_variables: BTreeMap<String, StepRunVariable>,
    ) -> Result<SettlementAnswer, SettlementWriteFailure> {
        let mut written = Vec::new();
        let stored = self
            .write_completed(&step, &outputs, log_lines, &run_variables, &mut written)
            .await;
        let (output_ref, log_ref, kept) = match stored {
            Ok(stored) => stored,
            Err(error) => return Err(write_failure(error, written)),
        };
        self.artifact_ids.extend(written);
        let output_lengths: Vec<usize> = outputs.iter().map(Vec::len).collect();
        self.statements.push(succeed_step(
            &step,
            at,
            &output_ref,
            &output_lengths,
            &log_ref,
            cost.as_ref(),
        ));
        if let Some(kept_write) = kept_value_statements(
            self.keys.definition_id,
            step.workflow_run_id,
            kept.iter().map(|(name, variable, kept_in)| match kept_in {
                Some((reference, artifact_id)) => (*name, reference, Some(*artifact_id)),
                None => (*name, &variable.value, None),
            }),
            at,
        ) {
            self.kept_reads
                .extend_at(self.statements.len(), kept_write.reads);
            self.statements.extend(kept_write.statements);
        }
        let session_id = self.keys.session_id;
        self.push(
            at,
            SessionEvent::WorkflowPhaseCompleted(step_payload!(
                WorkflowPhaseCompletedPayload,
                session_id,
                step,
            )),
        );
        self.push(
            at,
            SessionEvent::WorkflowStepCompleted(step_payload!(
                WorkflowStepCompletedPayload,
                session_id,
                step,
                output_ref: output_ref,
                log_ref: log_ref,
                cost: cost,
                output_item_counts: output_lengths.into_iter().map(SafeInt::from_usize).collect(),
                readied: Vec::new(),
            )),
        );
        let readying_event = self.events.len() - 1;
        self.moves
            .push((step, StepMove::Settled(StepEnding::Completed)));
        Ok(SettlementAnswer::Completed {
            readying_event,
            outputs,
            run_variables,
        })
    }

    /// The refs of a completed step's outputs and log, and each variable it keeps beside the
    /// reference a value above the inline cap is kept as, writing every artifact into `written`.
    async fn write_completed<'variables>(
        &self,
        step: &WorkflowStepKey,
        outputs: &[Vec<WorkflowItem>],
        log_lines: Vec<String>,
        run_variables: &'variables BTreeMap<String, StepRunVariable>,
        written: &mut Vec<ArtifactId>,
    ) -> Result<CompletedPayloads<'variables>, StepPayloadWriteError> {
        let output_ref = self
            .write_payload(step, &join_step_outputs(outputs), written)
            .await?;
        let log_ref = self.write_log(step, log_lines, written).await?;
        let mut kept = Vec::new();
        for (name, variable) in run_variables {
            if !variable.is_kept {
                continue;
            }
            let measured_bytes =
                json_utf8_byte_length(&variable.value).map_err(StepPayloadWriteError::Json)?;
            let reference = if measured_bytes <= WORKFLOW_STEP_PAYLOAD_INLINE_BYTE_CAP {
                None
            } else {
                let item = WorkflowItem {
                    json: AnyValue(variable.value.clone()),
                    binary: None,
                    paired_item: None,
                    error: None,
                };
                let reference = self.write_payload(step, &[item], written).await?;
                let artifact_id = match &reference {
                    WorkflowPayloadRef::Artifact { artifact_id, .. } => Some(*artifact_id),
                    WorkflowPayloadRef::Inline { .. } => None,
                }
                .expect("a value above the inline cap is written as an artifact");
                Some((
                    serde_json::to_value(&reference)
                        .expect("a payload ref writes as JSON, its items being JSON values"),
                    artifact_id,
                ))
            };
            kept.push((name.as_str(), variable, reference));
        }
        Ok((output_ref, log_ref, kept))
    }

    /// Writes a failed step's row and events, then answers what its node's failure route decides.
    async fn fail(
        &mut self,
        step: WorkflowStepKey,
        at: &WireInstant,
        failure: StepFailure,
        log_lines: Vec<String>,
        reported: &ReportedStep<'_>,
    ) -> Result<SettlementAnswer, SettlementWriteFailure> {
        let route = route_step_failure(
            reported.node,
            reported.spec,
            &step,
            &failure,
            reported.inputs,
        );
        let mut written = Vec::new();
        let log_ref = match self.write_log(&step, log_lines, &mut written).await {
            Ok(log_ref) => log_ref,
            Err(error) => return Err(write_failure(error, written)),
        };
        let output = match &route {
            StepFailureRoute::PassOn { outputs } => {
                match self
                    .write_payload(&step, &join_step_outputs(outputs), &mut written)
                    .await
                {
                    Ok(output_ref) => Some((output_ref, outputs.iter().map(Vec::len).collect())),
                    Err(error) => return Err(write_failure(error, written)),
                }
            }
            StepFailureRoute::Retry { .. } | StepFailureRoute::Park | StepFailureRoute::End => None,
        };
        self.artifact_ids.extend(written);
        let mut error = step_failure_error(&reported.node.id, &failure);
        let failed_item_index = *error_members(&mut error).2;
        let run_error = matches!(route, StepFailureRoute::End).then(|| error.clone());
        let decline_reason = match &failure {
            StepFailure::Declined { words, .. } => words.clone(),
            StepFailure::Failed(_) | StepFailure::EndsRun(_) => None,
        };
        self.statements.push(fail_step(
            &step,
            &FailedStepRow {
                finished_at: at,
                error: &error,
                decline_reason: decline_reason.as_ref(),
                output: output
                    .as_ref()
                    .map(|(output_ref, output_lengths): &(_, Vec<usize>)| {
                        (output_ref, output_lengths.as_slice())
                    }),
                log_ref: &log_ref,
                pool_wait_ms: cut_hold_milliseconds(reported.last_hold_report_at, at),
            },
        ));
        let session_id = self.keys.session_id;
        self.push(
            at,
            SessionEvent::WorkflowPhaseFailed(step_payload!(
                WorkflowPhaseFailedPayload,
                session_id,
                step,
                cancellation_reason: None,
            )),
        );
        self.push(
            at,
            SessionEvent::WorkflowStepFailed(step_payload!(
                WorkflowStepFailedPayload,
                session_id,
                step,
                error: error,
                failed_item_index: failed_item_index,
                decline_reason: decline_reason,
                log_ref: log_ref,
                passed_on: output.map(|(output_ref, output_lengths)| WorkflowPassedOnOutput {
                    output_ref,
                    output_item_counts: output_lengths
                        .into_iter()
                        .map(SafeInt::from_usize)
                        .collect(),
                }),
                readied: Vec::new(),
            )),
        );
        let readying_event = self.events.len() - 1;
        self.counts.moved(
            Some(reported.standing()),
            (WorkflowStepStatus::Failed, None),
        );
        if matches!(route, StepFailureRoute::Park) {
            self.counts.parked();
        }
        self.moves
            .push((step, StepMove::Settled(StepEnding::Failed(failure))));
        Ok(match route {
            StepFailureRoute::Retry { wait } => SettlementAnswer::Retry { wait },
            StepFailureRoute::PassOn { outputs } => SettlementAnswer::PassOn {
                readying_event,
                outputs,
            },
            StepFailureRoute::Park => SettlementAnswer::Park,
            StepFailureRoute::End => SettlementAnswer::End {
                error: run_error.expect("an end keeps its step's error for the run"),
            },
        })
    }

    /// `log_lines` as `step`'s log ref, one item per line.
    async fn write_log(
        &self,
        step: &WorkflowStepKey,
        log_lines: Vec<String>,
        written: &mut Vec<ArtifactId>,
    ) -> Result<WorkflowPayloadRef, StepPayloadWriteError> {
        let items: Vec<WorkflowItem> = log_lines
            .into_iter()
            .map(|line| WorkflowItem {
                json: AnyValue(json!({ "line": line })),
                binary: None,
                paired_item: None,
                error: None,
            })
            .collect();
        self.write_payload(step, &items, written).await
    }

    /// `items` as a payload ref of `step`, an artifact above the inline cap, whose id goes into
    /// `written`.
    async fn write_payload(
        &self,
        step: &WorkflowStepKey,
        items: &[WorkflowItem],
        written: &mut Vec<ArtifactId>,
    ) -> Result<WorkflowPayloadRef, StepPayloadWriteError> {
        let payload =
            write_step_payload(self.payloads.as_ref(), self.keys.session_id, step, items).await?;
        if let WorkflowPayloadRef::Artifact { artifact_id, .. } = &payload {
            written.push(*artifact_id);
        }
        Ok(payload)
    }
}

/// A completed step's output ref, its log ref, and each variable it keeps by name beside the
/// reference JSON a value above the inline cap is kept as and the artifact that names.
type CompletedPayloads<'variables> = (
    WorkflowPayloadRef,
    WorkflowPayloadRef,
    Vec<(
        &'variables str,
        &'variables StepRunVariable,
        Option<(Value, ArtifactId)>,
    )>,
);

/// The `workflow.phase.suspended` of `step` waiting on the spent account `provider_account_id`,
/// resuming at `resume_at` where one is armed.
fn account_suspended(
    commit: &RunTurnCommit,
    step: &WorkflowStepKey,
    provider_account_id: ProviderAccountId,
    resume_at: Option<WireInstant>,
) -> SessionEvent {
    SessionEvent::WorkflowPhaseSuspended(WorkflowPhaseSuspendedPayload::Account {
        session_id: commit.keys.session_id,
        workflow_run_id: step.workflow_run_id,
        node_id: step.node_id.clone(),
        attempt: step.attempt,
        execution_index: step.execution_index,
        provider_account_id,
        resume_at,
        wait_deadline_at: None,
        wait_id: None,
        log_ref: None,
    })
}

/// The whole milliseconds since a hold's last report at `last_hold_report_at` to `at`, which a
/// settlement that cuts the hold adds to the step's pool wait; 0 for a step the gate was not
/// holding.
fn cut_hold_milliseconds(last_hold_report_at: Option<&WireInstant>, at: &WireInstant) -> u64 {
    last_hold_report_at.map_or(0, |since| whole_milliseconds_between(since, at))
}

/// The settlement's write failure, with each artifact it wrote before failing.
fn write_failure(error: StepPayloadWriteError, written: Vec<ArtifactId>) -> SettlementWriteFailure {
    SettlementWriteFailure {
        error,
        artifact_ids: written,
    }
}

#[cfg(test)]
mod tests;
