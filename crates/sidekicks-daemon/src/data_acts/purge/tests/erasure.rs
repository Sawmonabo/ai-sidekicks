//! What a purge erases: nothing of a purged session left readable in the file or its log, the
//! states each caller purges from, and the log's truncation tried until no reader keeps it busy.

use std::time::Duration;

use rstest::rstest;
use rusqlite::{Connection, params};
use serde_json::json;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::workflow::run::status::{WorkflowRunStatus, WorkflowStepStatus};
use sidekicks_recovery::status::RECOVERY_STATUS_STATEMENT_CAPACITY;
use sidekicks_session::run::engine::test_fixture::insert_running_run;
use sidekicks_std::scheduler::budget::ProcessorMeter;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_workflow::test_rows::{
    TEST_SESSION_ID, TestStep, insert_run, insert_step, insert_workflow_version,
};
use sidekicks_workspace::git::process::{GitCall, GitRunner, in_folder, test_git_runner};
use sidekicks_workspace::git::turn_snapshot::retention::RunContextKey;
use sidekicks_workspace::git::worktree::test_rows::insert_worktree_rows;
use sidekicks_workspace::test_rows::PARENT_ROWS_AT;
use tempfile::TempDir;
use tokio::time::timeout;

use super::{
    MARKER, append_event, event_count, only_outcome, purge_fixture, receipts, state_of,
    store_session,
};
use crate::data_acts::purge::rows::PurgeCaller;
use crate::data_acts::purge::{SessionPurgeError, SessionPurgeOutcome};

const WAIT: Duration = Duration::from_secs(10);

// A repository holding one snapshot ref of `run_id`, stored as a run context of `session_id`.
async fn store_run_snapshot(
    connection: &Connection,
    git: &GitRunner,
    session_id: SessionId,
    run_id: RunId,
) -> TempDir {
    let repository = tempfile::tempdir().expect("a scratch repository");
    let arguments = |arguments: &[&str]| in_folder(repository.path(), arguments);
    git.run(None, GitCall::read(arguments(&["init", "--quiet"])))
        .await
        .expect("the repository is made");
    let object = git
        .run(
            None,
            GitCall::read(arguments(&["hash-object", "-w", "--stdin"]))
                .with_input(MARKER.as_bytes().to_vec()),
        )
        .await
        .expect("an object is written");
    let object = String::from_utf8(object.stdout).expect("an object id is ASCII");
    let snapshot_ref = format!(
        "refs/sidekicks/runs/{}/epoch-0/turn-1",
        RunContextKey::from(run_id)
    );
    git.run(
        None,
        GitCall::write(arguments(&["update-ref", &snapshot_ref, object.trim()])),
    )
    .await
    .expect("the snapshot ref is written");
    insert_worktree_rows(connection);
    connection
        .execute(
            "INSERT INTO run_execution_contexts (run_id, session_id, workspace_id, \
             execution_mode, execution_root, checkout_root, git_common_dir, branch_context_id, \
             created_at) VALUES (?1, ?2, 'workspace', 'boundRoot', ?3, ?3, ?4, \
             'branch-context', ?5)",
            params![
                run_id.text().as_str(),
                session_id.text().as_str(),
                repository.path().to_string_lossy().into_owned(),
                repository
                    .path()
                    .join(".git")
                    .to_string_lossy()
                    .into_owned(),
                PARENT_ROWS_AT
            ],
        )
        .expect("the test stores the run's context");
    repository
}

fn contains(bytes: &[u8], text: &str) -> bool {
    bytes
        .windows(text.len())
        .any(|window| window == text.as_bytes())
}

