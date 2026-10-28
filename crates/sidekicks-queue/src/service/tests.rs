//! The run queue's tests, over a test database holding a session whose lead is bound to the
//! table's first provider, whose driver is a stand-in that records what it is asked: a send to a
//! session that takes no change and the removal of a queued run's last message here; sends,
//! run ends and the interrupts' queue in the modules below.

mod interrupt;
mod run_ends;
mod sends;

use std::num::NonZeroUsize;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt as _;
use rstest::rstest;
use rusqlite::params;
use serde_json::{Value, json};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::{
    AgentQueueItemCancelRequest, AgentQueueItemCreateRequest, QueueItemId, QueuedSkillPick,
};
use sidekicks_contracts::session::cost::TokensPerRun;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_provider::driver::contract::{DriverError, MockProviderDriver};
use sidekicks_provider::driver::message_handing::{HandMoment, MessageHanding};
use sidekicks_provider::driver::run_control::{
    ApplyInterventionParams, ApplyInterventionResponse, InterventionResultStatus,
    SteerTurnEndedError, WithdrawQueuedMessageResult,
};
use sidekicks_provider::driver::session_control::ProviderSessionHandle;
use sidekicks_provider::driver::test_registry::registered_test_accounts;
use sidekicks_provider::driver::test_registry::{new_run_id, registry_of_first_provider};
use sidekicks_provider::driver::{CurrentProviderAccount, PROVIDERS};
use sidekicks_provider::process_identity::{ProcessStandIn, ProviderProcessIds};
use sidekicks_provider::runtime_binding::store::RuntimeBindingStore;
use sidekicks_provider::runtime_binding::test_store::test_provider_account_id;
use sidekicks_session::questions::schema::schema_parts;
use sidekicks_session::queue_store::{
    NewQueueItem, QueueItemBody, QueueItemReader, QueueItemRecord, RecordedQueueItemState,
    insert_queue_item_statement,
};
use sidekicks_session::run::binding_cursors::RunBindingCursors;
use sidekicks_session::run::engine::test_fixture::{
    insert_running_run, stored_run_state, test_engine,
};
use sidekicks_session::run::epochs::ExecutionEpochs;
use sidekicks_session::run::pause::RunPauseControl;
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::pause_point::PausePoint;
use sidekicks_std::port_registration::PortRegistration;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::database::writer::test_file::{TestDatabase, insert_lead, test_session_id};
use sidekicks_store::events::log_service::test_fixture::{TestLog, open_log};
use sidekicks_store::events::session::read::DamagedFromSequenceReader;
use tempfile::TempDir;

use super::{EMPTIED_RUN_DETAIL, RunQueue, RunQueueDeps};
use crate::changes::QueueChangeSignals;
use crate::error::QueueError;
use crate::memory_gate::{MemoryGate, MemoryGateFigures};
use crate::provider_session::test_opening::{
    RecordedProcessFollowing, record_first_provider_capabilities, test_opening_composer,
};
use crate::provider_session::{ProviderSessions, ProviderSessionsDeps};
use crate::run_token_limit::RunTokenLimitReader;

/// The statements the tests' read pool prepares, every reader's together.
const READ_STATEMENT_CAPACITY: usize = 32;

/// Bounds every wait a fault could hang.
const WAIT: Duration = Duration::from_secs(5);

/// How long a call held behind other work is watched to show it waits.
const HELD_WATCH: Duration = Duration::from_millis(200);

/// What the stand-in driver was asked, in order, and how it answers.
#[derive(Default)]
struct DriverCalls {
    /// Each run start or continue, with the message it opened with.
    starts: Mutex<Vec<(RunId, QueueItemId)>>,
    /// Each steer, with whether it was marked priority.
    steers: Mutex<Vec<(QueueItemId, bool)>>,
    /// Each resume, with the messages it carried.
    resumes: Mutex<Vec<(RunId, Vec<QueueItemId>)>>,
    /// Holds a start before it answers.
    start_pause: PausePoint,
    /// Holds a steer before it answers.
    steer_pause: PausePoint,
    /// How many starts fail before one succeeds.
    start_failures_left: AtomicUsize,
    /// How many priority steers find their turn ended before one is taken.
    dropped_priority_steers_left: AtomicUsize,
    /// Whether the provider's process keeps a message it took past its run's end.
    is_kept_by_process: AtomicBool,
}

