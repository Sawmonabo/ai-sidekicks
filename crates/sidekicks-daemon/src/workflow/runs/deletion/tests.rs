use std::path::PathBuf;
use std::sync::Arc;

use rstest::rstest;
use rusqlite::{Connection, params};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::retention::WorkflowRunPurgePreviewResponse;
use sidekicks_contracts::workflow::run::status::{WorkflowRunStatus, WorkflowStepStatus};

use super::{
    DeletedWorkflowRun, RUNS_PER_DELETE_WRITE, RunGuard, WORKFLOW_RUN_DELETION_STATEMENT_CAPACITY,
    WorkflowRunDeletion, WorkflowRunDeletionError, WorkflowRunNotDeletable, read_removable_runs,
};
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::test_file::TestDatabase;
use crate::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use crate::events::log_service::{
    EVENT_LOG_STATEMENT_CAPACITY, EventLogService, EventLogServiceDependencies,
};
use crate::events::session::followers::SessionEventFollowers;
use crate::git::worktree::test_rows::{RunContextRow, insert_worktree_rows};
use crate::workflow::test_rows::{TestStep, insert_run, insert_step, insert_workflow_version};

const DEFINITION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e50";
const VERSION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e51";
const OTHER_SESSION_ID: &str = "00000000-0000-7000-8000-000000000002";
const GIT_COMMON_DIR: &str = "/repos/app/.git";
const OLD: &str = "2026-10-01T00:00:00.000Z";
const NEW: &str = "2026-10-20T00:00:00.000Z";
const ENDED: &str = "2026-10-02T00:00:00.000Z";
const CUTOFF: &str = "2026-10-10T00:00:00.000Z";

