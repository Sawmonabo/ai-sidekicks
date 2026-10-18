use std::path::PathBuf;
use std::sync::Arc;

use rusqlite::{Connection, params};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::retention::WorkflowRunPurgePreviewResponse;
use sidekicks_contracts::workflow::run::status::{WorkflowRunStatus, WorkflowStepStatus};

use super::{
    DeletedWorkflowRun, WORKFLOW_RUN_DELETION_STATEMENT_CAPACITY, WorkflowRunDeletion,
    WorkflowRunDeletionError, WorkflowRunNotDeletable,
};
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::test_file::TestDatabase;
use crate::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use crate::events::log_service::{
    EVENT_LOG_STATEMENT_CAPACITY, EventLogService, EventLogServiceDependencies,
};
use crate::events::session::followers::SessionEventFollowers;
use crate::git::worktree::schema::WORKTREE_SCHEMA_SQL;
use crate::workflow::schema::WORKFLOW_SCHEMA_SQL;
use crate::workflow::test_rows::{TestStep, insert_run, insert_step, insert_workflow_version};

const DEFINITION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e50";
const VERSION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e51";
const OTHER_SESSION_ID: &str = "00000000-0000-7000-8000-000000000002";
const GIT_COMMON_DIR: &str = "/repos/app/.git";
const OLD: &str = "2026-10-01T00:00:00.000Z";
const NEW: &str = "2026-10-20T00:00:00.000Z";
const ENDED: &str = "2026-10-02T00:00:00.000Z";
const CUTOFF: &str = "2026-10-10T00:00:00.000Z";

/// The deletion over a test database holding the event, workflow and run context tables, and a
/// connection the test writes and reads rows through.
async fn open_deletion(database: &TestDatabase) -> (WorkflowRunDeletion, Connection) {
    let opener = database.opener();
    let writer = Arc::new(
        DatabaseWriter::open(
            move || -> rusqlite::Result<Connection> {
                let connection = opener()?;
                connection.execute_batch("PRAGMA foreign_keys = OFF;")?;
                connection.execute_batch(&WORKFLOW_SCHEMA_SQL)?;
                connection.execute_batch(&WORKTREE_SCHEMA_SQL)?;
                Ok(connection)
            },
            DatabaseWriterOptions::default(),
        )
        .await
        .expect("the writer opens the test database"),
    );
    let pool = Arc::new(DatabaseReadPool::new(
        database.path(),
        EVENT_LOG_STATEMENT_CAPACITY + WORKFLOW_RUN_DELETION_STATEMENT_CAPACITY,
    ));
    let event_log = Arc::new(EventLogService::new(EventLogServiceDependencies {
        writer: Arc::clone(&writer),
        pool: Arc::clone(&pool),
        followers: Arc::new(SessionEventFollowers::default()),
        projection_statements: None,
        refuse_session_write: None,
        read_damaged_from_sequence: None,
    }));
    let rows = database.reader();
    // The run context's workspace and session rows are not the deletion's concern.
    rows.execute_batch("PRAGMA foreign_keys = OFF;")
        .expect("the test turns off foreign keys");
    insert_workflow_version(&rows, DEFINITION_ID, VERSION_ID, "Nightly");
    (WorkflowRunDeletion::new(pool, writer, event_log), rows)
}

fn run_id(number: u8) -> String {
    format!("0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4f{number:02}")
}

fn workflow_run_id(number: u8) -> WorkflowRunId {
    WorkflowRunId::new(&run_id(number)).expect("the test's run id")
}

fn instant(text: &str) -> WireInstant {
    WireInstant::try_from(text.to_owned()).expect("the test's instant")
}

fn count(rows: &Connection, sql: &str, run_id: &str) -> i64 {
    rows.query_row(sql, [run_id], |row| row.get(0))
        .expect("the test counts rows")
}

fn run_row_count(rows: &Connection, run_id: &str) -> i64 {
    count(
        rows,
        "SELECT (SELECT COUNT(*) FROM workflow_runs WHERE id = ?1)
           + (SELECT COUNT(*) FROM workflow_steps WHERE workflow_run_id = ?1)
           + (SELECT COUNT(*) FROM run_execution_contexts WHERE run_id = ?1)",
        run_id,
    )
}

// The runs named by the log's deleted events, in sequence order per session.
fn deleted_event_runs(rows: &Connection) -> Vec<String> {
    let mut statement = rows
        .prepare(
            "SELECT json_extract(payload, '$.workflowRunId') FROM session_events
             WHERE type = 'workflow.run.deleted' ORDER BY session_id, sequence",
        )
        .expect("the test reads the log");
    statement
        .query_map([], |row| row.get(0))
        .expect("the test reads the log")
        .collect::<rusqlite::Result<_>>()
        .expect("the log reads")
}

