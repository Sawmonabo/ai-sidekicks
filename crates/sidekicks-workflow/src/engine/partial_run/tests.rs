use std::collections::{BTreeSet, HashMap};

use rstest::rstest;
use rusqlite::Connection;
use serde_json::{Value, json};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::document::{
    WorkflowDefinitionId, WorkflowDocumentHashedBody, WorkflowNode, WorkflowNodeId,
    WorkflowVersionId,
};
use sidekicks_contracts::workflow::run::control::WorkflowNodeExecuteScope;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::{WorkflowRunStatus, WorkflowStepStatus};
use sidekicks_contracts::workflow::run::step::record::{WorkflowPayloadRef, WorkflowStepKey};

use super::{
    PartialRunPlan, SettledStep, SourceVersion, dirty_nodes, plan_partial_run, read_settled_steps,
};
use crate::definitions::versions::history::WorkflowVersions;
use crate::engine::tick::{RunGraph, RunPin};
use crate::kinds::{NodeKindTable, PassThroughExecutor, loop_test_kind, main_test_kind};
use crate::test_rows::{
    TEST_SESSION_ID, TestSettledStep, insert_later_workflow_version, insert_run,
    insert_settled_step, insert_workflow_version_body, test_node_id, test_step_sources,
    workflow_tables,
};

mod pins;
mod reuse;

const DEFINITION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e01";
const FIRST_VERSION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e11";
const SECOND_VERSION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e12";
const FIRST_RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e21";
const SECOND_RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e22";
const THIRD_RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e23";

/// An edge from `.0`'s main output `.1` into `.2`'s main input `.3`.
type Edge = (&'static str, usize, &'static str, usize);

/// The chain `T → A → B → C`, `B` taking a second main input that nothing feeds.
const CHAIN: &[Edge] = &[("T", 0, "A", 0), ("A", 0, "B", 0), ("B", 0, "C", 0)];

/// The kinds the tests' graphs use: a source with no input, a step, a step with two inputs, and a
/// loop whose second output starts its body.
fn kinds() -> NodeKindTable {
    let kind = |name: &str, handles: (usize, usize)| {
        main_test_kind(name, "developer", handles, Box::new(PassThroughExecutor))
    };
    NodeKindTable::new(vec![
        kind("test.trigger", (0, 1)),
        kind("test.step", (1, 1)),
        kind("test.pair", (2, 1)),
        loop_test_kind(),
    ])
    .expect("the test kinds build")
}

/// The node `id` of the test kind `kind` at `order`, with `members` written over its own.
fn node(id: &str, kind: &str, order: i64, members: &Value) -> Value {
    let mut node = json!({
        "id": id, "kind": kind, "kindVersion": 1, "name": id, "order": order, "params": {},
    });
    for (member, value) in members.as_object().expect("the members are an object") {
        node[member] = value.clone();
    }
    node
}

/// The chain's nodes `A`, `B` and `C`, with `members` written over the node `changed`.
fn chain_nodes(changed: &str, members: &Value) -> Vec<Value> {
    [("A", "test.step"), ("B", "test.pair"), ("C", "test.step")]
        .into_iter()
        .zip(1..)
        .map(|((id, kind), order)| {
            let members = if id == changed {
                members.clone()
            } else {
                json!({})
            };
            node(id, kind, order, &members)
        })
        .collect()
}

/// The chain's nodes `A`, `B` and `C` as they stand.
fn chain() -> Vec<Value> {
    chain_nodes("", &json!({}))
}

/// `body` read as the hashed body a version stores.
fn parsed(body: &Value) -> WorkflowDocumentHashedBody {
    serde_json::from_value(body.clone()).expect("the test's body reads")
}

/// The run graph of `body`, its trigger among its nodes.
fn graph_of(body: &WorkflowDocumentHashedBody) -> RunGraph {
    let nodes: HashMap<WorkflowNodeId, WorkflowNode> =
        std::iter::once(WorkflowNode::from(&body.trigger))
            .chain(body.nodes.iter().cloned())
            .map(|node| (node.id.clone(), node))
            .collect();
    RunGraph::new(&nodes, &body.trigger.id, &body.edges, &kinds()).expect("the graph builds")
}

