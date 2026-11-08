//! The tick's dispatch: it decides in the tick's turn how each step the walk readies is admitted,
//! and a driver task per step launches it, evaluating its params, waits at the memory gate where
//! its kind asks, steps readied together entering in their order, runs its executor and settles
//! it, sending every later report to the tick. An agent step's driver creates the step's agent
//! run, which waits at the gate itself, and follows the run to its end.

mod agent_step;
mod launch;
mod run;
#[cfg(test)]
mod tests;

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::error::Error;
use std::sync::Arc;

use serde_json::Value;
use sidekicks_contracts::jsonrpc::byte_length::json_utf8_byte_length;
use sidekicks_contracts::wire::AnyValue;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::record::Record;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_contracts::workflow::definition::document::{WorkflowNode, WorkflowNodeId};
use sidekicks_contracts::workflow::definition::item::{WorkflowItem, WorkflowStepError};
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::admission::{GateEntryOrder, GateWaitEnd, SiblingEntry, send, wait_at_gate};
use super::node_settings::{
    execute_once_inputs, main_input_lengths, main_output_count, pinned_outputs, shape_outputs,
};
use super::{ReadyStep, RunScope, RunSnapshot, StepReport, StepReportKind, StepSettlement};
use crate::engine::event_record::{EngineFault, EngineRecorder};
use crate::engine::ports::{EnginePorts, StepAdmissionTicket, StepAdmissionWork, WorkflowNodeKey};
use crate::expressions::evaluator::ExpressionEvaluator;
use crate::kinds::step_context::StepContext;
use crate::kinds::{
    NodeKind, NodeKindTable, StepAdmissionNeed, StepAdmissionShape, StepFailure, uncoded_step_error,
};
use crate::secrets::redaction::RunRedaction;
use crate::secrets::store::WorkflowSecretStore;

/// Launches and drives the steps the tick readies, through the engine's ports and the service's
/// expression thread, database reads, secret store and HTTP client, reporting to the tick.
#[derive(Clone)]
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
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
    /// The engine's record for this daemon life, over the ports' sink.
    recorder: Arc<EngineRecorder>,
}

/// A step the dispatch admitted: its own cancel and the reports the tick writes for it this turn.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct DispatchedStep {
    /// The step's cancel, a child of its run's.
    pub(crate) cancel: CancellationToken,
    /// The reports the tick writes this turn, in order.
    pub(crate) reports: Vec<StepReport>,
}

