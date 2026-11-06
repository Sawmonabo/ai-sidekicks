//! The delivery's tests, over a test database holding a session and its running lead run bound to
//! the table's first provider, whose driver is a stand-in, the session's provider session opened,
//! by behavior: hands, take-backs, the interrupt's end, messages a provider process or a resume
//! keeps, and the undo's hold.

mod hands;
mod interrupt_end;
mod kept_messages;
mod run_end;
mod undo_hold;
mod withdraws;

use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt as _;
use rusqlite::params;
use sidekicks_contracts::approval::ApprovalRequestId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::InterventionId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_provider::driver::contract::MockProviderDriver;
use sidekicks_provider::driver::message_handing::{HandMoment, MessageHanding};
use sidekicks_provider::driver::run_control::{
    ApplyInterventionParams, ApplyInterventionResponse, InterventionResultStatus,
    WithdrawQueuedMessageResult,
};
use sidekicks_provider::driver::test_registry::{
    bind_run_to_first_provider, new_run_id, registry_of_first_provider,
};
use sidekicks_provider::port::run_pause::{ContinuedMessages, ContinuedRead};
use sidekicks_provider::process_identity::{
    ProcessStandIn, ProviderProcessIds, TEST_PROVIDER_PROCESS,
};
use sidekicks_session::questions::schema::schema_parts;
use sidekicks_session::queue_store::test_items::{self, words};
use sidekicks_session::queue_store::{QueueItemBody, QueueItemReader, QueueItemRecord};
use sidekicks_session::run::engine::test_fixture::insert_run;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
use sidekicks_store::events::log_service::test_fixture::{TestLog, open_log};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio::time::timeout;

use super::test_fixture::test_delivery_deps;
use super::{OpeningMessages, QueueDelivery, QueueDeliveryDeps};
use crate::provider_session::ProviderSessions;
use crate::provider_session::test_opening::{
    OrphanedAnswersStandIn, RecordedResumedRuns, test_provider_sessions,
};
use crate::session_lock::QueueSessionLock;

/// The statements the tests' read pool prepares: the delivery's reads and the recorder's.
const READ_STATEMENT_CAPACITY: usize = 8;

/// Bounds every wait a fault could hang.
const WAIT: Duration = Duration::from_secs(5);

/// A provider that takes a message at once and can give it back.
const HANDS_AT_ONCE: MessageHanding = MessageHanding {
    hands_at: HandMoment::AtOnce,
    can_withdraw: true,
    kept_by_process: false,
    reads_priority_message: false,
};

/// A provider whose messages the daemon holds to its turn's next tool boundary.
const HANDS_AT_TOOL_BOUNDARY: MessageHanding = MessageHanding {
    hands_at: HandMoment::AtToolBoundary,
    can_withdraw: false,
    kept_by_process: false,
    reads_priority_message: false,
};

/// The messages that open a run being started, as the test sets them, and a step the test runs
/// once, at the next read of a waiting message's opening, which a hand makes right after its read
/// of the waiting messages.
struct OpeningStandIn {
    openings: Mutex<HashSet<QueueItemId>>,
    after_read: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl OpeningStandIn {
    /// Runs `step` at the next read of a waiting message's opening.
    fn after_next_read(&self, step: impl FnOnce() + Send + 'static) {
        *self.after_read.lock().expect("the test's step is writable") = Some(Box::new(step));
    }
}

impl OpeningMessages for OpeningStandIn {
    fn is_opening(&self, item: &QueueItemRecord) -> bool {
        let after_read = self
            .after_read
            .lock()
            .expect("the test's step is readable")
            .take();
        if let Some(after_read) = after_read {
            after_read();
        }
        self.openings
            .lock()
            .expect("the test's openings are readable")
            .contains(&item.id)
    }

    fn take_reserved(&self, _run_id: RunId) -> Option<QueueItemId> {
        None
    }
}

/// A delivery over a session whose lead run runs, bound to the stand-in driver, its provider
/// session opened in this daemon.
struct Fixture {
    database: TestDatabase,
    log: TestLog,
    delivery: QueueDelivery,
    // Held so the delivery's weak hold on it lives: a resume finds the session opened.
    _provider_sessions: Arc<ProviderSessions>,
    session_lock: Arc<QueueSessionLock>,
    process: Arc<ProcessStandIn>,
    openings: Arc<OpeningStandIn>,
    session_id: SessionId,
    run_id: RunId,
}

async fn fixture(driver: MockProviderDriver) -> Fixture {
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await;
    let session_id = test_session_id();
    insert_session_row(&database.reader(), session_id.text().as_str(), None, None);
    let run_id = new_run_id();
    insert_run(&database, session_id, run_id, "running");
    bind_run_to_first_provider(&database, run_id);
    let pool = Arc::new(DatabaseReadPool::new(
        database.path(),
        READ_STATEMENT_CAPACITY,
    ));
    let session_lock = Arc::new(QueueSessionLock::new());
    let process = Arc::new(ProcessStandIn::default());
    process.set(Some(TEST_PROVIDER_PROCESS));
    let openings = Arc::new(OpeningStandIn {
        openings: Mutex::new(HashSet::new()),
        after_read: Mutex::new(None),
    });
    let providers = Arc::new(registry_of_first_provider(Arc::new(driver)));
    let provider_sessions = test_provider_sessions(
        Arc::clone(&pool),
        Arc::clone(&log.service),
        Arc::clone(&log.writer),
        Arc::clone(&providers),
        Arc::new(RecordedResumedRuns::default()).registered(),
        Arc::new(OrphanedAnswersStandIn::<ApprovalRequestId>::default()),
    );
    provider_sessions.record_test_opening(session_id);
    let delivery = QueueDelivery::new(QueueDeliveryDeps {
        session_lock: Arc::clone(&session_lock),
        processes: Arc::clone(&process) as Arc<dyn ProviderProcessIds>,
        openings: Arc::clone(&openings) as Arc<dyn OpeningMessages>,
        ..test_delivery_deps(
            pool,
            Arc::clone(&log.service),
            Arc::clone(&log.writer),
            providers,
            &provider_sessions,
        )
    });
    Fixture {
        database,
        log,
        delivery,
        _provider_sessions: provider_sessions,
        session_lock,
        process,
        openings,
        session_id,
        run_id,
    }
}

/// A driver answering `handing` for how its provider takes messages.
fn driver_handing(handing: MessageHanding) -> MockProviderDriver {
    let mut driver = MockProviderDriver::new();
    driver.expect_message_handing().return_const(handing);
    driver
}

/// The steer's answer that delivered the message into its own target.
fn applied() -> ApplyInterventionResponse {
    ApplyInterventionResponse {
        status: InterventionResultStatus::Applied,
        fallback_action: None,
        delivered_run_id: None,
        canceled: Vec::new(),
    }
}

/// The queue item a steer hands over, and whether it goes marked priority.
fn steered_item(params: &ApplyInterventionParams) -> (QueueItemId, bool) {
    let ApplyInterventionParams::Steer {
        client_idempotency_key,
        payload,
        ..
    } = params
    else {
        panic!("the delivery only steers");
    };
    (*client_idempotency_key, payload.is_priority)
}

/// Answers every steer as sent and counts them.
fn count_steers(driver: &mut MockProviderDriver) -> Arc<AtomicUsize> {
    let steers = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&steers);
    driver.expect_apply_intervention().returning(move |_| {
        counted.fetch_add(1, Ordering::SeqCst);
        async { Ok(applied()) }.boxed()
    });
    steers
}

