use rusqlite::{Connection, params};
use serde_json::{Value, json};
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::document::{
    WorkflowDefinitionId, WorkflowNodeId, WorkflowVersionId,
};
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::{WorkflowRunStatus, WorkflowStepStatus};
use sidekicks_contracts::workflow::run::step::record::{WorkflowPayloadRef, WorkflowStepKey};

use super::{SettledStep, read_settled_steps};
use crate::test_rows::{
    TestStep, insert_run, insert_step, insert_workflow_version_body, workflow_tables,
};

const DEFINITION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e01";
const FIRST_VERSION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e11";
const SECOND_VERSION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e12";
const FIRST_RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e21";
const SECOND_RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e22";
const THIRD_RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e23";

/// The workflow's body: a manual trigger and the test kind's `nodes`, joined by `edges`, each
/// edge from `[source, output, target, input]`.
fn body(nodes: &[Value], edges: &[(&str, usize, &str, usize)]) -> Value {
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