impl StepDispatch {
    /// The dispatch over `ports`, `evaluator`, `reads`, `secrets`, `http` and `kinds`, sending its
    /// drivers' reports on `reports` and recording the engine's faults in `recorder`, the record
    /// the run start keeps for this daemon life, so a run's lines carry one life and one sequence.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    #[expect(
        clippy::too_many_arguments,
        reason = "each is a separate service the dispatch drives steps through"
    )]
    pub(crate) fn new(
        ports: EnginePorts,
        evaluator: ExpressionEvaluator,
        reads: Arc<DatabaseReadPool>,
        secrets: Arc<WorkflowSecretStore>,
        http: reqwest::Client,
        kinds: Arc<NodeKindTable>,
        reports: mpsc::Sender<StepReport>,
        recorder: Arc<EngineRecorder>,
    ) -> Self {
        Self {
            ports,
            recorder,
            evaluator,
            reads,
            secrets,
            http,
            kinds,
            reports,
            gate_entries: GateEntryOrder::default(),
        }
    }

    /// Dispatches `readied`, the steps of the run of `scope` the walk readied in one turn in its
    /// order, reading `snapshot`, deciding in this turn how each is admitted, and answers each
    /// step's cancel and the reports the tick writes this turn, in the same order. A kind or
    /// version the table does not list fails at once, and a node pinned in a manual run settles
    /// with its pinned items, both with no task. A step the memory gate does not weigh is admitted
    /// at once and its driver spawned; a step the gate weighs, and an agent step, whose run joins
    /// the gate, has its driver evaluate its params first and take its turn in the entry line only
    /// then, after every sibling before it has taken its own, so the line holds evaluated steps,
    /// siblings in their order, and no step waits behind the evaluation of a step readied in
    /// another turn; the driver reports its hold and its admission. Must be called inside tokio.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) fn dispatch(
        &self,
        scope: &Arc<RunScope>,
        snapshot: &RunSnapshot,
        readied: Vec<ReadyStep>,
    ) -> Vec<DispatchedStep> {
        let entries = self.gate_entries.sibling_entries(readied.len());
        readied
            .into_iter()
            .zip(entries)
            .map(|(ready, entry)| self.dispatch_step(scope, snapshot, ready, entry))
            .collect()
    }

    /// Dispatches `ready` as [`Self::dispatch`] does, its `entry` its place among its siblings,
    /// given up at once by a step that takes no turn in the line.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    fn dispatch_step(
        &self,
        scope: &Arc<RunScope>,
        snapshot: &RunSnapshot,
        mut ready: ReadyStep,
        entry: SiblingEntry,
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
        if let Some(pin) = scope.pins.get(&node.id) {
            let mut outputs = pinned_outputs(pin, main_output_count(kind.spec.outputs.as_slice()));
            shape_outputs(
                node,
                &main_input_lengths(&kind.spec, &ready.inputs),
                &mut outputs,
            );
            let started = StepReportKind::Started {
                input_ref: ready.input_ref,
                permission_level: None,
                pin_hash: Some(pin.hash.clone()),
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
                ));
                DispatchedStep { cancel, reports }
            }
            StepAdmissionNeed::Gate(shape) => {
                tokio::spawn(self.clone().drive_at_gate(
                    Arc::clone(scope),
                    snapshot.clone(),
                    ready,
                    entry,
                    cancel.clone(),
                    shape,
                ));
                DispatchedStep {
                    cancel,
                    reports: Vec::new(),
                }
            }
            StepAdmissionNeed::OwnRun => {
                tokio::spawn(self.clone().drive_agent_step(
                    Arc::clone(scope),
                    snapshot.clone(),
                    ready,
                    entry,
                    cancel.clone(),
                ));
                DispatchedStep {
                    cancel,
                    reports: Vec::new(),
                }
            }
        }
    }

    /// The node of `step`, a step of the run of `scope`, and its kind, both of which the dispatch
    /// found when it dispatched the step.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    fn look_up_step<'scope>(
        &self,
        scope: &'scope RunScope,
        step: &WorkflowStepKey,
    ) -> (&'scope WorkflowNode, &NodeKind) {
        let node = scope
            .nodes
            .get(&step.node_id)
            .expect("the dispatch found the step's node in the run's nodes");
        let kind = self
            .kinds
            .kind_of(node)
            .expect("the dispatch found the node's kind in the table");
        (node, kind)
    }

    /// Drives `ready`, a step the memory gate weighs as `shape`, to its admission: launches it,
    /// which evaluates its params, measures what it runs, then waits for its turn in the entry
    /// line through its sibling `entry`, enters the gate and reports its hold and its admission,
    /// then runs it as [`Self::drive`] does, holding its ticket. A step whose launch fails settles
    /// before it takes a turn; one canceled in the line or at the gate settles canceled; one the
    /// gate releases unadmitted fails.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    async fn drive_at_gate(
        self,
        scope: Arc<RunScope>,
        snapshot: RunSnapshot,
        ready: ReadyStep,
        entry: SiblingEntry,
        cancel: CancellationToken,
        shape: StepAdmissionShape,
    ) {
        let (node, kind) = self.look_up_step(&scope, &ready.step);
        let step = ready.step.clone();
        let launched = self
            .launch(&scope, &snapshot, &ready, kind, cancel.clone())
            .await;
        let mut context = match launched {
            Ok(context) => context,
            Err(failure) => {
                // Every path gives its place up before it reports, so a slow report channel never
                // holds up a sibling.
                drop(entry);
                let settlement =
                    settle_launch_failure(failure, &cancel, &node.id, &scope.redaction);
                self.report(&step, &cancel, StepReportKind::Settled(settlement))
                    .await;
                return;
            }
        };
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
                    drop(entry);
                    drop(context);
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
        // A step canceled before its turn came holds no turn when it reports, so a slow report
        // channel never holds up the line.
        let Some(turn) = entry.wait_for_turn(&cancel).await else {
            drop(context);
            let canceled = StepSettlement::Canceled {
                hold_started_at: None,
                cancellation_reason: None,
            };
            self.report(&step, &cancel, StepReportKind::Settled(canceled))
                .await;
            return;
        };
        let ticket: Arc<dyn StepAdmissionTicket> = Arc::from(self.ports.admission.enqueue(work));
        drop(turn);
        let end = wait_at_gate(step.clone(), ticket.admitted(), &cancel, &self.reports).await;
        let settlement = match end {
            GateWaitEnd::Admitted => {
                context.admission = Some(ticket);
                self.run_launched(&scope, ready, &cancel, context).await;
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
                cancellation_reason: None,
            },
            // The tick's loop cancels the run once it stops reading reports, so nothing is left
            // to tell.
            GateWaitEnd::ReportsClosed => return,
        };
        drop(context);
        self.report(&step, &cancel, StepReportKind::Settled(settlement))
            .await;
        drop(ticket);
    }

    /// Drives the admitted step `ready`, its inputs already cut for execute-once, to its
    /// settlement: launched, then started and run. A launch that fails after the step's cancel
    /// settles canceled.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    async fn drive(
        self,
        scope: Arc<RunScope>,
        snapshot: RunSnapshot,
        ready: ReadyStep,
        cancel: CancellationToken,
    ) {
        let (node, kind) = self.look_up_step(&scope, &ready.step);
        let launched = self
            .launch(&scope, &snapshot, &ready, kind, cancel.clone())
            .await;
        match launched {
            Ok(context) => self.run_launched(&scope, ready, &cancel, context).await,
            Err(failure) => {
                let settlement =
                    settle_launch_failure(failure, &cancel, &node.id, &scope.redaction);
                self.report(&ready.step, &cancel, StepReportKind::Settled(settlement))
                    .await;
            }
        }
    }

    /// Runs the launched step `ready` on its `context`: reports its start, runs its executor and
    /// reports its settlement, then drops the context, so the gate place it holds is released
    /// after the report.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    async fn run_launched(
        &self,
        scope: &RunScope,
        ready: ReadyStep,
        cancel: &CancellationToken,
        context: StepContext,
    ) {
        let (node, kind) = self.look_up_step(scope, &ready.step);
        let step = ready.step.clone();
        let started = StepReportKind::Started {
            input_ref: ready.input_ref,
            permission_level: None,
            pin_hash: None,
        };
        if !self.report(&step, cancel, started).await {
            return;
        }
        if let Some(settlement) = self.run_executor(node, kind, &context, ready.inputs).await {
            self.report(&step, cancel, StepReportKind::Settled(settlement))
                .await;
        }
        drop(context);
    }

    /// Records `fault`, met by `step` of the run of `scope`, with `error`'s chain in the engine's
    /// record.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    async fn record_fault(
        &self,
        scope: &RunScope,
        step: &WorkflowStepKey,
        fault: EngineFault,
        error: &(dyn Error + Send + Sync + 'static),
    ) {
        self.recorder
            .for_run(scope.run_id, Arc::clone(&scope.redaction))
            .fault(Some(step), fault, error)
            .await;
    }

    /// Sends `kind` for `step` to the tick, answering whether the tick took it. When the tick has
    /// stopped taking reports, cancels the step through `cancel`, so a process it started still
    /// ends.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
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

