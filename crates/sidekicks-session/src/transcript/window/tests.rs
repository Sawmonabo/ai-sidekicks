use std::fmt::Write as _;
use std::sync::{Arc, Mutex};

use rstest::rstest;
use rusqlite::params;
use serde_json::{Value, json};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::event_cursor::encode_event_cursor;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::operations::{TranscriptReadRequest, TranscriptReadResponse};
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_provider::driver::contract::{MockProviderDriver, ProviderDriver};
use sidekicks_provider::driver::task_list::TaskListChange;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::writer::test_file::{TestDatabase, insert_lead, test_session_id};
use sidekicks_store::events::test_log::AT;

use super::{TranscriptReadError, read_transcript_window};
use crate::questions::schema::schema_parts;
use crate::transcript::block_cut::{BlockParse, MARKDOWN_PARSE};
use crate::transcript::body::read_row_body;
use crate::transcript::body::starts_cache::BlockCuts;
use crate::transcript::test_log::{
    STALLING_TEXT, TranscriptTestLog, stalling_parse, wire_block_starts, wire_message,
};

fn anchored_read(session_id: &SessionId, sequence: i64) -> TranscriptReadRequest {
    serde_json::from_value(json!({
        "sessionId": session_id,
        "aroundCursor": encode_event_cursor(sequence).expect("a test position is a cursor"),
        "limit": 3,
    }))
    .expect("the test's request reads")
}

fn refusal_code(result: Result<TranscriptReadResponse, TranscriptReadError>) -> RefusalCode {
    let Err(TranscriptReadError::Refused(refusal)) = result else {
        panic!("the read is refused");
    };
    refusal.code
}

#[test]
fn an_anchored_read_lands_a_standing_row_and_refuses_one_that_left() {
    let database = TestDatabase::new(schema_parts());
    let writer = database.opener()().expect("the test creates its database");
    let session_id = test_session_id();
    let session = session_id.text();
    for sequence in 0..5 {
        writer
            .execute(
                "INSERT INTO session_events
                   (id, session_id, sequence, occurred_at, monotonic_ns, category, type,
                    payload)
                 VALUES (?1, ?2, ?3, ?4, 0, 'sessionLifecycle', 'session.pinned', ?5)",
                params![
                    mint_uuid_v7().to_string(),
                    session.as_str(),
                    sequence,
                    AT,
                    json!({ "sessionId": session_id, "at": AT }).to_string()
                ],
            )
            .expect("the test writes its row");
    }
    // The row at sequence 2 is left out of every read, as a skipped damaged row is.
    writer
        .execute(
            "INSERT INTO session_events
               (id, session_id, sequence, occurred_at, monotonic_ns, category, type, payload)
             VALUES (?1, ?2, 5, ?3, 0, 'recoveryEvents', 'session.damagedEvents.skipped', ?4)",
            params![
                mint_uuid_v7().to_string(),
                session.as_str(),
                AT,
                json!({ "sessionId": session_id, "fromSequence": 2, "toSequence": 2 }).to_string()
            ],
        )
        .expect("the test writes the skip");
    let reader = database.reader();
    let no_damage = |_: &SessionId| None;

    let TranscriptReadResponse::Continuing(page) = read_transcript_window(
        &reader,
        &no_damage,
        &|_| None,
        &anchored_read(&session_id, 3),
        MARKDOWN_PARSE,
    )
    .expect("a standing row answers its window") else {
        panic!("rows remain before the window, so the page continues");
    };
    let sequences: Vec<u64> = page
        .entries
        .as_slice()
        .iter()
        .map(|row| row.sequence().get())
        .collect();
    assert_eq!(sequences, [1, 3, 4]);
    assert_eq!(
        page.next_cursor,
        encode_event_cursor(0).expect("a test position is a cursor")
    );

    assert_eq!(
        refusal_code(read_transcript_window(
            &reader,
            &no_damage,
            &|_| None,
            &anchored_read(&session_id, 2),
            MARKDOWN_PARSE,
        )),
        RefusalCode::TranscriptRowNotFound
    );
    assert_eq!(
        refusal_code(read_transcript_window(
            &reader,
            &no_damage,
            &|_| None,
            &anchored_read(&test_session_id(), 3),
            MARKDOWN_PARSE,
        )),
        RefusalCode::SessionNotFound
    );
}

const REPLY: &str = "agent.message.sent";