/// Answers every withdraw as taken back and counts them.
fn count_withdraws(driver: &mut MockProviderDriver) -> Arc<AtomicUsize> {
    let withdraws = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&withdraws);
    driver.expect_withdraw_queued_message().returning(move |_| {
        counted.fetch_add(1, Ordering::SeqCst);
        async { Ok(WithdrawQueuedMessageResult::Withdrawn {}) }.boxed()
    });
    withdraws
}

/// Queues a message for the fixture's run, after every one before it, and reads it back.
async fn insert_item(fixture: &Fixture) -> QueueItemRecord {
    let body = QueueItemBody::Message(words("Look again"));
    let item_id = test_items::insert_item(
        &fixture.log.writer,
        fixture.session_id,
        fixture.run_id,
        body,
    )
    .await;
    stored_item(fixture, item_id)
}

fn stored_item(fixture: &Fixture, item_id: QueueItemId) -> QueueItemRecord {
    QueueItemReader::new(&fixture.database.reader())
        .get(&item_id)
        .expect("the test reads its message")
        .expect("the test's message is stored")
}

/// Hands the fixture's run its waiting messages under the session lock.
async fn hand(fixture: &Fixture) {
    let hold = fixture.session_lock.hold_session(fixture.session_id).await;
    fixture
        .delivery
        .hand_waiting(&hold, fixture.run_id)
        .await
        .expect("the waiting messages are handed");
}

/// The ids of the messages a continue of the fixture's run reads, under the session lock; none
/// while an undo holds the session.
async fn continued_ids(fixture: &Fixture) -> Vec<QueueItemId> {
    let hold = fixture.session_lock.hold_session(fixture.session_id).await;
    let read = ContinuedMessages::read(&fixture.delivery, &hold, fixture.run_id, HANDS_AT_ONCE)
        .await
        .expect("the continue reads the waiting messages");
    match read {
        ContinuedRead::Messages(messages) => messages.iter().map(|message| message.id).collect(),
        ContinuedRead::HeldForUndo => Vec::new(),
    }
}

async fn settle(fixture: &Fixture) {
    timeout(WAIT, fixture.delivery.settle(fixture.session_id))
        .await
        .expect("the chain settles");
}

/// Holds the session's chain from a task of its own until the returned sender is sent.
async fn hold_chain(fixture: &Fixture) -> (oneshot::Sender<()>, JoinHandle<()>) {
    let (release, released) = oneshot::channel::<()>();
    let (turn_taken, turn) = oneshot::channel();
    let delivery = fixture.delivery.clone();
    let session_id = fixture.session_id;
    let holder = tokio::spawn(async move {
        delivery
            .run_between_hands(session_id, async move {
                turn_taken
                    .send(())
                    .expect("the test waits for the chain's turn");
                released.await.expect("the test lets the chain go");
            })
            .await;
    });
    turn.await.expect("the chain gives the holder its turn");
    (release, holder)
}

/// Lets the chain held by [`hold_chain`] go and waits for its holder to end.
async fn release_chain(release: oneshot::Sender<()>, holder: JoinHandle<()>) {
    release.send(()).expect("the holder waits to be let go");
    timeout(WAIT, holder)
        .await
        .expect("the holder ends")
        .expect("the holder does not panic");
}

fn set_run_state(fixture: &Fixture, state: RunState) {
    fixture
        .database
        .reader()
        .execute(
            "UPDATE runs SET state = ?2 WHERE run_id = ?1",
            params![fixture.run_id.text().as_str(), <&'static str>::from(state)],
        )
        .expect("the test moves the run");
}

/// A fresh interrupt's id, for a hold the delivery takes.
fn intervention_id() -> InterventionId {
    InterventionId::new(&mint_uuid_v7().to_string()).expect("a minted UUID is an intervention id")
}

fn item_ids(items: &[QueueItemRecord]) -> Vec<QueueItemId> {
    items.iter().map(|item| item.id).collect()
}