/// The settlement of a step whose launch failed with `failure`: canceled when its `cancel` is,
/// since a cancel during the launch comes back as the launch's own failure, else failed on node
/// `node_id` with its message scrubbed through `redaction`.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
fn settle_launch_failure(
    failure: StepFailure,
    cancel: &CancellationToken,
    node_id: &WorkflowNodeId,
    redaction: &RunRedaction,
) -> StepSettlement {
    if cancel.is_cancelled() {
        StepSettlement::Canceled {
            hold_started_at: None,
            cancellation_reason: None,
        }
    } else {
        StepSettlement::Failed {
            failure: fill_step_failure(failure, node_id, redaction),
            log_lines: Vec::new(),
        }
    }
}

/// The members every arm of a step failure carries: its message, its node and its item.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(super) fn error_members(
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
/// and a coded failure's details scrubbed through `redaction`. A decline passes through.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(super) fn fill_step_failure(
    mut failure: StepFailure,
    node_id: &WorkflowNodeId,
    redaction: &RunRedaction,
) -> StepFailure {
    if let Some(error) = failure.error_mut() {
        error_members(error)
            .1
            .get_or_insert_with(|| node_id.clone());
        scrub_step_error(error, redaction);
    }
    failure
}

/// `outputs`, a step's output items, with every string of each item's data and failure scrubbed
/// through `redaction` before the step settles with them.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
fn scrub_outputs(outputs: &mut [Vec<WorkflowItem>], redaction: &RunRedaction) {
    for item in outputs.iter_mut().flatten() {
        redaction.scrub_json(&mut item.json.0);
        if let Some(error) = &mut item.error {
            scrub_step_error(error, redaction);
        }
    }
}

