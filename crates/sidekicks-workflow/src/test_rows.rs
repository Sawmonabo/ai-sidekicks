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

#[cfg(test)]
use sidekicks_contracts::workflow::definition::document::WorkflowNodeId;

#[cfg(test)]
use crate::schema::WORKFLOW_SCHEMA_SQL;

/// The session every test run lives in.
pub const TEST_SESSION_ID: &str = "00000000-0000-7000-8000-000000000001";

/// The node every test step runs, as the test version's body names it.
pub(crate) const TEST_NODE_ID: &str = "approve";

const CREATED_AT: &str = "2026-10-01T00:00:00.000Z";

const STEP_STARTED_AT: &str = "2026-10-02T00:00:01.000Z";

const EMPTY_PAYLOAD_REF: &str = r#"{"kind":"inline","items":[]}"#;

/// The node id `id`, which a test names as text.
#[cfg(test)]
pub(crate) fn test_node_id(id: &str) -> WorkflowNodeId {
    WorkflowNodeId::new(id.to_owned()).expect("the test's node id")
}

/// A connection on a fresh in-memory database holding the workflow tables, with foreign keys on.
#[cfg(test)]
pub(crate) fn workflow_tables() -> Connection {
    let connection = Connection::open_in_memory().expect("an in-memory database opens");
    connection
        .execute_batch(&WORKFLOW_SCHEMA_SQL)
        .expect("the workflow tables create");
    connection
}

/// Stores the workflow `definition_id` named `name` with its version 1, `version_id`, whose body
/// holds the test node.
pub fn insert_workflow_version(
    connection: &Connection,
    definition_id: &str,
    version_id: &str,
    name: &str,
) {
    let body = serde_json::json!({
        "name": name,
        "trigger": {
            "id": "start", "kind": "trigger.manual", "kindVersion": 1, "name": "Start", "order": 0,
            "params": {}
        },
        "nodes": [{
            "id": TEST_NODE_ID, "kind": "human.approval", "kindVersion": 1, "name": "Approve",
            "order": 0, "params": {}
        }],
        "edges": [],
    });
    insert_workflow_version_body(connection, definition_id, version_id, &body);
}

