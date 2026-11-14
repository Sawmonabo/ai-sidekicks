//! The recorder's tests: each send guard refuses by its own index, and each writer raises its
//! queue once, moving the order only where no item event records the change, while another append
//! on the session raises nothing. A read behind the order mark pages through more waiting items
//! than one frame holds, and a read over a damaged log reads only the rows the log can read.

use std::sync::Arc;

use rstest::rstest;
use rusqlite::params;
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::jsonrpc::streaming::STREAM_FRAME_MAX_CHANGES;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::{
    MessageText, QueueItemId, QueueItemNotDeliveredReason, QueueItemSummary, QueueMessageSummary,
    UserMessageSentPayload,
};
use sidekicks_contracts::run::queued::AgentRunQueuedPayload;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::event_cursor::START_OF_LOG_POSITION;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_provider::runtime_binding::test_store::test_provider_account_id;
use sidekicks_session::questions::schema::schema_parts;
use sidekicks_session::queue_store::test_items::{test_queue_item, words};
use sidekicks_session::queue_store::{
    NewQueueItem, QueueItemBody, QueueItemOutcome, QueueItemRecord,
};
use sidekicks_session::run::engine::test_fixture::insert_run;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
use sidekicks_store::events::log_service::test_fixture::open_log;
use sidekicks_store::events::session::appender::{
    SessionEventAppender, SessionEventDraft, SessionEventLinkage,
};
use sidekicks_store::events::session::read::SessionEventReads;
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;

use super::{
    QueueRecorder, QueueRecorderDeps, RecordSendError, RecordedSend, RetargetRun, SendRefusal,
    SendRoute, lead_run_queued,
};
use crate::changes::{
    QueueChange, QueueChangeCursor, QueueChangeSignals, QueueKey, read_current_queue_cursor,
    read_queue_changes_after,
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
    insert_run(&database, session_id, run_id, "running");
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
    let mut item = test_queue_item(
        fixture.session_id,
        fixture.run_id,
        QueueItemBody::Message(words("Look again")),
    );
    item.device_id = Some(device_id());
    item
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
    lead_run_queued(
        fixture.session_id,
        RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id"),
        AgentId::try_from(mint_uuid_v7()).expect("a minted UUID is an agent id"),
        test_provider_account_id(),
        None,
    )
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
        QueueItemSummary::Review(_) | QueueItemSummary::PlanMessage(_) => {
            panic!("the recorder's tests queue only the person's messages")
        }
    }
}

/// The session's newest sequence, or the start of the log while it holds none.
fn session_head(fixture: &Fixture) -> i64 {
    SessionEventReads::new(&fixture.database.reader(), |_: &SessionId| None)
        .read_head(&fixture.session_id)
        .expect("the test reads the session's head")
        .unwrap_or(START_OF_LOG_POSITION)
}

/// Writes a row of `event_type` at `sequence` on the fixture's session, raw, with `payload` as
/// stored text, so a case can store one the typed append refuses.
fn write_raw_row(fixture: &Fixture, sequence: i64, event_type: SessionEventType, payload: &str) {
    fixture
        .database
        .reader()
        .execute(
            "INSERT INTO session_events
               (id, session_id, sequence, occurred_at, monotonic_ns, category, type, payload)
             VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?7)",
            params![
                mint_uuid_v7().to_string(),
                fixture.session_id.text().as_str(),
                sequence,
                WireInstant::now().as_str(),
                event_type.category().as_str(),
                event_type.as_str(),
                payload,
            ],
        )
        .expect("the test writes its raw row");
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
                message: MessageText::new("Look again".to_owned()).expect("a test message"),
                origin: None,
                answers_question_id: None,
                plan_message: None,
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