fn cursor(position: i64) -> Value {
    json!(encode_event_cursor(position).expect("a test position is a cursor"))
}

// The page `request` reads on `log`'s session, its replies cut by `parse`, as JSON, beside its
// attachments.
fn read_with_attachments(
    log: &TranscriptTestLog,
    request: Value,
    parse: BlockParse,
) -> (Value, Vec<bytes::Bytes>) {
    let mut request = request;
    request["sessionId"] = json!(log.session_log.session_id);
    let request: TranscriptReadRequest =
        serde_json::from_value(request).expect("the test's request reads");
    let response = read_transcript_window(
        &log.session_log.reader(),
        &|_: &SessionId| None,
        &|_| None,
        &request,
        parse,
    )
    .expect("the window reads");
    wire_message(&response)
}

// The page `request` reads on `log`'s session, as JSON.
fn read(log: &TranscriptTestLog, request: Value) -> Value {
    read_with_attachments(log, request, MARKDOWN_PARSE).0
}

// Each row of `page`: a tool row as `tool`, any other as its inline body.
fn row_bodies(page: &Value) -> Vec<String> {
    page["entries"]
        .as_array()
        .expect("a page holds entries")
        .iter()
        .map(|row| {
            if row["type"] == "agent.toolCall.completed" {
                "tool".to_owned()
            } else {
                row["content"]["body"]
                    .as_str()
                    .expect("the row's body travels inline")
                    .to_owned()
            }
        })
        .collect()
}

// Killed by pieces read as rows of their own, by a row taking its last piece's time, and by an
// anchored read at a later piece standing a row there.
#[test]
fn a_rejoined_reply_reads_as_one_row_at_its_first_piece() {
    let log = TranscriptTestLog::new(crate::questions::schema::schema_parts());
    let session_log = &log.session_log;
    let first_at = "2026-10-14T09:00:00.000Z";
    let (_, first_id) = session_log.piece(
        REPLY,
        session_log.run_id,
        "m1",
        Some(0),
        "Hello, ",
        first_at,
    );
    let (second, _) = session_log.piece(
        REPLY,
        session_log.run_id,
        "m1",
        Some(0),
        "world.",
        "2026-10-14T09:00:05.000Z",
    );

    let page = read(&log, json!({}));
    let rows = page["entries"].as_array().expect("a page holds entries");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["id"], first_id);
    assert_eq!(rows[0]["timestamp"], first_at);
    assert_eq!(rows[0]["content"]["body"], "Hello, world.");
    assert_eq!(rows[0]["content"]["contentLength"], 13);

    let around = read(&log, json!({ "aroundCursor": cursor(second), "limit": 3 }));
    assert_eq!(around["entries"], page["entries"]);
}

// One step of a reply's log.
#[derive(Clone, Copy, Debug)]
enum Step {
    // A reply piece: its message, its block and its text.
    Reply(&'static str, Option<u64>, &'static str),
    // A completed tool call.
    Tool,
}

// Killed by keying the join on the message alone, on the block alone, or on adjacency.
#[rstest]
#[case::blocks_of_one_message_stay_apart(
    &[
        Step::Reply("m1", Some(0), "Let me look."),
        Step::Tool,
        Step::Reply("m1", Some(2), "Found it."),
    ],
    &["Let me look.", "tool", "Found it."]
)]
#[case::a_tool_result_inside_a_block(
    &[
        Step::Reply("m1", Some(0), "Reading "),
        Step::Tool,
        Step::Reply("m1", Some(0), "the file."),
    ],
    &["Reading the file.", "tool"]
)]
#[case::a_plan_block_inside_a_message(
    &[
        Step::Reply("item", Some(0), "Step one, "),
        Step::Reply("item", Some(1), "1. Read"),
        Step::Reply("item", Some(0), "step two."),
    ],
    &["Step one, step two.", "1. Read"]
)]
#[case::the_same_block_of_two_messages(
    &[Step::Reply("m1", Some(0), "First."), Step::Reply("m2", Some(0), "Second.")],
    &["First.", "Second."]
)]
fn a_reply_rejoins_only_the_pieces_of_its_message_and_block(
    #[case] steps: &[Step],
    #[case] rows: &[&str],
) {
    let log = TranscriptTestLog::new(crate::questions::schema::schema_parts());
    for step in steps {
        match *step {
            Step::Reply(message_id, block, body) => {
                log.session_log.reply(message_id, block, body);
            }
            Step::Tool => {
                log.session_log
                    .tool_completion(log.session_log.run_id, "call-1", None, Some("ok"));
            }
        }
    }
    assert_eq!(row_bodies(&read(&log, json!({}))), rows);
}

