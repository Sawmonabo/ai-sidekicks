//! The purge's tests: nothing of a purged session left readable in the file or its log, the
//! states each caller purges from, a failed file step keeping every row for a retry, the range read
//! again once for an append that raced it, the second such refusal a fault, and the log's
//! truncation tried until no reader keeps it busy.

use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt as _;
use rstest::rstest;
use rusqlite::{Connection, params};
use serde_json::json;
use sidekicks_contracts::event::envelope::DAEMON_SCOPE_SENTINEL_SESSION_ID;
use sidekicks_contracts::machine::id::MachineId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_contracts::workflow::run::status::{WorkflowRunStatus, WorkflowStepStatus};
use tempfile::TempDir;
use tokio::sync::{mpsc, watch};
use tokio::time::timeout;

use super::checkpoint::WriteAheadLogTruncation;
use super::rows::{PurgeCaller, SESSION_PURGE_STATEMENT_CAPACITY};
use super::{SessionPurge, SessionPurgeDeps, SessionPurgeError, SessionPurgeOutcome};
use crate::approvals::rules::{APPROVAL_RULES_STATEMENT_CAPACITY, ApprovalRules};
use crate::artifacts::payload_store::PayloadStore;
use crate::artifacts::schema::ARTIFACT_STATEMENT_CAPACITY;
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::test_file::{TestDatabase, session_event_row, test_envelope};
use crate::events::log_service::tests::{TestLog, open_log};
use crate::events::log_service::{EVENT_LOG_STATEMENT_CAPACITY, EventLogAppendOptions};
use crate::events::session::appender::SessionEventAppender;
use crate::events::session::version::SESSION_EVENT_VERSION;
use crate::git::process::test_git_runner;
use crate::git::turn_snapshot::service::{
    TURN_SNAPSHOT_PRUNE_STATEMENT_CAPACITY, TurnSnapshotService,
};
use crate::keyed_lock::KeyedLock;
use crate::policy::shell_commands::reading_bound::ShellLineReadingBound;
use crate::provider::conversation_purge::{
    CONVERSATION_PURGE_STATEMENT_CAPACITY, ConversationPurge, ConversationPurgeError,
};
use crate::provider::driver::contract::MockProviderDriver;
use crate::provider::driver::registry::{ProviderRegistry, test_provider};
use crate::provider::driver::test_registry::test_driver_services;
use crate::provider::driver::{PROVIDERS, ProviderRegistration};
use crate::pty::shell::test_table::{TableFixture, table_fixture};
use crate::session::directory::list_feed::SessionListFeed;
use crate::session::directory::test_rows::insert_session_row;
use crate::session::related::ranking::SessionRelatedRanking;
use crate::session::run::engine::tests::insert_running_run;
use crate::workflow::test_rows::{
    TEST_SESSION_ID, TestStep, insert_run, insert_step, insert_workflow_version,
};
use crate::workspace::event_emitter::WorkspaceEventEmitter;
use crate::workspace::managed::service::ManagedWorkspaceService;
use crate::workspace::repo::mount::service::{
    REPO_MOUNT_SERVICE_STATEMENT_CAPACITY, RepoMountService,
};
use crate::workspace::repo::root_resolver::RepoRootResolver;
use sidekicks_contracts::wire::id::mint_uuid_v7;

const WAIT: Duration = Duration::from_secs(10);

// Text no row of the daemon writes on its own, and shorter than a body the log stores compressed.
const MARKER: &str = "purge-marker-7f3a9c51";

struct PurgeFixture {
    database: TestDatabase,
    log: TestLog,
    purge: SessionPurge,
    truncation: Arc<WriteAheadLogTruncation>,
    _shells: TableFixture,
    _home: TempDir,
}

