use std::collections::{BTreeSet, HashMap};

use rstest::rstest;
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::document::{
    WorkflowDefinitionId, WorkflowDocumentHashedBody, WorkflowNode, WorkflowNodeId,
    WorkflowVersionId,
};
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::{WorkflowRunStatus, WorkflowStepStatus};
use sidekicks_contracts::workflow::run::step::record::{WorkflowPayloadRef, WorkflowStepKey};

use super::{SettledStep, SourceVersion, dirty_nodes, read_settled_steps};
use crate::engine::tick::RunGraph;
use crate::kinds::{NodeKind, NodeKindTable, PassThroughExecutor, test_kind};
use crate::test_rows::{
    TestStep, insert_run, insert_step, insert_workflow_version_body, workflow_tables,
};

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

/// The test kind `name` with `inputs` main inputs and `outputs` main outputs, which passes its
/// inputs on.
fn kind(name: &str, inputs: usize, outputs: usize) -> NodeKind {
    let handles = |side: &str, count: usize| -> Value {
        (0..count)
            .map(|index| {
                json!({ "type": "main", "id": format!("{side}/main/{index}"), "label": "H" })
            })
            .collect()
    };
    test_kind(
        json!({
            "kind": name, "version": 1, "category": "developer",
            "displayName": "Test", "description": "A test kind.", "icon": "test",
            "params": [], "outputsDeriveFromParams": false,
            "inputs": handles("inputs", inputs), "outputs": handles("outputs", outputs),
        }),
        None,
        Box::new(PassThroughExecutor),
    )
}

/// The kinds the tests' graphs use: a source with no input, a step, a step with two inputs, and a
/// loop whose second output starts its body.
fn kinds() -> NodeKindTable {
    let mut loop_kind = kind("test.loop", 1, 2);
    loop_kind.loop_output = Some(1);
    NodeKindTable::new(vec![
        kind("test.trigger", 0, 1),
        kind("test.step", 1, 1),
        kind("test.pair", 2, 1),
        loop_kind,
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
    connection
        .execute(
            "INSERT INTO workflow_versions (id, definition_id, version_number, content_hash, \
             schema_version, definition_body, created_at) \
             SELECT ?1, definition_id, 2, content_hash, schema_version, ?2, created_at \
             FROM workflow_versions WHERE id = ?3",
            params![SECOND_VERSION_ID, second.to_string(), FIRST_VERSION_ID],
        )
        .expect("the test stores a second version");
}

/// One step a test stores: its node, its execution index in its run, where it stands, when it
/// ended, and the `(node, execution index)` of the step of its run that fed each input slot.
struct StoredStep<'step> {
    node_id: &'step str,
    execution_index: u32,
    status: WorkflowStepStatus,
    finished_at: &'step str,
    sources: &'step [(&'step str, u32)],
}

/// Stores `step` in run `run_id`, holding no items on its one main output.
fn store_step(connection: &Connection, run_id: &str, step: &StoredStep<'_>) {
    insert_step(
        connection,
        run_id,
        &TestStep {
            execution_index: step.execution_index,
            status: step.status,
            wait_cause: None,
            wait_account_id: None,
            resume_at: None,
        },
    );
    connection
        .execute(
            "UPDATE workflow_steps SET node_id = ?1, finished_at = ?2, source_json = ?3, \
             output_item_counts_json = '[0]' \
             WHERE workflow_run_id = ?4 AND execution_index = ?5",
            params![
                step.node_id,
                step.finished_at,
                sources_json(step.sources).to_string(),
                run_id,
                step.execution_index
            ],
        )
        .expect("the test settles the step");
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

/// The `source_json` of a step fed by each of `sources`, a `(node, execution index)` per slot.
fn sources_json(sources: &[(&str, u32)]) -> Value {
    sources
        .iter()
        .map(|(node_id, execution_index)| {
            json!({ "nodeId": node_id, "outputIndex": 0, "executionIndex": execution_index })
        })
        .collect()
}

/// The settled step a test expects: run `run_id`'s first attempt at `execution_index` of
/// `node_id`, on `version_id`, fed by `sources`.
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
            node_id: node_id_of(node_id),
            attempt: SafeInt::new(1).expect("an attempt"),
            execution_index: SafeInt::new(execution_index).expect("an execution index"),
        },
        workflow_version_id: WorkflowVersionId::new(version_id).expect("the test's version id"),
        sources: serde_json::from_value(sources_json(sources)).expect("the sources read"),
        output_ref: WorkflowPayloadRef::Inline { items: Vec::new() },
        output_item_counts: vec![SafeInt::new(0).expect("a count")],
    }
}

