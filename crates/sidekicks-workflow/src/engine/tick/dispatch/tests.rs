use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::future::BoxFuture;
use rstest::rstest;
use secrecy::SecretString;
use serde_json::{Map, Value, json};
use sidekicks_contracts::jsonrpc::byte_length::json_utf8_byte_length;
use sidekicks_contracts::wire::record::Record;
use sidekicks_contracts::workflow::definition::document::WorkflowNode;
use sidekicks_contracts::workflow::definition::item::{WorkflowItem, WorkflowPinnedItem};
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;
use sidekicks_contracts::workflow::run::trigger::WorkflowRunMode;
use sidekicks_ipc::redaction::CREDENTIAL_REDACTION;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::writer::test_file::TestDatabase;
use tokio::sync::{Notify, mpsc};
use tokio::time::timeout;

use super::{test_dispatch, test_ready_step, test_run_snapshot};
use crate::engine::ports::{
    AgentStepRequest, ScriptedGate, StepAdmission, StepAdmissionOutcome, StepAdmissionWork,
    StepScriptRuntime, WorkflowNodeKey,
};
use crate::engine::tick::{RunScope, StepReport, StepReportKind, StepSettlement, test_run_scope};
use crate::kinds::step_context::StepContext;
use crate::kinds::{
    NodeExecutor, NodeKind, StepAdmissionNeed, StepAdmissionShape, StepFailure, StepOutcome,
    test_kind, uncoded_step_error,
};
use crate::schema::schema_parts;
use crate::secrets::redaction::RunRedaction;

/// The longest a test waits on a report or a signal.
const WAIT: Duration = Duration::from_secs(10);

/// The run's secret, which a failure's message must never carry.
const SECRET: &str = "hunter2secretXYZ";

/// What a test executor does.
#[derive(Clone, Copy)]
enum Script {
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
    /// Fails with a coded failure whose message holds the run's secret.
    FailWithSecret,
    /// Asks for an agent run.
    AskAgentRun,
}

/// What a test executor saw, and the signals between it and the test.
#[derive(Default)]
struct ExecutorProbe {
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
                    }))
                    .expect("the test's failure reads"),
                ))),
                Script::AskAgentRun => Ok(StepOutcome::AgentRun(AgentStepRequest {
                    session_id: context.session_id,
                    step: context.step.clone(),
                    node_key: context.node_key.clone(),
                    permission_level: context.permission_level,
                    params: Map::new(),
                })),
            }
        })
    }

    fn admission_need(&self, _node: &WorkflowNode) -> StepAdmissionNeed {
        self.need
    }
}