impl DriverCalls {
    fn starts(&self) -> Vec<(RunId, QueueItemId)> {
        lock(&self.starts).clone()
    }

    fn steers(&self) -> Vec<(QueueItemId, bool)> {
        lock(&self.steers).clone()
    }

    fn resumes(&self) -> Vec<(RunId, Vec<QueueItemId>)> {
        lock(&self.resumes).clone()
    }
}

// Takes one from `left` when any is left.
fn take_one(left: &AtomicUsize) -> bool {
    left.try_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
        left.checked_sub(1)
    })
    .is_ok()
}

/// A driver whose provider takes messages at once, reads a priority message and gives back what
/// it was handed, its process keeping one past the run's end as `calls` says, recording each
/// start, steer and resume in `calls`.
fn recording_driver(calls: &Arc<DriverCalls>) -> MockProviderDriver {
    let mut driver = MockProviderDriver::new();
    let handing = Arc::clone(calls);
    driver
        .expect_message_handing()
        .returning(move || MessageHanding {
            hands_at: HandMoment::AtOnce,
            can_withdraw: true,
            kept_by_process: handing.is_kept_by_process.load(Ordering::SeqCst),
            reads_priority_message: true,
        });
    driver
        .expect_starts_process()
        .returning(|_, _| async { false }.boxed());
    driver.expect_create_session().returning(|_| {
        async {
            Ok(ProviderSessionHandle {
                provider_session_id: "provider-session".to_owned(),
                resume_handle: "conversation-1".to_owned(),
            })
        }
        .boxed()
    });
    let starting = Arc::clone(calls);
    driver.expect_start_run().returning(move |params| {
        let calls = Arc::clone(&starting);
        async move {
            calls.start_pause.pass().await;
            lock(&calls.starts).push((params.run_id, params.opening.message_id));
            if take_one(&calls.start_failures_left) {
                return Err(DriverError::Internal("the test's start fails".into()));
            }
            Ok(())
        }
        .boxed()
    });
    driver
        .expect_interrupt_run()
        .returning(|_| async { Ok(()) }.boxed());
    let steering = Arc::clone(calls);
    driver.expect_apply_intervention().returning(move |params| {
        let ApplyInterventionParams::Steer {
            target_run_id,
            client_idempotency_key,
            payload,
            ..
        } = params
        else {
            panic!("the queue only steers");
        };
        lock(&steering.steers).push((client_idempotency_key, payload.is_priority));
        let is_dropped = payload.is_priority && take_one(&steering.dropped_priority_steers_left);
        let steering = Arc::clone(&steering);
        async move {
            steering.steer_pause.pass().await;
            if is_dropped {
                return Err(DriverError::SteerTurnEnded(SteerTurnEndedError {
                    run_id: target_run_id,
                }));
            }
            Ok(applied())
        }
        .boxed()
    });
    driver
        .expect_withdraw_queued_message()
        .returning(|_| async { Ok(WithdrawQueuedMessageResult::Withdrawn {}) }.boxed());
    let resuming = Arc::clone(calls);
    driver.expect_resume_run().returning(move |params| {
        let messages = params.messages.iter().map(|message| message.id).collect();
        lock(&resuming.resumes).push((params.run_id, messages));
        async { Ok(()) }.boxed()
    });
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

/// A run queue over a session whose lead is bound to the stand-in driver.
struct Fixture {
    database: TestDatabase,
    log: TestLog,
    queue: Arc<RunQueue>,
    session_id: SessionId,
    // The engine's posture files.
    home: TempDir,
    process: Arc<ProcessStandIn>,
}

async fn fixture(driver: MockProviderDriver) -> Fixture {
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await;
    let home = tempfile::tempdir().expect("the test makes a home folder");
    let session_id = test_session_id();
    insert_session_row(&database.reader(), session_id.text().as_str(), None, None);
    insert_lead(&database, session_id, PROVIDERS[0].id);
    let process = Arc::new(ProcessStandIn::default());
    let queue = queue_over(
        &database,
        &log,
        &home,
        driver,
        Arc::clone(&process) as _,
        CurrentProviderAccount::Current(test_provider_account_id()),
    );
    Fixture {
        database,
        log,
        queue,
        session_id,
        home,
        process,
    }
}

/// A run queue over `database` and its `log`, built as the daemon's start builds it, its lead's
/// provider answered by `driver`, its process read from `processes` and its account by `account`.
fn queue_over(
    database: &TestDatabase,
    log: &TestLog,
    home: &TempDir,
    driver: MockProviderDriver,
    processes: Arc<dyn ProviderProcessIds>,
    account: CurrentProviderAccount,
) -> Arc<RunQueue> {
    let pool = Arc::new(DatabaseReadPool::new(
        database.path(),
        READ_STATEMENT_CAPACITY,
    ));
    let engine = test_engine(database, Arc::clone(&log.service), home.path());
    let providers = Arc::new(registry_of_first_provider(Arc::new(driver)));
    record_first_provider_capabilities(&providers);
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
        compose_opening: test_opening_composer(),
        transition_lock: Arc::new(KeyedLock::new()),
        process_follower: Arc::new(RecordedProcessFollowing::default()),
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
    RunQueue::new(RunQueueDeps {
        pool: Arc::clone(&pool),
        event_log: Arc::clone(&log.service),
        writer: Arc::clone(&log.writer),
        signals: Arc::new(QueueChangeSignals::new()),
        engine: Arc::clone(&engine),
        providers: Arc::clone(&providers),
        provider_sessions,
        memory_gate,
        processes,
        pauses: Arc::new(RunPauseControl::new(pool, engine, providers)),
        followers: Arc::clone(&log.followers),
        read_damaged_from_sequence,
        provider_accounts: registered_test_accounts(account),
        token_limits: {
            let token_limits = PortRegistration::new("run token limits");
            token_limits
                .register(Arc::new(ConfiguredTokenLimit) as Arc<dyn RunTokenLimitReader>)
                .expect("a new registration takes its port");
            Arc::new(token_limits)
        },
    })
}

/// The `Tokens per run` every test's daemon configuration sets.
fn configured_tokens_per_run() -> TokensPerRun {
    TokensPerRun(SafeInt::new(500_000).expect("the test's limit is a safe integer"))
}

// The daemon's configuration as the tests set it: every new lead run limited alike.
struct ConfiguredTokenLimit;

impl RunTokenLimitReader for ConfiguredTokenLimit {
    fn tokens_per_run(&self, _session_id: SessionId) -> Option<TokensPerRun> {
        Some(configured_tokens_per_run())
    }
}

fn client_key() -> ClientUuid {
    ClientUuid::new(mint_uuid_v7().to_string()).expect("a minted UUID is a client key")
}

impl Fixture {
    /// Writes a lead run of the session in `state`, at version 1, queued on the test's account,
    /// and answers its id.
    fn insert_run(&self, state: &str) -> RunId {
        let run_id = new_run_id();
        insert_running_run(&self.database, self.session_id, run_id);
        self.insert_event(
            run_id,
            SessionEventType::AgentRunQueued,
            &json!({
                "runId": run_id.text().as_str(),
                "admittedProviderAccountId": test_provider_account_id().as_str(),
            }),
        );
        self.set_run_state(run_id, state);
        run_id
    }

    /// Moves `run_id` to `state` as a writer outside the engine would.
    fn set_run_state(&self, run_id: RunId, state: &str) {
        self.database
            .reader()
            .execute(
                "UPDATE runs SET state = ?2 WHERE run_id = ?1",
                params![run_id.text().as_str(), state],
            )
            .expect("the test moves the run");
    }

    /// Writes the interrupted end of `run_id`, `trigger` naming the limit that ended it; a
    /// person's interrupt names none.
    fn insert_interrupted_end(&self, run_id: RunId, trigger: Option<&str>) {
        self.insert_event(
            run_id,
            SessionEventType::AgentRunInterrupted,
            &json!({ "runId": run_id.text().as_str(), "trigger": trigger }),
        );
    }

    /// Writes an event of `event_type` on `run_id` carrying `payload`, next in the session's log.
    fn insert_event(&self, run_id: RunId, event_type: SessionEventType, payload: &Value) {
        let connection = self.database.reader();
        let sequence: i64 = connection
            .query_row(
                "SELECT COALESCE(MAX(sequence), -1) + 1 FROM session_events WHERE session_id = ?1",
                [self.session_id.text().as_str()],
                |row| row.get(0),
            )
            .expect("the test reads the log's next sequence");
        connection
            .execute(
                "INSERT INTO session_events (id, session_id, sequence, occurred_at, monotonic_ns,
                   category, type, payload, run_id, run_version)
                 VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?7, ?8, 1)",
                params![
                    mint_uuid_v7().to_string(),
                    self.session_id.text().as_str(),
                    sequence,
                    WireInstant::now().as_str(),
                    event_type.category().as_str(),
                    event_type.as_str(),
                    payload.to_string(),
                    run_id.text().as_str(),
                ],
            )
            .expect("the test writes the run's event");
    }

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

    /// Sends a message to the session's lead as a person does and answers its id. Fails as the
    /// queue refuses the send.
    async fn send(&self) -> Result<QueueItemId, QueueError> {
        self.send_picking(None).await
    }

    /// [`Fixture::send`] with the skills `skills` picks.
    async fn send_picking(
        &self,
        skills: Option<Vec<QueuedSkillPick>>,
    ) -> Result<QueueItemId, QueueError> {
        let key = client_key();
        self.queue
            .create(
                AgentQueueItemCreateRequest {
                    session_id: self.session_id,
                    to: None,
                    workspace_id: None,
                    client_idempotency_key: key.clone(),
                    content: FreeFormText::new("Look again".to_owned()).expect("a test message"),
                    attachments: None,
                    skills,
                    replaces_queue_item_id: None,
                    answers_question_id: None,
                    output_speed_for_turn: None,
                },
                DeviceId::new("device-1".to_owned()).expect("a test device id"),
            )
            .await?;
        Ok(QueueItemReader::new(&self.database.reader())
            .get_by_idempotency_key(&self.session_id, &key)
            .expect("the test reads its send")
            .expect("the send is stored")
            .id)
    }

    fn stored_item(&self, item_id: QueueItemId) -> QueueItemRecord {
        QueueItemReader::new(&self.database.reader())
            .get(&item_id)
            .expect("the test reads its message")
            .expect("the test's message is stored")
    }

    fn stored_state(&self, item_id: QueueItemId) -> RecordedQueueItemState {
        self.stored_item(item_id).state
    }

    fn run_state(&self, run_id: RunId) -> String {
        stored_run_state(&self.database, &run_id).0
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

    let refused = fixture.send().await.expect_err("the send is refused");

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
    let run_id = fixture.insert_run("queued");
    let item_id = fixture.queue_message(run_id).await;

    fixture
        .queue
        .cancel(AgentQueueItemCancelRequest {
            queue_item_id: item_id,
            child_handle: None,
        })
        .await
        .expect("the message is removed");

    assert_eq!(fixture.run_state(run_id), "failed");
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