/// The workflow's body: the trigger `T` and `nodes`, joined by `edges`.
fn body(nodes: &[Value], edges: &[Edge]) -> Value {
    json!({
        "name": "Nightly",
        "trigger": {
            "id": "T", "kind": "test.trigger", "kindVersion": 1, "name": "T", "order": 0,
            "params": {},
        },
        "nodes": nodes,
        "edges": edges
            .iter()
            .map(|(source, output, target, input)| json!({
                "id": format!("{source}-{output}-{target}-{input}"),
                "source": source, "sourceHandle": format!("outputs/main/{output}"),
                "target": target, "targetHandle": format!("inputs/main/{input}"),
            }))
            .collect::<Vec<_>>(),
    })
}

/// The workflow with version 1 holding `first` and version 2 holding `second`.
fn store_versions(connection: &Connection, first: &Value, second: &Value) {
    insert_workflow_version_body(connection, DEFINITION_ID, FIRST_VERSION_ID, first);
    insert_later_workflow_version(connection, FIRST_VERSION_ID, SECOND_VERSION_ID, 2, second);
}

/// The first attempt of `node_id`'s step at `execution_index`, settled at `status` at
/// `finished_at`, fed by `sources`, holding no items on its one main output.
fn settled_row<'step>(
    node_id: &'step str,
    execution_index: u32,
    status: WorkflowStepStatus,
    finished_at: &'step str,
    sources: &'step [(&'step str, u32)],
) -> TestSettledStep<'step> {
    TestSettledStep {
        node_id,
        attempt: 1,
        execution_index,
        status,
        finished_at,
        sources,
        output_item_counts: &[0],
        pin_hash: None,
        reused_from: None,
    }
}

/// Stores a finished run `run_id` of `version_id`.
fn store_run(connection: &Connection, run_id: &str, version_id: &str) {
    insert_run(
        connection,
        run_id,
        version_id,
        WorkflowRunStatus::Succeeded,
        "2026-10-02T00:00:00.000Z",
        Some("2026-10-02T01:00:00.000Z"),
    );
}

/// The settled step a test expects: run `run_id`'s succeeded first attempt at `execution_index` of
/// `node_id`, on `version_id`, fed by `sources`, giving no pin and reusing no step.
fn settled(
    run_id: &str,
    node_id: &str,
    execution_index: u64,
    version_id: &str,
    sources: &[(&str, u32)],
) -> SettledStep {
    SettledStep {
        step: WorkflowStepKey {
            workflow_run_id: WorkflowRunId::new(run_id).expect("the test's run id"),
            node_id: test_node_id(node_id),
            attempt: SafeInt::new(1).expect("an attempt"),
            execution_index: SafeInt::new(execution_index).expect("an execution index"),
        },
        status: WorkflowStepStatus::Succeeded,
        workflow_version_id: WorkflowVersionId::new(version_id).expect("the test's version id"),
        session_id: SessionId::new(TEST_SESSION_ID).expect("the test's session id"),
        sources: serde_json::from_value(test_step_sources(sources)).expect("the sources read"),
        input_ref: WorkflowPayloadRef::Inline { items: Vec::new() },
        output_ref: WorkflowPayloadRef::Inline { items: Vec::new() },
        output_item_counts: vec![SafeInt::new(0).expect("a count")],
        pin_hash: None,
        reused_from: None,
    }
}