async fn purge_fixture() -> PurgeFixture {
    let database = TestDatabase::new();
    let log = open_log(&database, None).await;
    let reads = Arc::new(DatabaseReadPool::new(
        database.path(),
        EVENT_LOG_STATEMENT_CAPACITY
            + SESSION_PURGE_STATEMENT_CAPACITY
            + CONVERSATION_PURGE_STATEMENT_CAPACITY
            + APPROVAL_RULES_STATEMENT_CAPACITY
            + ARTIFACT_STATEMENT_CAPACITY
            + TURN_SNAPSHOT_PRUNE_STATEMENT_CAPACITY
            + REPO_MOUNT_SERVICE_STATEMENT_CAPACITY,
    ));
    let home = tempfile::tempdir().expect("a scratch home");
    let machine_id = MachineId::new("machine".to_owned()).expect("the id is short");
    let (_gate, gate_reader) = watch::channel(true);
    let shells = table_fixture(gate_reader).await;

    // A driver with no expectations fails the test on any call.
    let table: Vec<ProviderRegistration> = PROVIDERS
        .iter()
        .map(|descriptor| ProviderRegistration {
            descriptor,
            build: |_| Arc::new(MockProviderDriver::new()),
        })
        .collect();
    let services = test_driver_services();
    let conversations = Arc::new(ConversationPurge::new(
        Arc::clone(&reads),
        Arc::new(ProviderRegistry::register_from(&table, &services)),
    ));

    let list_feed = SessionListFeed::for_test(&database, &log.followers);
    let repo_mounts = Arc::new(RepoMountService::new(
        Arc::clone(&log.writer),
        Arc::clone(&reads),
        Arc::new(WorkspaceEventEmitter::new(Arc::clone(&log.service))),
        RepoRootResolver::new(test_git_runner()),
        machine_id.clone(),
    ));
    let (writes, _unread_writes) = mpsc::channel(64);
    let managed_workspaces = Arc::new(ManagedWorkspaceService::new(
        home.path(),
        None,
        repo_mounts,
        test_git_runner(),
        writes,
        Arc::clone(&list_feed),
    ));
    let project_rules = Arc::new(ApprovalRules::new(
        Arc::clone(&reads),
        Arc::new(SessionEventAppender::new(
            Arc::clone(&log.service),
            SESSION_EVENT_VERSION.clone(),
        )),
        machine_id.clone(),
        Box::new(|_rule| async { Ok(()) }.boxed()),
        Arc::new(ShellLineReadingBound::new(1024)),
    ));
    let truncation = Arc::new(WriteAheadLogTruncation::new(Arc::clone(&log.writer)));
    let purge = SessionPurge::new(SessionPurgeDeps {
        writer: Arc::clone(&log.writer),
        reads: Arc::clone(&reads),
        event_log: Arc::clone(&log.service),
        machine_id,
        transition_lock: Arc::new(KeyedLock::new()),
        shells: Arc::clone(&shells.table),
        conversations,
        managed_workspaces,
        snapshots: Arc::new(TurnSnapshotService::new(
            test_git_runner(),
            Arc::clone(&reads),
            &home.path().join("execution-roots"),
        )),
        project_rules,
        list_feed,
        ranking: Arc::new(SessionRelatedRanking::new(reads, Arc::clone(&log.writer))),
        payloads: Arc::new(
            PayloadStore::new(home.path().join("objects")).expect("the payload store opens"),
        ),
        truncation: Arc::clone(&truncation),
    });
    PurgeFixture {
        database,
        log,
        purge,
        truncation,
        _shells: shells,
        _home: home,
    }
}