/// A run still going is refused with nothing written; an ended run goes with its step and its
/// execution context, and its deleted event is appended, all in one write. Mutations: drop the
/// going-status guard; append the event apart from the deletes.
#[tokio::test]
async fn a_delete_refuses_a_going_run_and_removes_an_ended_one_with_its_event() {
    let database = TestDatabase::new();
    let (deletion, rows) = open_deletion(&database).await;
    let going = run_id(1);
    let ended = run_id(2);
    insert_run(
        &rows,
        &going,
        VERSION_ID,
        WorkflowRunStatus::Running,
        OLD,
        None,
    );
    insert_run(
        &rows,
        &ended,
        VERSION_ID,
        WorkflowRunStatus::Succeeded,
        OLD,
        Some(ENDED),
    );
    for run in [&going, &ended] {
        insert_step(
            &rows,
            run,
            &TestStep {
                execution_index: 0,
                status: WorkflowStepStatus::Succeeded,
                wait_cause: None,
                wait_account_id: None,
                resume_at: None,
            },
        );
    }
    rows.execute(
        "INSERT INTO run_execution_contexts (run_id, session_id, workspace_id, execution_mode,
           execution_root, checkout_root, git_common_dir, branch_context_id, created_at)
         VALUES (?1, 'session', 'workspace', 'boundRoot', '/repos/app', '/repos/app', ?2,
           'branch-context', ?3)",
        params![ended, GIT_COMMON_DIR, OLD],
    )
    .expect("the test stores the run's context");

    let refused = deletion
        .delete(workflow_run_id(1))
        .await
        .expect_err("a running run is refused");
    assert!(matches!(
        refused,
        WorkflowRunDeletionError::NotDeletable(WorkflowRunNotDeletable::Going {
            status: WorkflowRunStatus::Running,
            ..
        })
    ));
    assert_eq!(run_row_count(&rows, &going), 2);
    assert!(deleted_event_runs(&rows).is_empty());

    let deleted = deletion
        .delete(workflow_run_id(2))
        .await
        .expect("an ended run is deleted");
    assert_eq!(
        deleted,
        DeletedWorkflowRun {
            workflow_run_id: workflow_run_id(2),
            git_common_dir: Some(PathBuf::from(GIT_COMMON_DIR)),
        }
    );
    assert_eq!(run_row_count(&rows, &ended), 0);
    assert_eq!(deleted_event_runs(&rows), vec![ended]);
}

/// The preview counts exactly the runs the bulk delete then removes, across two sessions, and what
/// it leaves: a kept run, a waiting run and a failed run parked on its step, a chain's first run
/// while a later run of the chain runs, and a run newer than the bound. Mutations: drop the chain
/// condition or the Keep mark from what bulk delete removes.
#[tokio::test]
async fn a_bulk_delete_removes_what_its_preview_counted() {
    let database = TestDatabase::new();
    let (deletion, rows) = open_deletion(&database).await;
    let ended = |number, started_at| {
        insert_run(
            &rows,
            &run_id(number),
            VERSION_ID,
            WorkflowRunStatus::Succeeded,
            started_at,
            Some(ENDED),
        );
    };
    ended(1, OLD);
    ended(2, OLD);
    rows.execute(
        "UPDATE workflow_runs SET session_id = ?1 WHERE id = ?2",
        params![OTHER_SESSION_ID, run_id(2)],
    )
    .expect("the test moves a run to another session");
    ended(3, OLD);
    rows.execute(
        "UPDATE workflow_runs SET kept = 1 WHERE id = ?1",
        [run_id(3)],
    )
    .expect("the test keeps a run");
    insert_run(
        &rows,
        &run_id(4),
        VERSION_ID,
        WorkflowRunStatus::Waiting,
        OLD,
        None,
    );
    insert_run(
        &rows,
        &run_id(5),
        VERSION_ID,
        WorkflowRunStatus::Failed,
        OLD,
        None,
    );
    ended(6, OLD);
    insert_run(
        &rows,
        &run_id(7),
        VERSION_ID,
        WorkflowRunStatus::Running,
        NEW,
        None,
    );
    rows.execute(
        "UPDATE workflow_runs SET chain_root_run_id = ?1, chain_run_count = NULL,
           chain_kept_going = NULL WHERE id = ?2",
        params![run_id(6), run_id(7)],
    )
    .expect("the test chains a later run onto a first run");
    ended(8, NEW);

    let preview = deletion
        .preview_delete_older_than(&instant(CUTOFF))
        .await
        .expect("the preview reads");
    let counts = |preview: &WorkflowRunPurgePreviewResponse| {
        (
            preview.delete_count.get(),
            preview.kept_count.get(),
            preview.waiting_count.get(),
        )
    };
    assert_eq!(counts(&preview), (2, 1, 2));

    let deleted = deletion
        .delete_older_than(&instant(CUTOFF))
        .await
        .expect("the bulk delete commits");
    let mut deleted_ids: Vec<WorkflowRunId> =
        deleted.iter().map(|run| run.workflow_run_id).collect();
    deleted_ids.sort_by_key(|id| id.text().as_str().to_owned());
    assert_eq!(deleted_ids, vec![workflow_run_id(1), workflow_run_id(2)]);
    for number in 1..=8 {
        let is_deleted = number <= 2;
        assert_eq!(
            run_row_count(&rows, &run_id(number)),
            i64::from(!is_deleted),
            "run {number}"
        );
    }
    let mut event_runs = deleted_event_runs(&rows);
    event_runs.sort();
    assert_eq!(event_runs, vec![run_id(1), run_id(2)]);

    let after = deletion
        .preview_delete_older_than(&instant(CUTOFF))
        .await
        .expect("the preview reads");
    assert_eq!(counts(&after), (0, 1, 2));
}