// Behind the order mark, a read pages through the waiting messages a frame at a time, each page
// resuming after the last message it sent. Admitting the first message between the first and
// second pages sends its own change and moves no later message out of the next page. Killed by
// the resume cursor dropping its page place, which sends no further waiting message or starts
// again from the first, and by an offset in the keyset's stead, which the admission moves past
// the last message.
#[tokio::test]
async fn a_read_behind_the_order_mark_pages_every_waiting_message_once_in_order() {
    let fixture = fixture().await;
    let mut sent = Vec::new();
    for _ in 0..=STREAM_FRAME_MAX_CHANGES {
        sent.push(record(&fixture, new_item(&fixture)).await);
    }
    let queue = lead_queue(&fixture);
    let reader = fixture.database.reader();
    let read_after = |cursor: &QueueChangeCursor| -> Vec<QueueChange> {
        read_queue_changes_after(
            &reader,
            |_| None,
            &fixture.signals,
            &queue,
            cursor,
            STREAM_FRAME_MAX_CHANGES,
        )
        .expect("the test reads the queue's changes")
    };

    let mut pages = vec![read_after(&QueueChangeCursor::after(session_head(
        &fixture,
    )))];
    fixture
        .recorder
        .record_outcome(
            &sent[0],
            QueueItemOutcome::Admitted {
                run_id: fixture.run_id,
            },
            &WireInstant::now(),
        )
        .await
        .expect("the test admits the first message");
    while let Some(resume_cursor) = pages
        .last()
        .and_then(|page| page.last())
        .map(|change| change.resume_cursor.clone())
    {
        pages.push(read_after(&resume_cursor));
    }

    let page_ids: Vec<Vec<QueueItemId>> = pages
        .iter()
        .map(|page| {
            page.iter()
                .map(|change| summary_id(&change.stream_change.item))
                .collect()
        })
        .collect();
    let ids: Vec<QueueItemId> = sent.iter().map(|item| item.id).collect();
    assert_eq!(
        page_ids,
        [
            ids[..STREAM_FRAME_MAX_CHANGES].to_vec(),
            vec![ids[0], ids[STREAM_FRAME_MAX_CHANGES]],
            Vec::new(),
        ]
    );
    assert!(matches!(
        pages[1][0].stream_change.item,
        QueueItemSummary::Message(QueueMessageSummary::Admitted { .. })
    ));
}

// After the cursor sit one good change, a queue item row whose payload is not JSON in a range a
// later skip names, and another such row at the damaged session's last good point. A read behind
// every order mark, which runs both the change read and the waiting read, answers the good change
// alone. Killed by the readable-row guard dropped from the changed items, or either of its two
// conditions dropped: the payload's read then fails on a damaged row.
#[tokio::test]
async fn a_read_over_a_damaged_log_reads_only_its_readable_changes() {
    let fixture = fixture().await;
    let cursor = QueueChangeCursor::after(session_head(&fixture));
    let good = record(&fixture, new_item(&fixture)).await;
    let skipped = session_head(&fixture) + 1;
    write_raw_row(
        &fixture,
        skipped,
        SessionEventType::AgentQueueItemCreated,
        "{not json",
    );
    write_raw_row(
        &fixture,
        skipped + 1,
        SessionEventType::SessionDamagedEventsSkipped,
        &serde_json::json!({
            "sessionId": fixture.session_id,
            "fromSequence": skipped,
            "toSequence": skipped,
        })
        .to_string(),
    );
    let damaged_from = skipped + 2;
    write_raw_row(
        &fixture,
        damaged_from,
        SessionEventType::AgentQueueItemCreated,
        "{not json",
    );

    let read: Vec<QueueItemId> = read_queue_changes_after(
        &fixture.database.reader(),
        |_| Some(damaged_from),
        &fixture.signals,
        &lead_queue(&fixture),
        &cursor,
        CHANGES_READ_MAX,
    )
    .expect("the read leaves the damaged rows out")
    .iter()
    .map(|change| summary_id(&change.stream_change.item))
    .collect();
    assert_eq!(read, [good.id]);
}
