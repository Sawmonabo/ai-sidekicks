//! Reviewer blocks over a test database: a session with a queued run bound to a provider whose
//! driver is a stand-in, the blocks taken through the port and pressed through `Allow once`.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;

use futures::FutureExt as _;
use rstest::rstest;
use rusqlite::params;
use serde_json::json;
use serde_json::value::RawValue;
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::approval::{ApprovalDenialOverrideRequest, ReviewerDenialId};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queued::{
    AgentRunQueuedNewState, AgentRunQueuedPayload, RunQueuedSessionAgentPayload,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;

use super::{
    DenialOverrideError, REVIEWER_DENIALS_STATEMENT_CAPACITY, ReviewerDenialError, ReviewerDenials,
};
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::test_file::{TestDatabase, test_session_id};
use crate::events::log_service::tests::{TestLog, open_log};
use crate::events::session::appender::{
    SessionEventAppender, SessionEventDraft, SessionEventLinkage,
};
use crate::events::session::followers::FollowerAttachment;
use crate::events::session::version::SESSION_EVENT_VERSION;
use crate::ipc::domain_error::DomainError;
use crate::provider::driver::PROVIDERS;
use crate::provider::driver::contract::{DriverError, MockProviderDriver};
use crate::provider::driver::test_registry::{
    bind_run_to_first_provider, registry_of_first_providers,
};
use crate::provider::port::reviewer_denial::{ProviderReviewerDenial, ReviewerDenialPort};
use crate::session::directory::test_rows::insert_session_row;
use crate::session::run::pause::tests::unanswered;
use crate::session::run::projection::insert_queued_run_statement;
use sidekicks_contracts::wire::id::mint_uuid_v7;

/// Bounds a call the test expects to answer, so one that hangs fails the test.
const ANSWER_WAIT: Duration = Duration::from_secs(5);

/// The provider's own record of every test block.
const PROVIDER_RECORD: &str = r#"{"id":"review-1","status":"denied","action":{"command":"curl"}}"#;

/// A session with a queued run of one agent, the blocks' service following its log.
struct Fixture {
    database: TestDatabase,
    _log: TestLog,
    events: Arc<SessionEventAppender>,
    denials: Arc<ReviewerDenials>,
    attachment: Option<FollowerAttachment>,
    session_id: SessionId,
    run_id: RunId,
    // The binding of the run to the first provider.
    binding_id: RuntimeBindingId,
}

impl Fixture {
    /// A fixture whose run is bound to the table's first provider, answered by `first`, beside
    /// the second answered by `second`.
    async fn new(first: MockProviderDriver, second: MockProviderDriver) -> Self {
        let database = TestDatabase::new();
        let log = open_log(&database, None).await;
        let events = Arc::new(SessionEventAppender::new(
            Arc::clone(&log.service),
            SESSION_EVENT_VERSION.clone(),
        ));
        let session_id = test_session_id();
        insert_session_row(&database.reader(), session_id.text().as_str(), None, None);
        let denials = Arc::new(ReviewerDenials::new(
            Arc::new(DatabaseReadPool::new(
                database.path(),
                REVIEWER_DENIALS_STATEMENT_CAPACITY,
            )),
            Arc::clone(&events),
            Arc::new(registry_of_first_providers(vec![
                Arc::new(first),
                Arc::new(second),
            ])),
        ));
        let attachment = Some(denials.start(&log.followers));
        let mut fixture = Self {
            database,
            _log: log,
            events,
            denials,
            attachment,
            session_id,
            run_id: RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id"),
            binding_id: RuntimeBindingId::new("unbound".to_owned()).expect("a binding id"),
        };
        fixture.run_id = fixture.queue_run().await;
        fixture.binding_id = bind_run_to_first_provider(&fixture.database, fixture.run_id);
        fixture
    }

    /// Queues a new run of one agent in the session.
    async fn queue_run(&self) -> RunId {
        let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        let queued = AgentRunQueuedPayload::SessionAgent(RunQueuedSessionAgentPayload {
            session_id: self.session_id,
            run_id,
            run_version: SafeInt::ZERO,
            new_state: AgentRunQueuedNewState::Value,
            agent_id: AgentId::try_from(mint_uuid_v7()).expect("a minted UUID is an agent id"),
            resolved_agent: None,
            parent_run_id: None,
            reached_by: None,
            is_apart: None,
            effective_run_config: None,
            admitted_model_family: None,
            admitted_provider_account_id: None,
        });
        let insert_run = insert_queued_run_statement(&queued);
        self.append(
            SessionEvent::AgentRunQueued(queued),
            SessionEventLinkage {
                transactional_prelude: vec![insert_run],
                ..SessionEventLinkage::default()
            },
        )
        .await;
        run_id
    }

    async fn append(&self, event: SessionEvent, linkage: SessionEventLinkage) {
        self.events
            .append(
                SessionEventDraft::of_session(self.session_id, &event)
                    .expect("the test's event drafts"),
                linkage,
            )
            .await
            .expect("the test's event is appended");
    }

    /// Opens `tool_call_id` in `run_id`, as its `agent.toolCall.invoked` row, and returns the
    /// row's event id.
    async fn open_call(&self, run_id: RunId, tool_call_id: &str) -> String {
        let invoked = serde_json::from_value(json!({
            "type": "agent.toolCall.invoked",
            "payload": {
                "sessionId": self.session_id,
                "runId": run_id,
                "toolName": "Bash",
                "toolCallId": tool_call_id,
            },
        }))
        .expect("the test writes an agent.toolCall.invoked event");
        self.append(invoked, SessionEventLinkage::default()).await;
        self.database
            .reader()
            .query_row(
                "SELECT id FROM session_events WHERE type = 'agent.toolCall.invoked'
                 ORDER BY sequence DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .expect("the test reads the call's row")
    }

    /// Ends `run_id` with its `agent.run.completed`.
    async fn end_run(&self, run_id: RunId) {
        let completed = serde_json::from_value(json!({
            "type": "agent.run.completed",
            "payload": {
                "sessionId": self.session_id,
                "runId": run_id,
                "runVersion": 1,
                "previousState": "running",
                "newState": "completed",
            },
        }))
        .expect("the test writes an agent.run.completed event");
        self.append(completed, SessionEventLinkage::default()).await;
    }

    /// A block on `tool_call_id` of `run_id`.
    fn block(&self, run_id: RunId, tool_call_id: &str) -> ProviderReviewerDenial {
        ProviderReviewerDenial {
            session_id: self.session_id,
            run_id,
            tool_call_id: Some(tool_call_id.to_owned()),
            reason: Some("[Data Exfiltration]".to_owned()),
            is_overridable: true,
            provider_denial: RawValue::from_string(PROVIDER_RECORD.to_owned())
                .expect("the record is JSON"),
        }
    }

    /// Takes `block` in a task of its own, held once its read found no row; answers once it is
    /// held there.
    async fn take_until_waiting(
        &self,
        block: ProviderReviewerDenial,
    ) -> (
        tokio::task::JoinHandle<Result<(), ReviewerDenialError>>,
        tokio::sync::oneshot::Sender<()>,
    ) {
        let pause = self.denials.row_read_pause.arm();
        let denials = Arc::clone(&self.denials);
        let taken = tokio::spawn(async move { denials.take(block).await });
        tokio::time::timeout(ANSWER_WAIT, pause.reached)
            .await
            .expect("the block reads no row and waits")
            .expect("the block reaches its wait");
        (taken, pause.release)
    }

    /// Takes `block` and answers how it went.
    async fn take(&self, block: ProviderReviewerDenial) -> Result<(), ReviewerDenialError> {
        tokio::time::timeout(ANSWER_WAIT, self.denials.take(block))
            .await
            .expect("the block is answered")
    }

    /// The row each recorded block names, in record order.
    fn recorded_rows(&self) -> Vec<String> {
        self.database
            .reader()
            .prepare(
                "SELECT json_extract(payload, '$.eventId') FROM session_events
                 WHERE type = 'approval.reviewer.denied' ORDER BY sequence",
            )
            .expect("the test's read prepares")
            .query_map([], |row| row.get(0))
            .expect("the test reads the blocks")
            .collect::<Result<_, _>>()
            .expect("each block reads")
    }

    /// The one recorded block's id.
    fn denial_id(&self) -> ReviewerDenialId {
        let text: String = self
            .database
            .reader()
            .query_row("SELECT denial_id FROM reviewer_denials", [], |row| {
                row.get(0)
            })
            .expect("the test reads the block's id");
        ReviewerDenialId::new(&text).expect("a stored block id")
    }

    /// Presses `Allow once` on `denial_id`.
    async fn press(&self, denial_id: ReviewerDenialId) -> Result<WireInstant, DenialOverrideError> {
        tokio::time::timeout(
            ANSWER_WAIT,
            self.denials
                .override_denial(&ApprovalDenialOverrideRequest {
                    session_id: self.session_id,
                    denial_id,
                }),
        )
        .await
        .expect("the press is answered")
        .map(|answered| answered.overridden_at)
    }

    /// Records one block on a committed row of the fixture's run and answers its id.
    async fn recorded_block(&self) -> ReviewerDenialId {
        self.open_call(self.run_id, "call-1").await;
        self.take(self.block(self.run_id, "call-1"))
            .await
            .expect("the block is recorded");
        self.denial_id()
    }

    /// The instants the log's overrides of the session record.
    fn overrides(&self) -> Vec<String> {
        self.database
            .reader()
            .prepare(
                "SELECT occurred_at FROM session_events
                 WHERE type = 'approval.denial.overridden' ORDER BY sequence",
            )
            .expect("the test's read prepares")
            .query_map([], |row| row.get(0))
            .expect("the test reads the overrides")
            .collect::<Result<_, _>>()
            .expect("each override reads")
    }
}

/// A driver whose override answers each call with the next of `answers`, counting its calls.
fn driver_answering(
    calls: &Arc<AtomicUsize>,
    answers: impl Fn(usize) -> Result<(), DriverError> + Send + Sync + 'static,
) -> MockProviderDriver {
    let calls = Arc::clone(calls);
    let mut driver = MockProviderDriver::new();
    driver.expect_override_denial().returning(move |_| {
        let answer = answers(calls.fetch_add(1, Ordering::SeqCst));
        async move { answer }.boxed()
    });
    driver
}

/// The code of a refusal; `None` for any other failure.
fn refusal_code(error: DenialOverrideError) -> Option<RefusalCode> {
    if let DenialOverrideError::Refused(refusal) = error {
        Some(refusal.code)
    } else {
        None
    }
}

// Two blocks of one call that arrived before its row wait for it, and its commit records both on
// it, each its own block. Killed by settling one waiter per key, and by a block that does not wait.
#[tokio::test]
async fn blocks_that_came_before_their_row_are_each_recorded_on_it() {
    let fixture = Fixture::new(MockProviderDriver::new(), MockProviderDriver::new()).await;
    let (first, release_first) = fixture
        .take_until_waiting(fixture.block(fixture.run_id, "call-1"))
        .await;
    let (second, release_second) = fixture
        .take_until_waiting(fixture.block(fixture.run_id, "call-1"))
        .await;

    let row = fixture.open_call(fixture.run_id, "call-1").await;
    release_first.send(()).expect("the first block is held");
    release_second.send(()).expect("the second block is held");

    for taken in [first, second] {
        tokio::time::timeout(ANSWER_WAIT, taken)
            .await
            .expect("the block is answered")
            .expect("the block's task ends")
            .expect("the block is recorded");
    }
    assert_eq!(fixture.recorded_rows(), vec![row.clone(), row]);
}

// A row committed while the block's read still runs, after the read found none, wakes the block,
// which is recorded on it. Killed by arming the wait after the read.
#[tokio::test]
async fn a_row_committed_while_the_block_reads_carries_it() {
    let fixture = Fixture::new(MockProviderDriver::new(), MockProviderDriver::new()).await;
    let pause = fixture.denials.row_query_pause.arm();
    let denials = Arc::clone(&fixture.denials);
    let block = fixture.block(fixture.run_id, "call-1");
    let taken = tokio::spawn(async move { denials.take(block).await });
    tokio::time::timeout(ANSWER_WAIT, pause.reached)
        .await
        .expect("the read finds no row")
        .expect("the read is held on the pool's thread");

    let row = fixture.open_call(fixture.run_id, "call-1").await;
    pause.release.send(()).expect("the read is held");

    tokio::time::timeout(ANSWER_WAIT, taken)
        .await
        .expect("the block is answered")
        .expect("the block's task ends")
        .expect("the block is recorded");
    assert_eq!(fixture.recorded_rows(), vec![row]);
}

/// When the block's run ends with no row for it.
#[derive(Clone, Copy, Debug)]
enum RunEnd {
    /// Before the block arrives.
    BeforeTheBlock,
    /// While the block waits.
    WhileItWaits,
}

// A block whose run ends with no row for it is refused and nothing is recorded. Killed by
// dropping the run-end wake, and by a read that waits on an ended run.
#[rstest]
#[case::before_the_block(RunEnd::BeforeTheBlock)]
#[case::while_it_waits(RunEnd::WhileItWaits)]
#[tokio::test]
async fn a_block_whose_run_ends_without_its_row_is_refused(#[case] run_end: RunEnd) {
    let fixture = Fixture::new(MockProviderDriver::new(), MockProviderDriver::new()).await;
    let block = fixture.block(fixture.run_id, "call-1");

    let taken = match run_end {
        RunEnd::BeforeTheBlock => {
            fixture
                .database
                .reader()
                .execute(
                    "UPDATE runs SET state = 'completed' WHERE run_id = ?1",
                    [fixture.run_id.text().as_str()],
                )
                .expect("the test ends the run");
            fixture.take(block).await
        }
        RunEnd::WhileItWaits => {
            let (taken, release) = fixture.take_until_waiting(block).await;
            fixture.end_run(fixture.run_id).await;
            release.send(()).expect("the block is held");
            tokio::time::timeout(ANSWER_WAIT, taken)
                .await
                .expect("the block is answered")
                .expect("the block's task ends")
        }
    };

    assert!(matches!(taken, Err(ReviewerDenialError::NoRow { .. })));
    assert_eq!(fixture.recorded_rows(), Vec::<String>::new());
}

// The daemon's stop refuses a waiting block, and a block taken after it is refused rather than
// left waiting or recorded, whether or not it names a call; nothing is recorded. Killed by a stop
// that drops the waiters unsettled, and by either intake not reading the stop.
#[tokio::test]
async fn the_stop_refuses_every_block_waiting_or_later() {
    let mut fixture = Fixture::new(MockProviderDriver::new(), MockProviderDriver::new()).await;
    let (waiting, release) = fixture
        .take_until_waiting(fixture.block(fixture.run_id, "call-1"))
        .await;

    let attachment = fixture
        .attachment
        .take()
        .expect("the fixture follows the log");
    fixture.denials.stop(attachment);
    release.send(()).expect("the block is held");

    let waited = tokio::time::timeout(ANSWER_WAIT, waiting)
        .await
        .expect("the block is answered")
        .expect("the block's task ends");
    assert!(matches!(waited, Err(ReviewerDenialError::Stopped)));
    let later = fixture.take(fixture.block(fixture.run_id, "call-2")).await;
    assert!(matches!(later, Err(ReviewerDenialError::Stopped)));
    let mut call_less = fixture.block(fixture.run_id, "unused");
    call_less.tool_call_id = None;
    let later_call_less = fixture.take(call_less).await;
    assert!(matches!(later_call_less, Err(ReviewerDenialError::Stopped)));
    assert_eq!(fixture.recorded_rows(), Vec::<String>::new());
}

/// Where an older opening of the blocked call sits.
#[derive(Clone, Copy, Debug)]
enum OlderOpening {
    /// In an earlier run: the block waits for its own run's row.
    InAnEarlierRun,
    /// Earlier in the block's run: the newest opening carries the block.
    InTheSameRun,
}

// A block lands on the newest opening of its call in its own run, never on an older run's row
// with the same call id. Killed by dropping the run filter, and by reading the oldest opening.
#[rstest]
#[case::in_an_earlier_run(OlderOpening::InAnEarlierRun)]
#[case::in_the_same_run(OlderOpening::InTheSameRun)]
#[tokio::test]
async fn a_block_lands_on_the_newest_opening_of_its_call_in_its_run(#[case] older: OlderOpening) {
    let fixture = Fixture::new(MockProviderDriver::new(), MockProviderDriver::new()).await;
    let row = match older {
        OlderOpening::InAnEarlierRun => {
            let block_run = fixture.queue_run().await;
            fixture.open_call(fixture.run_id, "call-1").await;
            let (taken, release) = fixture
                .take_until_waiting(fixture.block(block_run, "call-1"))
                .await;
            let row = fixture.open_call(block_run, "call-1").await;
            release.send(()).expect("the block is held");
            tokio::time::timeout(ANSWER_WAIT, taken)
                .await
                .expect("the block is answered")
                .expect("the block's task ends")
                .expect("the block is recorded");
            row
        }
        OlderOpening::InTheSameRun => {
            fixture.open_call(fixture.run_id, "call-1").await;
            let row = fixture.open_call(fixture.run_id, "call-1").await;
            fixture
                .take(fixture.block(fixture.run_id, "call-1"))
                .await
                .expect("the block is recorded");
            row
        }
    };

    assert_eq!(fixture.recorded_rows(), vec![row]);
}

// Two presses, at once and in turn, hand the block to the provider once, and every answer carries
// the first press's instant. Killed by dropping the earlier override's read, and by dropping the
// press hold.
#[tokio::test]
async fn presses_on_one_block_send_it_once_and_answer_the_first_instant() {
    let calls = Arc::new(AtomicUsize::new(0));
    let fixture = Fixture::new(
        driver_answering(&calls, |_| Ok(())),
        MockProviderDriver::new(),
    )
    .await;
    let denial_id = fixture.recorded_block().await;

    let (first, second) = tokio::join!(fixture.press(denial_id), fixture.press(denial_id));
    let third = fixture.press(denial_id).await;

    let first = first.expect("the press is allowed");
    assert_eq!(second.expect("the press is allowed"), first);
    assert_eq!(third.expect("the press is allowed"), first);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.overrides(), vec![first.as_str().to_owned()]);
}

/// A press refused before the driver is called.
#[derive(Clone, Copy, Debug)]
enum RefusedPress {
    /// The session is unknown.
    UnknownSession,
    /// The session holds no such block.
    UnknownBlock,
    /// The provider lets no person overrule the block.
    NotOverridable,
    /// The session has closed.
    ClosedSession,
}

// A press is refused in order, the driver never called and nothing recorded. Killed by any check
// dropped or moved after the driver's call.
#[rstest]
#[case::unknown_session(RefusedPress::UnknownSession, RefusalCode::SessionNotFound)]
#[case::unknown_block(RefusedPress::UnknownBlock, RefusalCode::ApprovalDenialNotFound)]
#[case::not_overridable(
    RefusedPress::NotOverridable,
    RefusalCode::ApprovalDenialNotOverridable
)]
#[case::closed_session(RefusedPress::ClosedSession, RefusalCode::SessionAlreadyClosed)]
#[tokio::test]
async fn a_refused_press_never_reaches_the_driver(
    #[case] press: RefusedPress,
    #[case] code: RefusalCode,
) {
    let fixture = Fixture::new(MockProviderDriver::new(), MockProviderDriver::new()).await;
    fixture.open_call(fixture.run_id, "call-1").await;
    let mut block = fixture.block(fixture.run_id, "call-1");
    block.is_overridable = !matches!(press, RefusedPress::NotOverridable);
    fixture.take(block).await.expect("the block is recorded");
    let mut session_id = fixture.session_id;
    let mut denial_id = fixture.denial_id();
    match press {
        RefusedPress::UnknownSession => session_id = test_session_id(),
        RefusedPress::UnknownBlock => {
            denial_id = ReviewerDenialId::try_from(mint_uuid_v7()).expect("a block id");
        }
        RefusedPress::NotOverridable => {}
        RefusedPress::ClosedSession => close_session(&fixture),
    }

    let refused = tokio::time::timeout(
        ANSWER_WAIT,
        fixture
            .denials
            .override_denial(&ApprovalDenialOverrideRequest {
                session_id,
                denial_id,
            }),
    )
    .await
    .expect("the press is answered")
    .expect_err("the press is refused");

    assert_eq!(refusal_code(refused), Some(code));
    assert_eq!(fixture.overrides(), Vec::<String>::new());
}

