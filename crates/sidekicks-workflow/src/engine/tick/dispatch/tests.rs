mod gate;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::future::BoxFuture;
use rstest::rstest;
use secrecy::SecretString;
use serde_json::{Map, Value, json};
use sidekicks_contracts::workflow::definition::document::WorkflowNode;
use sidekicks_contracts::workflow::definition::item::WorkflowItem;
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;
use sidekicks_contracts::workflow::run::trigger::WorkflowRunMode;
use sidekicks_ipc::redaction::CREDENTIAL_REDACTION;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::writer::test_file::TestDatabase;
use tokio::sync::{Notify, mpsc};
use tokio::time::timeout;

use super::{test_dispatch, test_ready_step, test_run_snapshot};
use crate::definitions::content_hash::hash_canonical_json;
use crate::engine::ports::{AgentStepRequest, ScriptedGate, StepAdmission};
use crate::engine::start::hash_run_pins;
use crate::engine::tick::{RunScope, StepReport, StepReportKind, StepSettlement, test_run_scope};
use crate::kinds::step_context::StepContext;
use crate::kinds::{
    NodeExecutor, NodeKind, StepAdmissionNeed, StepFailure, StepOutcome, test_kind,
    uncoded_step_error,
};
use crate::schema::schema_parts;
use crate::secrets::redaction::RunRedaction;

/// The longest a test waits on a report or a signal.
pub(super) const WAIT: Duration = Duration::from_secs(10);

/// How long a test waits to see that nothing happens.
pub(super) const QUIET: Duration = Duration::from_millis(50);

/// The run's secret, which a failure and an output must never carry.
pub(super) const SECRET: &str = "hunter2secretXYZ";

/// What a test executor does.
#[derive(Clone, Copy)]
pub(super) enum Script {
    /// Records how many items each input holds and whether it holds a gate ticket, marks progress,
    /// sets the run variable `answer`, waits for the test's release, then passes its inputs on.
    Progress,
    /// Records the `name` param of its item 0 and gives one item holding it; fails on `fails_on`.
    EchoName {
        /// The name the call fails on.
        fails_on: Option<&'static str>,
    },
    /// Waits for the test's release, marks progress, then waits for its cancel and flags it.
    AwaitCancel,
    /// Fails with a coded failure whose message and details hold the run's secret.
    FailWithSecret,
    /// Gives one item holding the run's secret in its data, a member name and its failure.
    OutputSecret,
    /// Asks for an agent run carrying the params of its item 0.
    AskAgentRun,
    /// Waits for the test's release, then asks as [`Script::AskAgentRun`] does.
    AwaitReleaseThenAskAgentRun,
}

/// What a test executor saw, and the signals between it and the test.
#[derive(Default)]
pub(super) struct ExecutorProbe {
    /// Lets a waiting executor go on.
    release: Notify,
    /// What each call saw, in call order.
    seen: Mutex<Vec<Value>>,
    /// Whether the executor saw its cancel.
    is_canceled: AtomicBool,
    /// Woken once the executor saw its cancel.
    canceled: Notify,
    /// Whether the executor's step held its place at the memory gate.
    is_admitted: AtomicBool,
}

impl ExecutorProbe {
    /// Lets one waiting executor go on; a release with no waiter is kept for the next.
    pub(super) fn release(&self) {
        self.release.notify_one();
    }
}

/// A test executor following its script.
struct ScriptedExecutor {
    /// What it does.
    script: Script,
    /// What its step needs from the memory gate.
    need: StepAdmissionNeed,
    /// What it reports to the test.
    probe: Arc<ExecutorProbe>,
}