/// A node's source run is the run of its newest settled step across the runs of every version, past
/// a newer failed step and over an older succeeded one; a node with only a canceled step has none.
/// Mutations: drop the status filter (the failed step's run is picked); order by the end ascending
/// (the older step's run is picked).
#[test]
fn the_newest_settled_step_is_read_across_versions_past_a_newer_failed_one() {
    let connection = workflow_tables();
    let nodes = body(&[], &[]);
    store_versions(&connection, &nodes, &nodes);
    store_run(&connection, FIRST_RUN_ID, FIRST_VERSION_ID);
    store_run(&connection, SECOND_RUN_ID, SECOND_VERSION_ID);
    store_run(&connection, THIRD_RUN_ID, SECOND_VERSION_ID);
    let step = |node_id, execution_index, status, finished_at| {
        settled_row(node_id, execution_index, status, finished_at, &[("T", 0)])
    };
    let (succeeded, failed) = (WorkflowStepStatus::Succeeded, WorkflowStepStatus::Failed);
    insert_settled_step(
        &connection,
        FIRST_RUN_ID,
        &step("A", 0, succeeded, "2026-10-02T00:00:01.000Z"),
    );
    insert_settled_step(
        &connection,
        SECOND_RUN_ID,
        &step("A", 1, succeeded, "2026-10-02T00:00:02.000Z"),
    );
    insert_settled_step(
        &connection,
        THIRD_RUN_ID,
        &step("A", 0, failed, "2026-10-02T00:00:03.000Z"),
    );
    let canceled = step(
        "B",
        1,
        WorkflowStepStatus::Canceled,
        "2026-10-02T00:00:03.000Z",
    );
    insert_settled_step(&connection, THIRD_RUN_ID, &canceled);
    let definition_id = WorkflowDefinitionId::new(DEFINITION_ID).expect("the test's definition");
    let read = read_settled_steps(
        &connection,
        definition_id,
        &[test_node_id("A"), test_node_id("B")],
    )
    .expect("the steps read");
    assert_eq!(
        read.into_iter().collect::<Vec<_>>(),
        vec![(
            test_node_id("A"),
            vec![settled(
                SECOND_RUN_ID,
                "A",
                1,
                SECOND_VERSION_ID,
                &[("T", 0)]
            )]
        )]
    );
}

/// Each marking rule, applied to the chain's version 1 against version 2 with every node's step
/// from version 1, dirties exactly the nodes it names: a params, kind version or run-once edit the
/// node; a rename, a notes edit, an `order` change, naming the default `onError` or a one-try retry
/// nothing; an insert or a delete the node after it; an added or a removed connection its
/// destination; switching a node off or on the node and the node after it. Mutations: mark a node
/// whose switch alone changed only through the nodes it feeds (the switch cases fail); mark every
/// changed node (`rename`, `notes` and `order` fail); leave `kindVersion` or `executeOnce` out of
/// the members compared (`kind_version` or `execute_once` fails); compare `onError` or `retry` as
/// written (`on_error_stop_named` or `one_try_retry` fails); skip the removed connections
/// (`removed_connection` fails).
#[rstest]
#[case::params_edit(
    chain(), CHAIN,
    chain_nodes("B", &json!({ "params": { "note": "x" } })), CHAIN,
    &["B"],
)]
#[case::kind_version(
    chain_nodes("B", &json!({ "kindVersion": 2 })), CHAIN,
    chain(), CHAIN,
    &["B"],
)]
#[case::execute_once(
    chain(), CHAIN,
    chain_nodes("B", &json!({ "executeOnce": true })), CHAIN,
    &["B"],
)]
#[case::rename(
    chain(), CHAIN,
    chain_nodes("B", &json!({ "name": "Renamed" })), CHAIN,
    &[],
)]
#[case::notes(
    chain(), CHAIN,
    chain_nodes("B", &json!({ "notes": "x" })), CHAIN,
    &[],
)]
#[case::order(
    chain(), CHAIN,
    chain_nodes("B", &json!({ "order": 9 })), CHAIN,
    &[],
)]
#[case::on_error_stop_named(
    chain(), CHAIN,
    chain_nodes("B", &json!({ "onError": "stop" })), CHAIN,
    &[],
)]
#[case::one_try_retry(
    chain(), CHAIN,
    chain_nodes("B", &json!({ "retry": { "maxTries": 1, "waitMs": 0 } })), CHAIN,
    &[],
)]
#[case::insert(
    chain(), CHAIN,
    [chain(), vec![node("X", "test.step", 4, &json!({}))]].concat(),
    &[("T", 0, "A", 0), ("A", 0, "B", 0), ("B", 0, "C", 0), ("T", 0, "X", 0), ("X", 0, "B", 1)],
    &["B"],
)]
#[case::delete(
    [chain(), vec![node("X", "test.step", 4, &json!({}))]].concat(),
    &[("T", 0, "A", 0), ("A", 0, "B", 0), ("B", 0, "C", 0), ("T", 0, "X", 0), ("X", 0, "B", 1)],
    chain(), CHAIN,
    &["B"],
)]
#[case::added_connection(
    chain(), CHAIN,
    chain(),
    &[("T", 0, "A", 0), ("A", 0, "B", 0), ("B", 0, "C", 0), ("A", 0, "C", 0)],
    &["C"],
)]
#[case::removed_connection(
    chain(),
    &[("T", 0, "A", 0), ("A", 0, "B", 0), ("B", 0, "C", 0), ("A", 0, "C", 0)],
    chain(), CHAIN,
    &["C"],
)]
#[case::switched_off(
    chain(), CHAIN,
    chain_nodes("A", &json!({ "disabled": true })), CHAIN,
    &["A", "B"],
)]
#[case::switched_on(
    chain_nodes("A", &json!({ "disabled": true })), CHAIN,
    chain(), CHAIN,
    &["A", "B"],
)]
fn each_rule_dirties_exactly_the_nodes_it_names(
    #[case] source_nodes: Vec<Value>,
    #[case] source_edges: &[Edge],
    #[case] target_nodes: Vec<Value>,
    #[case] target_edges: &[Edge],
    #[case] expected: &[&str],
) {
    assert_eq!(
        dirty_of(
            &body(&source_nodes, source_edges),
            &body(&target_nodes, target_edges)
        ),
        expected
            .iter()
            .copied()
            .map(test_node_id)
            .collect::<BTreeSet<_>>()
    );
}

