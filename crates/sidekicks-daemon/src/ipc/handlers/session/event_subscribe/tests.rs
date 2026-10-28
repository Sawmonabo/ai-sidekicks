use std::time::Duration;

use serde_json::json;
use sidekicks_contracts::method::Method as _;
use sidekicks_ipc::call_fixtures::{context, request};
use sidekicks_ipc::registry::{Dispatch as _, EncodedFeed, Reply};
use sidekicks_ipc::stream::feed::CreditGate;
use sidekicks_provider::driver::contract::MockProviderDriver;
use sidekicks_provider::driver::task_list::TaskListChange;
use sidekicks_provider::driver::test_registry::{new_run_id, registry_of_first_provider};
use sidekicks_session::run::engine::test_fixture::insert_running_run;
use sidekicks_session::transcript::test_log::{
    STALLING_TEXT, stalling_parse, wire_block_starts, wire_message,
};
use sidekicks_session::transcript::window::read_transcript_window;
use sidekicks_store::database::writer::test_file::{
    TestDatabase, insert_lead, test_envelope, test_session_id,
};
use sidekicks_store::events::log_service::EventLogAppendOptions;
use sidekicks_store::events::log_service::test_fixture::open_log;

use super::*;
use crate::daemon::schema::schema_parts;

/// Long enough for a frame that is coming to come, many windows over.
const QUIET: Duration = Duration::from_millis(250);

/// A table of providers no session in these tests runs on.
fn no_drivers() -> Arc<ProviderRegistry> {
    Arc::new(registry_of_first_provider(Arc::new(
        MockProviderDriver::new(),
    )))
}

async fn pin(log: &EventLogService, session_id: SessionId) {
    let pinned = serde_json::from_value(json!({
        "type": "session.pinned",
        "payload": { "sessionId": session_id, "at": "2026-10-14T09:00:00.000Z" },
    }))
    .expect("the test writes a session.pinned event");
    log.append(
        test_envelope(session_id, &pinned),
        EventLogAppendOptions::default(),
    )
    .await
    .expect("the append commits");
}

/// The sequences of the next frame's events.
async fn next_sequences(feed: &mut Box<dyn EncodedFeed>, gate: &CreditGate) -> Vec<u64> {
    let value = feed
        .next(gate)
        .await
        .expect("the log reads")
        .expect("the stream goes on");
    let frame: SessionStreamFrame =
        serde_json::from_slice(&value.json).expect("the frame reads as its type");
    frame
        .changes
        .into_vec()
        .into_iter()
        .map(|change| change.event.sequence.get())
        .collect()
}

#[tokio::test]
async fn the_catch_up_reads_past_its_first_page_only_once_the_lane_has_credit_then_follows() {
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await.service;
    let session_id = test_session_id();
    for _ in 0..60 {
        pin(&log, session_id).await;
    }
    let mut builder = MethodRegistryBuilder::new();
    register_session_event_subscribe(&mut builder, Arc::clone(&log), no_drivers())
        .expect("the method registers");
    let reply = builder
        .freeze()
        .dispatch(
            request(
                SessionEventSubscribe::DESCRIPTOR.method,
                Some(&json!({ "sessionId": session_id })),
            ),
            context(1),
        )
        .await;
    let Ok(Reply::Subscription { mut feed, .. }) = reply else {
        panic!("a held session's subscribe answers a subscription");
    };

    let gate = CreditGate::spending(0);
    assert!(
        tokio::time::timeout(QUIET, feed.next(&gate)).await.is_err(),
        "nothing goes out while the lane has no credit"
    );
    gate.credit.add_permits(1);
    assert_eq!(
        next_sequences(&mut feed, &gate).await,
        (0..50).collect::<Vec<u64>>()
    );
    // An event stored while the lane has no credit is in the next page, read once credit comes.
    assert!(
        tokio::time::timeout(QUIET, feed.next(&gate)).await.is_err(),
        "nothing goes out while the lane has no credit"
    );
    pin(&log, session_id).await;
    gate.credit.add_permits(1);
    assert_eq!(
        next_sequences(&mut feed, &gate).await,
        (50..61).collect::<Vec<u64>>()
    );
    // Caught up: the stream is quiet until the log takes a new event, which it then follows.
    let gate = CreditGate::with_credit(1);
    assert!(
        tokio::time::timeout(QUIET, feed.next(&gate)).await.is_err(),
        "the caught-up stream waits for the log"
    );
    let (followed, ()) = tokio::join!(next_sequences(&mut feed, &gate), pin(&log, session_id));
    assert_eq!(followed, [61]);
}