fn close_session(fixture: &Fixture) {
    fixture
        .database
        .reader()
        .execute(
            "UPDATE sessions SET state = 'closed' WHERE id = ?1",
            [fixture.session_id.text().as_str()],
        )
        .expect("the test closes the session");
}

// A block already allowed answers its settled override in a closed session, since the earlier
// override is read before the session's state. Killed by checking the session first.
#[tokio::test]
async fn an_allowed_block_answers_its_override_after_its_session_closes() {
    let calls = Arc::new(AtomicUsize::new(0));
    let fixture = Fixture::new(
        driver_answering(&calls, |_| Ok(())),
        MockProviderDriver::new(),
    )
    .await;
    let denial_id = fixture.recorded_block().await;
    let allowed = fixture
        .press(denial_id)
        .await
        .expect("the press is allowed");

    close_session(&fixture);

    assert_eq!(fixture.press(denial_id).await.expect("it answers"), allowed);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

/// How the driver answers the first press.
#[derive(Clone, Copy, Debug)]
enum FirstAnswer {
    /// It refuses; the next press sends again.
    Refused,
    /// No answer came; the press is held until the process it went to ends.
    Unanswered,
    /// No answer came because the process it went to ended first; the next press sends again.
    UnansweredAfterItsProcessEnded,
}

// A refused press records nothing and the next one sends again; an unanswered one answers its
// refusal again and sends nothing until the process it went to has ended, however the release and
// the answer are ordered, and the press after that sends and is recorded. Killed by recording on a
// refusal, by a held press that sends again, by a hold the process's end does not release, by a
// release that reaches another binding's hold, and by a hold written after an earlier release.
#[rstest]
#[case::refused(FirstAnswer::Refused)]
#[case::unanswered(FirstAnswer::Unanswered)]
#[case::unanswered_after_its_process_ended(FirstAnswer::UnansweredAfterItsProcessEnded)]
#[tokio::test]
async fn a_press_the_driver_did_not_take_records_nothing(#[case] first: FirstAnswer) {
    let calls = Arc::new(AtomicUsize::new(0));
    let service: Arc<OnceLock<(Weak<ReviewerDenials>, RuntimeBindingId)>> = Arc::default();
    let ended_process = Arc::clone(&service);
    let fixture = Fixture::new(
        driver_answering(&calls, move |call| match (call, first) {
            (0, FirstAnswer::Refused) => Err(DriverError::Refused(DomainError::new(
                "the provider refused",
                RefusalCode::ProviderUnavailable,
            ))),
            (0, FirstAnswer::Unanswered) => Err(unanswered()),
            (0, FirstAnswer::UnansweredAfterItsProcessEnded) => {
                // The process's exit is reported before its pending request fails.
                let (denials, binding_id) = ended_process.get().expect("the service is set");
                denials
                    .upgrade()
                    .expect("the service is running")
                    .release_held_presses(binding_id);
                Err(unanswered())
            }
            _ => Ok(()),
        }),
        MockProviderDriver::new(),
    )
    .await;
    service
        .set((Arc::downgrade(&fixture.denials), fixture.binding_id.clone()))
        .expect("the service is set once");
    let denial_id = fixture.recorded_block().await;

    let refused = fixture.press(denial_id).await.expect_err("the press fails");
    match first {
        FirstAnswer::Refused => {
            assert!(matches!(refused, DenialOverrideError::Driver(_)));
        }
        FirstAnswer::Unanswered => {
            assert_eq!(refusal_code(refused), Some(RefusalCode::ProviderTimeout));
            fixture.denials.release_held_presses(
                &RuntimeBindingId::new("another-binding".to_owned()).expect("a binding id"),
            );
            let held = fixture
                .press(denial_id)
                .await
                .expect_err("the press is held");
            assert_eq!(refusal_code(held), Some(RefusalCode::ProviderTimeout));
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            fixture.denials.release_held_presses(&fixture.binding_id);
        }
        FirstAnswer::UnansweredAfterItsProcessEnded => {
            assert_eq!(refusal_code(refused), Some(RefusalCode::ProviderTimeout));
        }
    }
    assert_eq!(fixture.overrides(), Vec::<String>::new());

    let allowed = fixture
        .press(denial_id)
        .await
        .expect("the press is allowed");

    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(fixture.overrides(), vec![allowed.as_str().to_owned()]);
}

// A press the provider took whose record failed is recorded by the next press at the first press's
// instant, and the provider is not told again, even once its process has ended. Killed by a failed
// record that holds nothing, by a process's end that drops it, and by an instant taken at the
// second press.
#[tokio::test]
async fn a_taken_press_whose_record_failed_is_recorded_by_the_next() {
    let calls = Arc::new(AtomicUsize::new(0));
    let fixture = Fixture::new(
        driver_answering(&calls, |_| Ok(())),
        MockProviderDriver::new(),
    )
    .await;
    let denial_id = fixture.recorded_block().await;
    let refuse_overrides = "CREATE TRIGGER refuse_override BEFORE INSERT ON session_events
       WHEN NEW.type = 'approval.denial.overridden'
       BEGIN SELECT RAISE(ABORT, 'the test refuses the override'); END";
    fixture
        .database
        .reader()
        .execute(refuse_overrides, [])
        .expect("the test refuses overrides");

    let before = WireInstant::now();
    fixture
        .press(denial_id)
        .await
        .expect_err("the record fails");
    let after = WireInstant::now();
    fixture
        .database
        .reader()
        .execute("DROP TRIGGER refuse_override", [])
        .expect("the test lets overrides through");
    tokio::time::sleep(Duration::from_millis(5)).await;
    fixture.denials.release_held_presses(&fixture.binding_id);

    let allowed = fixture
        .press(denial_id)
        .await
        .expect("the press is allowed");

    assert!(before.as_str() <= allowed.as_str() && allowed.as_str() <= after.as_str());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.overrides(), vec![allowed.as_str().to_owned()]);
}

