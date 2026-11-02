use std::sync::Arc;

use rusqlite::Connection;
use serde_json::json;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_envelope, test_session_id};
use sidekicks_store::events::content::codec::BodyEncoder;
use sidekicks_store::events::session::insert::{
    SessionEventRow, insert_session_event, monotonic_ns_now,
};
use sidekicks_store::events::session::read::SessionEventReads;
use sidekicks_store::events::test_log::SessionTestLog;

use super::{
    CanonicalToolResultOutcome, CanonicalToolResultProvenance, CanonicalTranscriptRole,
    CanonicalTranscriptSegment, CanonicalTranscriptTurn, TranscriptExportBound,
    fold_canonical_transcript,
};
use crate::driver::schema::schema_parts;

/// Appends `event` to `session_id`'s log through the row write, with `body` as its stored
/// body.
fn append(
    writer: &Connection,
    session_id: &SessionId,
    event: serde_json::Value,
    body: Option<&str>,
) {
    let event: SessionEvent =
        serde_json::from_value(event).expect("the test writes a well-formed event");
    let mut envelope = test_envelope(*session_id, &event);
    let content_payload = body.map(|body| {
        envelope
            .describe_content(body.to_owned())
            .expect("the event carries a body")
    });
    let row = SessionEventRow {
        payload: serde_json::to_string(envelope.payload()).expect("a JSON object serializes"),
        envelope: Arc::new(envelope),
        monotonic_ns: monotonic_ns_now(),
        content_payload,
    };
    insert_session_event(writer, &mut BodyEncoder::new(), &row).expect("the test writes its row");
}

#[test]
fn a_turn_whose_body_cannot_be_read_keeps_its_place_and_another_run_stays_out() {
    let database = TestDatabase::new(schema_parts());
    let writer = database.opener()().expect("the test creates its database");
    let session_id = test_session_id();
    let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    let agent_message = json!({
        "type": "agent.message.sent",
        "payload": { "sessionId": session_id, "runId": run_id, "providerMessageId": "m" },
    });
    let user_message = json!({
        "type": "user.message.sent",
        "payload": {
            "sessionId": session_id,
            "runId": run_id,
            "actor": "person",
            "message": "Fix the build",
        },
    });
    let turn_ended = json!({
        "type": "agent.turn.completed",
        "payload": {
            "sessionId": session_id,
            "runId": run_id,
            "runVersion": 1,
            "turnNumber": 1,
        },
    });
    let turn_started = json!({
        "type": "agent.turn.started",
        "payload": {
            "sessionId": session_id,
            "runId": run_id,
            "runVersion": 1,
            "turnNumber": 2,
        },
    });
    append(&writer, &session_id, user_message, None);
    append(
        &writer,
        &session_id,
        agent_message.clone(),
        Some("Looking."),
    );
    append(&writer, &session_id, turn_ended, None);
    append(&writer, &session_id, turn_started, None);
    append(&writer, &session_id, agent_message, None);
    // Another run's message in the same session stays out of this run's transcript.
    let other_run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
    let other_run_message = json!({
        "type": "user.message.sent",
        "payload": {
            "sessionId": session_id,
            "runId": other_run_id,
            "actor": "person",
            "message": "Another run",
        },
    });
    append(&writer, &session_id, other_run_message, None);

    let reader = database.reader();
    let reads = SessionEventReads::new(&reader, |_: &SessionId| None);
    let projection = fold_canonical_transcript(
        &reads,
        &session_id,
        &run_id,
        TranscriptExportBound::AtOrBelow(5),
    )
    .expect("the run's transcript folds");

    let text = |position, text: &str, is_content_unavailable| CanonicalTranscriptSegment::Text {
        position,
        text: text.to_owned(),
        is_content_unavailable,
        queue_item_id: None,
    };
    assert_eq!(projection.built_at_position, 5);
    assert_eq!(
        projection.turns,
        [
            CanonicalTranscriptTurn {
                position: 0,
                role: CanonicalTranscriptRole::User,
                segments: vec![text(0, "Fix the build", false)],
            },
            CanonicalTranscriptTurn {
                position: 1,
                role: CanonicalTranscriptRole::Assistant,
                segments: vec![text(1, "Looking.", false)],
            },
            CanonicalTranscriptTurn {
                position: 4,
                role: CanonicalTranscriptRole::Assistant,
                segments: vec![text(4, "", true)],
            },
        ]
    );
}

// Killed by a reply's pieces or a completion's patched files folded as rows of their own,
// which would hand a provider a reply cut where the wire cut it or a result once per file.
#[test]
fn a_row_stored_in_pieces_folds_as_one_segment_with_its_whole_body() {
    let log = SessionTestLog::new(schema_parts());
    let (reply, _) = log.reply("m1", Some(0), "Hello, ");
    log.reply("m1", Some(0), "world.");
    let files = json!([
        { "path": "/repo/a.rs", "unavailable": "absent" },
        { "path": "/repo/b.rs", "unavailable": "absent" },
    ]);
    let body = json!({ "files": files }).to_string();
    let (completion, _) = log.tool_completion(
        log.run_id,
        "call-1",
        Some(json!([{ "path": "/repo/a.rs", "size": 0 }, { "path": "/repo/b.rs", "size": 0 }])),
        Some(&body),
    );

    let reader = log.reader();
    let reads = SessionEventReads::new(&reader, |_: &SessionId| None);
    let projection = fold_canonical_transcript(
        &reads,
        &log.session_id,
        &log.run_id,
        TranscriptExportBound::Unbounded,
    )
    .expect("the run's transcript folds");

    let position = |sequence: i64| u64::try_from(sequence).expect("a sequence is not negative");
    assert_eq!(
        projection.turns,
        [CanonicalTranscriptTurn {
            position: position(reply),
            role: CanonicalTranscriptRole::Assistant,
            segments: vec![
                CanonicalTranscriptSegment::Text {
                    position: position(reply),
                    text: "Hello, world.".to_owned(),
                    is_content_unavailable: false,
                    queue_item_id: None,
                },
                CanonicalTranscriptSegment::ToolResult {
                    position: position(completion),
                    tool_call_id: "call-1".to_owned(),
                    outcome: CanonicalToolResultOutcome::Succeeded,
                    provenance: CanonicalToolResultProvenance::Provider,
                    text: body,
                    is_content_unavailable: false,
                },
            ],
        }]
    );
}
