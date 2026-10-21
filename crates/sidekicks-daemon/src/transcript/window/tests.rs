use rstest::rstest;
use rusqlite::params;
use serde_json::{Value, json};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::session::event_cursor::encode_event_cursor;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::operations::{TranscriptReadRequest, TranscriptReadResponse};

use super::{TranscriptReadError, read_transcript_window};
use crate::database::writer::test_file::{TestDatabase, test_session_id};
use crate::transcript::block_cut::STALLING_TEXT;
use crate::transcript::body::read_row_body;
use crate::transcript::test_log::{AT, TranscriptTestLog, wire_block_starts, wire_message};
use crate::uuid_v7::mint_uuid_v7;

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
    let database = TestDatabase::new();
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

    let TranscriptReadResponse::Continuing(page) =
        read_transcript_window(&reader, &no_damage, &anchored_read(&session_id, 3))
            .expect("a standing row answers its window")
    else {
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
            &anchored_read(&session_id, 2)
        )),
        RefusalCode::TranscriptRowNotFound
    );
    assert_eq!(
        refusal_code(read_transcript_window(
            &reader,
            &no_damage,
            &anchored_read(&test_session_id(), 3)
        )),
        RefusalCode::SessionNotFound
    );
}

const REPLY: &str = "agent.message.sent";

fn cursor(position: i64) -> Value {
    json!(encode_event_cursor(position).expect("a test position is a cursor"))
}

// The page `request` reads on `log`'s session, as JSON, beside its attachments.
fn read_with_attachments(log: &TranscriptTestLog, request: Value) -> (Value, Vec<bytes::Bytes>) {
    let mut request = request;
    request["sessionId"] = json!(log.session_id);
    let request: TranscriptReadRequest =
        serde_json::from_value(request).expect("the test's request reads");
    let response = read_transcript_window(&log.reader(), &|_: &SessionId| None, &request)
        .expect("the window reads");
    wire_message(&response)
}

// The page `request` reads on `log`'s session, as JSON.
fn read(log: &TranscriptTestLog, request: Value) -> Value {
    read_with_attachments(log, request).0
}

// Each row of `page`: a tool row as `tool`, a turn's start as `turn`, any other as its inline body.
fn row_bodies(page: &Value) -> Vec<String> {
    page["entries"]
        .as_array()
        .expect("a page holds entries")
        .iter()
        .map(|row| {
            if row["type"] == "agent.toolCall.completed" {
                "tool".to_owned()
            } else if row["type"] == "agent.turn.started" {
                "turn".to_owned()
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
    let log = TranscriptTestLog::new();
    let first_at = "2026-10-14T09:00:00.000Z";
    let (_, first_id) = log.piece(REPLY, log.run_id, "m1", Some(0), "Hello, ", first_at);
    let (second, _) = log.piece(
        REPLY,
        log.run_id,
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
    // The start of the run's next turn.
    Turn,
}

// Killed by keying the join on the message alone, on the block alone, or on adjacency, and by a
// join that reaches past the run's current turn.
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
#[case::the_same_message_and_block_in_two_turns(
    &[Step::Reply("m1", Some(0), "Turn one."), Step::Turn, Step::Reply("m1", Some(0), "Turn two.")],
    &["Turn one.", "turn", "Turn two."]
)]
fn a_reply_rejoins_only_the_pieces_of_its_message_and_block(
    #[case] steps: &[Step],
    #[case] rows: &[&str],
) {
    let log = TranscriptTestLog::new();
    let mut turn_number = 1;
    for step in steps {
        match *step {
            Step::Reply(message_id, block, body) => {
                log.reply(message_id, block, body);
            }
            Step::Tool => {
                log.tool_completion(log.run_id, "call-1", None, Some("ok"));
            }
            Step::Turn => {
                turn_number += 1;
                log.turn_start(log.run_id, turn_number);
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
    let log = TranscriptTestLog::new();
    log.reply("a", Some(0), "A1 ");
    let (reply_b, _) = log.reply("b", Some(0), "B");
    let (head, _) = log.reply("a", Some(0), "A2");

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

    let (later, _) = log.reply("c", Some(0), "C");
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
    let log = TranscriptTestLog::new();
    // Each piece is under the stored cut, and the three together are over one page.
    let pieces: Vec<String> = ["\u{e9}", "\u{1f600}", "\u{5b57}"]
        .iter()
        .map(|character| format!("{}.", character.repeat(120_000)))
        .collect();
    let (_, row_id) = log.reply("long", Some(0), &pieces[0]);
    log.reply("long", Some(0), &pieces[1]);
    log.reply("long", Some(0), &pieces[2]);
    let whole = pieces.concat();
    assert!(whole.len() > sidekicks_contracts::jsonrpc::page::PAGE_MAX_BYTES);

    let reader = log.reader();
    let mut read_back = String::new();
    let mut offset = Some(0);
    let mut parts = 0;
    while let Some(part_offset) = offset {
        let part = read_row_body(
            &reader,
            &|_: &SessionId| None,
            &log.session_id,
            &row_id,
            part_offset,
            true,
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
    let log = TranscriptTestLog::new();
    let (_, id) = log.intervention(log.run_id, state);

    let page = read(&log, json!({}));
    let row = &page["entries"][0];
    assert_eq!(row["id"], id);
    assert_eq!(row["kind"], "run");
    assert_eq!(row["runId"], json!(log.run_id));
    assert_eq!(row["type"], format!("agent.intervention.{state}"));
    let stored_target: String = log
        .writer
        .query_row(
            "SELECT target_run_id FROM session_events WHERE id = ?",
            [&id],
            |stored| stored.get(0),
        )
        .expect("the intervention's target run is stored");
    assert_eq!(stored_target, log.run_id.to_string());
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
// still move, by a later row of the run not ending it, and by one row's failed cut failing the
// page or another row.
#[test]
fn a_window_cuts_reply_rows_into_blocks_and_a_failed_cut_fails_its_row_alone() {
    let log = TranscriptTestLog::new();
    let text = "First.\n\nSecond.\n\nThird.\n\nFourth.\n";
    log.reply("m1", Some(0), &text[..17]);
    log.reply("m1", Some(0), &text[17..]);

    let (open_page, open_attachments) = read_with_attachments(&log, json!({}));
    let open = wire_block_starts(
        &row_with_body(&open_page, text)["content"]["blockStarts"],
        &open_attachments,
    );
    let stalling = format!("Before.\n\n{STALLING_TEXT}\n");
    log.reply("m2", Some(0), &stalling);
    let (page, attachments) = read_with_attachments(&log, json!({}));
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
    let log = TranscriptTestLog::new();
    let paragraphs = 300_000;
    let whole = "a\n\n".repeat(paragraphs);
    // Four pieces, each under the stored cut, take a body whose starts alone pass one page.
    let piece_length = whole.len() / 4;
    let (_, row_id) = log.reply("long", Some(0), &whole[..piece_length]);
    for index in 1..4 {
        log.reply(
            "long",
            Some(0),
            &whole[index * piece_length..(index + 1) * piece_length],
        );
    }
    // A later row of the run ends this one, so every start is final.
    log.reply("next", Some(0), "Done.");
    assert!(4 * paragraphs > sidekicks_contracts::jsonrpc::page::PAGE_MAX_BYTES);

    let reader = log.reader();
    let mut starts = Vec::new();
    let mut offset = Some(0);
    while let Some(part_offset) = offset {
        let part = read_row_body(
            &reader,
            &|_: &SessionId| None,
            &log.session_id,
            &row_id,
            part_offset,
            true,
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