// Killed by a continuation counted toward a page or standing a row, by an unbounded page ending
// short of the head, from which the stream would send a piece again, and by a bounded page ending
// past its bound.
#[test]
fn rejoin_pages_count_rows_and_end_at_the_head_or_their_bound() {
    let log = TranscriptTestLog::new(crate::questions::schema::schema_parts());
    log.session_log.reply("a", Some(0), "A1 ");
    let (reply_b, _) = log.session_log.reply("b", Some(0), "B");
    let (head, _) = log.session_log.reply("a", Some(0), "A2");

    let first = read(&log, json!({ "limit": 1 }));
    assert_eq!(row_bodies(&first), ["A1 A2"]);
    assert_eq!(first["hasMore"], true);
    assert_eq!(first["joinedThrough"], cursor(head));
    let second = read(
        &log,
        json!({ "afterCursor": first["nextCursor"], "limit": 1 }),
    );
    assert_eq!(row_bodies(&second), ["B"]);
    assert_eq!(second["hasMore"], false);
    assert_eq!(second["nextCursor"], cursor(head));
    assert_eq!(second["joinedThrough"], cursor(head));

    let (later, _) = log.session_log.reply("c", Some(0), "C");
    let bounded = read(
        &log,
        json!({ "afterCursor": cursor(reply_b - 1), "beforeCursor": cursor(head), "limit": 5 }),
    );
    assert_eq!(row_bodies(&bounded), ["B"]);
    assert_eq!(bounded["hasMore"], false);
    assert_eq!(bounded["nextCursor"], cursor(head));
    assert_eq!(bounded["joinedThrough"], cursor(later));
}

// Killed by a body read of the anchor's own piece, and by a part cut inside a character.
#[test]
fn a_rejoined_body_over_a_page_reads_back_whole_in_parts() {
    let log = TranscriptTestLog::new(crate::questions::schema::schema_parts());
    // Each piece is stored compressed, and the three together are over one page.
    let pieces: Vec<String> = ["\u{e9}", "\u{1f600}", "\u{5b57}"]
        .iter()
        .map(|character| format!("{}.", character.repeat(120_000)))
        .collect();
    let (_, row_id) = log.session_log.reply("long", Some(0), &pieces[0]);
    log.session_log.reply("long", Some(0), &pieces[1]);
    log.session_log.reply("long", Some(0), &pieces[2]);
    let whole = pieces.concat();
    assert!(whole.len() > sidekicks_contracts::jsonrpc::page::PAGE_MAX_BYTES);

    let reader = log.session_log.reader();
    let mut read_back = String::new();
    let mut offset = Some(0);
    let mut parts = 0;
    while let Some(part_offset) = offset {
        let part = read_row_body(
            &reader,
            &|_: &SessionId| None,
            &log.session_log.session_id,
            &row_id,
            part_offset,
            MARKDOWN_PARSE,
            &BlockCuts::default(),
        )
        .expect("the body reads")
        .expect("a row stands at the anchor");
        let part = wire_message(&part).0;
        assert_eq!(part["contentLength"], whole.len());
        read_back.push_str(part["body"].as_str().expect("the part is available"));
        offset = part["nextOffset"].as_u64();
        parts += 1;
    }
    assert!(parts > 1);
    assert_eq!(read_back, whole);
}