// Kills: the workflow runs' rows left out of the write (the run's foreign keys refuse it or its
// steps stay), an unsettled release or a spent `Send now` key of the lead run left behind,
// `secure_delete` off or the truncation skipped (the marker stays in the file or its log), a
// receipt outside the delete's write or naming another range, a count of live runs that only run
// state changes move (the purged run stays counted), and a purge that skips a run's snapshot refs
// (the run's ref stays in its repository).
#[tokio::test]
async fn a_purge_leaves_nothing_of_the_session_readable_in_the_file_or_its_log() {
    let fixture = purge_fixture().await;
    let reader = fixture.database.reader();
    let session_id = SessionId::new(TEST_SESSION_ID).expect("a session id");
    let survivor = SessionId::try_from(mint_uuid_v7()).expect("a session id");
    store_session(&reader, session_id, SessionState::Archived);
    store_session(&reader, survivor, SessionState::Active);
    let lead_run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&fixture.database, session_id, lead_run_id);
    let git = test_git_runner();
    let repository = store_run_snapshot(&reader, &git, session_id, lead_run_id).await;
    append_event(&fixture.log, session_id, "Read").await;
    append_event(&fixture.log, session_id, MARKER).await;
    append_event(&fixture.log, survivor, "Write").await;
    let run_id = mint_uuid_v7().to_string();
    let version_id = mint_uuid_v7().to_string();
    insert_workflow_version(&reader, &mint_uuid_v7().to_string(), &version_id, "Review");
    insert_run(
        &reader,
        &run_id,
        &version_id,
        WorkflowRunStatus::Succeeded,
        "2026-10-02T00:00:00.000Z",
        Some("2026-10-02T00:01:00.000Z"),
    );
    insert_step(
        &reader,
        &run_id,
        &TestStep {
            execution_index: 0,
            status: WorkflowStepStatus::Succeeded,
            wait_cause: None,
            wait_account_id: None,
            resume_at: None,
        },
    );
    reader
        .execute(
            "UPDATE workflow_steps SET log_ref = ?1 WHERE workflow_run_id = ?2",
            params![
                json!({ "kind": "inline", "items": [MARKER] }).to_string(),
                run_id
            ],
        )
        .expect("the test marks the step");
    reader
        .execute(
            "INSERT INTO human_phase_form_state (id, workflow_run_id, node_id, draft_json, \
             created_at, updated_at) VALUES (?1, ?2, 'approve', ?3, ?4, ?4)",
            params![
                mint_uuid_v7().to_string(),
                run_id,
                json!({ "note": MARKER }).to_string(),
                "2026-10-02T00:00:30.000Z"
            ],
        )
        .expect("the test stores a form draft");
    reader
        .execute(
            "INSERT INTO interventions (id, target_run_id, type, state, payload,
               expected_run_version, client_idempotency_key, unreleased_choice, created_at)
             VALUES (?1, ?2, 'interrupt', 'applied', '{}', 1, ?1, 'returnToDraft', ?3)",
            params![
                mint_uuid_v7().to_string(),
                lead_run_id.text().as_str(),
                "2026-10-02T00:00:30.000Z"
            ],
        )
        .expect("the test records an interrupt whose release was left unsettled");
    reader
        .execute(
            "INSERT INTO send_now_requests (target_run_id, client_idempotency_key, queue_item_id,
               intervention_id, created_at) VALUES (?1, ?2, ?2, ?2, ?3)",
            params![
                lead_run_id.text().as_str(),
                mint_uuid_v7().to_string(),
                "2026-10-02T00:00:30.000Z"
            ],
        )
        .expect("the test records a key a `Send now` spent");
    assert_eq!(
        *fixture.live_runs.borrow(),
        1,
        "the appends' commits count the run"
    );

    let report = fixture
        .purge
        .purge(
            &[session_id],
            PurgeCaller::Retention,
            &ProcessorMeter::default(),
        )
        .await;

    let outcome = only_outcome(report);
    assert!(
        matches!(
            outcome,
            SessionPurgeOutcome::Removed {
                hand_out_failure: None
            }
        ),
        "the session is removed, got {outcome:?}"
    );
    timeout(WAIT, fixture.truncation.settled())
        .await
        .expect("the truncation ends");
    assert_eq!(state_of(&reader, session_id), None);
    assert_eq!(event_count(&reader, session_id), 0);
    assert_eq!(
        *fixture.live_runs.borrow(),
        0,
        "the purge's commit uncounts the run"
    );
    let lead_run_text = lead_run_id.text();
    let (run, lead_run) = (run_id.as_str(), lead_run_text.as_str());
    for (rows, id) in [
        ("workflow_steps WHERE workflow_run_id = ?1", run),
        ("human_phase_form_state WHERE workflow_run_id = ?1", run),
        ("workflow_runs WHERE id = ?1", run),
        // An unsettled release, and a key a `Send now` spent.
        (
            "interventions WHERE target_run_id = ?1 AND unreleased_choice IS NOT NULL",
            lead_run,
        ),
        ("send_now_requests WHERE target_run_id = ?1", lead_run),
    ] {
        let left: i64 = reader
            .query_row(&format!("SELECT COUNT(*) FROM {rows}"), [id], |row| {
                row.get(0)
            })
            .expect("the test counts the rows left");
        assert_eq!(left, 0, "no row of {rows} outlives its session");
    }
    let snapshot_refs = git
        .run(
            None,
            GitCall::read(in_folder(
                repository.path(),
                &["for-each-ref", "refs/sidekicks/runs/"],
            )),
        )
        .await
        .expect("the repository's refs are listed");
    assert!(
        snapshot_refs.stdout.is_empty(),
        "the run's snapshot refs are pruned"
    );
    assert_eq!(event_count(&reader, survivor), 1);
    assert_eq!(
        receipts(&reader),
        vec![(session_id.to_string(), 0, 1)],
        "one receipt names the session's whole range"
    );
    drop(reader);
    let file = std::fs::read(fixture.database.path()).expect("the file reads");
    let mut log_path = fixture.database.path().into_os_string();
    log_path.push("-wal");
    let write_ahead_log = std::fs::read(&log_path).unwrap_or_default();
    assert!(write_ahead_log.is_empty(), "the log is truncated");
    assert!(
        !contains(&file, MARKER),
        "no deleted byte stays in the file"
    );
}