impl NodeExecutor for ScriptedExecutor {
    fn execute<'step>(
        &'step self,
        context: &'step StepContext,
        inputs: Vec<Vec<WorkflowItem>>,
    ) -> BoxFuture<'step, Result<StepOutcome, StepFailure>> {
        Box::pin(async move {
            let probe = &self.probe;
            match self.script {
                Script::Progress => {
                    let lengths: Vec<usize> = inputs.iter().map(Vec::len).collect();
                    lock(&probe.seen).push(json!(lengths));
                    probe
                        .is_admitted
                        .store(context.admission.is_some(), Ordering::SeqCst);
                    context.mark_progress();
                    let mut variables = Map::new();
                    variables.insert("answer".to_owned(), json!(42));
                    context.set_run_variables(variables, false);
                    probe.release.notified().await;
                    Ok(StepOutcome::Outputs(inputs))
                }
                Script::EchoName { fails_on } => {
                    let params = context
                        .item_params(0)
                        .await
                        .expect("the call's params evaluate");
                    let name = params["name"]
                        .as_str()
                        .expect("the name is text")
                        .to_owned();
                    lock(&probe.seen).push(json!(name));
                    if fails_on == Some(name.as_str()) {
                        let error = uncoded_step_error(format!("no {name}"));
                        return Err(StepFailure::Failed(Box::new(error)));
                    }
                    Ok(StepOutcome::Outputs(vec![vec![
                        serde_json::from_value(json!({ "json": { "seen": name } }))
                            .expect("the test's item reads"),
                    ]]))
                }
                Script::AwaitCancel => {
                    probe.release.notified().await;
                    context.mark_progress();
                    context.cancel.cancelled().await;
                    probe.is_canceled.store(true, Ordering::SeqCst);
                    probe.canceled.notify_one();
                    Ok(StepOutcome::Outputs(inputs))
                }
                Script::FailWithSecret => Err(StepFailure::Failed(Box::new(
                    serde_json::from_value(json!({
                        "message": format!("token {SECRET} refused"),
                        "code": "workflow.test.refused",
                        "details": {
                            "token": SECRET, "tried": [format!("Bearer {SECRET}")], SECRET: 1,
                        },
                    }))
                    .expect("the test's failure reads"),
                ))),
                Script::OutputSecret => Ok(StepOutcome::Outputs(vec![vec![secret_item()]])),
                Script::AskAgentRun | Script::AwaitReleaseThenAskAgentRun => {
                    if matches!(self.script, Script::AwaitReleaseThenAskAgentRun) {
                        probe.release.notified().await;
                    }
                    let params = context
                        .item_params(0)
                        .await
                        .expect("the item's params evaluate");
                    Ok(StepOutcome::AgentRun(AgentStepRequest {
                        session_id: context.session_id,
                        step: context.step.clone(),
                        node_key: context.node_key.clone(),
                        permission_level: context.permission_level,
                        params: Map::clone(&params),
                    }))
                }
            }
        })
    }

    fn admission_need(&self, _node: &WorkflowNode) -> StepAdmissionNeed {
        self.need
    }
}

/// An item holding the run's secret in its data, nested and as a member name, and in its coded
/// failure's message and details.
pub(super) fn secret_item() -> WorkflowItem {
    serde_json::from_value(json!({
        "json": { "token": SECRET, "headers": [{ "auth": format!("Bearer {SECRET}") }], SECRET: 1 },
        "error": {
            "message": format!("{SECRET} expired"),
            "code": "workflow.test.refused",
            "details": { "token": SECRET },
        },
    }))
    .expect("the test's item reads")
}

/// Asserts that `settlement`, as JSON, carries the mask and nowhere the run's secret.
pub(super) fn assert_masked(settlement: &Value) {
    let text = settlement.to_string();
    assert!(
        !text.contains(SECRET),
        "the secret reached the tick: {text}"
    );
    assert!(
        text.contains(CREDENTIAL_REDACTION),
        "nothing was masked: {text}"
    );
}