// A tool output of several pages is stored whole and compressed, its row sized by the length its
// payload states, and read back part by part from the frames each part covers. Killed by sizing
// the row by its stored bytes, by a part decoding the wrong frames, and by a body cut on the way
// in.
#[test]
fn a_long_tool_output_is_stored_whole_and_read_back_in_parts() {
    let log = TranscriptTestLog::new(crate::questions::schema::schema_parts());
    let session_log = &log.session_log;
    let mut whole = String::new();
    for line in 0..160_000 {
        writeln!(whole, "{line:>6} \u{e9}output").expect("a string takes text");
    }
    let (sequence, row_id) =
        session_log.tool_completion(session_log.run_id, "call-1", None, Some(&whole));
    let stored_bytes: i64 = session_log
        .reader()
        .query_row(
            "SELECT length(content_payload) FROM session_events WHERE sequence = ?1",
            [sequence],
            |row| row.get(0),
        )
        .expect("the row reads");
    assert!(usize::try_from(stored_bytes).expect("a length") < whole.len() / 2);

    let page = read(&log, json!({}));
    let content = &page["entries"][0]["content"];
    assert_eq!(content["contentLength"], whole.len());
    assert!(content.get("body").is_none(), "{content}");

    let reader = session_log.reader();
    let mut read_back = String::new();
    let mut offset = Some(0);
    let mut parts = 0;
    while let Some(part_offset) = offset {
        let part = read_row_body(
            &reader,
            &|_: &SessionId| None,
            &session_log.session_id,
            &row_id,
            part_offset,
            MARKDOWN_PARSE,
            &BlockCuts::default(),
        )
        .expect("the body reads")
        .expect("a row stands there");
        let part = wire_message(&part).0;
        assert_eq!(part["offset"], part_offset);
        assert_eq!(part["contentLength"], whole.len());
        read_back.push_str(part["body"].as_str().expect("the part is available"));
        offset = part["nextOffset"].as_u64();
        parts += 1;
    }
    assert!(parts > 1);
    assert_eq!(read_back, whole);
}

// Killed by an intervention filed on the general arm, where run filters and rollback miss it, or
// under any run but its target.
#[rstest]
fn an_intervention_row_stands_on_its_target_runs_arm(
    #[values(
        "requested",
        "accepted",
        "applied",
        "rejected",
        "degraded",
        "expired",
        "failed"
    )]
    state: &str,
) {
    let log = TranscriptTestLog::new(crate::questions::schema::schema_parts());
    let (_, id) = log.intervention(log.session_log.run_id, state);

    let page = read(&log, json!({}));
    let row = &page["entries"][0];
    assert_eq!(row["id"], id);
    assert_eq!(row["kind"], "run");
    assert_eq!(row["runId"], json!(log.session_log.run_id));
    assert_eq!(row["type"], format!("agent.intervention.{state}"));
    let stored_target: String = log
        .session_log
        .writer
        .query_row(
            "SELECT target_run_id FROM session_events WHERE id = ?",
            [&id],
            |stored| stored.get(0),
        )
        .expect("the intervention's target run is stored");
    assert_eq!(stored_target, log.session_log.run_id.to_string());
}

// The first row of `page` whose inline body is `body`.
fn row_with_body<'page>(page: &'page Value, body: &str) -> &'page Value {
    page["entries"]
        .as_array()
        .expect("a page holds entries")
        .iter()
        .find(|row| row["content"]["body"] == body)
        .expect("the row is on the page")
}

// Killed by the window's cut call removed, by an open row cut as ended, whose last starts could
// still move, by a later row of the run ending it, by its turn's end not ending it, by a stalled
// cut not refused, and by one row's failed cut failing the page or another row.
#[test]
fn a_window_cuts_reply_rows_into_blocks_and_a_failed_cut_fails_its_row_alone() {
    let log = TranscriptTestLog::new(crate::questions::schema::schema_parts());
    let text = "First.\n\nSecond.\n\nThird.\n\nFourth.\n";
    log.session_log.reply("m1", Some(0), &text[..17]);
    log.session_log.reply("m1", Some(0), &text[17..]);
    let stalling = format!("Before.\n\n{STALLING_TEXT}\n");
    log.session_log.reply("m2", Some(0), &stalling);

    let (open_page, open_attachments) = read_with_attachments(&log, json!({}), stalling_parse);
    let open = wire_block_starts(
        &row_with_body(&open_page, text)["content"]["blockStarts"],
        &open_attachments,
    );
    log.turn_end(log.session_log.run_id, 1);
    let (page, attachments) = read_with_attachments(&log, json!({}), stalling_parse);
    let ended = wire_block_starts(
        &row_with_body(&page, text)["content"]["blockStarts"],
        &attachments,
    );
    assert_eq!(ended, [0, 8, 17, 25]);
    assert!(!open.is_empty() && open.len() < ended.len());
    assert_eq!(open, ended[..open.len()]);
    let failed = &row_with_body(&page, &stalling)["content"];
    assert_eq!(failed["blockCutFailure"], "stalled");
    assert!(failed.get("blockStarts").is_none());
}

