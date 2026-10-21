//! The delivery's tests, over a test database holding a session and its running lead run bound to
//! the table's first provider, whose driver is a stand-in, by behavior: hands, take-backs, the
//! interrupt's end, and messages a provider process or a resume keeps.

mod hands;
mod interrupt_end;
mod kept_messages;
mod withdraws;

use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt as _;
use rusqlite::params;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::InterventionId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::FreeFormText;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio::time::timeout;

use super::{
    InterruptedRunContinuation, OpeningMessages, ProviderProcessIdentity, ProviderProcessIds,
    QueueDelivery, QueueDeliveryDeps,
};
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::test_file::{TestDatabase, test_session_id};
use crate::events::log_service::tests::{TestLog, open_log};
use crate::provider::driver::contract::MockProviderDriver;
use crate::provider::driver::message_handing::{HandMoment, MessageHanding};
use crate::provider::driver::run_control::{
    ApplyInterventionParams, ApplyInterventionResponse, InterventionResultStatus,
    WithdrawQueuedMessageResult,
};
use crate::provider::driver::test_registry::{
    bind_run_to_first_provider, registry_of_first_provider,
};
use crate::queue::changes::QueueChangeSignals;
use crate::queue::recorder::{QueueRecorder, QueueRecorderDeps};
use crate::queue::session_lock::QueueSessionLock;
use crate::queue::store::{
    NewQueueItem, QueueItemBody, QueueItemReader, QueueItemRecord, insert_queue_item_statement,
};
use crate::session::directory::test_rows::insert_session_row;
use crate::session::run::engine::tests::insert_running_run;
use crate::session::run::pause::ContinuedMessages;
use sidekicks_contracts::wire::id::mint_uuid_v7;

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

/// The session's provider process when each test starts.
const FIRST_PROCESS: ProviderProcessIdentity = ProviderProcessIdentity {
    process_id: 7,
    spawn_sequence: 1,
};

/// The session's provider process, as the test sets it.
struct ProcessStandIn(Mutex<Option<ProviderProcessIdentity>>);

impl ProviderProcessIds for ProcessStandIn {
    fn process_identity(&self, _session_id: &SessionId) -> Option<ProviderProcessIdentity> {
        *self.0.lock().expect("the test's process is readable")
    }
}

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
}

/// No test's run rests interrupted with a kept message taken.
struct NoContinuation;

impl InterruptedRunContinuation for NoContinuation {
    fn continue_interrupted_run(&self, _session_id: SessionId, _run_id: RunId) {}
}

/// A delivery over a session whose lead run runs, bound to the stand-in driver.
struct Fixture {
    database: TestDatabase,
    log: TestLog,
    delivery: QueueDelivery,
    session_lock: Arc<QueueSessionLock>,
    process: Arc<ProcessStandIn>,
    openings: Arc<OpeningStandIn>,
    session_id: SessionId,
    run_id: RunId,
}

async fn fixture(driver: MockProviderDriver) -> Fixture {
    let database = TestDatabase::new();
    let log = open_log(&database, None).await;
    let session_id = test_session_id();
    insert_session_row(&database.reader(), session_id.text().as_str(), None, None);
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&database, session_id, run_id);
    bind_run_to_first_provider(&database, run_id);
    let pool = Arc::new(DatabaseReadPool::new(
        database.path(),
        READ_STATEMENT_CAPACITY,
    ));
    let recorder = Arc::new(QueueRecorder::new(QueueRecorderDeps {
        event_log: Arc::clone(&log.service),
        writer: Arc::clone(&log.writer),
        pool: Arc::clone(&pool),
        signals: Arc::new(QueueChangeSignals::new()),
    }));
    let session_lock = Arc::new(QueueSessionLock::new());
    let process = Arc::new(ProcessStandIn(Mutex::new(Some(FIRST_PROCESS))));
    let openings = Arc::new(OpeningStandIn {
        openings: Mutex::new(HashSet::new()),
        after_read: Mutex::new(None),
    });
    let delivery = QueueDelivery::new(QueueDeliveryDeps {
        pool,
        recorder,
        providers: Arc::new(registry_of_first_provider(Arc::new(driver))),
        session_lock: Arc::clone(&session_lock),
        processes: Arc::clone(&process) as Arc<dyn ProviderProcessIds>,
        openings: Arc::clone(&openings) as Arc<dyn OpeningMessages>,
        continuation: Arc::new(NoContinuation),
    });
    Fixture {
        database,
        log,
        delivery,
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
        cancelled: Vec::new(),
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
    let item = NewQueueItem {
        id: QueueItemId::try_from(mint_uuid_v7()).expect("a minted UUID is a queue item id"),
        session_id: fixture.session_id,
        body: QueueItemBody {
            content: FreeFormText::new("Look again".to_owned()).expect("a test message"),
            attachments: None,
            skills: None,
            answers_question_id: None,
            output_speed_for_turn: None,
            workspace_id: None,
        },
        target_run_id: fixture.run_id,
        device_id: None,
        client_idempotency_key: ClientUuid::new(mint_uuid_v7().to_string())
            .expect("a minted UUID is a client key"),
        replaces_queue_item_id: None,
        now: WireInstant::now(),
    };
    fixture
        .log
        .writer
        .write(vec![insert_queue_item_statement(&item)])
        .await
        .expect("the test queues its message");
    stored_item(fixture, item.id)
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

/// The ids of the messages a continue of the fixture's run reads, under the session lock.
async fn continued_ids(fixture: &Fixture) -> Vec<QueueItemId> {
    let hold = fixture.session_lock.hold_session(fixture.session_id).await;
    ContinuedMessages::read(&fixture.delivery, &hold, fixture.run_id, HANDS_AT_ONCE)
        .await
        .expect("the continue reads the waiting messages")
        .iter()
        .map(|message| message.id)
        .collect()
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