/// The kind `test.step` at version 1, one main input and output and a sensitive `token` param,
/// run once per item when `is_per_item`, its executor following `script` and its steps needing
/// `need` from the memory gate.
pub(super) fn scripted_kind(
    script: Script,
    need: StepAdmissionNeed,
    probe: &Arc<ExecutorProbe>,
    is_per_item: bool,
) -> NodeKind {
    let mut spec = json!({
        "kind": "test.step", "version": 1, "category": "developer",
        "displayName": "Step", "description": "A test kind.", "icon": "test",
        "outputsDeriveFromParams": false,
        "inputs": [{ "type": "main", "id": "inputs/main/0", "label": "In" }],
        "outputs": [{ "type": "main", "id": "outputs/main/0", "label": "Out" }],
        "params": [{ "id": "token", "label": "Token", "type": "string", "sensitive": true }],
    });
    if is_per_item {
        spec["perItem"] = json!(true);
    }
    test_kind(
        spec,
        None,
        Box::new(ScriptedExecutor {
            script,
            need,
            probe: Arc::clone(probe),
        }),
    )
}

/// The node `step` of `test.step` at version 1 with no params, each member of `settings` laid
/// over it.
pub(super) fn test_node(settings: &Value) -> WorkflowNode {
    let mut node = json!({
        "id": "step", "kind": "test.step", "kindVersion": 1, "name": "Step", "order": 0,
        "params": {},
    });
    for (member, value) in settings.as_object().expect("the settings are an object") {
        node[member] = value.clone();
    }
    serde_json::from_value(node).expect("the test's node reads")
}

/// `report` of step `step` as JSON, reading every member it carries.
pub(super) fn report_json(report: &StepReport, step: &WorkflowStepKey) -> Value {
    assert_eq!(&report.step, step);
    match &report.kind {
        StepReportKind::WaitingOnMemory { hold_started_at } => {
            json!({ "waitingOnMemory": hold_started_at })
        }
        StepReportKind::Admitted { hold_started_at } => json!({ "admitted": hold_started_at }),
        StepReportKind::Started {
            input_ref,
            permission_level,
            pin_hash,
        } => {
            let mut started = json!({ "inputRef": input_ref, "permissionLevel": permission_level });
            if let Some(pin_hash) = pin_hash {
                started["pinHash"] = json!(pin_hash);
            }
            json!({ "started": started })
        }
        StepReportKind::Progressed => json!("progressed"),
        StepReportKind::Canceling { .. }
        | StepReportKind::BranchesCanceled { .. }
        | StepReportKind::ResumeDue { .. }
        | StepReportKind::RunCapped { .. } => {
            panic!("no dispatched step winds a branch down or comes due")
        }
        StepReportKind::Settled(settlement) => settlement_json(settlement),
    }
}

/// `settlement` as JSON, reading every member it carries.
fn settlement_json(settlement: &StepSettlement) -> Value {
    match settlement {
        StepSettlement::Completed {
            outputs,
            cost,
            log_lines,
            run_variables,
        } => {
            let run_variables: Map<String, Value> = run_variables
                .iter()
                .map(|(name, variable)| {
                    let value = json!({ "value": variable.value, "isKept": variable.is_kept });
                    (name.clone(), value)
                })
                .collect();
            json!({ "completed": {
                "outputs": outputs, "cost": cost, "logLines": log_lines,
                "runVariables": run_variables,
            } })
        }
        StepSettlement::Failed { failure, log_lines } => {
            let failure = match failure {
                StepFailure::Failed(error) => {
                    serde_json::to_value(error).expect("a step failure writes")
                }
                StepFailure::EndsRun(error) => {
                    let error = serde_json::to_value(error).expect("a step failure writes");
                    json!({ "endsRun": error })
                }
                StepFailure::Crashed(error) => {
                    let error = serde_json::to_value(error).expect("a step failure writes");
                    json!({ "crashed": error })
                }
                StepFailure::Declined { words, at } => json!({ "words": words, "at": at }),
            };
            json!({ "failed": { "failure": failure, "logLines": log_lines } })
        }
        StepSettlement::PersonWait {
            wait,
            admission,
            log_lines,
        } => json!({ "personWait": {
            "wait": format!("{wait:?}"), "isAdmitted": admission.is_some(), "logLines": log_lines,
        } }),
        StepSettlement::AccountSpent {
            provider_account_id,
            resets_at,
            run: _,
            records,
        } => json!({ "accountSpent": {
            "providerAccountId": provider_account_id, "resetsAt": resets_at,
            "logLines": records.log_lines,
        } }),
        StepSettlement::Canceled {
            hold_started_at,
            cancellation_reason,
        } => json!({ "canceled": {
            "holdStartedAt": hold_started_at, "cancellationReason": cancellation_reason,
        } }),
    }
}