// The press reaches the driver of the provider the blocked run runs on, not the first provider,
// with that run and the provider's whole record as it was taken. Killed by resolving any other
// provider, and by handing back anything but the stored record.
#[tokio::test]
async fn a_press_reaches_the_blocked_runs_own_provider_with_the_whole_record() {
    let handed: Arc<Mutex<Vec<(RunId, String)>>> = Arc::new(Mutex::new(Vec::new()));
    let mut second = MockProviderDriver::new();
    let seen = Arc::clone(&handed);
    second
        .expect_override_denial()
        .times(1)
        .returning(move |params| {
            seen.lock()
                .expect("the test's list locks")
                .push((params.run_id, params.provider_denial.get().to_owned()));
            async { Ok(()) }.boxed()
        });
    let fixture = Fixture::new(MockProviderDriver::new(), second).await;
    let helper_run = fixture.queue_run().await;
    fixture
        .database
        .reader()
        .execute(
            "INSERT INTO runtime_bindings (id, run_id, provider_name, contract_version,
               cli_version_raw, created_at, updated_at)
             VALUES ('helper-binding', ?1, ?2, '1.0.0', '1.0.0', '', '')",
            params![helper_run.text().as_str(), PROVIDERS[1].id],
        )
        .expect("the test binds the helper's run to the second provider");
    fixture.open_call(helper_run, "call-1").await;
    fixture
        .take(fixture.block(helper_run, "call-1"))
        .await
        .expect("the block is recorded");

    fixture
        .press(fixture.denial_id())
        .await
        .expect("the press is allowed");

    assert_eq!(
        *handed.lock().expect("the test's list locks"),
        vec![(helper_run, PROVIDER_RECORD.to_owned())]
    );
}

