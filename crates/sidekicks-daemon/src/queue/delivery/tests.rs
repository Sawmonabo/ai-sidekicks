//! The delivery's tests, over a test database holding a session and its running lead run bound to
//! the table's first provider, whose driver is a stand-in: hands keep call order, a withdraw past
//! its deadline and a held run reach no driver, the interrupt's end partitions the waiting
//! messages, and a message kept by a gone process is never handed again on its own.

use std::cell::RefCell;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt as _;
use rusqlite::params;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::{QueueItemId, QueueItemNotDeliveredReason};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_platforms::Spawner;
use tokio::runtime::Handle;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::{Instant, timeout};

use super::{
    InterruptEndWrites, InterruptedRunContinuation, OpeningMessages, ProviderProcessIds,
    QueueDelivery, QueueDeliveryDeps, QueueWithdrawal, WITHDRAW_DEADLINE,
};
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::test_file::{TestDatabase, test_session_id};
use crate::events::log_service::tests::{TestLog, open_log};
use crate::events::session::appender::{SessionEventAppender, SessionEventLinkage};
use crate::events::session::version::SESSION_EVENT_VERSION;
use crate::keyed_lock::KeyedLock;
use crate::provider::driver::contract::{
    HandMoment, MessageHanding, MockProviderDriver, ProviderDriver,
};
use crate::provider::driver::registry::ProviderRegistry;
use crate::provider::driver::run_control::{
    ApplyInterventionParams, ApplyInterventionResponse, InterruptPendingChoice,
    InterventionResultStatus, WithdrawQueuedMessageResult,
};
use crate::provider::driver::{DriverServices, PROVIDERS, ProviderRegistration};
use crate::queue::changes::QueueChangeSignals;
use crate::queue::recorder::{QueueRecorder, QueueRecorderDeps};
use crate::queue::refusals::UnreturnedReason;
use crate::queue::store::{
    NewQueueItem, QueueItemBody, QueueItemReader, QueueItemRecord, RecordedQueueItemState,
    insert_queue_item_statement,
};
use crate::session::directory::test_rows::insert_session_row;
use crate::session::run::engine::tests::insert_running_run;
use crate::session::run::pause::ContinuedMessages;
use crate::uuid_v7::mint_uuid_v7;

/// The statements the tests' read pool prepares: the delivery's reads and the recorder's.
const READ_STATEMENT_CAPACITY: usize = 8;

/// Bounds every wait a fault could hang.
const WAIT: Duration = Duration::from_secs(5);

/// A provider that takes a message at once and can give it back.
const HANDS_AT_ONCE: MessageHanding = MessageHanding {
    hands_at: HandMoment::AtOnce,
    can_withdraw: true,
    kept_by_process: false,
};

thread_local! {
    // The driver the next registry this thread builds registers for the table's first provider.
    static NEXT_DRIVER: RefCell<Option<Arc<dyn ProviderDriver>>> = const { RefCell::new(None) };
}

// Hands the registry the driver the test put in the slot.
fn take_next_driver(_services: &DriverServices) -> Arc<dyn ProviderDriver> {
    NEXT_DRIVER
        .with_borrow_mut(Option::take)
        .expect("the test sets its driver before the registry is built")
}

/// The session's provider process, as the test sets it.
struct ProcessStandIn(Mutex<Option<u32>>);

impl ProviderProcessIds for ProcessStandIn {
    fn process_id(&self, _session_id: &SessionId) -> Option<u32> {
        *self.0.lock().expect("the test's process id is readable")
    }
}

/// No message opens a run being started.
struct NoOpenings;

