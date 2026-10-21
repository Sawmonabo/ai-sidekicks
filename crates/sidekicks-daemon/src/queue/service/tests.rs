//! The run queue's tests, over a test database holding a session whose lead is bound to the
//! table's first provider, whose driver is a stand-in: a send to a session that takes no change,
//! the removal of a queued run's last message, `Send now`, and an interrupt's release from inside
//! the session's hold.

use std::num::NonZeroUsize;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt as _;
use rstest::rstest;
use rusqlite::params;
use serde_json::json;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::InterventionId;
use sidekicks_contracts::run::queue::{
    AgentQueueItemCancelRequest, AgentQueueItemCreateRequest, QueueItemId,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use tempfile::TempDir;
use tokio::time::timeout;

use super::{EMPTIED_RUN_DETAIL, RunQueue, RunQueueDeps};
use crate::admission::memory_gate::{MemoryGate, MemoryGateFigures};
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::test_file::{TestDatabase, test_session_id};
use crate::events::log_service::tests::{TestLog, open_log};
use crate::events::session::read::DamagedFromSequenceReader;
use crate::interventions::interrupt_queue::{
    InterruptChoice, InterruptQueue, SendNow, SendNowOutcome,
};
use crate::ipc::domain_error::DomainError;
use crate::provider::driver::PROVIDERS;
use crate::provider::driver::contract::MockProviderDriver;
use crate::provider::driver::message_handing::{HandMoment, MessageHanding};
use crate::provider::driver::run_control::{
    ApplyInterventionParams, ApplyInterventionResponse, InterruptPendingChoice,
    InterventionResultStatus, WithdrawQueuedMessageResult,
};
use crate::provider::driver::test_registry::{
    bind_run_to_first_provider, registry_of_first_provider,
};
use crate::provider::runtime_binding::store::RuntimeBindingStore;
use crate::queue::changes::QueueChangeSignals;
use crate::queue::delivery::{ProviderProcessIdentity, ProviderProcessIds};
use crate::queue::error::QueueError;
use crate::queue::provider_session::{ProviderSessions, ProviderSessionsDeps};
use crate::queue::store::{
    NewQueueItem, QueueItemBody, QueueItemReader, RecordedQueueItemState,
    insert_queue_item_statement,
};
use crate::session::directory::test_rows::insert_session_row;
use crate::session::run::binding_cursors::RunBindingCursors;
use crate::session::run::engine::tests::{insert_running_run, stored_run_state, test_engine};
use crate::session::run::epochs::ExecutionEpochs;
use crate::session::run::pause::RunPauseControl;
use crate::uuid_v7::mint_uuid_v7;

/// The statements the tests' read pool prepares, every reader's together.
const READ_STATEMENT_CAPACITY: usize = 32;

/// Bounds every wait a fault could hang.
const WAIT: Duration = Duration::from_secs(5);

/// A session with no provider process running.
struct NoProcess;

impl ProviderProcessIds for NoProcess {
    fn process_identity(&self, _session_id: &SessionId) -> Option<ProviderProcessIdentity> {
        None
    }
}

/// A run queue over a session whose lead is bound to the stand-in driver.
struct Fixture {
    database: TestDatabase,
    log: TestLog,
    queue: Arc<RunQueue>,
    session_id: SessionId,
    // The engine's posture files.
    _home: TempDir,
}

async fn fixture(driver: MockProviderDriver) -> Fixture {
    let database = TestDatabase::new();
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id = test_session_id();
    insert_session_row(&database.reader(), session_id.text().as_str(), None, None);
    insert_lead(&database, session_id);
    let pool = Arc::new(DatabaseReadPool::new(
        database.path(),
        READ_STATEMENT_CAPACITY,
    ));
    let engine = test_engine(&database, Arc::clone(&log.service), home.path());
    let providers = Arc::new(registry_of_first_provider(Arc::new(driver)));
    let runtime_bindings = Arc::new(RuntimeBindingStore::new(
        Arc::clone(&pool),
        Arc::clone(&log.writer),
    ));
    let binding_cursors = Arc::new(RunBindingCursors::new(
        Arc::clone(&pool),
        Arc::clone(&runtime_bindings),
        Arc::new(Mutex::new(ExecutionEpochs::new(
            NonZeroUsize::new(8).expect("the cap is not zero"),
        ))),
    ));
    let provider_sessions = Arc::new(ProviderSessions::new(ProviderSessionsDeps {
        pool: Arc::clone(&pool),
        writer: Arc::clone(&log.writer),
        runtime_bindings,
        binding_cursors,
        providers: Arc::clone(&providers),
        compose_opening: Arc::new(|session_id| {
            async move { Err(format!("no test opens session {session_id}").into()) }.boxed()
        }),
    }));
    let memory_gate = Arc::new(MemoryGate::new(
        MemoryGateFigures {
            physical_memory_bytes: 16 << 30,
            quick_thread_bytes: 0,
            ingest_worker_bytes: 0,
        },
        Arc::new(|| Ok(16 << 30)),
        Arc::new(|_process_id| Ok(None)),
    ));
    let read_damaged_from_sequence: Arc<DamagedFromSequenceReader> =
        Arc::new(|_: &SessionId| None::<i64>);
    let queue = RunQueue::new(RunQueueDeps {
        pool: Arc::clone(&pool),
        event_log: Arc::clone(&log.service),
        writer: Arc::clone(&log.writer),
        signals: Arc::new(QueueChangeSignals::new()),
        engine: Arc::clone(&engine),
        providers: Arc::clone(&providers),
        provider_sessions,
        memory_gate,
        processes: Arc::new(NoProcess),
        pauses: Arc::new(RunPauseControl::new(pool, engine, providers)),
        followers: Arc::clone(&log.followers),
        read_damaged_from_sequence,
    });
    Fixture {
        database,
        log,
        queue,
        session_id,
        _home: home,
    }
}

/// Writes the session's creation, its lead bound to the table's first provider.
fn insert_lead(database: &TestDatabase, session_id: SessionId) {
    database
        .reader()
        .execute(
            "INSERT INTO session_events
               (id, session_id, sequence, occurred_at, monotonic_ns, category, type, payload)
             VALUES (?1, ?2, 0, ?3, 0, 'sessionLifecycle', 'session.created', ?4)",
            params![
                mint_uuid_v7().to_string(),
                session_id.text().as_str(),
                WireInstant::now().as_str(),
                json!({
                    "mainAgent": {
                        "agentId": mint_uuid_v7().to_string(),
                        "binding": { "providerName": PROVIDERS[0].id },
                    },
                })
                .to_string(),
            ],
        )
        .expect("the test creates the session's lead");
}

/// A driver whose provider takes messages at once, reads a priority message and gives back what
/// it was handed.
fn driver_reading_priority() -> MockProviderDriver {
    let mut driver = MockProviderDriver::new();
    driver
        .expect_message_handing()
        .return_const(MessageHanding {
            hands_at: HandMoment::AtOnce,
            can_withdraw: true,
            kept_by_process: false,
            reads_priority_message: true,
        });
    driver
}

/// The steer's answer that delivered the message into its own target.
fn applied() -> ApplyInterventionResponse {
    ApplyInterventionResponse {
        status: InterventionResultStatus::Applied,
        fallback_action: None,
        delivered_run_id: None,
        cancelled: Vec::new(),
    }
}

fn new_run_id() -> RunId {
    RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id")
}

fn client_key() -> ClientUuid {
    ClientUuid::new(mint_uuid_v7().to_string()).expect("a minted UUID is a client key")
}

impl Fixture {
    /// Queues a message for `run_id`, after every one before it, and answers its id.
    async fn queue_message(&self, run_id: RunId) -> QueueItemId {
        let item_id =
            QueueItemId::try_from(mint_uuid_v7()).expect("a minted UUID is a queue item id");
        let item = NewQueueItem {
            id: item_id,
            session_id: self.session_id,
            body: QueueItemBody {
                content: FreeFormText::new("Look again".to_owned()).expect("a test message"),
                attachments: None,
                skills: None,
                answers_question_id: None,
                output_speed_for_turn: None,
                workspace_id: None,
            },
            target_run_id: run_id,
            device_id: None,
            client_idempotency_key: client_key(),
            replaces_queue_item_id: None,
            now: WireInstant::now(),
        };
        self.log
            .writer
            .write(vec![insert_queue_item_statement(&item)])
            .await
            .expect("the test queues its message");
        item_id
    }

    fn stored_state(&self, item_id: QueueItemId) -> RecordedQueueItemState {
        QueueItemReader::new(&self.database.reader())
            .get(&item_id)
            .expect("the test reads its message")
            .expect("the test's message is stored")
            .state
    }

    fn count_items(&self) -> i64 {
        self.database
            .reader()
            .query_row("SELECT COUNT(*) FROM queue_items", [], |row| row.get(0))
            .expect("the test counts the queue's rows")
    }
}

// A send to a session that takes no change is refused by the session's state, read again: a
// closed one `session.alreadyClosed`, one being purged `session.changeRefused`, and neither
// writes a row. Killed by refusing a purge as closed, or by writing the send first.
#[rstest]
#[case::closed(SessionState::Closed, RefusalCode::SessionAlreadyClosed)]
#[case::purge_requested(SessionState::PurgeRequested, RefusalCode::SessionChangeRefused)]
#[tokio::test]
async fn a_send_to_a_session_that_takes_no_change_is_refused(
    #[case] state: SessionState,
    #[case] code: RefusalCode,
) {
    let fixture = fixture(MockProviderDriver::new()).await;
    fixture
        .database
        .reader()
        .execute(
            "UPDATE sessions SET state = ?2 WHERE id = ?1",
            params![
                fixture.session_id.text().as_str(),
                <&'static str>::from(state)
            ],
        )
        .expect("the test moves the session");
    let request = AgentQueueItemCreateRequest {
        session_id: fixture.session_id,
        to: None,
        workspace_id: None,
        client_idempotency_key: client_key(),
        content: FreeFormText::new("Look again".to_owned()).expect("a test message"),
        attachments: None,
        skills: None,
        replaces_queue_item_id: None,
        answers_question_id: None,
        output_speed_for_turn: None,
    };

    let refused = fixture
        .queue
        .create(
            request,
            DeviceId::new("device-1".to_owned()).expect("a test device id"),
        )
        .await
        .expect_err("the send is refused");

    let QueueError::Refused(DomainError { code: refused, .. }) = refused else {
        panic!("the send is refused by the session's state, got {refused:?}");
    };
    assert_eq!(refused, code);
    assert_eq!(fixture.count_items(), 0);
}

// Removing the only message a queued run waits for ends that run `failed` with the emptied
// detail in the same write, and the message reads canceled. Killed by leaving a queued run with
// no message to open with.
#[tokio::test]
async fn removing_a_queued_runs_last_message_ends_the_run_failed() {
    let fixture = fixture(MockProviderDriver::new()).await;
    let run_id = new_run_id();
    fixture
        .database
        .reader()
        .execute(
            "INSERT INTO runs (run_id, session_id, state, run_version) VALUES (?1, ?2, 'queued', 1)",
            params![run_id.text().as_str(), fixture.session_id.text().as_str()],
        )
        .expect("the test queues the run");
    let item_id = fixture.queue_message(run_id).await;

    fixture
        .queue
        .cancel(AgentQueueItemCancelRequest {
            queue_item_id: item_id,
            child_handle: None,
        })
        .await
        .expect("the message is removed");

    assert_eq!(
        stored_run_state(&fixture.database, &run_id).0,
        "failed".to_owned()
    );
    let detail_events: i64 = fixture
        .database
        .reader()
        .query_row(
            "SELECT COUNT(*) FROM session_events
             WHERE type = 'agent.run.failed' AND instr(payload, ?1) > 0",
            [EMPTIED_RUN_DETAIL.as_str()],
            |row| row.get(0),
        )
        .expect("the test reads the run's end");
    assert_eq!(detail_events, 1);
    assert_eq!(
        fixture.stored_state(item_id),
        RecordedQueueItemState::Canceled
    );
}

// `Send now` on a provider that reads a priority message takes back the message ahead, hands the
// one sent now first marked priority, then the one ahead in its order, and marks the message with
// the request's key. Killed by answering the interrupt instead, handing in the queue's order, or
// not marking the message.
#[tokio::test]
async fn send_now_hands_the_message_first_and_the_rest_in_order() {
    let steers = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&steers);
    let mut driver = driver_reading_priority();
    driver.expect_apply_intervention().returning(move |params| {
        let ApplyInterventionParams::Steer {
            client_idempotency_key,
            payload,
            ..
        } = params
        else {
            panic!("the queue only steers");
        };
        recorded
            .lock()
            .expect("the steers are recorded")
            .push((client_idempotency_key, payload.is_priority));
        async { Ok(applied()) }.boxed()
    });
    driver
        .expect_withdraw_queued_message()
        .returning(|_| async { Ok(WithdrawQueuedMessageResult::Withdrawn {}) }.boxed());
    let fixture = fixture(driver).await;
    let run_id = new_run_id();
    insert_running_run(&fixture.database, fixture.session_id, run_id);
    bind_run_to_first_provider(&fixture.database, run_id);
    let ahead = fixture.queue_message(run_id).await;
    let sent_now = fixture.queue_message(run_id).await;
    let key = client_key();

    let outcome = fixture
        .queue
        .send_now(SendNow {
            run_id,
            expected_run_version: SafeInt::new(1).expect("a test version"),
            item_id: sent_now,
            key: key.clone(),
            intervention_id: InterventionId::new(&mint_uuid_v7().to_string())
                .expect("a minted UUID is an intervention id"),
        })
        .await
        .expect("the queue answers");
    fixture.queue.stop().await;

    assert!(matches!(outcome, SendNowOutcome::Sent), "{outcome:?}");
    assert_eq!(
        *steers.lock().expect("the steers are readable"),
        [(sent_now, true), (ahead, false)]
    );
    let marked: Option<String> = fixture
        .database
        .reader()
        .query_row(
            "SELECT send_now_key FROM queue_items WHERE id = ?1",
            [sent_now.text().as_str()],
            |row| row.get(0),
        )
        .expect("the test reads the message's mark");
    assert_eq!(marked.as_deref(), Some(key.as_str()));
}