/// Appends a piece of block `block` of `run_id`'s reply `message_id` holding `body`; returns
/// its id.
async fn reply_piece(
    log: &EventLogService,
    session_id: SessionId,
    run_id: &str,
    (message_id, block): (&str, u64),
    body: &str,
) -> String {
    let piece = serde_json::from_value(json!({
        "type": "agent.message.sent",
        "payload": {
            "sessionId": session_id,
            "runId": run_id,
            "providerMessageId": message_id,
            "providerBlock": { "index": block, "attempt": 1 },
        },
    }))
    .expect("the test writes a reply piece");
    let receipt = log
        .append(
            test_envelope(session_id, &piece),
            EventLogAppendOptions {
                content_body: Some(body.to_owned()),
                ..EventLogAppendOptions::default()
            },
        )
        .await
        .expect("the append commits");
    receipt.id.as_str().to_owned()
}

/// Each change's piece, as its row's id, its offset and its inline text.
fn pieces_of(
    page: &RecordPage<EventCursor, SessionStreamChange>,
) -> Vec<(String, u64, serde_json::Value)> {
    page.changes
        .iter()
        .map(|change| {
            let piece = change.piece.as_ref().expect("each change is a piece");
            (
                piece.row_id.as_str().to_owned(),
                piece.offset.get(),
                serde_json::to_value(&piece.content).expect("a body serializes")["body"].clone(),
            )
        })
        .collect()
}

// Killed by a piece placed relative to itself rather than its row, by a frame over the page
// budget or one cut without saying so, by a frame's fold advanced past a cut, and by a stream
// opened inside a row placing its pieces from zero.
#[tokio::test]
async fn event_subscribe_places_pieces_in_their_row_across_cut_frames_and_from_inside() {
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await.service;
    let session_id = test_session_id();
    let run_id = sidekicks_contracts::wire::id::mint_uuid_v7().to_string();
    let body = "x".repeat(30_000);
    let piece_count = 40;
    let row_id = reply_piece(&log, session_id, &run_id, ("m1", 0), &body).await;
    for _ in 1..piece_count {
        reply_piece(&log, session_id, &run_id, ("m1", 0), &body).await;
    }
    let start = log
        .read_follow_start(session_id, FollowStart::StartOfLog)
        .await
        .expect("the session's start reads");
    let placed = |index: usize| {
        let offset = u64::try_from(index * body.len()).expect("a test offset fits");
        (row_id.clone(), offset, json!(body))
    };

    let record =
        SessionEventRecord::new(Arc::clone(&log), no_drivers(), session_id, MARKDOWN_PARSE);
    let first = record
        .read_after(&start, 64)
        .await
        .expect("the frame reads");
    let kept = first.changes.len();
    assert!(first.is_cut_short);
    assert!(kept > 0 && kept < piece_count);
    assert_eq!(pieces_of(&first), (0..kept).map(placed).collect::<Vec<_>>());
    let last_cursor = first.changes[kept - 1].cursor.clone();
    let next = record
        .read_after(&last_cursor, 64)
        .await
        .expect("the frame reads");
    assert_eq!(pieces_of(&next)[0], placed(kept));

    let opened_inside =
        SessionEventRecord::new(Arc::clone(&log), no_drivers(), session_id, MARKDOWN_PARSE);
    let inside = opened_inside
        .read_after(&first.changes[2].cursor, 1)
        .await
        .expect("the frame reads");
    assert_eq!(pieces_of(&inside), [placed(3)]);
}

