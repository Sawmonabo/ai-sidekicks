//! The tick's dispatch: it admits each step the walk readies, and a driver task per step launches
//! it, runs its executor and settles it, sending every later report to the tick.

mod launch;
mod run;
#[cfg(test)]
mod tests;

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::sync::Arc;

use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_contracts::workflow::definition::document::WorkflowNodeId;
use sidekicks_contracts::workflow::definition::item::WorkflowStepError;
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::admission::send;
use super::node_settings::{
    execute_once_inputs, main_input_lengths, main_output_count, pinned_outputs, shape_outputs,
};
use super::{ReadyStep, RunScope, RunSnapshot, StepReport, StepReportKind, StepSettlement};
use crate::engine::ports::EnginePorts;
use crate::expressions::evaluator::ExpressionEvaluator;
use crate::kinds::{NodeKindTable, StepFailure, uncoded_step_error};
use crate::secrets::redaction::RunRedaction;
use crate::secrets::store::WorkflowSecretStore;

/// Launches and drives the steps the tick readies, through the engine's ports and the service's
/// expression thread, database reads, secret store and HTTP client, reporting to the tick.
#[derive(Clone)]
pub(crate) struct StepDispatch {
    /// The ports the program's workflow engine hands the dispatch.
    ports: EnginePorts,
    /// The service's one expression thread, which evaluates each step's templates.
    evaluator: ExpressionEvaluator,
    /// The database's read connections, which find the records of a step's secrets.
    reads: Arc<DatabaseReadPool>,
    /// The keychain store a step's secret values are read from.
    secrets: Arc<WorkflowSecretStore>,
    /// The daemon's HTTP client, which a step's context hands its executor.
    http: reqwest::Client,
    /// The kinds the engine runs, which a step's node is looked up in.
    kinds: Arc<NodeKindTable>,
    /// The tick's report channel, which every driver sends its step's reports on.
    reports: mpsc::Sender<StepReport>,
}

/// A step the dispatch admitted: its own cancel and the reports the tick writes for it this turn.
pub(crate) struct DispatchedStep {
    /// The step's cancel, a child of its run's.
    pub(crate) cancel: CancellationToken,
    /// The reports the tick writes this turn, in order.
    pub(crate) reports: Vec<StepReport>,
}

impl StepDispatch {
    /// The dispatch over `ports`, `evaluator`, `reads`, `secrets`, `http` and `kinds`, sending its
    /// drivers' reports on `reports`.
    pub(crate) fn new(
        ports: EnginePorts,
        evaluator: ExpressionEvaluator,
        reads: Arc<DatabaseReadPool>,
        secrets: Arc<WorkflowSecretStore>,
        http: reqwest::Client,
        kinds: Arc<NodeKindTable>,
        reports: mpsc::Sender<StepReport>,
    ) -> Self {
        Self {
            ports,
            evaluator,
            reads,
            secrets,
            http,
            kinds,
            reports,
        }
    }

    /// Dispatches `ready`, a step of the run of `scope`, reading `snapshot`: admits it at once and
    /// spawns its driver, or fails it at once when the table lists no kind at its node's version.
    /// Answers the step's cancel and the reports the tick writes this turn. Must be called inside
    /// tokio.
    pub(crate) fn dispatch(
        &self,
        scope: &Arc<RunScope>,
        snapshot: &RunSnapshot,
        ready: ReadyStep,
    ) -> DispatchedStep {
        let node = scope
            .nodes
            .get(&ready.step.node_id)
            .expect("the walk readies only the run's own nodes");
        let cancel = scope.cancel.child_token();
        let mut reports = vec![StepReport {
            step: ready.step.clone(),
            at: WireInstant::now(),
            kind: StepReportKind::Admitted {
                hold_started_at: None,
            },
        }];
        if self.kinds.kind_of(node).is_none() {
            let error = uncoded_step_error(format!(
                "this service runs no kind {} at version {}",
                node.kind.0.as_str(),
                node.kind_version.get()
            ));
            let failure = fill_step_failure(
                StepFailure::Failed(Box::new(error)),
                &node.id,
                &scope.redaction,
            );
            reports.push(StepReport {
                step: ready.step,
                at: WireInstant::now(),
                kind: StepReportKind::Settled(StepSettlement::Failed {
                    failure,
                    log_lines: Vec::new(),
                }),
            });
            return DispatchedStep { cancel, reports };
        }
        tokio::spawn(self.clone().drive(
            Arc::clone(scope),
            snapshot.clone(),
            ready,
            cancel.clone(),
        ));
        DispatchedStep { cancel, reports }
    }

