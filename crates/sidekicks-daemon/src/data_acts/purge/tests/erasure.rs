//! What a purge erases: nothing of a purged session left readable in the file or its log, its
//! tool-server connections, the states each caller purges from, and the log's truncation tried
//! until no reader keeps it busy.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rstest::rstest;
use rusqlite::params;
use serde_json::json;
use sidekicks_contracts::mcp::server::McpServerName;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_contracts::workflow::run::status::{WorkflowRunStatus, WorkflowStepStatus};
use sidekicks_recovery::status::RECOVERY_STATUS_STATEMENT_CAPACITY;
use sidekicks_session::run::engine::test_fixture;
use sidekicks_std::scheduler::budget::ProcessorMeter;
use sidekicks_store::data_folder::session_storage_folder;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_workflow::test_rows::{
    TEST_SESSION_ID, TestStep, insert_run, insert_step, insert_workflow_version,
};
use sidekicks_workspace::git::process::{GitCall, GitRunner, in_folder, test_git_runner};
use sidekicks_workspace::git::turn_snapshot::capture_folder::CAPTURES_SEGMENT;
use sidekicks_workspace::git::turn_snapshot::retention::RunContextKey;
use tokio::time::timeout;

use super::{
    MARKER, append_activation, append_event, event_count, only_outcome, purge_fixture, receipts,
    state_of, store_session,
};
use crate::data_acts::purge::rows::PurgeCaller;
use crate::data_acts::purge::{SessionPurgeError, SessionPurgeOutcome};

const WAIT: Duration = Duration::from_secs(10);

