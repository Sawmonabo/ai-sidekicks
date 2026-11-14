//! A step's executor run: the executor driven to its answer while the step's records are taken as
//! they come, a per-item kind's calls one item at a time, going on past a failing call where the
//! node's `onError` does, and the settlement the answer becomes.

use std::collections::BTreeMap;

use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::document::{WorkflowNode, WorkflowNodeOnError};
use sidekicks_contracts::workflow::definition::item::WorkflowItem;

use super::{StepDispatch, error_members, fill_step_failure, scrub_outputs};
use crate::engine::tick::node_settings::{
    join_per_item_outputs, main_input_lengths, main_inputs, per_item_calls, shape_outputs,
};
use crate::engine::tick::step_failure::{passed_on_outputs, step_retry};
use crate::engine::tick::{StepReportKind, StepSettlement};
use crate::kinds::step_context::StepContext;
use crate::kinds::{NodeKind, StepFailure, StepOutcome, uncoded_step_error};

impl StepDispatch {
    /// Runs the executor of `kind`, the kind of `node`, over `inputs` with `context`, sending
    /// `Progressed` each time the step marks progress, and answers the step's settlement. A step
    /// canceled while it ran settles canceled once its executor returns, whatever it answered.
    /// Answers `None` when the tick stopped taking reports, which cancels the step.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(super) async fn run_executor(
        &self,
        node: &WorkflowNode,
        kind: &NodeKind,
        context: &StepContext,
        inputs: Vec<Vec<WorkflowItem>>,
    ) -> Option<StepSettlement> {
        let main_input_lengths = main_input_lengths(&kind.spec, &inputs);
        let execution = execute(node, kind, context, inputs);
        tokio::pin!(execution);
        let mut log_lines = Vec::new();
        let mut run_variables = BTreeMap::new();
        let mut is_reporting = true;
        let answer = loop {
            tokio::select! {
                answer = &mut execution => break answer,
                () = context.wait_for_records() => {
                    let records = context.take_records();
                    log_lines.extend(records.log_lines);
                    run_variables.extend(records.run_variables);
                    if records.has_progressed && is_reporting {
                        is_reporting = self
                            .report(&context.step, &context.cancel, StepReportKind::Progressed)
                            .await;
                    }
                }
            }
        };
        let records = context.finish_records();
        log_lines.extend(records.log_lines);
        run_variables.extend(records.run_variables);
        if !is_reporting {
            return None;
        }
        if context.cancel.is_cancelled() {
            return Some(StepSettlement::Canceled {
                hold_started_at: None,
                cancellation_reason: None,
            });
        }
        let fill = |failure| fill_step_failure(failure, &node.id, &context.redaction);
        Some(match answer {
            Ok(StepOutcome::Outputs(mut outputs)) => {
                shape_outputs(node, &main_input_lengths, &mut outputs);
                scrub_outputs(&mut outputs, &context.redaction);
                StepSettlement::Completed {
                    outputs,
                    cost: None,
                    log_lines,
                    run_variables,
                }
            }
            Ok(StepOutcome::PersonWait(wait)) => StepSettlement::PersonWait {
                wait,
                admission: context.admission.clone(),
                log_lines,
            },
            Ok(StepOutcome::AgentRun(_request)) => StepSettlement::Failed {
                failure: fill(StepFailure::Failed(Box::new(uncoded_step_error(format!(
                    "the kind {} asked for an agent run, which only an agent step starts",
                    kind.spec.kind.0.as_str()
                ))))),
                log_lines,
            },
            Err(failure) => StepSettlement::Failed {
                failure: fill(failure),
                log_lines,
            },
        })
    }
}

/// Runs the step's executor over `inputs` on `node`: once, or for a per-item kind once per item of
/// its one main input, in order, each call reading its own item as item 0, their outputs joined in
/// call order. A failing call ends the step there, carrying the call's index, unless the node's
/// `onError` goes on past it and the failure is a decline or a failure on the step's last try:
/// then the call's outputs are what `onError` passes on, its error naming the call's item, and
/// the next call runs.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(super) async fn execute(
    node: &WorkflowNode,
    kind: &NodeKind,
    context: &StepContext,
    inputs: Vec<Vec<WorkflowItem>>,
) -> Result<StepOutcome, StepFailure> {
    if kind.spec.per_item != Some(true) {
        return kind.executor.execute(context, inputs).await;
    }
    let can_go_on = matches!(
        node.on_error,
        Some(WorkflowNodeOnError::Continue | WorkflowNodeOnError::ContinueErrorOutput)
    );
    let is_last_try = context.step.attempt.get() >= step_retry(node).max_tries;
    let main_input = main_inputs(&kind.spec, inputs).next().unwrap_or_default();
    let mut calls = Vec::new();
    for (call_index, call_inputs) in per_item_calls(main_input).into_iter().enumerate() {
        context.begin_item_call(call_index);
        // Kept only where a failing call may go on, since only then are its items passed on.
        let kept_inputs = can_go_on.then(|| call_inputs.clone());
        let failure = match kind.executor.execute(context, call_inputs).await {
            Ok(StepOutcome::Outputs(outputs)) => {
                calls.push(outputs);
                continue;
            }
            Ok(StepOutcome::PersonWait(_) | StepOutcome::AgentRun(_)) => {
                StepFailure::Failed(Box::new(uncoded_step_error(format!(
                    "the per-item kind {} asked for a wait or an agent run, which a call over one \
                     item cannot make",
                    kind.spec.kind.0.as_str()
                ))))
            }
            Err(failure) => failure,
        };
        let goes_on = match failure {
            StepFailure::Failed(_) => is_last_try,
            StepFailure::Declined { .. } => true,
            StepFailure::EndsRun(_) | StepFailure::Crashed(_) => false,
        };
        match kept_inputs.filter(|_| goes_on) {
            Some(call_inputs) => {
                calls.push(passed_on_call_outputs(
                    node,
                    kind,
                    failure,
                    &call_inputs,
                    call_index,
                ));
            }
            None => return Err(fill_failed_call(failure, call_index)),
        }
    }
    Ok(StepOutcome::Outputs(join_per_item_outputs(calls)))
}

/// The outputs `node`'s `onError` passes on for the per-item call `call_index` that failed with
/// `failure` over `call_inputs`: its one item, carrying the error with the call's index as the
/// error's item, since the call's own item 0 is the step's item `call_index`.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
fn passed_on_call_outputs(
    node: &WorkflowNode,
    kind: &NodeKind,
    mut failure: StepFailure,
    call_inputs: &[Vec<WorkflowItem>],
    call_index: usize,
) -> Vec<Vec<WorkflowItem>> {
    if let Some(error) = failure.error_mut() {
        *error_members(error).2 = None;
    }
    let mut outputs = passed_on_outputs(node, &kind.spec, &failure, call_inputs)
        .expect("a node whose onError goes on passes its items on");
    for error in outputs
        .iter_mut()
        .flatten()
        .filter_map(|item| item.error.as_mut())
    {
        *error_members(error).2 = Some(SafeInt::from_usize(call_index));
    }
    outputs
}

/// `failure` carrying the index of the per-item call that failed, `call_index`, where it names no
/// item. A decline passes through.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
fn fill_failed_call(mut failure: StepFailure, call_index: usize) -> StepFailure {
    if let Some(error) = failure.error_mut() {
        error_members(error)
            .2
            .get_or_insert_with(|| SafeInt::from_usize(call_index));
    }
    failure
}