/// The next report on `received` as JSON, `None` once every driver ended.
pub(super) async fn next_report(
    received: &mut mpsc::Receiver<StepReport>,
    step: &WorkflowStepKey,
) -> Option<Value> {
    timeout(WAIT, received.recv())
        .await
        .expect("the driver reports in time")
        .map(|report| report_json(&report, step))
}

/// Dispatches the first execution of `node`, the only node of `scope`'s run, of `kind`, over an
/// item holding each value of `inputs` on its one input, its steps entering `gate` where one is
/// given, else ports refusing every call. Admits the gate each time the step reports a hold and
/// releases the executor each time it reports progress. Answers the reports `dispatch` answered,
/// then every report its driver sent until it ended.
async fn run_step(
    scope: RunScope,
    node: &WorkflowNode,
    kind: NodeKind,
    inputs: Vec<Value>,
    probe: &ExecutorProbe,
    gate: Option<&Arc<ScriptedGate>>,
) -> (Vec<Value>, Vec<Value>) {
    let database = TestDatabase::new(schema_parts());
    let (mut dispatch, mut received) = test_dispatch(&database, vec![kind]);
    if let Some(gate) = gate {
        dispatch.ports.admission = Arc::clone(gate) as Arc<dyn StepAdmission>;
    }
    let scope = Arc::new(scope);
    let ready = test_ready_step(&scope, node, vec![inputs]);
    let step = ready.step.clone();
    let dispatched = dispatch
        .dispatch(&scope, &test_run_snapshot(node), vec![ready])
        .remove(0);
    drop(dispatch);
    let answered = dispatched
        .reports
        .iter()
        .map(|report| report_json(report, &step))
        .collect();
    let mut sent = Vec::new();
    while let Some(report) = next_report(&mut received, &step).await {
        if report == json!("progressed") {
            probe.release.notify_one();
        }
        if let Some(gate) = gate.filter(|_gate| report.get("waitingOnMemory").is_some()) {
            gate.admit();
        }
        sent.push(report);
    }
    (answered, sent)
}

/// An item holding `name` and its lineage to input item `item`.
fn named_item(name: &str, item: u64) -> Value {
    json!({ "json": { "name": name }, "pairedItem": { "item": item } })
}

/// The `Started` every test step sends.
fn started() -> Value {
    json!({ "started": { "inputRef": { "kind": "inline", "items": [] }, "permissionLevel": null } })
}

/// A `Completed` settlement with `outputs` and `run_variables`, no cost and no log line.
fn completed(outputs: &Value, run_variables: &Value) -> Value {
    json!({ "completed": {
        "outputs": outputs, "cost": null, "logLines": [], "runVariables": run_variables,
    } })
}

/// The items pinned onto every pinned test node.
fn pinned_items() -> Value {
    json!([{ "json": { "pinned": true } }])
}

/// The stored pins of the test's workflow: the test node's pinned items.
fn pin_data_json() -> String {
    json!({ "step": pinned_items() }).to_string()
}

/// What the dispatch answers for a node pinned in a manual run: admitted, started with the hash of
/// its pinned item list and completed with the pinned item.
fn pinned_settlement() -> Vec<Value> {
    let pin_hash = hash_canonical_json(&pinned_items()).expect("the test's pins hash");
    let mut started = started();
    started["started"]["pinHash"] = json!(pin_hash);
    vec![
        json!({ "admitted": null }),
        started,
        completed(&json!([[{ "json": { "pinned": true } }]]), &json!({})),
    ]
}