// Killed by the body read's cut call removed, by a part carrying starts outside its own text, and
// by starts over a page answered with a panic rather than spread across the parts.
#[test]
fn a_body_read_spreads_starts_past_a_page_across_its_parts() {
    let log = TranscriptTestLog::new(crate::questions::schema::schema_parts());
    let session_log = &log.session_log;
    let paragraphs = 300_000;
    let whole = "a\n\n".repeat(paragraphs);
    // Four pieces, each under the stored cut, take a body whose starts alone pass one page.
    let piece_length = whole.len() / 4;
    let (_, row_id) = session_log.reply("long", Some(0), &whole[..piece_length]);
    for index in 1..4 {
        session_log.reply(
            "long",
            Some(0),
            &whole[index * piece_length..(index + 1) * piece_length],
        );
    }
    // The turn's end ends the row, so every start is final.
    log.turn_end(session_log.run_id, 1);
    assert!(4 * paragraphs > sidekicks_contracts::jsonrpc::page::PAGE_MAX_BYTES);

    let reader = session_log.reader();
    let mut starts = Vec::new();
    let mut offset = Some(0);
    while let Some(part_offset) = offset {
        let part = read_row_body(
            &reader,
            &|_: &SessionId| None,
            &session_log.session_id,
            &row_id,
            part_offset,
            MARKDOWN_PARSE,
            &BlockCuts::default(),
        )
        .expect("the body reads")
        .expect("a row stands at the anchor");
        let (part, attachments) = wire_message(&part);
        let part_start = part["offset"].as_u64().expect("a part names its offset");
        let part_end = part_start
            + u64::try_from(part["body"].as_str().expect("the part is available").len())
                .expect("a part's length fits");
        let part_starts = wire_block_starts(&part["blockStarts"], &attachments);
        // Every character is one UTF-16 unit, so a drawn offset is a stored one.
        assert!(
            part_starts
                .iter()
                .all(|&start| (part_start..part_end).contains(&u64::from(start)))
        );
        starts.extend(part_starts);
        offset = part["nextOffset"].as_u64();
    }
    let expected: Vec<u32> = (0..paragraphs)
        .map(|index| u32::try_from(3 * index).expect("an offset fits"))
        .collect();
    assert_eq!(starts, expected);
}

