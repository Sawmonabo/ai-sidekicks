//! The recorder's tests: each send guard refuses by its own index, and each writer raises its
//! queue once, moving the order only where no item event records the change, while another append
//! on the session raises nothing.

use std::sync::Arc;

use rstest::rstest;
use rusqlite::params;
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::{
    QueueItemId, QueueItemNotDeliveredReason, QueueItemSummary, QueueMessageSummary,
    UserMessageSentPayload,
};
use sidekicks_contracts::run::queued::{
    AgentRunQueuedNewState, AgentRunQueuedPayload, RunQueuedSessionAgentPayload,
};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_session::questions::schema::schema_parts;
use sidekicks_session::queue_store::{
    NewQueueItem, QueueItemBody, QueueItemOutcome, QueueItemRecord, QueueMessageBody,
};
use sidekicks_session::run::engine::test_fixture::insert_running_run;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
use sidekicks_store::events::log_service::test_fixture::open_log;
use sidekicks_store::events::session::appender::{
    SessionEventAppender, SessionEventDraft, SessionEventLinkage,
};
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;

use super::{
    QueueRecorder, QueueRecorderDeps, RecordSendError, RecordedSend, RetargetRun, SendRefusal,
    SendRoute,
};
use crate::changes::{
    QueueChangeSignals, QueueKey, read_current_queue_cursor, read_queue_changes_after,
};

/// The statements the recorder's read pool prepares: the read back of a send's item.
const READ_STATEMENT_CAPACITY: usize = 1;

/// More changes than any test's queue holds.
const CHANGES_READ_MAX: usize = 16;

/// A session taking messages, its lead run running, and a recorder over its database beside an
/// appender of the session's other events.
struct Fixture {
    database: TestDatabase,
    recorder: QueueRecorder,
    appender: SessionEventAppender,
    signals: Arc<QueueChangeSignals>,
    session_id: SessionId,
    run_id: RunId,
}

async fn fixture() -> Fixture {
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await;
    let session_id = test_session_id();
    insert_session_row(&database.reader(), session_id.text().as_str(), None, None);
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    insert_running_run(&database, session_id, run_id);
    let signals = Arc::new(QueueChangeSignals::new());
    let appender =
        SessionEventAppender::new(Arc::clone(&log.service), SESSION_EVENT_VERSION.clone());
    let recorder = QueueRecorder::new(QueueRecorderDeps {
        event_log: log.service,
        writer: log.writer,
        pool: Arc::new(DatabaseReadPool::new(
            database.path(),
            READ_STATEMENT_CAPACITY,
        )),
        signals: Arc::clone(&signals),
    });
    Fixture {
        database,
        recorder,
        appender,
        signals,
        session_id,
        run_id,
    }
}

fn device_id() -> DeviceId {
    DeviceId::new("test-device".to_owned()).expect("a test device id")
}

/// A message to the fixture's lead run under a fresh key.
fn new_item(fixture: &Fixture) -> NewQueueItem {
    NewQueueItem {
        id: QueueItemId::try_from(mint_uuid_v7()).expect("a minted UUID is a queue item id"),
        session_id: fixture.session_id,
        body: QueueItemBody::Message(QueueMessageBody {
            content: FreeFormText::new("Look again".to_owned()).expect("a test message"),
            attachments: None,
            skills: None,
            answers_question_id: None,
            output_speed_for_turn: None,
            workspace_id: None,
        }),
        target_run_id: fixture.run_id,
        device_id: Some(device_id()),
        client_idempotency_key: Some(
            ClientUuid::new(mint_uuid_v7().to_string()).expect("a minted UUID is a client key"),
        ),
        replaces_queue_item_id: None,
        now: WireInstant::now(),
    }
}

/// Sends `item` into the fixture's live run, retrying `retries` when it is given.
fn live_send(item: NewQueueItem, retries: Option<QueueItemRecord>) -> RecordedSend {
    RecordedSend {
        item,
        route: SendRoute::LiveRun,
        retries,
    }
}

async fn record(fixture: &Fixture, item: NewQueueItem) -> QueueItemRecord {
    fixture
        .recorder
        .record_send(live_send(item, None))
        .await
        .expect("the test's send is recorded")
}

fn lead_queue(fixture: &Fixture) -> QueueKey {
    QueueKey {
        session_id: fixture.session_id,
        child_handle: None,
    }
}

fn end_run(fixture: &Fixture) {
    fixture
        .database
        .reader()
        .execute(
            "UPDATE runs SET state = ?2 WHERE run_id = ?1",
            params![
                fixture.run_id.text().as_str(),
                <&'static str>::from(RunState::Completed)
            ],
        )
        .expect("the test ends the run");
}