/// Stores the workflow `definition_id` with its version 1, `version_id`, whose body is `body`, a
/// canonical body holding the workflow's `name`.
pub(crate) fn insert_workflow_version_body(
    connection: &Connection,
    definition_id: &str,
    version_id: &str,
    body: &serde_json::Value,
) {
    let name = body["name"]
        .as_str()
        .expect("the test's body names its workflow");
    let body = body.to_string();
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

/// Stores `version_id`, version `version_number` of the workflow whose version is
/// `earlier_version_id`, with `body` as its body and the earlier version's hash and instant.
#[cfg(test)]
pub(crate) fn insert_later_workflow_version(
    connection: &Connection,
    earlier_version_id: &str,
    version_id: &str,
    version_number: u32,
    body: &serde_json::Value,
) {
    connection
        .execute(
            "INSERT INTO workflow_versions (id, definition_id, version_number, content_hash, \
             schema_version, definition_body, created_at) \
             SELECT ?1, definition_id, ?2, content_hash, schema_version, ?3, created_at \
             FROM workflow_versions WHERE id = ?4",
            params![
                version_id,
                version_number,
                body.to_string(),
                earlier_version_id
            ],
        )
        .expect("the test stores a later version");
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
pub fn insert_run(
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

/// Stores the waiting run `run_id` of version `version_id` in `session_id`, started at
/// `started_at`: the first run of its own chain, or a later run of `root`'s chain where one is
/// given.
#[cfg(test)]
pub(crate) fn insert_chain_run(
    connection: &Connection,
    run_id: &str,
    version_id: &str,
    session_id: &str,
    started_at: &str,
    root: Option<&str>,
) {
    insert_run(
        connection,
        run_id,
        version_id,
        WorkflowRunStatus::Waiting,
        started_at,
        None,
    );
    connection
        .execute(
            "UPDATE workflow_runs SET session_id = ?1 WHERE id = ?2",
            params![session_id, run_id],
        )
        .expect("the test moves the run to its session");
    if let Some(root) = root {
        connection
            .execute(
                "UPDATE workflow_runs SET chain_root_run_id = ?1, chain_run_count = NULL,
                   chain_kept_going = NULL WHERE id = ?2",
                params![root, run_id],
            )
            .expect("the test chains a later run onto a first run");
    }
}

/// A step a test stores: its place in the run, where it stands and what a waiting one waits on.
pub struct TestStep<'step> {
    /// Its execution index.
    pub execution_index: u32,
    /// Where it stands.
    pub status: WorkflowStepStatus,
    /// What it waits on, for a waiting step.
    pub wait_cause: Option<WorkflowWaitCause>,
    /// The spent account an `account` wait waits on.
    pub wait_account_id: Option<&'step str>,
    /// When an `account` wait resumes itself.
    pub resume_at: Option<&'step str>,
}

/// Stores `step` in run `run_id`, running the test node; a waiting step started waiting when it
/// started, and a wait on a person holds a wait id made from its execution index.
pub fn insert_step(connection: &Connection, run_id: &str, step: &TestStep<'_>) {
    insert_step_row(
        connection,
        run_id,
        &StepRow {
            node_id: TEST_NODE_ID,
            attempt: 1,
            step,
            finished_at: None,
            source_json: "[]".to_owned(),
            output_item_counts_json: "[]".to_owned(),
            pin_hash: None,
            reused_from_json: None,
        },
    );
}

/// A settled step a test stores: its node, attempt and execution index, where it stands, when it
/// ended, the `(node, execution index)` of the step of its run that fed each input slot, how many
/// items each main output holds, its output itself empty, the pin it ran on and the step it reused.
#[cfg(test)]
pub(crate) struct TestSettledStep<'step> {
    /// Its node.
    pub(crate) node_id: &'step str,
    /// Its attempt, from 1.
    pub(crate) attempt: u32,
    /// Its execution index.
    pub(crate) execution_index: u32,
    /// Where it stands.
    pub(crate) status: WorkflowStepStatus,
    /// When it ended, as stored.
    pub(crate) finished_at: &'step str,
    /// Per input slot, the node and execution index of the step that fed it.
    pub(crate) sources: &'step [(&'step str, u32)],
    /// How many items each main output holds.
    pub(crate) output_item_counts: &'step [u64],
    /// The hash of the pin it ran on, or for a reused skip its source step's.
    pub(crate) pin_hash: Option<&'step str>,
    /// For a reused skip, the run, execution index and version of the first attempt of its node
    /// whose data it carries.
    pub(crate) reused_from: Option<(&'step str, u32, &'step str)>,
}

/// Stores `step` in run `run_id`.
#[cfg(test)]
pub(crate) fn insert_settled_step(
    connection: &Connection,
    run_id: &str,
    step: &TestSettledStep<'_>,
) {
    insert_step_row(
        connection,
        run_id,
        &StepRow {
            node_id: step.node_id,
            attempt: step.attempt,
            step: &TestStep {
                execution_index: step.execution_index,
                status: step.status,
                wait_cause: None,
                wait_account_id: None,
                resume_at: None,
            },
            finished_at: Some(step.finished_at),
            source_json: test_step_sources(step.sources).to_string(),
            output_item_counts_json: serde_json::json!(step.output_item_counts).to_string(),
            pin_hash: step.pin_hash,
            reused_from_json: step
                .reused_from
                .map(|(run_id, execution_index, version_id)| {
                    serde_json::json!({
                        "step": {
                            "workflowRunId": run_id, "nodeId": step.node_id, "attempt": 1,
                            "executionIndex": execution_index,
                        },
                        "workflowVersionId": version_id,
                    })
                    .to_string()
                }),
        },
    );
}

/// The `source_json` of a step fed by each of `sources`, a `(node, execution index)` per slot,
/// each from its node's first main output.
#[cfg(test)]
pub(crate) fn test_step_sources(sources: &[(&str, u32)]) -> serde_json::Value {
    sources
        .iter()
        .map(|(node_id, execution_index)| {
            serde_json::json!({
                "nodeId": node_id, "outputIndex": 0, "executionIndex": execution_index,
            })
        })
        .collect()
}