/// The kind `test.step` at version 1, one main input and output and a sensitive `token` param,
/// run once per item when `is_per_item`, its executor following `script` and its steps needing
/// `need` from the memory gate.
fn scripted_kind(
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
fn test_node(settings: &Value) -> WorkflowNode {
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
fn report_json(report: &StepReport, step: &WorkflowStepKey) -> Value {
    assert_eq!(&report.step, step);
    match &report.kind {
        StepReportKind::WaitingOnPool { hold_started_at } => {
            json!({ "waitingOnPool": hold_started_at })
        }
        StepReportKind::Admitted { hold_started_at } => json!({ "admitted": hold_started_at }),
        StepReportKind::Started {
            input_ref,
            permission_level,
        } => json!({ "started": { "inputRef": input_ref, "permissionLevel": permission_level } }),
        StepReportKind::Progressed => json!("progressed"),
        StepReportKind::Canceling | StepReportKind::BranchesCanceled => {
            panic!("no dispatched step winds a branch down")
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
        StepSettlement::AccountSpent { .. } => panic!("no test step spends an account"),
        StepSettlement::Canceled {
            hold_started_at,
            is_sibling_failure,
        } => json!({ "canceled": {
            "holdStartedAt": hold_started_at, "isSiblingFailure": is_sibling_failure,
        } }),
    }
}

/// The next report on `received` as JSON, `None` once every driver ended.
async fn next_report(
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
    let dispatched = dispatch.dispatch(&scope, &test_run_snapshot(node), ready);
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
        if let Some(gate) = gate.filter(|_gate| report.get("waitingOnPool").is_some()) {
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

/// The pin every pinned test node carries.
fn pin_data() -> Record<String, Vec<WorkflowPinnedItem>> {
    serde_json::from_value(json!({ "step": [{ "json": { "pinned": true } }] }))
        .expect("the test's pins read")
}

/// What the dispatch answers for a node pinned in a manual run: admitted, started and completed
/// with the pinned item.
fn pinned_settlement() -> Vec<Value> {
    vec![
        json!({ "admitted": null }),
        started(),
        completed(&json!([[{ "json": { "pinned": true } }]]), &json!({})),
    ]
}

/// A `Failed` settlement with `failure` and no log line.
fn failed(failure: &Value) -> Value {
    json!({ "failed": { "failure": failure, "logLines": [] } })
}

/// The dispatch admits a step at once; its driver sends `Started` with the step's input before
/// the executor's progress, then `Completed` with the lineage filled and the run variable set. A
/// node pinned in a manual run settles with its pinned items in the dispatch's own answer, without
/// resolving a secret or running its executor, a trigger run ignores the pin, and an execute-once
/// node runs over its first item. Mutations: send `Started` after the executor; resolve a pinned
/// node's secrets; drop the records; skip the lineage fill; run a pinned node in a manual run;
/// settle a pinned node from a task; skip the execute-once cut.
#[rstest]
#[case::unpinned(WorkflowRunMode::Manual, false, json!({}), 2, Some(2))]
#[case::pinned_manual(
    WorkflowRunMode::Manual,
    true,
    json!({ "params": { "token": "secret://shared/missing" } }),
    2,
    None
)]
#[case::pinned_trigger(WorkflowRunMode::Trigger, true, json!({}), 2, Some(2))]
#[case::execute_once(WorkflowRunMode::Manual, false, json!({ "executeOnce": true }), 3, Some(1))]
#[tokio::test]
async fn a_step_reports_its_start_progress_and_outputs_in_order(
    #[case] mode: WorkflowRunMode,
    #[case] is_pinned: bool,
    #[case] settings: Value,
    #[case] input_count: usize,
    #[case] executor_item_count: Option<usize>,
) {
    let probe = Arc::new(ExecutorProbe::default());
    let node = test_node(&settings);
    let mut scope = test_run_scope(mode, vec![node.clone()]);
    if is_pinned {
        scope.pin_data = Some(pin_data());
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

    let (expected_answered, expected_sent) = match executor_item_count {
        None => (pinned_settlement(), Vec::new()),
        Some(item_count) => {
            let outputs: Vec<Value> = names[..item_count]
                .iter()
                .zip(0..)
                .map(|(name, item)| named_item(name, item))
                .collect();
            let sent = vec![
                started(),
                json!("progressed"),
                completed(
                    &json!([outputs]),
                    &json!({ "answer": { "value": 42, "isKept": false } }),
                ),
            ];
            (vec![json!({ "admitted": null })], sent)
        }
    };
    assert_eq!(answered, expected_answered);
    assert_eq!(sent, expected_sent);
    let seen: Vec<Value> = executor_item_count
        .map(|item_count| json!([item_count]))
        .into_iter()
        .collect();
    assert_eq!(*lock(&probe.seen), seen);
}

/// A per-item kind runs once per item, in order, each call reading its own item as item 0, and
/// joins the calls' outputs in call order; a failing call settles the step there, carrying the
/// call's index and the node's id. Mutations: leave the item cursor unmoved, so both calls read
/// `Ada`; drop the call's index; run a call after a failure.
#[rstest]
#[case::every_call(
    None,
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
    Some("Bob"),
    &["Ada", "Bob", "Cy"],
    failed(&json!({ "message": "no Bob", "nodeId": "step", "itemIndex": 1 }))
)]
#[tokio::test]
async fn a_per_item_kind_runs_once_per_item_in_order(
    #[case] fails_on: Option<&'static str>,
    #[case] names: &[&str],
    #[case] settlement: Value,
) {
    let probe = Arc::new(ExecutorProbe::default());
    let node = test_node(&json!({ "params": { "name": "={{ $json.name }}" } }));

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
    assert_eq!(*lock(&probe.seen), vec![json!("Ada"), json!("Bob")]);
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
    let dispatched = dispatch.dispatch(&scope, &test_run_snapshot(&node), ready);
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
        Some(json!({ "canceled": { "holdStartedAt": null, "isSiblingFailure": false } }))
    );
    assert_eq!(next_report(&mut received, &step).await, None);
}

/// A step that cannot run fails with its node's id and its message scrubbed of the run's secrets:
/// an unclosed template before any `Started`, an unlisted kind version in the dispatch's own
/// answer with no driver, an executor's coded failure after `Started`, and an executor asking for
/// an agent run. Mutations: send `Started` before a launch failure; leave the secret in the
/// message; accept the agent run.
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

/// A step the memory gate weighs gets nothing in the dispatch's answer: it enters the gate with
/// what it runs, a quick step's input measured, reports its hold where the gate holds it, then its
/// admission, and launches holding its ticket, which is dropped once it settles. A node pinned in
/// a manual run settles in the dispatch's answer without entering the gate. Mutations: run the
/// executor before the admission; answer `Admitted` at dispatch for a gate step; launch without
/// the ticket; leave the input unmeasured or zero; send a pinned step into the gate or settle it
/// from a task.
#[rstest]
#[case::quick_code_held(
    StepAdmissionShape::QuickCode { budget_bytes: 1024, output_max_bytes: 2048 },
    None,
    false
)]
#[case::script_admitted(
    StepAdmissionShape::Script { runtime: StepScriptRuntime::Bun },
    Some(StepAdmissionOutcome::Admitted),
    false
)]
#[case::pinned_manual(
    StepAdmissionShape::Script { runtime: StepScriptRuntime::Bun },
    None,
    true
)]
#[tokio::test]
async fn a_gate_step_waits_for_its_admission_before_it_launches(
    #[case] shape: StepAdmissionShape,
    #[case] initial: Option<StepAdmissionOutcome>,
    #[case] is_pinned: bool,
) {
    let probe = Arc::new(ExecutorProbe::default());
    let node = test_node(&json!({}));
    let mut scope = test_run_scope(WorkflowRunMode::Manual, vec![node.clone()]);
    if is_pinned {
        scope.pin_data = Some(pin_data());
    }
    let inputs: Vec<Value> = ["Ada", "Bob"]
        .iter()
        .map(|name| json!({ "name": name }))
        .collect();
    let input_bytes =
        json_utf8_byte_length(&test_ready_step(&scope, &node, vec![inputs.clone()]).inputs)
            .expect("the test's inputs measure");
    assert_ne!(input_bytes, 0);
    let node_key = WorkflowNodeKey::new(scope.workflow_id, &node.id);
    let gate = Arc::new(ScriptedGate::new(initial));

    let (answered, sent) = run_step(
        scope,
        &node,
        scripted_kind(
            Script::Progress,
            StepAdmissionNeed::Gate(shape),
            &probe,
            false,
        ),
        inputs,
        &probe,
        Some(&gate),
    )
    .await;

    if is_pinned {
        assert_eq!(answered, pinned_settlement());
        assert_eq!(sent, Vec::<Value>::new());
        assert_eq!(gate.enqueued(), Vec::new());
        assert!(lock(&probe.seen).is_empty());
        return;
    }
    assert_eq!(answered, Vec::<Value>::new());
    let mut expected_sent = if initial.is_none() {
        let hold = sent[0]["waitingOnPool"].clone();
        assert!(
            hold.is_string(),
            "the first report is not a hold: {}",
            sent[0]
        );
        vec![
            json!({ "waitingOnPool": hold }),
            json!({ "admitted": hold }),
        ]
    } else {
        vec![json!({ "admitted": null })]
    };
    expected_sent.extend([
        started(),
        json!("progressed"),
        completed(
            &json!([[named_item("Ada", 0), named_item("Bob", 1)]]),
            &json!({ "answer": { "value": 42, "isKept": false } }),
        ),
    ]);
    assert_eq!(sent, expected_sent);
    let expected_work = match shape {
        StepAdmissionShape::QuickCode { .. } => StepAdmissionWork::QuickCode {
            budget_bytes: 1024,
            input_bytes: u64::try_from(input_bytes).expect("the test's length fits"),
            output_max_bytes: 2048,
            node_key,
        },
        StepAdmissionShape::Script { .. } => StepAdmissionWork::Script {
            runtime: StepScriptRuntime::Bun,
            node_key,
        },
    };
    assert_eq!(gate.enqueued(), vec![expected_work]);
    assert!(probe.is_admitted.load(Ordering::SeqCst));
    assert_eq!(gate.dropped_tickets(), 1);
}