// Killed by a task-list call kept as a row, by its opening asked with its end's facts or its end
// with its opening's, by a failed or opened call asked as a success, and by a page that continues
// holding no row when its whole stretch is task-list calls.
#[test]
fn a_task_list_call_adds_no_row_and_a_stretch_of_them_is_passed_over() {
    let log = TranscriptTestLog::new(schema_parts());
    let session_log = &log.session_log;
    insert_lead(
        &session_log.database,
        session_log.session_id,
        "test-provider",
    );
    let tool_row = |event_type: &str, tool_name: &str, body: &str| {
        session_log
            .write(
                json!({
                    "type": event_type,
                    "payload": {
                        "sessionId": session_log.session_id,
                        "runId": session_log.run_id,
                        "toolName": tool_name,
                        "toolCallId": format!("{tool_name}-call"),
                    },
                }),
                Some(body),
            )
            .0
    };
    tool_row("agent.toolCall.invoked", "task-list", r#"{"tasks":[]}"#);
    tool_row("agent.toolCall.completed", "task-list", "Updated.");
    let read_opening = tool_row("agent.toolCall.invoked", "read", "{}");
    let read_end = tool_row("agent.toolCall.failed", "read", "No such file.");
    let asked = Arc::new(Mutex::new(Vec::new()));
    let mut driver = MockProviderDriver::new();
    driver.expect_task_list_change().returning({
        let asked = Arc::clone(&asked);
        move |call| {
            lock(&asked).push((
                call.tool_name.to_owned(),
                call.input.cloned(),
                call.result.cloned(),
                call.is_success,
            ));
            (call.tool_name == "task-list").then_some(TaskListChange::Nothing)
        }
    });
    let driver: Arc<dyn ProviderDriver> = Arc::new(driver);
    let request = |limit: u64| -> TranscriptReadRequest {
        serde_json::from_value(json!({
            "sessionId": session_log.session_id,
            "afterCursor": cursor(0),
            "limit": limit,
        }))
        .expect("the test's request reads")
    };
    let sequences = |driver_of: &dyn Fn(&ProviderId) -> Option<Arc<dyn ProviderDriver>>| {
        let response = read_transcript_window(
            &session_log.reader(),
            &|_: &SessionId| None,
            driver_of,
            &request(2),
            MARKDOWN_PARSE,
        )
        .expect("the window reads");
        let TranscriptReadResponse::Terminal(page) = response else {
            panic!("the page reaches the end of the log");
        };
        page.entries
            .as_slice()
            .iter()
            .map(|row| i64::from(row.sequence()))
            .collect::<Vec<i64>>()
    };

    // The page's first stretch is the task-list call alone, so it reads on to the next.
    assert_eq!(
        sequences(&|_| Some(Arc::clone(&driver))),
        [read_opening, read_end]
    );
    assert_eq!(
        *lock(&asked),
        [
            (
                "task-list".to_owned(),
                Some(json!({ "tasks": [] })),
                None,
                false
            ),
            ("task-list".to_owned(), None, Some(json!("Updated.")), true),
            ("read".to_owned(), Some(json!({})), None, false),
            ("read".to_owned(), None, Some(json!("No such file.")), false),
        ]
    );

    // A session whose provider no driver answers keeps the call's rows.
    let response = read_transcript_window(
        &session_log.reader(),
        &|_: &SessionId| None,
        &|_| None,
        &request(4),
        MARKDOWN_PARSE,
    )
    .expect("the window reads");
    let TranscriptReadResponse::Terminal(page) = response else {
        panic!("the page reaches the end of the log");
    };
    assert_eq!(page.entries.as_slice().len(), 4);
}

// A read whose stretches are all task-list calls past the request's cap answers an empty page that
// continues after the last stretch it passed over, and the read from there finds the row behind
// them. Killed by passing over stretches without a cap (the first page reads on to the row), and
// by a capped page continuing from where it was asked to read (the second page is empty again).
#[test]
fn a_read_past_its_cap_of_task_list_stretches_continues_empty_after_them() {
    const LIMIT: usize = 2;
    let log = TranscriptTestLog::new(schema_parts());
    let session_log = &log.session_log;
    insert_lead(
        &session_log.database,
        session_log.session_id,
        "test-provider",
    );
    let tool_row = |event_type: &str, tool_name: &str, call: usize, body: &str| {
        session_log
            .write(
                json!({
                    "type": event_type,
                    "payload": {
                        "sessionId": session_log.session_id,
                        "runId": session_log.run_id,
                        "toolName": tool_name,
                        "toolCallId": format!("{tool_name}-call-{call}"),
                    },
                }),
                Some(body),
            )
            .0
    };
    let task_list_events = super::PASSED_OVER_STRETCHES_MAX * LIMIT;
    let mut last_task_list_event = 0;
    for call in 0..task_list_events / 2 {
        tool_row(
            "agent.toolCall.invoked",
            "task-list",
            call,
            r#"{"tasks":[]}"#,
        );
        last_task_list_event = tool_row("agent.toolCall.completed", "task-list", call, "Updated.");
    }
    let read_opening = tool_row("agent.toolCall.invoked", "read", 0, "{}");
    let mut driver = MockProviderDriver::new();
    driver
        .expect_task_list_change()
        .returning(|call| (call.tool_name == "task-list").then_some(TaskListChange::Nothing));
    let driver: Arc<dyn ProviderDriver> = Arc::new(driver);
    let read_after = |after: Value| {
        read_transcript_window(
            &session_log.reader(),
            &|_: &SessionId| None,
            &|_| Some(Arc::clone(&driver)),
            &serde_json::from_value(json!({
                "sessionId": session_log.session_id,
                "afterCursor": after,
                "limit": LIMIT,
            }))
            .expect("the test's request reads"),
            MARKDOWN_PARSE,
        )
        .expect("the window reads")
    };

    let TranscriptReadResponse::Continuing(capped) = read_after(cursor(0)) else {
        panic!("the capped page continues");
    };
    let rest = read_after(serde_json::to_value(&capped.next_cursor).expect("a cursor writes"));

    assert!(capped.entries.as_slice().is_empty());
    assert_eq!(
        Some(capped.next_cursor),
        encode_event_cursor(last_task_list_event).ok()
    );
    let TranscriptReadResponse::Terminal(rest) = rest else {
        panic!("the read after the capped page reaches the end of the log");
    };
    let sequences: Vec<i64> = rest
        .entries
        .as_slice()
        .iter()
        .map(|row| i64::from(row.sequence()))
        .collect();
    assert_eq!(sequences, [read_opening]);
}