// Killed by a completion's joined parts streamed as pieces of its row, and by its stored parts
// sent as events of their own.
#[tokio::test]
async fn event_subscribe_sends_a_patch_bearing_completion_once_whole_and_no_part_of_it() {
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await.service;
    let session_id = test_session_id();
    let run_id = sidekicks_contracts::wire::id::mint_uuid_v7().to_string();
    let files = [
        json!({
            "path": "/repo/a.rs",
            "patch": "@@ -1 +1 @@\n-a\n+b\n",
            "additions": 1,
            "deletions": 1,
        }),
        json!({ "path": "/repo/b.rs", "unavailable": "absent" }),
    ];
    let completion = serde_json::from_value(json!({
        "type": "agent.toolCall.completed",
        "payload": {
            "sessionId": session_id,
            "runId": run_id,
            "toolName": "edit",
            "toolCallId": "call-1",
            "omittedPatches": [
                { "path": "/repo/a.rs", "size": 20 },
                { "path": "/repo/b.rs", "size": 0 },
            ],
        },
    }))
    .expect("the test writes a tool completion");
    log.append(
        test_envelope(session_id, &completion),
        EventLogAppendOptions {
            content_body: Some(json!({ "files": files }).to_string()),
            ..EventLogAppendOptions::default()
        },
    )
    .await
    .expect("the append commits");
    let start = log
        .read_follow_start(session_id, FollowStart::StartOfLog)
        .await
        .expect("the session's start reads");

    let record =
        SessionEventRecord::new(Arc::clone(&log), no_drivers(), session_id, MARKDOWN_PARSE);
    let page = record
        .read_after(&start, 64)
        .await
        .expect("the frame reads");
    let [change] = page.changes.as_slice() else {
        panic!("the completion goes out as one change: {:?}", page.changes);
    };
    assert_eq!(change.event.sequence.get(), 0);
    assert!(change.run_stamp.is_some());
    assert!(change.piece.is_none());
}

/// Appends the end of `run_id`'s first turn.
async fn turn_end(log: &EventLogService, session_id: SessionId, run_id: &str) {
    let end = serde_json::from_value(json!({
        "type": "agent.turn.completed",
        "payload": {
            "sessionId": session_id,
            "runId": run_id,
            "runVersion": 1,
            "turnNumber": 1,
        },
    }))
    .expect("the test writes a turn end");
    log.append(
        test_envelope(session_id, &end),
        EventLogAppendOptions::default(),
    )
    .await
    .expect("the append commits");
}

// Killed by the stream's cut call removed, by an ended row's held-back starts never sent, by a
// later row of the run ending the open one, by the turn's end not ending it, by a stalled cut
// not refused, and by one row's failed cut failing the frame or another row.
#[tokio::test]
async fn event_subscribe_sends_each_rows_block_starts_and_a_failed_cut_fails_its_row_alone() {
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await.service;
    let session_id = test_session_id();
    let run_id = sidekicks_contracts::wire::id::mint_uuid_v7().to_string();
    let text = "First.\n\nSecond.\n\nThird.\n\nFourth.\n";
    let row_id = reply_piece(&log, session_id, &run_id, ("m1", 0), text).await;
    let stalling = format!("Before.\n\n{STALLING_TEXT}\n");
    let stalled_row_id = reply_piece(&log, session_id, &run_id, ("m2", 0), &stalling).await;
    turn_end(&log, session_id, &run_id).await;
    let start = log
        .read_follow_start(session_id, FollowStart::StartOfLog)
        .await
        .expect("the session's start reads");

    let record =
        SessionEventRecord::new(Arc::clone(&log), no_drivers(), session_id, stalling_parse);
    let page = record
        .read_after(&start, 64)
        .await
        .expect("the frame reads");
    let [open, stalled, end] = page.changes.as_slice() else {
        panic!("both pieces and the turn's end go out in one frame");
    };
    let (open, open_attachments) = wire_message(open);
    assert_eq!(open["piece"]["rowId"], row_id.as_str());
    let mut starts = wire_block_starts(&open["piece"]["blockStarts"], &open_attachments);
    assert!(!starts.is_empty() && starts.len() < 4);
    let (stalled, _) = wire_message(stalled);
    assert_eq!(stalled["piece"]["rowId"], stalled_row_id.as_str());
    assert_eq!(stalled["piece"]["blockCutFailure"], "stalled");
    assert!(stalled["piece"].get("blockStarts").is_none());
    assert!(stalled.get("endedRows").is_none());
    let (end, end_attachments) = wire_message(end);
    let ended_rows = end["endedRows"]
        .as_array()
        .expect("the turn's end ends a row");
    assert_eq!(ended_rows.len(), 1);
    assert_eq!(ended_rows[0]["rowId"], row_id.as_str());
    starts.extend(wire_block_starts(
        &ended_rows[0]["blockStarts"],
        &end_attachments,
    ));
    assert_eq!(starts, [0, 8, 17, 25]);
}