/// A `Failed` settlement with `failure` and no log line.
fn failed(failure: &Value) -> Value {
    json!({ "failed": { "failure": failure, "logLines": [] } })
}

/// The dispatch admits a step at once; its driver sends `Started` with the step's input before
/// the executor's progress, then `Completed` with the lineage filled and the run variable set. A
/// trigger run ignores a node's pin, and an execute-once node runs over its first item. Mutations:
/// send `Started` after the executor; drop the records; skip the lineage fill; honor a pin in a
/// trigger run; skip the execute-once cut.
#[rstest]
#[case::unpinned(WorkflowRunMode::Manual, false, json!({}), 2, 2)]
#[case::pinned_trigger(WorkflowRunMode::Trigger, true, json!({}), 2, 2)]
#[case::execute_once(WorkflowRunMode::Manual, false, json!({ "executeOnce": true }), 3, 1)]
#[tokio::test]
async fn a_step_reports_its_start_progress_and_outputs_in_order(
    #[case] mode: WorkflowRunMode,
    #[case] is_pinned: bool,
    #[case] settings: Value,
    #[case] input_count: usize,
    #[case] executor_item_count: usize,
) {
    let probe = Arc::new(ExecutorProbe::default());
    let node = test_node(&settings);
    let mut scope = test_run_scope(mode, vec![node.clone()]);
    if is_pinned {
        scope.pins = hash_run_pins(Some(&pin_data_json()), mode).expect("the test's pins hash");
    }
    let names = ["Ada", "Bob", "Cy"];
    let inputs = names[..input_count]
        .iter()
        .map(|name| json!({ "name": name }))
        .collect();

    let (answered, sent) = run_step(
        scope,
        &node,
        scripted_kind(
            Script::Progress,
            StepAdmissionNeed::Unweighed,
            &probe,
            false,
        ),
        inputs,
        &probe,
        None,
    )
    .await;

    let outputs: Vec<Value> = names[..executor_item_count]
        .iter()
        .zip(0..)
        .map(|(name, item)| named_item(name, item))
        .collect();
    assert_eq!(answered, vec![json!({ "admitted": null })]);
    assert_eq!(
        sent,
        vec![
            started(),
            json!("progressed"),
            completed(
                &json!([outputs]),
                &json!({ "answer": { "value": 42, "isKept": false } }),
            ),
        ]
    );
    assert_eq!(*lock(&probe.seen), vec![json!([executor_item_count])]);
}