/// A trigger whose `inputs` go from absent to `[]` declares the same inputs, so nothing is dirty.
/// Mutation: compare the trigger's `inputs` as written (the trigger is marked).
#[test]
fn a_trigger_whose_inputs_go_from_absent_to_empty_is_clean() {
    let source = body(&chain(), CHAIN);
    let mut target = source.clone();
    target["trigger"]["inputs"] = json!([]);
    assert_eq!(dirty_of(&source, &target), BTreeSet::new());
}

/// The nodes `dirty_nodes` marks in `target_body` against `source_body`, every node of the source
/// holding its step.
fn dirty_of(source_body: &Value, target_body: &Value) -> BTreeSet<WorkflowNodeId> {
    let source = parsed(source_body);
    let target = parsed(target_body);
    let node_ids = std::iter::once(source.trigger.id.clone())
        .chain(source.nodes.iter().map(|node| node.id.clone()))
        .collect();
    dirty_nodes(
        &target,
        &graph_of(&target),
        &[SourceVersion {
            body: source,
            node_ids,
        }],
    )
}

/// A step a test run stores at its position in the run, which is its execution index: its node,
/// the `(node, execution index)` that fed each slot, its attempt and status, the pin it ran on and
/// the `(run, execution index, version)` of the step it reused.
#[derive(Clone, Copy)]
struct RunRow<'row> {
    node_id: &'row str,
    sources: &'row [(&'row str, u32)],
    attempt: u32,
    status: WorkflowStepStatus,
    pin_hash: Option<&'row str>,
    reused_from: Option<(&'row str, u32, &'row str)>,
}

/// The succeeded first attempt of `node_id` fed by `sources`, giving no pin and reusing no step.
fn row<'row>(node_id: &'row str, sources: &'row [(&'row str, u32)]) -> RunRow<'row> {
    RunRow {
        node_id,
        sources,
        attempt: 1,
        status: WorkflowStepStatus::Succeeded,
        pin_hash: None,
        reused_from: None,
    }
}