/// The block starts each row of a window read on `database` carries, by row id.
fn window_starts(database: &TestDatabase, session_id: SessionId) -> HashMap<String, Vec<u32>> {
    let request = serde_json::from_value(json!({ "sessionId": session_id }))
        .expect("the test's request reads");
    let page = read_transcript_window(
        &database.reader(),
        &|_: &SessionId| None,
        &|_| None,
        &request,
        MARKDOWN_PARSE,
    )
    .expect("the window reads");
    let (page, attachments) = wire_message(&page);
    page["entries"]
        .as_array()
        .expect("a page holds entries")
        .iter()
        .filter_map(|row| {
            let starts = wire_block_starts(&row["content"]["blockStarts"], &attachments);
            Some((row["id"].as_str()?.to_owned(), starts))
        })
        .collect()
}

/// Every start the changes of `page` send, by row id, in the order sent.
fn streamed_starts(
    page: &RecordPage<EventCursor, SessionStreamChange>,
) -> HashMap<String, Vec<u32>> {
    let mut starts: HashMap<String, Vec<u32>> = HashMap::new();
    for change in &page.changes {
        let (change, attachments) = wire_message(change);
        let ended = change["endedRows"].as_array().cloned().unwrap_or_default();
        for row in std::iter::once(&change["piece"]).chain(&ended) {
            if let Some(row_id) = row["rowId"].as_str() {
                starts
                    .entry(row_id.to_owned())
                    .or_default()
                    .extend(wire_block_starts(&row["blockStarts"], &attachments));
            }
        }
    }
    starts
}

// Killed by a row ended when another row of its run starts, whose later piece then sends its
// starts again or moves them, and by a stream opened between the pieces sending starts a read
// there already gave.
#[tokio::test]
async fn event_subscribe_sends_a_message_rows_starts_once_across_a_plan_block_inside_it() {
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await.service;
    let session_id = test_session_id();
    let run_id = sidekicks_contracts::wire::id::mint_uuid_v7().to_string();
    let message_row = reply_piece(
        &log,
        session_id,
        &run_id,
        ("item", 0),
        "Step one.\n\nStep two.\n\n",
    )
    .await;
    let plan_row = reply_piece(
        &log,
        session_id,
        &run_id,
        ("item", 1),
        "Plan.\n\n1. Read\n2. Write\n\nThen act.\n",
    )
    .await;
    let start = log
        .read_follow_start(session_id, FollowStart::StartOfLog)
        .await
        .expect("the session's start reads");
    let record =
        SessionEventRecord::new(Arc::clone(&log), no_drivers(), session_id, MARKDOWN_PARSE);
    let before = record
        .read_after(&start, 64)
        .await
        .expect("the frame reads");
    let read_between = window_starts(&database, session_id);
    reply_piece(
        &log,
        session_id,
        &run_id,
        ("item", 0),
        "Step three.\n\nStep four.\n",
    )
    .await;
    let between_cursor = &before.changes[1].cursor;
    let after = record
        .read_after(between_cursor, 64)
        .await
        .expect("the frame reads");
    let opened_between =
        SessionEventRecord::new(Arc::clone(&log), no_drivers(), session_id, MARKDOWN_PARSE);
    let inside = opened_between
        .read_after(between_cursor, 64)
        .await
        .expect("the frame reads");
    let read_open = window_starts(&database, session_id);
    turn_end(&log, session_id, &run_id).await;
    let last_cursor = &after.changes[0].cursor;
    let ended = record
        .read_after(last_cursor, 64)
        .await
        .expect("the frame reads");
    let inside_ended = opened_between
        .read_after(last_cursor, 64)
        .await
        .expect("the frame reads");
    let read_ended = window_starts(&database, session_id);

    for row_id in [&message_row, &plan_row] {
        let whole = &read_ended[row_id];
        assert!(whole.len() > 1, "the row {row_id} has blocks to cut");
        let mut streamed = Vec::new();
        for page in [&before, &after, &ended] {
            streamed.extend(streamed_starts(page).remove(row_id).unwrap_or_default());
        }
        assert_eq!(
            &streamed, whole,
            "the stream sends each start once, unmoved"
        );
        for read in [&read_between, &read_open] {
            assert!(
                whole.starts_with(&read[row_id]),
                "an open read's starts never move"
            );
        }
    }
    // The message row takes a piece after the stream opened, so that stream seeds it.
    let mut joined = read_between[&message_row].clone();
    for page in [&inside, &inside_ended] {
        joined.extend(
            streamed_starts(page)
                .remove(&message_row)
                .unwrap_or_default(),
        );
    }
    assert_eq!(
        joined, read_ended[&message_row],
        "a stream opened after a read sends only what it left"
    );
}