/// The deletion over a test database holding the event, workflow and run context tables and the
/// rows a run's context points at, foreign keys on, and a connection the test writes and reads
/// rows through.
async fn open_deletion(database: &TestDatabase) -> (WorkflowRunDeletion, Connection) {
    let writer = Arc::new(
        DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
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
    insert_worktree_rows(&rows);
    insert_workflow_version(&rows, DEFINITION_ID, VERSION_ID, "Nightly");
    (WorkflowRunDeletion::new(pool, writer, event_log), rows)
}

fn run_id(number: u16) -> String {
    format!("0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d{number:04}")
}

fn workflow_run_id(number: u16) -> WorkflowRunId {
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
/// execution context, children before the run as the foreign keys hold them, and its deleted event
/// is appended. Mutations: drop the going-status guard; delete the run before its steps; drop the
/// event's append, the steps' delete or the execution context's delete from the run's write.
#[tokio::test]
async fn a_delete_refuses_a_going_run_and_removes_an_ended_one_with_its_event() {
    let database = TestDatabase::new(crate::workflow::schema::schema_parts());
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
    RunContextRow {
        run_id: &ended,
        git_common_dir: Some(GIT_COMMON_DIR),
        ..RunContextRow::BOUND_ROOT
    }
    .insert(&rows)
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
    assert_eq!(deleted_event_runs(&rows), Vec::<String>::new());

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
    let database = TestDatabase::new(crate::workflow::schema::schema_parts());
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

/// A cutoff between two stored milliseconds rounds up to the later one, so the preview counts and
/// the bulk delete removes a run started at the earlier one and not one started at the later; a
/// cutoff on a millisecond takes no run started at it. Mutation: cut the cutoff down to its
/// millisecond, or drop the digits past the ninth without rounding up.
#[rstest]
#[case::half_a_millisecond_past("2026-10-10T00:00:00.0005Z", true)]
#[case::a_digit_past_the_ninth("2026-10-10T00:00:00.0000000001Z", true)]
#[case::on_the_millisecond("2026-10-10T00:00:00.000Z", false)]
#[case::zeros_past_the_ninth_digit("2026-10-10T00:00:00.0000000000Z", false)]
#[tokio::test]
async fn a_cutoff_between_milliseconds_takes_the_runs_started_before_it(
    #[case] cutoff: &str,
    #[case] takes_the_earlier_run: bool,
) {
    let database = TestDatabase::new(crate::workflow::schema::schema_parts());
    let (deletion, rows) = open_deletion(&database).await;
    for (number, started_at) in [
        (1, "2026-10-10T00:00:00.000Z"),
        (2, "2026-10-10T00:00:00.001Z"),
    ] {
        insert_run(
            &rows,
            &run_id(number),
            VERSION_ID,
            WorkflowRunStatus::Succeeded,
            started_at,
            Some(NEW),
        );
    }
    let taken: Vec<WorkflowRunId> = if takes_the_earlier_run {
        vec![workflow_run_id(1)]
    } else {
        Vec::new()
    };

    let preview = deletion
        .preview_delete_older_than(&instant(cutoff))
        .await
        .expect("the preview reads");
    assert_eq!(preview.delete_count.get(), taken.len() as u64);
    let deleted: Vec<WorkflowRunId> = deletion
        .delete_older_than(&instant(cutoff))
        .await
        .expect("the bulk delete commits")
        .iter()
        .map(|run| run.workflow_run_id)
        .collect();
    assert_eq!(deleted, taken);
    assert_eq!(run_row_count(&rows, &run_id(2)), 1);
}

/// A bulk delete write whose guard refuses a run kept since its page was read drops that run and
/// writes the rest again: the kept run stays with its rows and no event, and the others go with
/// theirs. Mutation: answer the guard's refusal instead of dropping the run.
#[tokio::test]
async fn a_run_kept_since_its_page_was_read_is_left_and_the_rest_go() {
    let database = TestDatabase::new(crate::workflow::schema::schema_parts());
    let (deletion, rows) = open_deletion(&database).await;
    for number in 1..=3 {
        insert_run(
            &rows,
            &run_id(number),
            VERSION_ID,
            WorkflowRunStatus::Succeeded,
            OLD,
            Some(ENDED),
        );
    }
    let cutoff = instant(CUTOFF);
    let page = read_removable_runs(&rows, Some(&cutoff), None).expect("the page reads");
    assert_eq!(page.len(), 3);
    rows.execute(
        "UPDATE workflow_runs SET kept = 1 WHERE id = ?1",
        [run_id(2)],
    )
    .expect("the test keeps a run");

    let deleted = deletion
        .delete_still_removable_runs(
            page,
            RunGuard::StillRemovable {
                older_than: Some(&cutoff),
            },
        )
        .await
        .expect("the runs still removable are deleted");
    let deleted_ids: Vec<WorkflowRunId> = deleted.iter().map(|run| run.workflow_run_id).collect();
    assert_eq!(deleted_ids, vec![workflow_run_id(1), workflow_run_id(3)]);
    for number in 1..=3 {
        assert_eq!(
            run_row_count(&rows, &run_id(number)),
            i64::from(number == 2),
            "run {number}"
        );
    }
    assert_eq!(deleted_event_runs(&rows), vec![run_id(1), run_id(3)]);
}

/// A bulk delete over one run more than a write takes reads its second page after the first page's
/// last run, and removes every run. Mutations: drop the after-the-last-run condition from the page
/// read; end the delete after its first page.
#[tokio::test]
async fn a_bulk_delete_reads_its_second_page_after_the_first_pages_last_run() {
    let database = TestDatabase::new(crate::workflow::schema::schema_parts());
    let (deletion, rows) = open_deletion(&database).await;
    let run_count = RUNS_PER_DELETE_WRITE + 1;
    let last_number = u16::try_from(run_count).expect("the test's run count fits its ids");
    for number in 1..=last_number {
        insert_run(
            &rows,
            &run_id(number),
            VERSION_ID,
            WorkflowRunStatus::Succeeded,
            OLD,
            Some(ENDED),
        );
    }
    let cutoff = instant(CUTOFF);
    let first_page = read_removable_runs(&rows, Some(&cutoff), None).expect("the page reads");
    assert_eq!(first_page.len(), RUNS_PER_DELETE_WRITE);
    let last = first_page.last().expect("the first page holds runs");
    let second_page = read_removable_runs(
        &rows,
        Some(&cutoff),
        Some((last.session_id, last.workflow_run_id)),
    )
    .expect("the page reads");
    let second_page_runs: Vec<WorkflowRunId> =
        second_page.iter().map(|run| run.workflow_run_id).collect();
    assert_eq!(second_page_runs, vec![workflow_run_id(last_number)]);

    let deleted = deletion
        .delete_older_than(&cutoff)
        .await
        .expect("the bulk delete commits");
    assert_eq!(deleted.len(), run_count);
    let left: i64 = rows
        .query_row("SELECT COUNT(*) FROM workflow_runs", [], |row| row.get(0))
        .expect("the test counts the runs");
    assert_eq!(left, 0);
}
