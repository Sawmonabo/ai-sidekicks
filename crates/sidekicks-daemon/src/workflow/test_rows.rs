//! Rows the workflow stores' tests build on, written with plain SQL as the engine would write them:
//! a workflow with one version, its runs and their steps, on a connection holding the workflow
//! tables.

use rusqlite::{Connection, params};
use sidekicks_contracts::name_fold::fold_name;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::workflow::run::status::{
    WorkflowRunStatus, WorkflowStepStatus, WorkflowWaitCause,
};
use sidekicks_contracts::workflow::run::trigger::WorkflowRunMode;

use crate::workflow::schema::WORKFLOW_SCHEMA_SQL;

/// The session every test run lives in.
pub(crate) const TEST_SESSION_ID: &str = "00000000-0000-7000-8000-000000000001";

/// The node every test step runs, as the test version's body names it.
pub(crate) const TEST_NODE_ID: &str = "approve";

const CREATED_AT: &str = "2026-10-01T00:00:00.000Z";

const STEP_STARTED_AT: &str = "2026-10-02T00:00:01.000Z";

const EMPTY_PAYLOAD_REF: &str = r#"{"kind":"inline","items":[]}"#;

/// A connection on a fresh in-memory database holding the workflow tables, with foreign keys on.
pub(crate) fn workflow_tables() -> Connection {
    let connection = Connection::open_in_memory().expect("an in-memory database opens");
    connection
        .execute_batch(&WORKFLOW_SCHEMA_SQL)
        .expect("the workflow tables create");
    connection
}

/// Stores the workflow `definition_id` named `name` with its version 1, `version_id`, whose body
/// holds the test node.
pub(crate) fn insert_workflow_version(
    connection: &Connection,
    definition_id: &str,
    version_id: &str,
    name: &str,
) {
    let body = serde_json::json!({
        "name": name,
        "trigger": {
            "id": "start", "kind": "trigger.manual", "kindVersion": 1, "name": "Start", "order": 0
        },
        "nodes": [
            { "id": TEST_NODE_ID, "kind": "human.approval", "kindVersion": 1, "name": "Approve" }
        ],
        "edges": [],
    })
    .to_string();
    let content_hash = format!("b3:{}", "0".repeat(64));
    connection
        .execute(
            "INSERT INTO workflow_definitions (id, name, name_folded, content_hash, \
             schema_version, definition_body, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, '2', ?5, ?6, ?6)",
            params![
                definition_id,
                name,
                fold_name(name),
                content_hash,
                body,
                CREATED_AT
            ],
        )
        .expect("the test stores a workflow");
    connection
        .execute(
            "INSERT INTO workflow_versions (id, definition_id, version_number, content_hash, \
             schema_version, definition_body, created_at) VALUES (?1, ?2, 1, ?3, '2', ?4, ?5)",
            params![version_id, definition_id, content_hash, body, CREATED_AT],
        )
        .expect("the test stores a version");
}

// `text`'s instant in the stored form every instant takes, as the runs' writer writes it.
fn stored_instant(text: &str) -> String {
    let timestamp: jiff::Timestamp = text.parse().expect("the test writes an instant");
    WireInstant::from_timestamp(timestamp)
        .expect("the test's instant is after the year 0000")
        .as_str()
        .to_owned()
}

/// Stores the first run of its own chain, `run_id`, of version `version_id`, at `status`, started
/// at `started_at` and ended at `finished_at`, both written in the stored form.
pub(crate) fn insert_run(
    connection: &Connection,
    run_id: &str,
    version_id: &str,
    status: WorkflowRunStatus,
    started_at: &str,
    finished_at: Option<&str>,
) {
    connection
        .execute(
            "INSERT INTO workflow_runs (id, workflow_version_id, session_id, status, mode, \
             trigger_json, started_by, started_at, finished_at, chain_root_run_id, \
             chain_run_count, chain_kept_going) \
             VALUES (?1, ?2, ?3, ?4, ?5, '{\"kind\":\"trigger.manual\"}', \
             '{\"kind\":\"schedule\"}', ?6, ?7, ?1, 1, 0)",
            params![
                run_id,
                version_id,
                TEST_SESSION_ID,
                <&'static str>::from(status),
                <&'static str>::from(WorkflowRunMode::Manual),
                stored_instant(started_at),
                finished_at.map(stored_instant)
            ],
        )
        .expect("the test stores a run");
}

/// A step a test stores: its place in the run, where it stands and what a waiting one waits on.
pub(crate) struct TestStep<'step> {
    /// Its execution index.
    pub(crate) execution_index: u32,
    /// Where it stands.
    pub(crate) status: WorkflowStepStatus,
    /// What it waits on, for a waiting step.
    pub(crate) wait_cause: Option<WorkflowWaitCause>,
    /// The spent account an `account` wait waits on.
    pub(crate) wait_account_id: Option<&'step str>,
    /// When an `account` wait resumes itself.
    pub(crate) resume_at: Option<&'step str>,
}

/// Stores `step` in run `run_id`, running the test node; a waiting step started waiting when it
/// started.
pub(crate) fn insert_step(connection: &Connection, run_id: &str, step: &TestStep<'_>) {
    let is_waiting = step.status == WorkflowStepStatus::Waiting;
    connection
        .execute(
            "INSERT INTO workflow_steps (workflow_run_id, node_id, attempt, execution_index, \
             status, wait_cause, wait_account_id, resume_at, wait_started_at, started_at, \
             input_ref, output_ref, log_ref) \
             VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?10)",
            params![
                run_id,
                TEST_NODE_ID,
                step.execution_index,
                <&'static str>::from(step.status),
                step.wait_cause.map(<&'static str>::from),
                step.wait_account_id,
                step.resume_at,
                is_waiting.then_some(STEP_STARTED_AT),
                STEP_STARTED_AT,
                EMPTY_PAYLOAD_REF
            ],
        )
        .expect("the test stores a step");
}