/// A per-item kind runs once per item, in order, each call reading its own item as item 0, and
/// joins the calls' outputs in call order; a failing call settles the step there, carrying the
/// call's index and the node's id, unless the node's `onError` goes on, when the call's item is
/// passed on with the error naming it and the next call runs. Mutations: leave the item cursor
/// unmoved, so both calls read `Ada`; drop the call's index; run a call after a failure the node
/// does not go on past; stop at a failure it goes on past; leave the passed-on error naming the
/// call's own item 0; put the passed-on item on the main output under `continueErrorOutput`.
#[rstest]
#[case::every_call(
    None,
    None,
    &["Ada", "Bob"],
    &["Ada", "Bob"],
    completed(
        &json!([[
            { "json": { "seen": "Ada" }, "pairedItem": { "item": 0 } },
            { "json": { "seen": "Bob" }, "pairedItem": { "item": 1 } },
        ]]),
        &json!({}),
    )
)]
#[case::failing_call(
    None,
    Some("Bob"),
    &["Ada", "Bob", "Cy"],
    &["Ada", "Bob"],
    failed(&json!({ "message": "no Bob", "nodeId": "step", "itemIndex": 1 }))
)]
#[case::continue_past_failing_call(
    Some("continue"),
    Some("Bob"),
    &["Ada", "Bob", "Cy"],
    &["Ada", "Bob", "Cy"],
    completed(
        &json!([[
            { "json": { "seen": "Ada" }, "pairedItem": { "item": 0 } },
            {
                "json": { "name": "Bob" }, "pairedItem": { "item": 1, "input": 0 },
                "error": { "message": "no Bob", "nodeId": "step", "itemIndex": 1 },
            },
            { "json": { "seen": "Cy" }, "pairedItem": { "item": 2 } },
        ]]),
        &json!({}),
    )
)]
#[case::error_output_past_failing_call(
    Some("continueErrorOutput"),
    Some("Bob"),
    &["Ada", "Bob", "Cy"],
    &["Ada", "Bob", "Cy"],
    completed(
        &json!([
            [
                { "json": { "seen": "Ada" }, "pairedItem": { "item": 0 } },
                { "json": { "seen": "Cy" }, "pairedItem": { "item": 2 } },
            ],
            [{
                "json": { "name": "Bob" }, "pairedItem": { "item": 1, "input": 0 },
                "error": { "message": "no Bob", "nodeId": "step", "itemIndex": 1 },
            }],
        ]),
        &json!({}),
    )
)]
#[tokio::test]
async fn a_per_item_kind_runs_once_per_item_in_order(
    #[case] on_error: Option<&'static str>,
    #[case] fails_on: Option<&'static str>,
    #[case] names: &[&str],
    #[case] seen: &[&str],
    #[case] settlement: Value,
) {
    let probe = Arc::new(ExecutorProbe::default());
    let mut settings = json!({ "params": { "name": "={{ $json.name }}" } });
    if let Some(on_error) = on_error {
        settings["onError"] = json!(on_error);
    }
    let node = test_node(&settings);

    let (answered, sent) = run_step(
        test_run_scope(WorkflowRunMode::Manual, vec![node.clone()]),
        &node,
        scripted_kind(
            Script::EchoName { fails_on },
            StepAdmissionNeed::Unweighed,
            &probe,
            true,
        ),
        names.iter().map(|name| json!({ "name": name })).collect(),
        &probe,
        None,
    )
    .await;

    assert_eq!(answered, vec![json!({ "admitted": null })]);
    assert_eq!(sent, vec![started(), settlement]);
    let seen: Vec<Value> = seen.iter().map(|name| json!(name)).collect();
    assert_eq!(*lock(&probe.seen), seen);
}

/// A canceled step settles `Canceled` only once its executor returns, and a step whose reports the
/// tick stopped taking is canceled and reports nothing more. Mutations: drop the executor's future
/// at the cancel; ignore a closed report channel.
#[rstest]
#[case::canceled(false)]
#[case::reports_closed(true)]
#[tokio::test]
async fn a_canceled_step_settles_once_its_executor_returns(#[case] is_receiver_dropped: bool) {
    let probe = Arc::new(ExecutorProbe::default());
    let node = test_node(&json!({}));
    let database = TestDatabase::new(schema_parts());
    let (dispatch, mut received) = test_dispatch(
        &database,
        vec![scripted_kind(
            Script::AwaitCancel,
            StepAdmissionNeed::Unweighed,
            &probe,
            false,
        )],
    );
    let scope = Arc::new(test_run_scope(WorkflowRunMode::Manual, vec![node.clone()]));
    let ready = test_ready_step(&scope, &node, vec![vec![json!({})]]);
    let step = ready.step.clone();
    let dispatched = dispatch
        .dispatch(&scope, &test_run_snapshot(&node), vec![ready])
        .remove(0);
    drop(dispatch);
    assert_eq!(next_report(&mut received, &step).await, Some(started()));

    if is_receiver_dropped {
        drop(received);
        probe.release.notify_one();
        timeout(WAIT, probe.canceled.notified())
            .await
            .expect("the closed report channel cancels the step");
        assert!(dispatched.cancel.is_cancelled());
        return;
    }
    probe.release.notify_one();
    assert_eq!(
        next_report(&mut received, &step).await,
        Some(json!("progressed"))
    );
    dispatched.cancel.cancel();
    let settled = next_report(&mut received, &step).await;
    assert!(probe.is_canceled.load(Ordering::SeqCst));
    assert_eq!(
        settled,
        Some(json!({ "canceled": { "holdStartedAt": null, "cancellationReason": null } }))
    );
    assert_eq!(next_report(&mut received, &step).await, None);
}

