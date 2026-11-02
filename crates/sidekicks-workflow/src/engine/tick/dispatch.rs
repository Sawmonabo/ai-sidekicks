//! The tick's dispatch: it decides in the tick's turn how each step the walk readies is admitted,
//! and a driver task per step waits at the memory gate where its kind asks, launches it, runs its
//! executor and settles it, sending every later report to the tick.

mod launch;
mod run;
#[cfg(test)]
mod tests;

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::sync::Arc;

use sidekicks_contracts::jsonrpc::byte_length::json_utf8_byte_length;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_contracts::workflow::definition::document::WorkflowNodeId;
use sidekicks_contracts::workflow::definition::item::WorkflowStepError;
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::admission::{GateEntryOrder, GateEntryTurn, GateWaitEnd, send, wait_at_gate};
use super::node_settings::{
    execute_once_inputs, main_input_lengths, main_output_count, pinned_outputs, shape_outputs,
};
use super::{ReadyStep, RunScope, RunSnapshot, StepReport, StepReportKind, StepSettlement};
use crate::engine::ports::{EnginePorts, StepAdmissionTicket, StepAdmissionWork, WorkflowNodeKey};
use crate::expressions::evaluator::ExpressionEvaluator;
use crate::kinds::{
    NodeKindTable, StepAdmissionNeed, StepAdmissionShape, StepFailure, uncoded_step_error,
};
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
    /// The one line in which every run this dispatch serves enters the memory gate.
    gate_entries: GateEntryOrder,
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
            gate_entries: GateEntryOrder::default(),
        }
    }

    /// Dispatches `ready`, a step of the run of `scope`, reading `snapshot`, deciding in this turn
    /// how it is admitted. A kind or version the table does not list fails at once, and a node
    /// pinned in a manual run settles with its pinned items, both with no task. A step the memory
    /// gate does not weigh is admitted at once and its driver spawned; a step the gate weighs
    /// takes its turn in the entry line and its driver reports its hold and its admission. Answers
    /// the step's cancel and the reports the tick writes this turn. Must be called inside tokio.
    pub(crate) fn dispatch(
        &self,
        scope: &Arc<RunScope>,
        snapshot: &RunSnapshot,
        mut ready: ReadyStep,
    ) -> DispatchedStep {
        let node = scope
            .nodes
            .get(&ready.step.node_id)
            .expect("the walk readies only the run's own nodes");
        let cancel = scope.cancel.child_token();
        let report = |step: WorkflowStepKey, kind: StepReportKind| StepReport {
            step,
            at: WireInstant::now(),
            kind,
        };
        let admitted = StepReportKind::Admitted {
            hold_started_at: None,
        };
        let Some(kind) = self.kinds.kind_of(node) else {
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
            let failed = StepSettlement::Failed {
                failure,
                log_lines: Vec::new(),
            };
            let reports = vec![
                report(ready.step.clone(), admitted),
                report(ready.step, StepReportKind::Settled(failed)),
            ];
            return DispatchedStep { cancel, reports };
        };
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
            let completed = StepSettlement::Completed {
                outputs,
                cost: None,
                log_lines: Vec::new(),
                run_variables: BTreeMap::new(),
            };
            let reports = vec![
                report(ready.step.clone(), admitted),
                report(ready.step.clone(), started),
                report(ready.step, StepReportKind::Settled(completed)),
            ];
            return DispatchedStep { cancel, reports };
        }
        ready.inputs = execute_once_inputs(node, std::mem::take(&mut ready.inputs));
        match kind.executor.admission_need(node) {
            StepAdmissionNeed::Unweighed => {
                let reports = vec![report(ready.step.clone(), admitted)];
                tokio::spawn(self.clone().drive(
                    Arc::clone(scope),
                    snapshot.clone(),
                    ready,
                    cancel.clone(),
                    None,
                ));
                DispatchedStep { cancel, reports }
            }
            StepAdmissionNeed::Gate(shape) => {
                // Taken here, not in the driver, so turns follow the order the tick dispatches in.
                let turn = self.gate_entries.take_turn();
                tokio::spawn(self.clone().drive_at_gate(
                    Arc::clone(scope),
                    snapshot.clone(),
                    ready,
                    cancel.clone(),
                    shape,
                    turn,
                ));
                DispatchedStep {
                    cancel,
                    reports: Vec::new(),
                }
            }
        }
    }

    /// Drives `ready`, a step the memory gate weighs as `shape`, to its admission: measures what
    /// it runs, waits for its `turn` in the entry line, enters the gate and reports its hold and
    /// its admission, then runs it as [`Self::drive`] does, holding its ticket. A step canceled in
    /// the line or at the gate settles canceled; one the gate releases unadmitted fails.
    async fn drive_at_gate(
        self,
        scope: Arc<RunScope>,
        snapshot: RunSnapshot,
        ready: ReadyStep,
        cancel: CancellationToken,
        shape: StepAdmissionShape,
        turn: GateEntryTurn,
    ) {
        let node = scope
            .nodes
            .get(&ready.step.node_id)
            .expect("the dispatch found the step's node in the run's nodes");
        let step = ready.step.clone();
        let node_key = WorkflowNodeKey::new(scope.workflow_id, &node.id);
        let work = match shape {
            StepAdmissionShape::Script { runtime } => {
                StepAdmissionWork::Script { runtime, node_key }
            }
            StepAdmissionShape::QuickCode {
                budget_bytes,
                output_max_bytes,
            } => match json_utf8_byte_length(&ready.inputs) {
                Ok(input_bytes) => StepAdmissionWork::QuickCode {
                    budget_bytes,
                    input_bytes: u64::try_from(input_bytes)
                        .expect("a length held in memory fits in 64 bits"),
                    output_max_bytes,
                    node_key,
                },
                Err(error) => {
                    // Every path drops the turn before it reports, so a slow report channel never
                    // holds up the line.
                    drop(turn);
                    let failure = StepFailure::Failed(Box::new(uncoded_step_error(format!(
                        "the step's input could not be measured: {error}"
                    ))));
                    let failed = StepSettlement::Failed {
                        failure: fill_step_failure(failure, &node.id, &scope.redaction),
                        log_lines: Vec::new(),
                    };
                    self.report(&step, &cancel, StepReportKind::Settled(failed))
                        .await;
                    return;
                }
            },
        };
        let is_canceled_in_line = tokio::select! {
            biased;
            () = cancel.cancelled() => true,
            () = turn.wait() => false,
        };
        if is_canceled_in_line {
            drop(turn);
            let canceled = StepSettlement::Canceled {
                hold_started_at: None,
                is_sibling_failure: false,
            };
            self.report(&step, &cancel, StepReportKind::Settled(canceled))
                .await;
            return;
        }
        let ticket: Arc<dyn StepAdmissionTicket> = Arc::from(self.ports.admission.enqueue(work));
        drop(turn);
        let end = wait_at_gate(step.clone(), ticket.admitted(), &cancel, &self.reports).await;
        let settlement = match end {
            GateWaitEnd::Admitted => {
                self.drive(scope, snapshot, ready, cancel, Some(ticket))
                    .await;
                return;
            }
            GateWaitEnd::Withdrawn { .. } => {
                let failure = StepFailure::Failed(Box::new(uncoded_step_error(
                    "the memory gate released the step before admitting it".to_owned(),
                )));
                StepSettlement::Failed {
                    failure: fill_step_failure(failure, &node.id, &scope.redaction),
                    log_lines: Vec::new(),
                }
            }
            // Dropping the ticket below withdraws the step's place.
            GateWaitEnd::Canceled { hold_started_at } => StepSettlement::Canceled {
                hold_started_at,
                is_sibling_failure: false,
            },
            // The tick's loop cancels the run once it stops reading reports, so nothing is left
            // to tell.
            GateWaitEnd::ReportsClosed => return,
        };
        self.report(&step, &cancel, StepReportKind::Settled(settlement))
            .await;
        drop(ticket);
    }

    /// Drives the admitted step `ready`, its inputs already cut for execute-once, to its
    /// settlement: launched holding its place at the memory gate, `admission`, then started and
    /// run. A launch that fails after the step's cancel settles canceled.
    async fn drive(
        self,
        scope: Arc<RunScope>,
        snapshot: RunSnapshot,
        ready: ReadyStep,
        cancel: CancellationToken,
        admission: Option<Arc<dyn StepAdmissionTicket>>,
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
        let launched = self
            .launch(
                &scope,
                &snapshot,
                &ready,
                kind,
                cancel.clone(),
                admission.clone(),
            )
            .await;
        let context = match launched {
            Ok(context) => context,
            Err(failure) => {
                // A cancel during the launch comes back as the launch's own failure.
                let settlement = if cancel.is_cancelled() {
                    StepSettlement::Canceled {
                        hold_started_at: None,
                        is_sibling_failure: false,
                    }
                } else {
                    StepSettlement::Failed {
                        failure: fill_step_failure(failure, &node.id, &scope.redaction),
                        log_lines: Vec::new(),
                    }
                };
                self.report(&step, &cancel, StepReportKind::Settled(settlement))
                    .await;
                drop(admission);
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
        // Dropped only after the settlement is sent, so the gate place they hold is released
        // after the report.
        drop(context);
        drop(admission);
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