    /// Drives the admitted step `ready` to its settlement: a node pinned in a manual run gives its
    /// pinned items; any other is cut for execute-once, launched, started and run.
    async fn drive(
        self,
        scope: Arc<RunScope>,
        snapshot: RunSnapshot,
        mut ready: ReadyStep,
        cancel: CancellationToken,
    ) {
        let node = scope
            .nodes
            .get(&ready.step.node_id)
            .expect("the dispatch found the step's node in the run's nodes");
        let kind = self
            .kinds
            .kind_of(node)
            .expect("the dispatch found the node's kind in the table");
        let step = ready.step.clone();
        let pinned = pinned_outputs(
            scope.mode,
            scope.pin_data.as_ref(),
            node,
            main_output_count(&kind.spec),
        );
        if let Some(mut outputs) = pinned {
            shape_outputs(
                node,
                &main_input_lengths(&kind.spec, &ready.inputs),
                &mut outputs,
            );
            let started = StepReportKind::Started {
                input_ref: ready.input_ref,
                permission_level: None,
            };
            if self.report(&step, &cancel, started).await {
                let completed = StepSettlement::Completed {
                    outputs,
                    cost: None,
                    log_lines: Vec::new(),
                    run_variables: BTreeMap::new(),
                };
                self.report(&step, &cancel, StepReportKind::Settled(completed))
                    .await;
            }
            return;
        }
        ready.inputs = execute_once_inputs(node, std::mem::take(&mut ready.inputs));
        let launched = self
            .launch(&scope, &snapshot, &ready, kind, cancel.clone(), None)
            .await;
        let context = match launched {
            Ok(context) => context,
            Err(failure) => {
                let failed = StepSettlement::Failed {
                    failure: fill_step_failure(failure, &node.id, &scope.redaction),
                    log_lines: Vec::new(),
                };
                self.report(&step, &cancel, StepReportKind::Settled(failed))
                    .await;
                return;
            }
        };
        let started = StepReportKind::Started {
            input_ref: ready.input_ref,
            permission_level: None,
        };
        if !self.report(&step, &cancel, started).await {
            return;
        }
        if let Some(settlement) = self.run_executor(node, kind, &context, ready.inputs).await {
            self.report(&step, &cancel, StepReportKind::Settled(settlement))
                .await;
        }
        // Dropped only after the settlement is sent, so the gate place it holds is released after
        // the report.
        drop(context);
    }

    /// Sends `kind` for `step` to the tick, answering whether the tick took it. When the tick has
    /// stopped taking reports, cancels the step through `cancel`, so a process it started still
    /// ends.
    async fn report(
        &self,
        step: &WorkflowStepKey,
        cancel: &CancellationToken,
        kind: StepReportKind,
    ) -> bool {
        let is_taken = send(&self.reports, step, WireInstant::now(), kind)
            .await
            .is_ok();
        if !is_taken {
            cancel.cancel();
        }
        is_taken
    }
}