impl OpeningMessages for NoOpenings {
    fn is_opening(&self, _item_id: &QueueItemId) -> bool {
        false
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
    session_lock: Arc<KeyedLock<SessionId>>,
    process: Arc<ProcessStandIn>,
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
    database
        .reader()
        .execute(
            "INSERT INTO runtime_bindings (id, run_id, provider_name, contract_version,
               cli_version_raw, created_at, updated_at)
             VALUES ('binding', ?1, ?2, '1.0.0', '1.0.0', '', '')",
            params![run_id.text().as_str(), PROVIDERS[0].id],
        )
        .expect("the test binds the run to its provider");
    NEXT_DRIVER.with_borrow_mut(|next| *next = Some(Arc::new(driver)));
    let services = DriverServices {
        spawner: Spawner::new(Handle::current()).expect("the spawner thread starts"),
        data_folder: PathBuf::from("data"),
    };
    let providers = ProviderRegistry::register_from(
        &[ProviderRegistration {
            descriptor: PROVIDERS[0],
            build: take_next_driver,
        }],
        &services,
    );
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
    let session_lock = Arc::new(KeyedLock::new());
    let process = Arc::new(ProcessStandIn(Mutex::new(Some(7))));
    let delivery = QueueDelivery::new(QueueDeliveryDeps {
        pool,
        recorder,
        providers: Arc::new(providers),
        session_lock: Arc::clone(&session_lock),
        processes: Arc::clone(&process) as Arc<dyn ProviderProcessIds>,
        openings: Arc::new(NoOpenings),
        continuation: Arc::new(NoContinuation),
    });
    Fixture {
        database,
        log,
        delivery,
        session_lock,
        process,
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
    let hold = fixture.session_lock.acquire(fixture.session_id).await;
    fixture
        .delivery
        .hand_waiting(&hold, fixture.run_id)
        .await
        .expect("the waiting messages are handed");
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

// Two hands reach the driver in call order, the second only once the first's driver call is
// over, on the multi-thread runtime where a task woken last can run first. Killed by spawning a
// task per hand onto the session's keyed lock, or by spawning hands with no chain at all.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hands_reach_the_driver_one_at_a_time_in_call_order() {
    let (called, mut steered) = mpsc::unbounded_channel();
    let (release_first, first_released) = oneshot::channel::<()>();
    let first_released = Mutex::new(Some(first_released));
    let mut driver = driver_handing(HANDS_AT_ONCE);
    driver.expect_apply_intervention().returning(move |params| {
        let ApplyInterventionParams::Steer {
            client_idempotency_key,
            ..
        } = params
        else {
            panic!("the delivery only steers");
        };
        called
            .send(client_idempotency_key)
            .expect("the test reads each steer");
        let released = first_released
            .lock()
            .expect("the first steer's release is readable")
            .take();
        async move {
            if let Some(released) = released {
                released.await.expect("the test releases the first steer");
            }
            Ok(applied())
        }
        .boxed()
    });
    let fixture = fixture(driver).await;

    let first = insert_item(&fixture).await;
    hand(&fixture).await;
    let first_steered = timeout(WAIT, steered.recv())
        .await
        .expect("the first hand steers");
    let second = insert_item(&fixture).await;
    hand(&fixture).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let early = steered.try_recv();
    release_first
        .send(())
        .expect("the first steer waits to be released");
    let second_steered = timeout(WAIT, steered.recv())
        .await
        .expect("the second hand steers");
    settle(&fixture).await;

    assert_eq!(first_steered, Some(first.id));
    assert!(
        early.is_err(),
        "the second hand waits behind the first's driver call"
    );
    assert_eq!(second_steered, Some(second.id));
}

// A withdraw the chain does not reach within the deadline answers not delivered, the message
// reads not delivered and stays handed, and once the chain reaches it the withdraw makes no
// driver call. Killed by dropping the deadline check at the withdraw's start.
#[tokio::test(start_paused = true)]
async fn a_withdraw_past_its_deadline_reads_not_delivered_and_reaches_no_driver() {
    let mut driver = driver_handing(HANDS_AT_ONCE);
    let steers = count_steers(&mut driver);
    let withdraws = count_withdraws(&mut driver);
    let fixture = fixture(driver).await;
    let item = insert_item(&fixture).await;
    hand(&fixture).await;
    settle(&fixture).await;
    let (release, holder) = hold_chain(&fixture).await;

    let started = Instant::now();
    let withdrawals = {
        let hold = fixture.session_lock.acquire(fixture.session_id).await;
        fixture
            .delivery
            .take_back(&hold, std::slice::from_ref(&item))
            .await
            .expect("the take-back answers")
    };
    let waited = started.elapsed();
    let is_handed = fixture.delivery.is_handed(&item.id);
    release_chain(release, holder).await;
    settle(&fixture).await;

    assert_eq!(steers.load(Ordering::SeqCst), 1);
    assert!(waited >= WITHDRAW_DEADLINE);
    assert!(matches!(
        withdrawals.get(&item.id),
        Some(QueueWithdrawal::Unreturned(UnreturnedReason::NotDelivered))
    ));
    assert_eq!(
        stored_item(&fixture, item.id).state,
        RecordedQueueItemState::NotDelivered {
            reason: QueueItemNotDeliveredReason::Failed
        }
    );
    assert!(is_handed, "a message not given back stays handed");
    assert_eq!(withdraws.load(Ordering::SeqCst), 0);
}

// A hand queued behind the chain to a run an interrupt then holds makes no driver call, and its
// message waits unhanded for the interrupt's choice. Killed by dropping the job's re-check of
// the hold before the driver call.
#[tokio::test]
async fn a_hand_to_a_run_held_for_an_interrupt_makes_no_driver_call() {
    let mut driver = driver_handing(HANDS_AT_ONCE);
    let steers = count_steers(&mut driver);
    let fixture = fixture(driver).await;
    let item = insert_item(&fixture).await;
    let (release, holder) = hold_chain(&fixture).await;

    {
        let hold = fixture.session_lock.acquire(fixture.session_id).await;
        fixture
            .delivery
            .hand_waiting(&hold, fixture.run_id)
            .await
            .expect("the hand is queued");
        timeout(
            WAIT,
            fixture.delivery.hold_for_interrupt(&hold, fixture.run_id),
        )
        .await
        .expect("no hand is inside its driver call");
    }
    release_chain(release, holder).await;
    settle(&fixture).await;

    assert_eq!(steers.load(Ordering::SeqCst), 0);
    assert_eq!(
        stored_item(&fixture, item.id).state,
        RecordedQueueItemState::Queued
    );
    assert!(!fixture.delivery.is_handed(&item.id));
}

/// A run with three messages waiting: the first two handed to the provider, the third not.
async fn interrupted_fixture() -> (Fixture, [QueueItemRecord; 3]) {
    let mut driver = driver_handing(HANDS_AT_ONCE);
    count_steers(&mut driver);
    let fixture = fixture(driver).await;
    let given_back = insert_item(&fixture).await;
    let still_handed = insert_item(&fixture).await;
    hand(&fixture).await;
    settle(&fixture).await;
    let unhanded = insert_item(&fixture).await;
    (fixture, [given_back, still_handed, unhanded])
}

/// The interrupt's end writes for `pending`, the provider giving back the first message and an
/// id it was never handed, on the session's chain.
async fn end_writes(
    fixture: &Fixture,
    pending: InterruptPendingChoice,
    given_back: &QueueItemRecord,
) -> InterruptEndWrites {
    let unknown = QueueItemId::try_from(mint_uuid_v7()).expect("a minted UUID is a queue item id");
    let cancelled = [given_back.id, unknown];
    timeout(
        WAIT,
        fixture.delivery.run_between_hands(
            fixture.session_id,
            fixture
                .delivery
                .interrupt_end_writes(fixture.run_id, pending, None, &cancelled),
        ),
    )
    .await
    .expect("the chain gives the end its turn")
    .expect("the end's writes are built")
}

fn item_ids(items: &[QueueItemRecord]) -> Vec<QueueItemId> {
    items.iter().map(|item| item.id).collect()
}

// `returnToDraft`: the writes, committed as the run's end commits them, cancel the message given
// back and the one never handed; the one the provider still holds stays waiting and handed.
// Killed by skipping the give-back or by keeping handed messages among those cancelled.
#[tokio::test]
async fn an_interrupt_to_the_draft_cancels_what_the_provider_does_not_hold() {
    let (fixture, [given_back, still_handed, unhanded]) = interrupted_fixture().await;

    let mut writes = end_writes(&fixture, InterruptPendingChoice::ReturnToDraft, &given_back).await;
    assert_eq!(item_ids(&writes.changed), vec![given_back.id, unhanded.id]);
    assert!(!writes.moves_order);
    let draft = writes
        .preceding_events
        .pop()
        .expect("each cancel carries its event");
    SessionEventAppender::new(
        Arc::clone(&fixture.log.service),
        SESSION_EVENT_VERSION.clone(),
    )
    .append(
        draft,
        SessionEventLinkage {
            transactional_prelude: writes.statements,
            preceding_events: writes.preceding_events,
            ..SessionEventLinkage::default()
        },
    )
    .await
    .expect("the end's writes commit");

    assert_eq!(
        stored_item(&fixture, given_back.id).state,
        RecordedQueueItemState::Canceled
    );
    assert_eq!(
        stored_item(&fixture, unhanded.id).state,
        RecordedQueueItemState::Canceled
    );
    assert_eq!(
        stored_item(&fixture, still_handed.id).state,
        RecordedQueueItemState::Queued
    );
    assert!(fixture.delivery.is_handed(&still_handed.id));
}

// `keepWaiting`: nothing is written, the message given back waits unhanded, and once the run
// rests interrupted its continue reads the unhanded messages in queue order, the one the provider
// still holds left out. Killed by skipping the give-back or by reading a handed message.
#[tokio::test]
async fn an_interrupt_that_keeps_waiting_leaves_the_messages_for_the_continue() {
    let (fixture, [given_back, still_handed, unhanded]) = interrupted_fixture().await;

    let writes = end_writes(&fixture, InterruptPendingChoice::KeepWaiting, &given_back).await;
    let is_given_back_handed = fixture.delivery.is_handed(&given_back.id);
    set_run_state(&fixture, RunState::Interrupted);
    let continued = ContinuedMessages::read(&fixture.delivery, fixture.run_id)
        .await
        .expect("the continue reads the waiting messages");

    assert!(writes.statements.is_empty());
    assert!(writes.preceding_events.is_empty());
    assert!(writes.changed.is_empty());
    assert_eq!(
        stored_item(&fixture, given_back.id).state,
        RecordedQueueItemState::Queued
    );
    assert!(!is_given_back_handed);
    assert_eq!(
        continued
            .iter()
            .map(|message| message.id)
            .collect::<Vec<_>>(),
        vec![given_back.id, unhanded.id]
    );
    assert!(fixture.delivery.is_handed(&still_handed.id));
}

// A message handed to a provider whose process keeps it past the run's end stays handed through
// the end while that process is the session's; once the process is gone it is forgotten, its run
// answered, and it waits without being handed again. Killed by forgetting kept messages at the
// run's end, or by keeping them once their process is gone.
#[tokio::test]
async fn a_message_kept_by_a_gone_process_waits_and_is_never_handed_on_its_own() {
    let mut driver = driver_handing(MessageHanding {
        hands_at: HandMoment::AtOnce,
        can_withdraw: true,
        kept_by_process: true,
    });
    let steers = count_steers(&mut driver);
    let fixture = fixture(driver).await;
    let item = insert_item(&fixture).await;
    hand(&fixture).await;
    settle(&fixture).await;

    set_run_state(&fixture, RunState::Completed);
    fixture.delivery.end_run(fixture.session_id, fixture.run_id);
    let is_kept_through_the_end = fixture.delivery.is_handed(&item.id);
    *fixture
        .process
        .0
        .lock()
        .expect("the test's process id is writable") = None;
    let ended_runs = fixture
        .delivery
        .forget_kept_by_gone_process(fixture.session_id)
        .await
        .expect("the kept messages are read");
    hand(&fixture).await;
    settle(&fixture).await;

    assert!(is_kept_through_the_end);
    assert_eq!(ended_runs, vec![fixture.run_id]);
    assert!(!fixture.delivery.is_handed(&item.id));
    assert_eq!(
        stored_item(&fixture, item.id).state,
        RecordedQueueItemState::Queued
    );
    assert_eq!(steers.load(Ordering::SeqCst), 1);
}