// A block that names no call is recorded as it arrives, with no row of a call, even on a run that
// has ended, and `Allow once` answers it as it does a call's block. Killed by a call-less block
// that waits for a row or is refused at its run's end.
#[tokio::test]
async fn a_block_that_names_no_call_is_recorded_at_once_and_allowed_once() {
    let calls = Arc::new(AtomicUsize::new(0));
    let fixture = Fixture::new(
        driver_answering(&calls, |_| Ok(())),
        MockProviderDriver::new(),
    )
    .await;
    fixture
        .database
        .reader()
        .execute(
            "UPDATE runs SET state = 'completed' WHERE run_id = ?1",
            [fixture.run_id.text().as_str()],
        )
        .expect("the test ends the run");
    let mut block = fixture.block(fixture.run_id, "unused");
    block.tool_call_id = None;

    fixture.take(block).await.expect("the block is recorded");
    let event_id: Option<String> = fixture
        .database
        .reader()
        .query_row(
            "SELECT json_extract(payload, '$.eventId') FROM session_events
             WHERE type = 'approval.reviewer.denied'",
            [],
            |row| row.get(0),
        )
        .expect("the test reads the block");
    let allowed = fixture
        .press(fixture.denial_id())
        .await
        .expect("the press is allowed");

    assert_eq!(event_id, None);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.overrides(), vec![allowed.as_str().to_owned()]);
}
