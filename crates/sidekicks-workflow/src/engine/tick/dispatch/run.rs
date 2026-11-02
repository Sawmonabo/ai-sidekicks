//! A step's executor run: the executor driven to its answer while the step's records are taken as
//! they come, a per-item kind's calls one item at a time, and the settlement the answer becomes.

use std::collections::BTreeMap;

use sidekicks_contracts::workflow::definition::document::WorkflowNode;
use sidekicks_contracts::workflow::definition::item::WorkflowItem;

use super::{StepDispatch, error_members, fill_step_failure};
use crate::engine::tick::node_settings::{
    index, join_per_item_outputs, main_input_lengths, main_inputs, per_item_calls, shape_outputs,
};
use crate::engine::tick::{StepReportKind, StepSettlement};
use crate::kinds::step_context::StepContext;
use crate::kinds::{NodeKind, StepFailure, StepOutcome, uncoded_step_error};

impl StepDispatch {
    /// Runs the executor of `kind`, the kind of `node`, over `inputs` with `context`, sending
    /// `Progressed` each time the step marks progress, and answers the step's settlement. A step
    /// canceled while it ran settles canceled once its executor returns, whatever it answered.
    /// Answers `None` when the tick stopped taking reports, which cancels the step.
    pub(super) async fn run_executor(
        &self,
        node: &WorkflowNode,
        kind: &NodeKind,
        context: &StepContext,
        inputs: Vec<Vec<WorkflowItem>>,
    ) -> Option<StepSettlement> {
        let main_input_lengths = main_input_lengths(&kind.spec, &inputs);
        let execution = execute(kind, context, inputs);
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
        let records = context.take_records();
        log_lines.extend(records.log_lines);
        run_variables.extend(records.run_variables);
        if !is_reporting {
            return None;
        }
        if context.cancel.is_cancelled() {
            return Some(StepSettlement::Canceled {
                hold_started_at: None,
                is_sibling_failure: false,
            });
        }
        let fill = |failure| fill_step_failure(failure, &node.id, &context.redaction);
        Some(match answer {
            Ok(StepOutcome::Outputs(mut outputs)) => {
                shape_outputs(node, &main_input_lengths, &mut outputs);
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

/// Runs the step's executor over `inputs`: once, or for a per-item kind once per item of its one
/// main input, in order, each call reading its own item as item 0, their outputs joined in call
/// order. A failing call ends the step there, carrying the call's index.
pub(super) async fn execute(
    kind: &NodeKind,
    context: &StepContext,
    inputs: Vec<Vec<WorkflowItem>>,
) -> Result<StepOutcome, StepFailure> {
    if kind.spec.per_item != Some(true) {
        return kind.executor.execute(context, inputs).await;
    }
    let main_input = main_inputs(&kind.spec, inputs).next().unwrap_or_default();
    let mut calls = Vec::new();
    for (call_index, call_inputs) in per_item_calls(main_input).into_iter().enumerate() {
        context.begin_item_call(call_index);
        let outputs = match kind.executor.execute(context, call_inputs).await {
            Ok(StepOutcome::Outputs(outputs)) => outputs,
            Ok(StepOutcome::PersonWait(_) | StepOutcome::AgentRun(_)) => {
                let error = uncoded_step_error(format!(
                    "the per-item kind {} asked for a wait or an agent run, which a call over one \
                     item cannot make",
                    kind.spec.kind.0.as_str()
                ));
                return Err(fill_failed_call(
                    StepFailure::Failed(Box::new(error)),
                    call_index,
                ));
            }
            Err(failure) => return Err(fill_failed_call(failure, call_index)),
        };
        calls.push(outputs);
    }
    Ok(StepOutcome::Outputs(join_per_item_outputs(calls)))
}

/// `failure` carrying the index of the per-item call that failed, `call_index`, where it names no
/// item. A decline passes through.
fn fill_failed_call(failure: StepFailure, call_index: usize) -> StepFailure {
    match failure {
        StepFailure::Failed(mut error) => {
            let (_message, _node_id, item_index) = error_members(&mut error);
            item_index.get_or_insert_with(|| index(call_index));
            StepFailure::Failed(error)
        }
        declined @ StepFailure::Declined { .. } => declined,
    }
}