fn store_session(connection: &Connection, session_id: SessionId, state: SessionState) {
    insert_session_row(connection, session_id.text().as_str(), None, None);
    connection
        .execute(
            "UPDATE sessions SET state = ?1 WHERE id = ?2",
            params![<&'static str>::from(state), session_id.text().as_str()],
        )
        .expect("the test sets the session's state");
}

// An event of the session's log naming `tool`.
async fn append_event(log: &TestLog, session_id: SessionId, tool: &str) {
    let event = serde_json::from_value(json!({
        "type": "agent.toolCall.invoked",
        "payload": {
            "sessionId": session_id,
            "runId": mint_uuid_v7().to_string(),
            "toolName": tool,
        },
    }))
    .expect("the test writes an agent.toolCall.invoked event");
    log.service
        .append(
            test_envelope(session_id, &event),
            EventLogAppendOptions::default(),
        )
        .await
        .expect("the event is appended");
}

fn count(connection: &Connection, sql: &str, session_id: SessionId) -> i64 {
    connection
        .query_row(sql, [session_id.text().as_str()], |row| row.get(0))
        .expect("the test counts rows")
}

fn event_count(connection: &Connection, session_id: SessionId) -> i64 {
    count(
        connection,
        "SELECT COUNT(*) FROM session_events WHERE session_id = ?1",
        session_id,
    )
}

fn state_of(connection: &Connection, session_id: SessionId) -> Option<String> {
    connection
        .query_row(
            "SELECT state FROM sessions WHERE id = ?1",
            [session_id.text().as_str()],
            |row| row.get(0),
        )
        .ok()
}

// The removed sessions the sentinel's receipts name, as `(session, from, to)`.
fn receipts(connection: &Connection) -> Vec<(String, u64, u64)> {
    let mut statement = connection
        .prepare(
            "SELECT payload FROM session_events WHERE session_id = ?1
               AND type = 'session.event.compacted' ORDER BY sequence",
        )
        .expect("the test's read prepares");
    statement
        .query_map([DAEMON_SCOPE_SENTINEL_SESSION_ID.text().as_str()], |row| {
            row.get::<_, String>(0)
        })
        .expect("the test reads the receipts")
        .flat_map(|payload| {
            let payload: serde_json::Value =
                serde_json::from_str(&payload.expect("a payload reads")).expect("a JSON payload");
            payload["removedSessions"]
                .as_array()
                .expect("a receipt names its sessions")
                .iter()
                .map(|removed| {
                    (
                        removed["sessionId"].as_str().expect("a session").to_owned(),
                        removed["fromSeq"].as_u64().expect("a first sequence"),
                        removed["toSeq"].as_u64().expect("a last sequence"),
                    )
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

fn only_outcome(report: super::SessionPurgeReport) -> SessionPurgeOutcome {
    let mut outcomes = report.outcomes;
    assert_eq!(outcomes.len(), 1, "one session was asked for");
    outcomes.remove(0).1
}

fn contains(bytes: &[u8], text: &str) -> bool {
    bytes
        .windows(text.len())
        .any(|window| window == text.as_bytes())
}

// Kills: the workflow runs' rows left out of the write (the run's foreign keys refuse it or its
// steps stay), an unsettled release or a spent `Send now` key of the lead run left behind,
// `secure_delete` off or the truncation skipped (the marker stays in the file or its log), and a
// receipt outside the delete's write or naming another range.
#[tokio::test]
async fn a_purge_leaves_nothing_of_the_session_readable_in_the_file_or_its_log() {
    let fixture = purge_fixture().await;
    let reader = fixture.database.reader();
    let session_id = SessionId::new(TEST_SESSION_ID).expect("a session id");
    let survivor = SessionId::try_from(mint_uuid_v7()).expect("a session id");
    store_session(&reader, session_id, SessionState::Archived);
    store_session(&reader, survivor, SessionState::Active);
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
    let lead_run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&fixture.database, session_id, lead_run_id);
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

    let report = fixture
        .purge
        .purge(&[session_id], PurgeCaller::Retention)
        .await;

    assert!(report.is_truncation_running);
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
    for table in ["workflow_steps", "human_phase_form_state", "workflow_runs"] {
        let column = if table == "workflow_runs" {
            "id"
        } else {
            "workflow_run_id"
        };
        let left: i64 = reader
            .query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE {column} = ?1"),
                [&run_id],
                |row| row.get(0),
            )
            .expect("the test counts the run's rows");
        assert_eq!(left, 0, "{table} keeps none of the run's rows");
    }
    let unreleased: i64 = reader
        .query_row(
            "SELECT COUNT(*) FROM interventions WHERE unreleased_choice IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .expect("the test counts the unsettled releases");
    assert_eq!(unreleased, 0, "no unsettled release outlives its session");
    let send_now_keys: i64 = reader
        .query_row("SELECT COUNT(*) FROM send_now_requests", [], |row| {
            row.get(0)
        })
        .expect("the test counts the spent `Send now` keys");
    assert_eq!(
        send_now_keys, 0,
        "no spent `Send now` key outlives its session"
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

// Kills: a caller's from-states widened or narrowed, and a refused mark that changes the row.
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

    let outcome = only_outcome(fixture.purge.purge(&[session_id], caller).await);

    if is_removed {
        assert!(
            matches!(outcome, SessionPurgeOutcome::Removed { .. }),
            "the session is removed, got {outcome:?}"
        );
        assert_eq!(state_of(&reader, session_id), None);
        assert_eq!(event_count(&reader, session_id), 0);
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
    }
}

// Kills: the rows deleted before the files, and a retention purge that will not take up a session
// a failed purge left marked.
#[tokio::test]
async fn a_failed_file_step_keeps_every_row_and_purging_again_finishes() {
    let fixture = purge_fixture().await;
    let reader = fixture.database.reader();
    let session_id = SessionId::try_from(mint_uuid_v7()).expect("a session id");
    store_session(&reader, session_id, SessionState::Closed);
    append_event(&fixture.log, session_id, "Read").await;
    let run_id = mint_uuid_v7().to_string();
    reader
        .execute(
            "INSERT INTO runs (run_id, session_id, state, run_version)
             VALUES (?1, ?2, 'completed', 1)",
            params![run_id, session_id.text().as_str()],
        )
        .expect("the test writes the run");
    // A conversation on a provider no driver answers refuses the provider's step.
    reader
        .execute(
            "INSERT INTO runtime_bindings
               (id, run_id, provider_name, contract_version, cli_version_raw, resume_handle,
                spawn_config, created_at, updated_at)
             VALUES (?1, ?2, ?3, '1.0.0', '2.1.0', 'conversation',
                     '{\"resolvedExecutablePath\":\"/bin/provider\"}',
                     '2026-10-19T09:00:00.000Z', '2026-10-19T09:00:00.000Z')",
            params![mint_uuid_v7().to_string(), run_id, test_provider().as_str()],
        )
        .expect("the test writes the binding");

    let refused = only_outcome(
        fixture
            .purge
            .purge(&[session_id], PurgeCaller::Retention)
            .await,
    );

    assert!(
        matches!(
            refused,
            SessionPurgeOutcome::Refused(SessionPurgeError::Conversations(
                ConversationPurgeError::ProviderNotFound(_)
            ))
        ),
        "the provider's step refuses the purge, got {refused:?}"
    );
    assert_eq!(
        state_of(&reader, session_id).as_deref(),
        Some(<&'static str>::from(SessionState::PurgeRequested))
    );
    assert_eq!(event_count(&reader, session_id), 1);
    assert_eq!(receipts(&reader), []);

    reader
        .execute("DELETE FROM runtime_bindings WHERE run_id = ?1", [&run_id])
        .expect("the test lets the provider's step pass");
    let retried = only_outcome(
        fixture
            .purge
            .purge(&[session_id], PurgeCaller::Retention)
            .await,
    );

    assert!(
        matches!(retried, SessionPurgeOutcome::Removed { .. }),
        "purging again finishes, got {retried:?}"
    );
    assert_eq!(state_of(&reader, session_id), None);
    assert_eq!(receipts(&reader), vec![(session_id.to_string(), 0, 0)]);
}

// Kills: the upper-bound guard dropped (the receipt misses the raced event) and the range not read
// again after its refusal (the purge refused instead).
#[tokio::test]
async fn an_append_queued_before_the_range_read_is_taken_into_the_receipt() {
    let fixture = purge_fixture().await;
    let reader = fixture.database.reader();
    let session_id = SessionId::try_from(mint_uuid_v7()).expect("a session id");
    store_session(&reader, session_id, SessionState::Archived);
    append_event(&fixture.log, session_id, "Read").await;
    let before_lock = fixture.purge.rows_lock_pause.arm();
    let before_write = fixture.purge.rows_write_pause.arm();

    let session_ids = [session_id];
    let (outcome, ()) = tokio::join!(
        fixture.purge.purge(&session_ids, PurgeCaller::Retention),
        async {
            before_lock
                .reached
                .await
                .expect("the purge reaches the append lock");
            #[expect(
                clippy::async_yields_async,
                reason = "the raced append is awaited once the writer's hold lets go"
            )]
            let raced = fixture
                .log
                .writer
                .hold_while(|| async {
                    // Queued under the append lock before the purge takes it, committed after the
                    // purge's range read.
                    let mut raced = Box::pin(append_event(&fixture.log, session_id, "Write"));
                    assert!(futures::poll!(raced.as_mut()).is_pending());
                    before_lock.release.send(()).expect("the purge waits");
                    before_write
                        .reached
                        .await
                        .expect("the purge read its range");
                    raced
                })
                .await;
            raced.await;
            before_write.release.send(()).expect("the purge waits");
        }
    );

    let outcome = only_outcome(outcome);
    assert!(
        matches!(outcome, SessionPurgeOutcome::Removed { .. }),
        "the purge reads the range again and removes the session, got {outcome:?}"
    );
    assert_eq!(event_count(&reader, session_id), 0);
    assert_eq!(receipts(&reader), vec![(session_id.to_string(), 0, 1)]);
}

// Kills: a range read again without end, and a refused write that deletes anything.
#[tokio::test]
async fn a_second_refusal_of_the_range_is_a_fault_that_keeps_every_row() {
    let fixture = purge_fixture().await;
    let reader = fixture.database.reader();
    let session_id = SessionId::try_from(mint_uuid_v7()).expect("a session id");
    store_session(&reader, session_id, SessionState::Archived);
    append_event(&fixture.log, session_id, "Read").await;
    let first = fixture.purge.rows_write_pause.arm();
    let second = fixture.purge.rows_write_pause.arm();

    let session_ids = [session_id];
    let (outcome, ()) = tokio::join!(
        fixture.purge.purge(&session_ids, PurgeCaller::Retention),
        async {
            // A row past the range at each write: only a fault past the append lock can write one.
            for pause in [first, second] {
                pause.reached.await.expect("the purge read its range");
                fixture
                    .log
                    .writer
                    .append_events(vec![session_event_row(&session_id)], Vec::new())
                    .await
                    .expect("the row is written");
                pause.release.send(()).expect("the purge waits");
            }
        }
    );

    let outcome = only_outcome(outcome);
    assert!(
        matches!(
            outcome,
            SessionPurgeOutcome::Refused(SessionPurgeError::RangeMoved)
        ),
        "the second refusal is a fault, got {outcome:?}"
    );
    assert_eq!(event_count(&reader, session_id), 3);
    assert_eq!(
        state_of(&reader, session_id).as_deref(),
        Some(<&'static str>::from(SessionState::PurgeRequested))
    );
    assert_eq!(receipts(&reader), []);
}

// Kills: the marked guard dropped (the rows go though the session left `purge_requested`), and its
// refusal read as the range's (the purge writes again).
#[tokio::test]
async fn a_session_moved_after_its_mark_keeps_every_row() {
    let fixture = purge_fixture().await;
    let reader = fixture.database.reader();
    let session_id = SessionId::try_from(mint_uuid_v7()).expect("a session id");
    store_session(&reader, session_id, SessionState::Archived);
    append_event(&fixture.log, session_id, "Read").await;
    let before_write = fixture.purge.rows_write_pause.arm();

    let session_ids = [session_id];
    let (outcome, ()) = tokio::join!(
        fixture.purge.purge(&session_ids, PurgeCaller::Retention),
        async {
            before_write
                .reached
                .await
                .expect("the purge read its range");
            reader
                .execute(
                    "UPDATE sessions SET state = ?2 WHERE id = ?1",
                    params![
                        session_id.text().as_str(),
                        <&'static str>::from(SessionState::Archived)
                    ],
                )
                .expect("the test moves the session off its mark");
            before_write.release.send(()).expect("the purge waits");
        }
    );

    let outcome = only_outcome(outcome);
    assert!(
        matches!(
            outcome,
            SessionPurgeOutcome::Refused(SessionPurgeError::MarkLost)
        ),
        "a session moved off its mark is refused, got {outcome:?}"
    );
    assert_eq!(event_count(&reader, session_id), 1);
    assert_eq!(
        state_of(&reader, session_id).as_deref(),
        Some(<&'static str>::from(SessionState::Archived))
    );
    assert_eq!(receipts(&reader), []);
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

    assert!(fixture.truncation.request());
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