// Each session is damaged, so a removed one must leave the recovery state too. Kills: a caller's
// from-states widened or narrowed, a refused mark that changes the row, and the recovery state not
// cleared after the rows went.
#[rstest]
#[case::retention_of_an_archived_session(PurgeCaller::Retention, SessionState::Archived, true)]
#[case::retention_of_an_active_session(PurgeCaller::Retention, SessionState::Active, false)]
#[case::damaged_history_of_an_active_session(
    PurgeCaller::DamagedHistory,
    SessionState::Active,
    true
)]
#[case::damaged_history_of_a_provisioning_session(
    PurgeCaller::DamagedHistory,
    SessionState::Provisioning,
    false
)]
#[tokio::test]
async fn a_purge_marks_a_session_only_from_its_callers_states(
    #[case] caller: PurgeCaller,
    #[case] state: SessionState,
    #[case] is_removed: bool,
) {
    let fixture = purge_fixture().await;
    let reader = fixture.database.reader();
    let session_id = SessionId::try_from(mint_uuid_v7()).expect("a session id");
    store_session(&reader, session_id, state);
    append_event(&fixture.log, session_id, "Read").await;
    fixture.recovery.mark_session_unreadable(&session_id);

    let outcome = only_outcome(
        fixture
            .purge
            .purge(&[session_id], caller, &ProcessorMeter::default())
            .await,
    );

    if is_removed {
        assert!(
            matches!(outcome, SessionPurgeOutcome::Removed { .. }),
            "the session is removed, got {outcome:?}"
        );
        assert_eq!(state_of(&reader, session_id), None);
        assert_eq!(event_count(&reader, session_id), 0);
        let reads =
            DatabaseReadPool::new(fixture.database.path(), RECOVERY_STATUS_STATEMENT_CAPACITY);
        let recovery = fixture.recovery.read(&reads).await;
        assert_eq!(recovery.sessions, Vec::new());
    } else {
        let SessionPurgeOutcome::Refused(SessionPurgeError::NotMarkable { state: refused }) =
            outcome
        else {
            panic!("the mark is refused, got {outcome:?}");
        };
        assert_eq!(refused, Some(state));
        assert_eq!(
            state_of(&reader, session_id).as_deref(),
            Some(<&'static str>::from(state))
        );
        assert_eq!(event_count(&reader, session_id), 1);
        assert!(
            fixture
                .recovery
                .read_session_write_refusal(&session_id)
                .is_some()
        );
    }
}

// Kills: a busy truncation taken as done, and a truncation given up after its first busy answer.
#[tokio::test]
async fn the_logs_truncation_is_tried_until_no_reader_keeps_it_busy() {
    let fixture = purge_fixture().await;
    let session_id = SessionId::try_from(mint_uuid_v7()).expect("a session id");
    store_session(&fixture.database.reader(), session_id, SessionState::Active);
    let mut snapshot_holder = fixture.database.reader();
    let snapshot = snapshot_holder
        .transaction()
        .expect("the reader begins a transaction");
    snapshot
        .query_row("SELECT COUNT(*) FROM sessions", [], |row| {
            row.get::<_, i64>(0)
        })
        .expect("the reader takes its snapshot");
    append_event(&fixture.log, session_id, "Read").await;
    let mut log_path = fixture.database.path().into_os_string();
    log_path.push("-wal");

    fixture.truncation.request();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let held_log = std::fs::metadata(&log_path)
        .expect("the log is there")
        .len();
    snapshot.finish().expect("the reader ends its transaction");
    timeout(WAIT, fixture.truncation.settled())
        .await
        .expect("the truncation ends once the reader lets go");

    assert!(held_log > 0, "the reader's snapshot kept the log");
    assert_eq!(
        std::fs::metadata(&log_path)
            .expect("the log is there")
            .len(),
        0
    );
}