/// The queue rows and the session events stored.
fn stored_counts(database: &TestDatabase) -> (i64, i64) {
    database
        .reader()
        .query_row(
            "SELECT (SELECT COUNT(*) FROM queue_items), (SELECT COUNT(*) FROM session_events)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("the test counts the stored rows")
}

/// A lead run queued for the fixture's session.
fn next_run(fixture: &Fixture) -> AgentRunQueuedPayload {
    AgentRunQueuedPayload::SessionAgent(RunQueuedSessionAgentPayload {
        session_id: fixture.session_id,
        run_id: RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id"),
        run_version: SafeInt::ZERO,
        new_state: AgentRunQueuedNewState::Value,
        agent_id: AgentId::try_from(mint_uuid_v7()).expect("a minted UUID is an agent id"),
        resolved_agent: None,
        parent_run_id: None,
        reached_by: None,
        effective_run_config: None,
        admitted_model_family: None,
        admitted_provider_account_id: None,
    })
}

fn summary_id(summary: &QueueItemSummary) -> QueueItemId {
    match summary {
        QueueItemSummary::Message(
            QueueMessageSummary::Queued { id, .. }
            | QueueMessageSummary::Admitted { id, .. }
            | QueueMessageSummary::Superseded { id, .. }
            | QueueMessageSummary::Canceled { id, .. }
            | QueueMessageSummary::NotDelivered { id, .. },
        ) => *id,
        QueueItemSummary::Review(_) => panic!("the recorder's tests queue no review"),
    }
}

/// The guard a case leaves stale before its send.
#[derive(Clone, Copy, Debug)]
enum StaleGuard {
    KeySpent,
    SessionClosed,
    RunEnded,
    RetriedMessageWaiting,
}

// Each send is refused by the one guard its case leaves stale, which it names, and leaves no
// row, no event and no change signal. Killed by swapping any two guard indexes, or by raising
// the queue's change before the write commits.
#[rstest]
#[case::a_spent_key(StaleGuard::KeySpent, SendRefusal::KeySpent)]
#[case::a_closed_session(StaleGuard::SessionClosed, SendRefusal::SessionClosed)]
#[case::a_run_that_ended(StaleGuard::RunEnded, SendRefusal::RouteChanged)]
#[case::a_retry_of_a_waiting_message(StaleGuard::RetriedMessageWaiting, SendRefusal::RetryChanged)]
#[tokio::test]
async fn a_send_past_a_stale_guard_is_refused_by_that_guard_and_writes_nothing(
    #[case] stale: StaleGuard,
    #[case] expected: SendRefusal,
) {
    let fixture = fixture().await;
    let mut item = new_item(&fixture);
    let mut retries = None;
    match stale {
        StaleGuard::KeySpent => {
            let first = new_item(&fixture);
            item.client_idempotency_key = first.client_idempotency_key.clone();
            record(&fixture, first).await;
        }
        StaleGuard::SessionClosed => {
            fixture
                .database
                .reader()
                .execute(
                    "UPDATE sessions SET state = ?2 WHERE id = ?1",
                    params![
                        fixture.session_id.text().as_str(),
                        <&'static str>::from(SessionState::Closed)
                    ],
                )
                .expect("the test closes the session");
        }
        StaleGuard::RunEnded => end_run(&fixture),
        // The message reads queued, not not delivered, so no retry may supersede it.
        StaleGuard::RetriedMessageWaiting => {
            retries = Some(record(&fixture, new_item(&fixture)).await);
        }
    }
    let stored_before = stored_counts(&fixture.database);
    let mut count = fixture.signals.change_count(&lead_queue(&fixture));
    let count_before = *count.borrow_and_update();

    let error = fixture
        .recorder
        .record_send(live_send(item, retries))
        .await
        .expect_err("the stale guard refuses the send");

    assert!(
        matches!(error, RecordSendError::Refused(refusal) if refusal == expected),
        "{error:?}"
    );
    assert_eq!(stored_counts(&fixture.database), stored_before);
    assert_eq!(*count.borrow(), count_before);
}

/// The write a case makes to a queue of two waiting messages.
#[derive(Clone, Copy, Debug)]
enum QueueWrite {
    Send,
    Order,
    Retarget,
    NextRun,
    Outcome,
    LateAdmission,
    RefusedOrder,
    UserMessage,
}

// Each write raises its queue's change exactly once after it commits. A reader at the cursor
// taken before it reads the waiting messages again, in their order, only after a write no item
// event records, and after a send or an outcome only that item's own change; a refused write
// raises nothing, and nor does a `user.message.sent` appended on the same session outside the
// queue. The expected messages are indexes into the two waiting and, third, the one a send adds.
// Killed by flipping any writer's `moves_order`, raising twice, raising a refused write, raising
// on any append to the session, or reading any event that names an item as its change.
#[rstest]
#[case::a_send(QueueWrite::Send, &[2])]
#[case::a_reorder(QueueWrite::Order, &[1, 0])]
#[case::a_retarget(QueueWrite::Retarget, &[0, 1])]
#[case::a_next_run(QueueWrite::NextRun, &[0, 1])]
#[case::an_outcome(QueueWrite::Outcome, &[0])]
#[case::a_late_admission(QueueWrite::LateAdmission, &[0])]
#[case::a_refused_reorder(QueueWrite::RefusedOrder, &[])]
#[case::a_user_message(QueueWrite::UserMessage, &[])]
#[tokio::test]
async fn each_write_raises_its_queue_once_and_moves_the_order_only_when_no_event_records_it(
    #[case] write: QueueWrite,
    #[case] expected: &[usize],
) {
    let fixture = fixture().await;
    let sent = [
        record(&fixture, new_item(&fixture)).await,
        record(&fixture, new_item(&fixture)).await,
    ];
    let now = WireInstant::now();
    match write {
        QueueWrite::NextRun => end_run(&fixture),
        QueueWrite::RefusedOrder => fixture
            .recorder
            .record_outcome(&sent[0], QueueItemOutcome::Canceled, &now)
            .await
            .expect("the test removes the first message"),
        QueueWrite::LateAdmission => {
            let not_delivered = QueueItemOutcome::NotDelivered {
                reason: QueueItemNotDeliveredReason::Failed {},
            };
            fixture
                .recorder
                .record_outcome(&sent[0], not_delivered, &now)
                .await
                .expect("the test marks the first message not delivered");
        }
        QueueWrite::Send
        | QueueWrite::Order
        | QueueWrite::Retarget
        | QueueWrite::Outcome
        | QueueWrite::UserMessage => {}
    }
    let queue = lead_queue(&fixture);
    let mut count = fixture.signals.change_count(&queue);
    let count_before = *count.borrow_and_update();
    let reader = fixture.database.reader();
    let cursor = read_current_queue_cursor(&reader, |_| None, &fixture.signals, &queue)
        .expect("the test reads the queue's cursor");

    let reordered = [sent[1].clone(), sent[0].clone()];
    let mut ids: Vec<QueueItemId> = sent.iter().map(|item| item.id).collect();
    let result = match write {
        QueueWrite::Send => {
            let item = record(&fixture, new_item(&fixture)).await;
            ids.push(item.id);
            Ok(())
        }
        QueueWrite::Order | QueueWrite::RefusedOrder => {
            fixture.recorder.record_order(&reordered, &now).await
        }
        QueueWrite::Retarget => {
            fixture
                .recorder
                .record_retarget(RetargetRun::Live(fixture.run_id), &sent, &now)
                .await
        }
        QueueWrite::NextRun => {
            fixture
                .recorder
                .record_next_run(next_run(&fixture), &sent, &now)
                .await
        }
        QueueWrite::Outcome => {
            fixture
                .recorder
                .record_outcome(&sent[0], QueueItemOutcome::Canceled, &now)
                .await
        }
        QueueWrite::LateAdmission => {
            fixture
                .recorder
                .record_late_admission(&sent[0], fixture.run_id, &now)
                .await
        }
        QueueWrite::UserMessage => {
            // It names a waiting message, as a send's own row does.
            let message = UserMessageSentPayload {
                session_id: fixture.session_id,
                queue_item_id: Some(sent[0].id),
                run_id: Some(fixture.run_id),
                actor: FreeFormText::new("test-device".to_owned()).expect("a test actor"),
                device_id: Some(device_id()),
                message: FreeFormText::new("Look again".to_owned()).expect("a test message"),
                origin: None,
                answers_question_id: None,
            };
            let draft = SessionEventDraft::new(message, SessionEvent::UserMessageSent)
                .expect("the test's message drafts");
            fixture
                .appender
                .append(draft, SessionEventLinkage::default())
                .await
                .expect("the test appends its message");
            Ok(())
        }
    };

    let is_refused = matches!(write, QueueWrite::RefusedOrder);
    match result {
        Ok(()) => assert!(!is_refused, "the removed message's place was written"),
        Err(error) => assert!(is_refused && error.is_refused(), "{error:?}"),
    }
    let raises = !matches!(write, QueueWrite::RefusedOrder | QueueWrite::UserMessage);
    assert_eq!(*count.borrow(), count_before + u64::from(raises));
    let read: Vec<QueueItemId> = read_queue_changes_after(
        &reader,
        |_| None,
        &fixture.signals,
        &queue,
        &cursor,
        CHANGES_READ_MAX,
    )
    .expect("the test reads the queue's changes")
    .iter()
    .map(|change| summary_id(&change.stream_change.item))
    .collect();
    let expected: Vec<QueueItemId> = expected.iter().map(|index| ids[*index]).collect();
    assert_eq!(read, expected);
}