// An interrupt's release called while the session's queue is held, as a run's end written under
// that hold calls it, answers without waiting for the hold; once the hold goes, the run's hold is
// let go and its waiting message handed. Killed by a release that takes the session's lock inline
// (the test times out), or by one that never settles.
#[tokio::test]
async fn a_release_from_inside_the_sessions_hold_settles_once_the_hold_goes() {
    let steers = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&steers);
    let mut driver = driver_reading_priority();
    driver.expect_apply_intervention().returning(move |_| {
        counted.fetch_add(1, Ordering::SeqCst);
        async { Ok(applied()) }.boxed()
    });
    let fixture = fixture(driver).await;
    let run_id = new_run_id();
    insert_running_run(&fixture.database, fixture.session_id, run_id);
    bind_run_to_first_provider(&fixture.database, run_id);
    fixture.queue_message(run_id).await;
    let intervention_id = InterventionId::new(&mint_uuid_v7().to_string())
        .expect("a minted UUID is an intervention id");
    let choice = InterruptChoice {
        pending: InterruptPendingChoice::KeepWaiting,
        deliver_first: None,
    };

    let is_held_inside = {
        let hold = fixture.queue.session_lock.acquire(fixture.session_id).await;
        fixture
            .queue
            .delivery
            .hold_for_interrupt(&hold, run_id, intervention_id)
            .await;
        timeout(
            WAIT,
            fixture
                .queue
                .release_interrupt(run_id, intervention_id, choice),
        )
        .await
        .expect("the release answers inside the hold")
        .expect("the release reads its run");
        fixture.queue.delivery.is_held_for_interrupt(run_id)
    };
    timeout(WAIT, fixture.queue.stop())
        .await
        .expect("the release settles once the hold goes");

    assert!(is_held_inside, "the run stays held while the hold is");
    assert!(!fixture.queue.delivery.is_held_for_interrupt(run_id));
    assert_eq!(steers.load(Ordering::SeqCst), 1);
}