/// A step that cannot run fails with its node's id and its message and details scrubbed of the
/// run's secrets: an unclosed template before any `Started`, an unlisted kind version in the
/// dispatch's own answer with no driver, an executor's coded failure after `Started`, and an
/// executor asking for an agent run. Mutations: send `Started` before a launch failure; leave the
/// secret in the message; leave it in a coded failure's details, a member's name among them;
/// accept the agent run.
#[rstest]
#[case::unclosed_template(
    json!({ "params": { "bad": "={{ a" } }),
    Script::Progress,
    vec![json!({ "admitted": null })],
    vec![failed(&json!({ "message": "the template at bad is never closed", "nodeId": "step" }))]
)]
#[case::unlisted_version(
    json!({ "kindVersion": 2 }),
    Script::Progress,
    vec![
        json!({ "admitted": null }),
        failed(&json!({
            "message": "this service runs no kind test.step at version 2", "nodeId": "step",
        })),
    ],
    Vec::new()
)]
#[case::coded_failure(
    json!({}),
    Script::FailWithSecret,
    vec![json!({ "admitted": null })],
    vec![
        started(),
        failed(&json!({
            "message": format!("token {CREDENTIAL_REDACTION} refused"),
            "code": "workflow.test.refused",
            "details": {
                "token": CREDENTIAL_REDACTION,
                "tried": [format!("Bearer {CREDENTIAL_REDACTION}")],
                CREDENTIAL_REDACTION: 1,
            },
            "nodeId": "step",
        })),
    ]
)]
#[case::agent_run(
    json!({}),
    Script::AskAgentRun,
    vec![json!({ "admitted": null })],
    vec![
        started(),
        failed(&json!({
            "message": "the kind test.step asked for an agent run, which only an agent step starts",
            "nodeId": "step",
        })),
    ]
)]
#[tokio::test]
async fn a_step_that_cannot_run_fails_with_its_node(
    #[case] settings: Value,
    #[case] script: Script,
    #[case] expected_answered: Vec<Value>,
    #[case] expected_sent: Vec<Value>,
) {
    let probe = Arc::new(ExecutorProbe::default());
    let node = test_node(&settings);
    let mut scope = test_run_scope(WorkflowRunMode::Manual, vec![node.clone()]);
    scope.redaction = Arc::new(RunRedaction::new(&[SecretString::from(SECRET)]));

    let (answered, sent) = run_step(
        scope,
        &node,
        scripted_kind(script, StepAdmissionNeed::Unweighed, &probe, false),
        vec![json!({})],
        &probe,
        None,
    )
    .await;

    assert_eq!(answered, expected_answered);
    assert_eq!(sent, expected_sent);
}

/// A step's output items reach the tick with the run's secret masked wherever they carry it: in
/// their data at any depth, in a member name and in an item's failure. Mutation: settle the
/// executor's outputs unscrubbed.
#[tokio::test]
async fn a_steps_outputs_reach_the_tick_masked() {
    let probe = Arc::new(ExecutorProbe::default());
    let node = test_node(&json!({}));
    let mut scope = test_run_scope(WorkflowRunMode::Manual, vec![node.clone()]);
    scope.redaction = Arc::new(RunRedaction::new(&[SecretString::from(SECRET)]));

    let (_answered, sent) = run_step(
        scope,
        &node,
        scripted_kind(
            Script::OutputSecret,
            StepAdmissionNeed::Unweighed,
            &probe,
            false,
        ),
        vec![json!({})],
        &probe,
        None,
    )
    .await;

    let settlement = sent.last().expect("the step settled");
    assert!(settlement.get("completed").is_some(), "{settlement}");
    assert_masked(settlement);
}