/// Scrubs `error`'s message and, for a coded failure, every string of its details, member names
/// included, through `redaction`; an agent resolution's details are typed values only.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
fn scrub_step_error(error: &mut WorkflowStepError, redaction: &RunRedaction) {
    let (message, _node_id, _item_index) = error_members(error);
    if let Cow::Owned(scrubbed) = redaction.scrub(message.as_str()) {
        *message = NonEmptyText::new(scrubbed).expect("a mask leaves a message non-empty");
    }
    if let WorkflowStepError::Coded(coded) = error
        && let Some(details) = &mut coded.details
    {
        let mut whole = Value::Object(
            std::mem::take(details)
                .into_map()
                .into_iter()
                .map(|(name, member)| (name, member.0))
                .collect(),
        );
        redaction.scrub_json(&mut whole);
        let members = whole
            .as_object_mut()
            .map(std::mem::take)
            .expect("a scrub keeps an object an object");
        *details = Record::new(
            members
                .into_iter()
                .map(|(name, member)| (name, AnyValue(member)))
                .collect(),
        )
        .expect("a scrub keeps the details a record");
    }
}

/// A dispatch for a test over `database`'s reads, a keychain holding nothing, ports refusing every
/// call and the table of `kinds`, recording in a recorder of its own over the ports' sink, with
/// the receiving end of its report channel.
#[cfg(test)]
fn test_dispatch(
    database: &sidekicks_store::database::writer::test_file::TestDatabase,
    kinds: Vec<crate::kinds::NodeKind>,
) -> (StepDispatch, mpsc::Receiver<StepReport>) {
    let ports = crate::engine::ports::refusing_engine_ports();
    let recorder = Arc::new(EngineRecorder::new(Arc::clone(&ports.records)));
    let kinds = Arc::new(NodeKindTable::new(kinds).expect("the test's kinds build a table"));
    let (dispatch, received, _sender) = test_dispatch_recording(database, ports, kinds, recorder);
    (dispatch, received)
}

/// A dispatch as [`test_dispatch`] builds one, over `ports` and the table `kinds`, recording in
/// `recorder`, with a sending end of its report channel too, which a test reports on as a driver.
#[cfg(test)]
pub(super) fn test_dispatch_recording(
    database: &sidekicks_store::database::writer::test_file::TestDatabase,
    ports: EnginePorts,
    kinds: Arc<NodeKindTable>,
    recorder: Arc<EngineRecorder>,
) -> (
    StepDispatch,
    mpsc::Receiver<StepReport>,
    mpsc::Sender<StepReport>,
) {
    let (reports, received) = mpsc::channel(16);
    let dispatch = StepDispatch::new(
        ports,
        ExpressionEvaluator::start().expect("the expression thread starts"),
        Arc::new(DatabaseReadPool::new(
            database.path(),
            crate::secrets::resolution::STEP_SECRET_STATEMENT_CAPACITY,
        )),
        Arc::new(WorkflowSecretStore::new(
            crate::secrets::store::ScriptedKeychain::holding(&[], false),
        )),
        reqwest::Client::new(),
        kinds,
        reports.clone(),
        recorder,
    );
    (dispatch, received, reports)
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

/// A snapshot of a run in which `node` has not run and no run variable is set, at `Ask`.
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
        permission_level: sidekicks_contracts::session::controls::methods::PermissionLevel::Ask,
    }
}