/// The members every arm of a step failure carries: its message, its node and its item.
fn error_members(
    error: &mut WorkflowStepError,
) -> (
    &mut NonEmptyText,
    &mut Option<WorkflowNodeId>,
    &mut Option<SafeInt<0>>,
) {
    match error {
        WorkflowStepError::Uncoded(arm) => {
            (&mut arm.message, &mut arm.node_id, &mut arm.item_index)
        }
        WorkflowStepError::Coded(arm) => (&mut arm.message, &mut arm.node_id, &mut arm.item_index),
        WorkflowStepError::AgentResolution(arm) => {
            (&mut arm.message, &mut arm.node_id, &mut arm.item_index)
        }
    }
}

/// `failure` as the step settles with it: its node `node_id` where it names none, and its message
/// scrubbed through `redaction`. A decline passes through.
fn fill_step_failure(
    failure: StepFailure,
    node_id: &WorkflowNodeId,
    redaction: &RunRedaction,
) -> StepFailure {
    match failure {
        StepFailure::Failed(mut error) => {
            let (message, error_node_id, _item_index) = error_members(&mut error);
            error_node_id.get_or_insert_with(|| node_id.clone());
            if let Cow::Owned(scrubbed) = redaction.scrub(message.as_str()) {
                *message = NonEmptyText::new(scrubbed).expect("a mask leaves a message non-empty");
            }
            StepFailure::Failed(error)
        }
        declined @ StepFailure::Declined { .. } => declined,
    }
}

/// A dispatch for a test over `database`'s reads, a keychain holding nothing, ports refusing every
/// call and the table of `kinds`, with the receiving end of its report channel.
#[cfg(test)]
fn test_dispatch(
    database: &sidekicks_store::database::writer::test_file::TestDatabase,
    kinds: Vec<crate::kinds::NodeKind>,
) -> (StepDispatch, mpsc::Receiver<StepReport>) {
    let (reports, received) = mpsc::channel(16);
    let dispatch = StepDispatch::new(
        crate::engine::ports::refusing_engine_ports(),
        ExpressionEvaluator::start().expect("the expression thread starts"),
        Arc::new(DatabaseReadPool::new(
            database.path(),
            crate::secrets::resolution::STEP_SECRET_STATEMENT_CAPACITY,
        )),
        Arc::new(WorkflowSecretStore::new(
            crate::secrets::store::ScriptedKeychain::holding(&[], false),
        )),
        reqwest::Client::new(),
        Arc::new(NodeKindTable::new(kinds).expect("the test's kinds build a table")),
        reports,
    );
    (dispatch, received)
}

/// The first execution of `node`, the only node of the run of `scope`, readied with an item
/// holding each value of `inputs`, one list per input handle.
#[cfg(test)]
fn test_ready_step(
    scope: &RunScope,
    node: &sidekicks_contracts::workflow::definition::document::WorkflowNode,
    inputs: Vec<Vec<serde_json::Value>>,
) -> ReadyStep {
    use serde_json::json;

    ReadyStep {
        step: serde_json::from_value(json!({
            "workflowRunId": scope.run_id, "nodeId": node.id, "attempt": 1, "executionIndex": 0,
        }))
        .expect("the test's step key reads"),
        run_index: 0,
        inputs: inputs
            .into_iter()
            .map(|items| {
                items
                    .into_iter()
                    .map(|value| {
                        serde_json::from_value(json!({ "json": value }))
                            .expect("the test's item reads")
                    })
                    .collect()
            })
            .collect(),
        input_ref: serde_json::from_value(json!({ "kind": "inline", "items": [] }))
            .expect("the test's input reference reads"),
    }
}

/// A snapshot of a run in which `node` has not run and no run variable is set.
#[cfg(test)]
fn test_run_snapshot(
    node: &sidekicks_contracts::workflow::definition::document::WorkflowNode,
) -> RunSnapshot {
    RunSnapshot {
        outputs: Arc::new(crate::expressions::lineage::StepOutputs::new([(
            node.id.clone(),
            node.name.as_str().to_owned(),
        )])),
        run_variables: Arc::new(serde_json::Map::new()),
    }
}