// The columns a stored step row takes beyond its run: the step, its node and attempt, when it
// ended, what fed it and it holds, the pin it ran on and the step it reused.
struct StepRow<'step> {
    node_id: &'step str,
    attempt: u32,
    step: &'step TestStep<'step>,
    finished_at: Option<&'step str>,
    source_json: String,
    output_item_counts_json: String,
    pin_hash: Option<&'step str>,
    reused_from_json: Option<String>,
}

// Stores `row` in run `run_id`; a waiting step started waiting when it started, and a wait on a
// person holds a wait id made from its execution index.
fn insert_step_row(connection: &Connection, run_id: &str, row: &StepRow<'_>) {
    let step = row.step;
    let is_waiting = step.status == WorkflowStepStatus::Waiting;
    let is_person_wait = matches!(
        step.wait_cause,
        Some(WorkflowWaitCause::Approval | WorkflowWaitCause::Form | WorkflowWaitCause::Reply)
    );
    connection
        .execute(
            "INSERT INTO workflow_steps (workflow_run_id, node_id, attempt, execution_index, \
             status, wait_cause, wait_account_id, resume_at, wait_started_at, wait_id, \
             started_at, finished_at, source_json, output_item_counts_json, input_ref, \
             output_ref, log_ref, pin_hash, reused_from_json) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15, ?15, \
             ?16, ?17)",
            params![
                run_id,
                row.node_id,
                row.attempt,
                step.execution_index,
                <&'static str>::from(step.status),
                step.wait_cause.map(<&'static str>::from),
                step.wait_account_id,
                step.resume_at,
                is_waiting.then_some(STEP_STARTED_AT),
                is_person_wait
                    .then(|| format!("00000000-0000-7000-8000-{:012x}", step.execution_index)),
                STEP_STARTED_AT,
                row.finished_at,
                row.source_json,
                row.output_item_counts_json,
                EMPTY_PAYLOAD_REF,
                row.pin_hash,
                row.reused_from_json
            ],
        )
        .expect("the test stores a step");
}

/// Stores a live execution context of run `run_id` in session `session_id`'s workspace on a
/// project's mount of its own, as a project session's start records it; once per database.
#[cfg(test)]
pub(crate) fn insert_live_execution_context(
    connection: &Connection,
    run_id: &str,
    session_id: &str,
) {
    const MOUNT_ID: &str = "00000000-0000-7000-8000-0000000000c1";
    for row in sidekicks_workspace::test_rows::project_and_mount_rows(MOUNT_ID, None) {
        connection
            .execute_batch(&row)
            .expect("the test stores the project and its mount");
    }
    connection
        .execute(
            "INSERT INTO workspaces (id, session_id, repo_mount_id, execution_mode, fs_root, \
             state, created_at, updated_at) VALUES ('workspace', ?1, ?2, 'boundRoot', \
             '/repos/app', 'ready', ?3, ?3)",
            params![session_id, MOUNT_ID, CREATED_AT],
        )
        .expect("the test stores the session's workspace");
    connection
        .execute(
            "INSERT INTO branch_contexts (id, workspace_id, base_branch, head_branch, \
             created_at, updated_at) VALUES ('branch', 'workspace', 'main', 'main', ?1, ?1)",
            [CREATED_AT],
        )
        .expect("the test stores the workspace's branch context");
    connection
        .execute(
            "INSERT INTO run_execution_contexts (run_id, session_id, workspace_id, \
             execution_mode, execution_root, checkout_root, git_common_dir, \
             branch_context_id, created_at) VALUES (?1, ?2, 'workspace', 'boundRoot', \
             '/repos/app', '/repos/app', '/repos/app/.git', 'branch', ?3)",
            params![run_id, session_id, CREATED_AT],
        )
        .expect("the test stores the run's execution context");
}

/// When run `run_id`'s execution context was released, `None` while it is live.
#[cfg(test)]
pub(crate) fn execution_context_released_at(
    connection: &Connection,
    run_id: &str,
) -> Option<String> {
    connection
        .query_row(
            "SELECT released_at FROM run_execution_contexts WHERE run_id = ?1",
            [run_id],
            |row| row.get(0),
        )
        .expect("the test reads the run's execution context")
}

/// Every row of the runs and steps tables and every stored event, each column as SQLite holds it,
/// so a refusal is seen to leave them byte-identical.
#[cfg(test)]
pub(crate) fn stored_rows(rows: &Connection) -> Vec<Vec<rusqlite::types::Value>> {
    [
        "SELECT * FROM workflow_runs ORDER BY id",
        "SELECT * FROM workflow_steps ORDER BY workflow_run_id, execution_index",
        "SELECT * FROM session_events ORDER BY session_id, sequence",
    ]
    .into_iter()
    .flat_map(|sql| table_rows(rows, sql, ()))
    .collect()
}

/// Run `run_id`'s row and its step rows in execution order, each column as SQLite holds it, so a
/// rebuild is seen to write them byte-identical.
#[cfg(test)]
pub(crate) fn run_rows(rows: &Connection, run_id: &str) -> Vec<Vec<rusqlite::types::Value>> {
    [
        "SELECT * FROM workflow_runs WHERE id = ?1",
        "SELECT * FROM workflow_steps WHERE workflow_run_id = ?1 ORDER BY execution_index",
    ]
    .into_iter()
    .flat_map(|sql| table_rows(rows, sql, [run_id]))
    .collect()
}

// The rows `sql` reads with `params`, each column as SQLite holds it.
#[cfg(test)]
fn table_rows(
    rows: &Connection,
    sql: &str,
    params: impl rusqlite::Params,
) -> Vec<Vec<rusqlite::types::Value>> {
    let mut statement = rows.prepare(sql).expect("the test reads the table");
    let width = statement.column_count();
    statement
        .query_map(params, |row| {
            (0..width)
                .map(|column| row.get::<_, rusqlite::types::Value>(column))
                .collect::<Result<Vec<_>, _>>()
        })
        .expect("the test reads the table")
        .collect::<Result<Vec<_>, _>>()
        .expect("each row reads")
}

/// Rebuilds session `session_id`'s run and step rows from its log on `rows` and checks that run
/// `run_id`'s rows read back byte-identical to the rows the live writes left.
#[cfg(test)]
pub(crate) fn assert_rebuild_rewrites_run_rows(rows: &Connection, session_id: &str, run_id: &str) {
    let live = run_rows(rows, run_id);
    rebuild_workflow_runs(rows, session_id);
    assert_eq!(run_rows(rows, run_id), live);
}

/// Writes the run and step rows of session `session_id` again from its log on `rows`, through the
/// runs projection's clear and fold in one transaction with foreign keys on, each statement held
/// to the row count it expects, as a rebuild's write holds it; the fold reads only the event types
/// the projection names, as a rebuild's read does.
#[cfg(test)]
pub(crate) fn rebuild_workflow_runs(rows: &Connection, session_id: &str) {
    use sidekicks_contracts::event::session::SessionEvent;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_store::database::statement::run_statement;
    use sidekicks_store::events::projection::SessionProjection as _;
    use sidekicks_store::events::session::read::{SessionEventFilter, SessionEventReads};

    use crate::runs::projection::WorkflowRunsProjection;

    let session_id = SessionId::new(session_id).expect("the test's session id");
    let events = SessionEventReads::new(rows, |_: &SessionId| None)
        .read_after(&session_id, -1, -1, SessionEventFilter::default())
        .expect("the log reads");
    let mut statements = WorkflowRunsProjection.clear_statements(&session_id);
    let mut fold = WorkflowRunsProjection.fold(&session_id);
    for envelope in &events {
        let event = SessionEvent::from_envelope(envelope).expect("each event reads");
        if WorkflowRunsProjection
            .event_types()
            .contains(&event.event_type())
        {
            fold.apply(envelope, &event, &mut statements)
                .expect("each event folds");
        }
    }
    statements.extend(fold.closing_statements());
    // The live writer may hold the file a moment longer, so the write waits for it.
    rows.execute_batch("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")
        .expect("the test turns foreign keys on");
    let transaction = rows
        .unchecked_transaction()
        .expect("the rebuild's transaction begins");
    for statement in &statements {
        let result = run_statement(&transaction, statement).expect("each statement runs");
        if let Some(expected) = statement.expected_row_count {
            assert_eq!(result.row_count, expected, "{}", statement.sql);
        }
    }
    transaction.commit().expect("the rebuild commits");
}