/// Where a gate step is when its cancel comes.
#[derive(Clone, Copy)]
enum CancelPoint {
    /// Waiting for its turn in the entry line.
    InLine,
    /// Held at the gate.
    AtGate,
}

/// A gate step enters the gate only once every turn taken before its own is dropped, and a cancel
/// ends it in the line, before it enters, or at the gate, carrying its hold and dropping its
/// ticket. Mutations: enter without waiting for the turn; ignore a cancel in the line; drop the
/// hold's instant from the cancel; keep the ticket after the cancel.
#[rstest]
#[case::in_line(CancelPoint::InLine)]
#[case::at_gate(CancelPoint::AtGate)]
#[tokio::test]
async fn a_gate_step_enters_in_its_turn_and_a_cancel_ends_it(#[case] point: CancelPoint) {
    let probe = Arc::new(ExecutorProbe::default());
    let node = test_node(&json!({}));
    let database = TestDatabase::new(schema_parts());
    let need = StepAdmissionNeed::Gate(StepAdmissionShape::QuickCode {
        budget_bytes: 1024,
        output_max_bytes: 2048,
    });
    let (mut dispatch, mut received) = test_dispatch(
        &database,
        vec![scripted_kind(Script::Progress, need, &probe, false)],
    );
    let gate = Arc::new(ScriptedGate::new(None));
    dispatch.ports.admission = Arc::clone(&gate) as Arc<dyn StepAdmission>;
    let scope = Arc::new(test_run_scope(WorkflowRunMode::Manual, vec![node.clone()]));
    let ready = test_ready_step(&scope, &node, vec![vec![json!({ "name": "Ada" })]]);
    let step = ready.step.clone();
    let earlier_turn = dispatch.gate_entries.take_turn();
    let dispatched = dispatch.dispatch(&scope, &test_run_snapshot(&node), ready);
    drop(dispatch);
    assert!(dispatched.reports.is_empty());

    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        gate.enqueued(),
        Vec::new(),
        "the step entered before its turn"
    );
    assert!(
        received.try_recv().is_err(),
        "the step reported before its turn"
    );

    let hold = match point {
        CancelPoint::InLine => {
            dispatched.cancel.cancel();
            Value::Null
        }
        CancelPoint::AtGate => {
            drop(earlier_turn);
            timeout(WAIT, gate.wait_for_entry())
                .await
                .expect("the step enters once the earlier turn is dropped");
            let held = next_report(&mut received, &step)
                .await
                .expect("the hold is reported");
            let hold = held["waitingOnPool"].clone();
            assert!(hold.is_string(), "the first report is not a hold: {held}");
            dispatched.cancel.cancel();
            hold
        }
    };
    assert_eq!(
        next_report(&mut received, &step).await,
        Some(json!({ "canceled": { "holdStartedAt": hold, "isSiblingFailure": false } }))
    );
    assert_eq!(next_report(&mut received, &step).await, None);
    let entry_count = usize::from(matches!(point, CancelPoint::AtGate));
    assert_eq!(gate.enqueued().len(), entry_count);
    assert_eq!(gate.dropped_tickets(), entry_count);
    assert!(lock(&probe.seen).is_empty());
}