// A capture folder in the session's storage folder under `data_folder`, holding an object of
// `MARKER` under one snapshot ref of `run_id`.
async fn store_capture_folder(
    git: &GitRunner,
    data_folder: &Path,
    session_id: SessionId,
    run_id: RunId,
) -> PathBuf {
    let capture_folder = session_storage_folder(data_folder, &session_id)
        .join(CAPTURES_SEGMENT)
        .join("repository");
    git.run(
        None,
        GitCall::read([
            OsString::from("init"),
            "--quiet".into(),
            "--bare".into(),
            capture_folder.clone().into(),
        ]),
    )
    .await
    .expect("the capture folder is made");
    let arguments = |arguments: &[&str]| in_folder(&capture_folder, arguments);
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
    capture_folder
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
// state changes move (the purged run stays counted), a purge that keeps the session's storage
// folder (its capture folder and the run's snapshot refs stay), a window's shadow links left (the
// windows' delete is refused, so the session is not removed), a session's shadows, volume folders
// or kept undo outcomes left, any of the messaging deletes left out (its row on the session, at
// either end of a pair, stays, and the reminder's note keeps the marker), either orphaned answers'
// delete left out (its row stays, and the question's answer keeps the marker), and either question
// delete left out (the question or its paired answer stays).
#[tokio::test]
async fn a_purge_leaves_nothing_of_the_session_readable_in_the_file_or_its_log() {
    let fixture = purge_fixture().await;
    let reader = fixture.database.reader();
    let session_id = SessionId::new(TEST_SESSION_ID).expect("a session id");
    let survivor = SessionId::try_from(mint_uuid_v7()).expect("a session id");
    store_session(&reader, session_id, SessionState::Archived);
    store_session(&reader, survivor, SessionState::Active);
    let lead_run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    test_fixture::insert_run(&fixture.database, session_id, lead_run_id, "running");
    let git = test_git_runner();
    let capture_folder =
        store_capture_folder(&git, fixture.home.path(), session_id, lead_run_id).await;
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
    let (session_text, survivor_text) = (session_id.text(), survivor.text());
    let (session, other) = (session_text.as_str(), survivor_text.as_str());
    let (lower, higher) = if session < other {
        (session, other)
    } else {
        (other, session)
    };
    let at = "2026-10-02T00:00:30.000Z";
    for (sql, row) in [
        (
            "INSERT INTO session_exchanges (session_id, peer_session_id, messages_since_user_wrote,
               started_at, updated_at) VALUES (?1, ?2, 1, ?3, ?3)",
            [lower, higher, at],
        ),
        (
            "INSERT INTO session_paused_message_queue (target_session_id, arrival_sequence,
               source_session_id, source_event_id, arrived_at) VALUES (?1, 1, ?2, 'e-1', ?3)",
            [other, session, at],
        ),
        (
            "INSERT INTO session_waits (session_id, tool_call_id, awaited_session_id, form,
               created_at) VALUES (?1, 'call-1', ?2, 'held', ?3)",
            [other, session, at],
        ),
        (
            "INSERT INTO session_reminders (id, session_id, note, set_at, due_at)
               VALUES ('r-1', ?1, ?2, ?3, ?3)",
            [session, MARKER, at],
        ),
        (
            "INSERT INTO approval_orphaned_answers
               (approval_request_id, session_id, run_id, recorded_at)
               VALUES ('card-1', ?1, ?2, ?3)",
            [session, lead_run_id.text().as_str(), at],
        ),
        (
            "INSERT INTO question_orphaned_answers
               (question_id, session_id, run_id, answer, recorded_at)
               VALUES ('question-1', ?1, 'run-1', ?2, ?3)",
            [session, MARKER, at],
        ),
    ] {
        reader
            .execute(sql, row)
            .expect("the test stores a messaging row");
    }
    let (checkpoint_id, window_id, shadow_id) = (
        mint_uuid_v7().to_string(),
        mint_uuid_v7().to_string(),
        mint_uuid_v7().to_string(),
    );
    reader
        .execute_batch(&format!(
            "INSERT INTO session_checkpoints (checkpoint_id, session_id, message_sequence, run_id,
               epoch, position, created_at)
             VALUES ('{checkpoint_id}', '{session}', 1, '{lead_run}', 0, 1, '{at}');
             INSERT INTO checkpoint_commands (window_id, checkpoint_id, command, started_at)
             VALUES ('{window_id}', '{checkpoint_id}', '{MARKER}', '{at}');
             INSERT INTO checkpoint_shadows (shadow_id, session_id, path, not_kept_reason,
               taken_at, time_precision, is_current)
             VALUES ('{shadow_id}', '{session}', '/repo/{MARKER}.bin', 'failed', 1, 1, 1);
             INSERT INTO checkpoint_window_shadows (window_id, shadow_id)
             VALUES ('{window_id}', '{shadow_id}');
             INSERT INTO checkpoint_versions (checkpoint_id, sequence, path, leg, kind,
               parent_real_path, window_id, shadow_id)
             VALUES ('{checkpoint_id}', 0, '/repo/{MARKER}.bin', 'command', 'shadow', '/repo',
               '{window_id}', '{shadow_id}');
             INSERT INTO checkpoint_volume_folders (session_id, folder, volume_id)
             VALUES ('{session}', '/volume/.ai-sidekicks-501/{session}', 'volume');
             INSERT INTO session_restores (client_idempotency_key, session_id, outcome,
               created_at)
             VALUES ('{restore_key}', '{session}', '{{\"note\":\"{MARKER}\"}}', '{at}');",
            lead_run = lead_run_id.text().as_str(),
            restore_key = mint_uuid_v7(),
        ))
        .expect("the test records a checkpoint, an open window, its shadow and an undo's outcome");
    reader
        .execute(
            "INSERT INTO questions (id, session_id, run_id, is_agent_waiting)
               VALUES ('question-1', ?1, 'run-1', 0)",
            [session],
        )
        .expect("the test stores a question");
    reader
        .execute(
            "INSERT INTO question_answer_items (queue_item_id, question_id)
               VALUES ('item-1', 'question-1')",
            [],
        )
        .expect("the test pairs a queued answer with the question");
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
        // A checkpoint, its open window, the shadow the window stands on and the version naming
        // it, the session's folder on another volume, and an undo's kept outcome.
        ("session_checkpoints WHERE session_id = ?1", session),
        (
            "checkpoint_commands WHERE window_id = ?1",
            window_id.as_str(),
        ),
        (
            "checkpoint_versions WHERE checkpoint_id = ?1",
            checkpoint_id.as_str(),
        ),
        (
            "checkpoint_window_shadows WHERE shadow_id = ?1",
            shadow_id.as_str(),
        ),
        ("checkpoint_shadows WHERE session_id = ?1", session),
        ("checkpoint_volume_folders WHERE session_id = ?1", session),
        ("session_restores WHERE session_id = ?1", session),
        // The session's messaging rows, at either end of a pair.
        (
            "session_exchanges WHERE session_id = ?1 OR peer_session_id = ?1",
            session,
        ),
        (
            "session_paused_message_queue WHERE source_session_id = ?1",
            session,
        ),
        ("session_waits WHERE awaited_session_id = ?1", session),
        ("session_reminders WHERE session_id = ?1", session),
        ("approval_orphaned_answers WHERE session_id = ?1", session),
        ("question_orphaned_answers WHERE session_id = ?1", session),
        ("questions WHERE session_id = ?1", session),
        ("question_answer_items WHERE question_id = ?1", "question-1"),
    ] {
        let left: i64 = reader
            .query_row(&format!("SELECT COUNT(*) FROM {rows}"), [id], |row| {
                row.get(0)
            })
            .expect("the test counts the rows left");
        assert_eq!(left, 0, "no row of {rows} outlives its session");
    }
    assert!(
        !capture_folder.exists(),
        "the run's snapshot refs go with the session's storage folder"
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

// Mutation: leave the client's session close out of the purge; the connection then stays open.
#[tokio::test]
async fn a_purge_closes_the_sessions_tool_server_connections() {
    let fixture = purge_fixture().await;
    let session_id = SessionId::try_from(mint_uuid_v7()).expect("a session id");
    store_session(
        &fixture.database.reader(),
        session_id,
        SessionState::Archived,
    );
    let server_name: McpServerName =
        FreeFormText::new("tracker".to_owned()).expect("a short server name");
    let probe = fixture
        .mcp_client
        .probe_standing_connection(session_id, &server_name);

    let outcome = only_outcome(
        fixture
            .purge
            .purge(
                &[session_id],
                PurgeCaller::Retention,
                &ProcessorMeter::default(),
            )
            .await,
    );

    assert!(
        matches!(outcome, SessionPurgeOutcome::Removed { .. }),
        "the session is removed, got {outcome:?}"
    );
    timeout(WAIT, probe.closed())
        .await
        .expect("the session's connection reads closed");
}

// Each session is damaged, so a removed one must leave the recovery state too, and holds one event,
// its activation where the case says, else a tool call. Kills: a caller's from-states widened or
// narrowed, the unfinished create's mark taking an activated session, a refused mark that changes
// the row, and the recovery state not cleared after the rows went.
#[rstest]
#[case::retention_of_an_archived_session(
    PurgeCaller::Retention,
    SessionState::Archived,
    false,
    true
)]
#[case::retention_of_an_active_session(PurgeCaller::Retention, SessionState::Active, false, false)]
#[case::damaged_history_of_an_active_session(
    PurgeCaller::DamagedHistory,
    SessionState::Active,
    false,
    true
)]
#[case::damaged_history_of_a_provisioning_session(
    PurgeCaller::DamagedHistory,
    SessionState::Provisioning,
    false,
    false
)]
#[case::unfinished_create_of_a_provisioning_session(
    PurgeCaller::UnfinishedCreate,
    SessionState::Provisioning,
    false,
    true
)]
#[case::unfinished_create_of_an_activated_session(
    PurgeCaller::UnfinishedCreate,
    SessionState::Provisioning,
    true,
    false
)]
#[case::unfinished_create_of_an_archived_session(
    PurgeCaller::UnfinishedCreate,
    SessionState::Archived,
    false,
    false
)]
#[tokio::test]
async fn a_purge_marks_a_session_only_from_its_callers_states(
    #[case] caller: PurgeCaller,
    #[case] state: SessionState,
    #[case] is_activated: bool,
    #[case] is_removed: bool,
) {
    let fixture = purge_fixture().await;
    let reader = fixture.database.reader();
    let session_id = SessionId::try_from(mint_uuid_v7()).expect("a session id");
    store_session(&reader, session_id, state);
    if is_activated {
        append_activation(&fixture.log, session_id).await;
    } else {
        append_event(&fixture.log, session_id, "Read").await;
    }
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