fn node_id_of(id: &str) -> WorkflowNodeId {
    WorkflowNodeId::new(id.to_owned()).expect("the test's node id")
}

/// A node's newest settled step is read across the runs of every version, past a newer failed
/// step and over an older succeeded one; a node with only a canceled step has none. Mutations:
/// drop the status filter (the failed step is read); order by the end ascending (the older step
/// is read).
#[test]
fn the_newest_settled_step_is_read_across_versions_past_a_newer_failed_one() {
    let connection = workflow_tables();
    let nodes = body(&[], &[]);
    store_versions(&connection, &nodes, &nodes);
    store_run(&connection, FIRST_RUN_ID, FIRST_VERSION_ID);
    store_run(&connection, SECOND_RUN_ID, SECOND_VERSION_ID);
    store_run(&connection, THIRD_RUN_ID, SECOND_VERSION_ID);
    let step = |node_id, execution_index, status, finished_at| StoredStep {
        node_id,
        execution_index,
        status,
        finished_at,
        sources: &[("T", 0)],
    };
    let (succeeded, failed) = (WorkflowStepStatus::Succeeded, WorkflowStepStatus::Failed);
    store_step(
        &connection,
        FIRST_RUN_ID,
        &step("A", 0, succeeded, "2026-10-02T00:00:01.000Z"),
    );
    store_step(
        &connection,
        SECOND_RUN_ID,
        &step("A", 1, succeeded, "2026-10-02T00:00:02.000Z"),
    );
    store_step(
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
    store_step(&connection, THIRD_RUN_ID, &canceled);
    let definition_id = WorkflowDefinitionId::new(DEFINITION_ID).expect("the test's definition");
    let read = read_settled_steps(
        &connection,
        definition_id,
        &[node_id_of("A"), node_id_of("B")],
    )
    .expect("the steps read");
    assert_eq!(
        read.into_iter().collect::<Vec<_>>(),
        vec![(
            node_id_of("A"),
            settled(SECOND_RUN_ID, "A", 1, SECOND_VERSION_ID, &[("T", 0)])
        )]
    );
}

/// Each marking rule, applied to the chain's version 1 against version 2 with every node's step
/// from version 1, dirties exactly the nodes it names: a params edit the node; an insert or a
/// delete the node after it; an added connection its destination; switching a node off or on the
/// node and the node after it. Mutation: mark a node whose switch alone changed only through the
/// nodes it feeds (the switch cases fail).
#[rstest]
#[case::params_edit(
    chain(), CHAIN,
    chain_nodes("B", &json!({ "params": { "note": "x" } })), CHAIN,
    &["B"],
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
    let source = parsed(&body(&source_nodes, source_edges));
    let target = parsed(&body(&target_nodes, target_edges));
    let node_ids = std::iter::once(source.trigger.id.clone())
        .chain(source.nodes.iter().map(|node| node.id.clone()))
        .collect();
    let dirty = dirty_nodes(
        &target,
        &graph_of(&target),
        &[SourceVersion {
            body: source,
            node_ids,
        }],
    );
    assert_eq!(
        dirty,
        expected
            .iter()
            .copied()
            .map(node_id_of)
            .collect::<BTreeSet<_>>()
    );
}