// A read whose records end in a task-list call sends the events before it and reads through
// it, so the stream never reads it again, and a read whose records are all task-list calls
// sends nothing, reads through them and leaves the next read due. Killed by a cursor moved
// only past the changes sent, by a task-list call sent as a change, and by a read full by its
// count of records left waiting for the next change.
#[tokio::test]
async fn a_read_ending_in_a_task_list_call_reads_through_it() {
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await.service;
    let session_id = test_session_id();
    let run_id = new_run_id();
    let providers = {
        let mut driver = MockProviderDriver::new();
        driver
            .expect_task_list_change()
            .returning(|call| (call.tool_name == "task-list").then_some(TaskListChange::Nothing));
        Arc::new(registry_of_first_provider(Arc::new(driver)))
    };
    let provider = providers
        .drivers()
        .next()
        .map(|(provider, _)| provider.clone())
        .expect("the table has a provider");
    insert_lead(&database, session_id, provider.as_str());
    insert_running_run(&database, session_id, run_id);
    pin(&log, session_id).await;
    let task_list_call = serde_json::from_value(json!({
        "type": "agent.toolCall.invoked",
        "payload": {
            "sessionId": session_id,
            "runId": run_id,
            "toolName": "task-list",
            "toolCallId": "task-list-call",
        },
    }))
    .expect("the test writes a task-list call");
    log.append(
        test_envelope(session_id, &task_list_call),
        EventLogAppendOptions::default(),
    )
    .await
    .expect("the append commits");
    let start = log
        .read_follow_start(session_id, FollowStart::StartOfLog)
        .await
        .expect("the session's start reads");
    // The lead's creation, the pin, then the call.
    let through_task_list = encode_event_cursor(2).expect("a sequence is a cursor");
    let record = SessionEventRecord::new(log, providers, session_id, MARKDOWN_PARSE);

    let whole = record.read_after(&start, 64).await.expect("the page reads");
    let tail = record
        .read_after(&whole.changes[whole.changes.len() - 1].cursor, 1)
        .await
        .expect("the page reads");

    let sent: Vec<&str> = whole
        .changes
        .iter()
        .map(|change| change.event.event_type.as_str())
        .collect();
    assert_eq!(sent, ["session.created", "session.pinned"]);
    assert_eq!(whole.read_through, Some(through_task_list.clone()));
    assert_eq!(tail.changes, []);
    assert_eq!(tail.read_through, Some(through_task_list));
    assert!(tail.is_cut_short);
}