/// Stores run `run_id` of `version_id` with `rows`, each at its position as its execution index,
/// ended in that order within `minute`, so a run stored with a later minute holds the newer steps.
fn store_run_rows(
    connection: &Connection,
    run_id: &str,
    version_id: &str,
    minute: u32,
    rows: &[RunRow<'_>],
) {
    store_run(connection, run_id, version_id);
    for (row, execution_index) in rows.iter().zip(0..) {
        let finished_at = format!("2026-10-02T00:{minute:02}:{execution_index:02}.000Z");
        let step = TestSettledStep {
            attempt: row.attempt,
            pin_hash: row.pin_hash,
            reused_from: row.reused_from,
            ..settled_row(
                row.node_id,
                execution_index,
                row.status,
                &finished_at,
                row.sources,
            )
        };
        insert_settled_step(connection, run_id, &step);
    }
}

/// Stores run `run_id` of `version_id` with one succeeded step per `(node, sources)` of `steps`,
/// as [`store_run_rows`] stores them.
fn store_run_steps(
    connection: &Connection,
    run_id: &str,
    version_id: &str,
    minute: u32,
    steps: &[(&str, &[(&str, u32)])],
) {
    let rows: Vec<RunRow<'_>> = steps
        .iter()
        .map(|&(node_id, sources)| row(node_id, sources))
        .collect();
    store_run_rows(connection, run_id, version_id, minute, &rows);
}

/// The chain's four steps in one run, each fed by the step before it.
const CHAIN_STEPS: &[(&str, &[(&str, u32)])] = &[
    ("T", &[]),
    ("A", &[("T", 0)]),
    ("B", &[("A", 1)]),
    ("C", &[("B", 2)]),
];

/// A node of a plan's list with the run its step came from.
type KeptStep = (String, WorkflowRunId);

/// The plan of a partial run of version 2, whose body is `target_body`, on `target` over `scope`,
/// given `pins`.
fn planned(
    connection: &Connection,
    target_body: &Value,
    target: &str,
    scope: WorkflowNodeExecuteScope,
    pins: &HashMap<WorkflowNodeId, RunPin>,
) -> PartialRunPlan {
    let version = WorkflowVersions::new(connection)
        .read_version(WorkflowVersionId::new(SECOND_VERSION_ID).expect("the test's version id"))
        .expect("the target version reads");
    let graph = graph_of(&parsed(target_body));
    plan_partial_run(
        connection,
        &version,
        &graph,
        &test_node_id(target),
        scope,
        pins,
    )
    .expect("the plan reads")
}

/// `plan` as the nodes it executes, each reused node and each node read as prior input, the last
/// two each with the run its steps came from.
fn kept_runs(plan: PartialRunPlan) -> (Vec<String>, Vec<KeptStep>, Vec<KeptStep>) {
    let PartialRunPlan {
        executed,
        reused,
        inputs,
    } = plan;
    let kept = |nodes: Vec<(WorkflowNodeId, Vec<SettledStep>)>| -> Vec<KeptStep> {
        nodes
            .into_iter()
            .map(|(node_id, steps)| {
                let run_id = steps
                    .first()
                    .expect("a kept node has steps")
                    .step
                    .workflow_run_id;
                (node_id.as_str().to_owned(), run_id)
            })
            .collect()
    };
    (
        executed
            .iter()
            .map(|node_id| node_id.as_str().to_owned())
            .collect(),
        kept(reused),
        kept(inputs),
    )
}

/// The plan of a partial run of version 2, whose body is `target_body`, on `target` over `scope`
/// with no pins, as [`kept_runs`] lists it.
fn plan(
    connection: &Connection,
    target_body: &Value,
    target: &str,
    scope: WorkflowNodeExecuteScope,
) -> (Vec<String>, Vec<KeptStep>, Vec<KeptStep>) {
    kept_runs(planned(
        connection,
        target_body,
        target,
        scope,
        &HashMap::new(),
    ))
}

/// The ids `ids` as a plan lists them.
fn names(ids: &[&str]) -> Vec<String> {
    ids.iter().map(|&id| id.to_owned()).collect()
}

/// `ids`, each keeping its step from run `run_id`.
fn reused_from(run_id: &str, ids: &[&str]) -> Vec<KeptStep> {
    let run_id = WorkflowRunId::new(run_id).expect("the test's run id");
    ids.iter().map(|&id| (id.to_owned(), run_id)).collect()
}

/// Each node is checked against the version its own step ran: the trigger's step ran version 1,
/// whose difference marks both the trigger and `S`, while `S`'s newer step ran version 2, so `S`
/// stays clean. Mutation: keep each version's marks on every node (`S` executes).
#[test]
fn each_node_is_checked_against_its_own_steps_version() {
    let connection = workflow_tables();
    let nodes = |note: &str| {
        let members = json!({ "params": { "note": note } });
        vec![
            node("S", "test.trigger", 1, &members),
            node("M", "test.pair", 2, &json!({})),
        ]
    };
    let edges: &[Edge] = &[("T", 0, "M", 0), ("S", 0, "M", 1)];
    let mut first = body(&nodes("first"), edges);
    first["trigger"]["params"] = json!({ "note": "first" });
    let second = body(&nodes("second"), edges);
    store_versions(&connection, &first, &second);
    let steps: &[(&str, &[(&str, u32)])] = &[("T", &[]), ("S", &[]), ("M", &[("T", 0), ("S", 1)])];
    store_run_steps(&connection, FIRST_RUN_ID, FIRST_VERSION_ID, 1, steps);
    store_run_steps(
        &connection,
        SECOND_RUN_ID,
        SECOND_VERSION_ID,
        2,
        &[("S", &[])],
    );
    assert_eq!(
        plan(
            &connection,
            &second,
            "M",
            WorkflowNodeExecuteScope::FromHere
        ),
        (
            names(&["T", "M"]),
            reused_from(SECOND_RUN_ID, &["S"]),
            Vec::new()
        )
    );
}

/// A dirty `A` makes the clean `B` after it execute, since `B`'s step was computed from `A`'s old
/// output. Mutation: drop the rule that a node fed by an executing node executes (`B` is reused).
#[test]
fn a_dirty_node_makes_the_clean_nodes_after_it_execute() {
    let connection = workflow_tables();
    let first = body(&chain(), CHAIN);
    let second = body(
        &chain_nodes("A", &json!({ "params": { "note": "x" } })),
        CHAIN,
    );
    store_versions(&connection, &first, &second);
    store_run_steps(&connection, FIRST_RUN_ID, FIRST_VERSION_ID, 1, CHAIN_STEPS);
    assert_eq!(
        plan(
            &connection,
            &second,
            "C",
            WorkflowNodeExecuteScope::FromHere
        ),
        (
            names(&["A", "B", "C"]),
            reused_from(FIRST_RUN_ID, &["T"]),
            Vec::new()
        )
    );
}

/// A loop's node executes whenever a node in its body executes, whether the body node is dirty
/// or has no settled step. Mutation: drop the rule that lifts a loop (`L` is reused).
#[rstest]
#[case::a_dirty_body_node(json!({ "params": { "note": "x" } }), true)]
#[case::a_body_node_with_no_settled_step(json!({}), false)]
fn a_loop_executes_whole_when_a_node_in_its_body_executes(
    #[case] body_change: Value,
    #[case] has_body_step: bool,
) {
    let connection = workflow_tables();
    let loop_body = |members: &Value| {
        body(
            &[
                node("L", "test.loop", 1, &json!({})),
                node("X", "test.step", 2, members),
                node("Y", "test.step", 3, &json!({})),
            ],
            &[
                ("T", 0, "L", 0),
                ("L", 1, "X", 0),
                ("X", 0, "Y", 0),
                ("Y", 0, "L", 0),
            ],
        )
    };
    let second = loop_body(&body_change);
    store_versions(&connection, &loop_body(&json!({})), &second);
    let steps: &[(&str, &[(&str, u32)])] = &[
        ("T", &[]),
        ("L", &[("T", 0)]),
        ("X", &[("L", 1)]),
        ("Y", &[("X", 2)]),
    ];
    let steps: Vec<_> = steps
        .iter()
        .copied()
        .filter(|&(node_id, _)| has_body_step || node_id != "X")
        .collect();
    store_run_steps(&connection, FIRST_RUN_ID, FIRST_VERSION_ID, 1, &steps);
    assert_eq!(
        plan(
            &connection,
            &second,
            "Y",
            WorkflowNodeExecuteScope::FromHere
        ),
        (
            names(&["L", "X", "Y"]),
            reused_from(FIRST_RUN_ID, &["T"]),
            Vec::new()
        )
    );
}

/// The loop `T → L`, its body `L → X → L` and its done output `L → D`, or with `Y` after `X` in the
/// body where `has_second_body_node`, every node's step settled in one run.
fn store_loop_run(connection: &Connection, has_second_body_node: bool) -> Value {
    let mut nodes = vec![
        node("L", "test.loop", 1, &json!({})),
        node("X", "test.step", 2, &json!({})),
        node("D", "test.step", 4, &json!({})),
    ];
    let mut edges = vec![("T", 0, "L", 0), ("L", 1, "X", 0), ("L", 0, "D", 0)];
    let first_steps: &[(&str, &[(&str, u32)])] =
        &[("T", &[]), ("L", &[("T", 0)]), ("X", &[("L", 1)])];
    let mut steps = first_steps.to_vec();
    if has_second_body_node {
        nodes.push(node("Y", "test.step", 3, &json!({})));
        edges.extend([("X", 0, "Y", 0), ("Y", 0, "L", 0)]);
        steps.push(("Y", &[("X", 2)]));
    } else {
        edges.push(("X", 0, "L", 0));
    }
    steps.push(("D", &[("L", 1)]));
    let loop_body = body(&nodes, &edges);
    store_versions(connection, &loop_body, &loop_body);
    store_run_steps(connection, FIRST_RUN_ID, FIRST_VERSION_ID, 1, &steps);
    loop_body
}

/// `Run from here` on `D`, after a loop whose body is `X`, covers the body though `X` is no
/// ancestor of `D`. Mutation: drop the covered loop's body from the covered set (`X` is left out).
#[test]
fn run_from_here_past_a_loop_covers_its_body() {
    let connection = workflow_tables();
    let loop_body = store_loop_run(&connection, false);
    assert_eq!(
        plan(
            &connection,
            &loop_body,
            "D",
            WorkflowNodeExecuteScope::FromHere
        ),
        (
            names(&["D"]),
            reused_from(FIRST_RUN_ID, &["T", "L", "X"]),
            Vec::new()
        )
    );
}

/// A run on `X` inside the body `L → X → Y → L`, in either scope, leaves `Y`, which follows `X`,
/// out of every list, and `L` executes because `X` does. Mutation: let a descendant of the target
/// join the covered set (`Y` executes).
#[rstest]
#[case::from_here(WorkflowNodeExecuteScope::FromHere)]
#[case::node(WorkflowNodeExecuteScope::Node)]
fn no_run_covers_a_descendant_of_its_target(#[case] scope: WorkflowNodeExecuteScope) {
    let connection = workflow_tables();
    let loop_body = store_loop_run(&connection, true);
    let kept = reused_from(FIRST_RUN_ID, &["T"]);
    let (reused, inputs) = match scope {
        WorkflowNodeExecuteScope::FromHere => (kept, Vec::new()),
        WorkflowNodeExecuteScope::Node => (Vec::new(), kept),
    };
    assert_eq!(
        plan(&connection, &loop_body, "X", scope),
        (names(&["L", "X"]), reused, inputs)
    );
}

/// `Run this node` on `C` reads the steps before it as its prior input though `A` changed since,
/// and with `B` never run, `B` executes before `C` and only `T` and `A` are read. Mutations: mark
/// dirty nodes on a node run (`A` executes); keep a node with no settled step among the inputs
/// (the second plan fails).
#[test]
fn run_this_node_uses_its_ancestors_steps_as_they_are() {
    let first = body(&chain(), CHAIN);
    let second = body(
        &chain_nodes("A", &json!({ "params": { "note": "x" } })),
        CHAIN,
    );
    let without_b: &[(&str, &[(&str, u32)])] =
        &[("T", &[]), ("A", &[("T", 0)]), ("C", &[("B", 9)])];
    for (steps, executed, inputs) in [
        (CHAIN_STEPS, &["C"][..], &["T", "A", "B"][..]),
        (without_b, &["B", "C"][..], &["T", "A"][..]),
    ] {
        let connection = workflow_tables();
        store_versions(&connection, &first, &second);
        store_run_steps(&connection, FIRST_RUN_ID, FIRST_VERSION_ID, 1, steps);
        assert_eq!(
            plan(&connection, &second, "C", WorkflowNodeExecuteScope::Node),
            (
                names(executed),
                Vec::new(),
                reused_from(FIRST_RUN_ID, inputs)
            )
        );
    }
}
