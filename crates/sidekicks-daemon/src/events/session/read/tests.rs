use rstest::rstest;
use rusqlite::params;
use sidekicks_contracts::session::id::SessionId;

use sidekicks_contracts::event::envelope::{
    HydratedContentUnavailableReason, HydratedSessionEventContent,
};
use sidekicks_contracts::wire::integer::SafeInt;

use super::{MalformedStoredEventFault, SessionEventReads, SessionLogReadError};
use crate::database::writer::test_file::{TestDatabase, test_session_id};
use crate::transcript::test_log::TranscriptTestLog;
use sidekicks_contracts::wire::id::mint_uuid_v7;

const WELL_FORMED_INSTANT: &str = "2026-10-14T09:00:00.000Z";

#[rstest]
#[case::payload_not_an_object(WELL_FORMED_INSTANT, "sessionLifecycle", "[]", "payload")]
#[case::prototype_member(
    WELL_FORMED_INSTANT,
    "sessionLifecycle",
    r#"{"__proto__":{}}"#,
    "__proto__"
)]
#[case::occurred_at_finer_than_a_millisecond(
    "2026-10-14T09:00:00.0001Z",
    "sessionLifecycle",
    "{}",
    "occurred_at"
)]
#[case::unknown_category(WELL_FORMED_INSTANT, "lifecycle", "{}", "category")]
fn a_malformed_stored_row_is_refused_naming_its_event_and_session(
    #[case] occurred_at: &str,
    #[case] category: &str,
    #[case] payload: &str,
    #[case] faulty_member: &str,
) {
    let database = TestDatabase::new();
    let writer = database.opener()().expect("the test creates its database");
    let (session_id, event_id) = (test_session_id(), mint_uuid_v7().to_string());
    writer
        .execute(
            "INSERT INTO session_events
               (id, session_id, sequence, occurred_at, monotonic_ns, category, type, payload)
             VALUES (?1, ?2, 0, ?3, 0, ?4, 'session.pinned', ?5)",
            params![
                event_id,
                session_id.text().as_str(),
                occurred_at,
                category,
                payload
            ],
        )
        .expect("the test writes its row");

    let reader = database.reader();
    let reads = SessionEventReads::new(&reader, |_: &SessionId| None);
    let Err(SessionLogReadError::Malformed(malformed)) = reads.read_window(&session_id, 0, 0)
    else {
        panic!("the row is refused as malformed");
    };
    let found_member = match &malformed.fault {
        MalformedStoredEventFault::PayloadNotObject(_) => "payload",
        MalformedStoredEventFault::PrototypeMember => "__proto__",
        MalformedStoredEventFault::Column { column, .. } => column,
        MalformedStoredEventFault::Check(_) => "check",
    };
    assert_eq!(found_member, faulty_member);
    assert_eq!(malformed.event_id, event_id);
    assert_eq!(malformed.session_id, session_id.text().as_str());
    let message = malformed.to_string();
    assert!(message.contains(&event_id), "{message}");
    assert!(message.contains(session_id.text().as_str()), "{message}");
}

// A hydrated read decodes each stored piece of a row, a compressed one among them, and joins
// them after the row's own, leaves the event's payload as stored, and reads a row with no body
// as absent. Killed by joining the stored bytes undecoded, by dropping a piece, and by reading
// a missing body as an empty one.
#[test]
fn a_hydrated_read_joins_each_rows_decoded_bodies() {
    let log = TranscriptTestLog::new();
    let opening = "\u{e9}".repeat(1_500);
    let (row, _) = log.reply("m1", Some(0), &opening);
    log.reply("m1", Some(0), " and the rest.");
    let (bare, _) = log.tool_completion(log.run_id, "call-1", None, None);
    let reader = log.reader();
    let stored_payload: String = reader
        .query_row(
            "SELECT payload FROM session_events WHERE sequence = ?1",
            [row],
            |row| row.get(0),
        )
        .expect("the row reads");

    let reads = SessionEventReads::new(&reader, |_: &SessionId| None);
    let page = reads
        .read_run_page_hydrated(
            &log.session_id,
            &log.run_id,
            -1,
            &["agent.message.sent", "agent.toolCall.completed"],
            None,
        )
        .expect("the run reads");
    assert!(page.oversized.is_none());
    let events = page.events;
    let sequences: Vec<i64> = events
        .iter()
        .map(|event| i64::from(event.event.sequence))
        .collect();
    assert_eq!(sequences, [row, bare]);
    assert_eq!(
        serde_json::to_string(&events[0].event.payload).expect("a payload serializes"),
        stored_payload
    );
    assert_eq!(
        events[0].content,
        HydratedSessionEventContent::Available {
            body: format!("{opening} and the rest."),
            content_length: SafeInt::new(opening.len() as u64),
        }
    );
    assert_eq!(
        events[1].content,
        HydratedSessionEventContent::Unavailable {
            reason: HydratedContentUnavailableReason::Absent,
        }
    );
}

// A hydrated page loads rows while their bodies stay within the page's text, stops before the
// row that passes it, and hands back a row whose body alone passes it unloaded, by itself.
// Killed by a page that loads past its text, and by a long row loaded with the others.
#[test]
fn a_hydrated_page_stays_within_its_text() {
    const MEBIBYTE: usize = 1024 * 1024;
    let log = TranscriptTestLog::new();
    let (first, _) = log.reply("m1", None, &"a".repeat(3 * MEBIBYTE));
    let (second, _) = log.reply("m2", None, &"b".repeat(3 * MEBIBYTE));
    let (long, _) = log.reply("m3", None, &"c".repeat(9 * MEBIBYTE));
    let (last, _) = log.reply("m4", None, "the last reply");
    let reader = log.reader();
    let reads = SessionEventReads::new(&reader, |_: &SessionId| None);
    let sequences = |page: &super::HydratedPage| -> Vec<i64> {
        page.events
            .iter()
            .map(|event| i64::from(event.event.sequence))
            .collect()
    };

    let page = reads
        .read_page_hydrated(&log.session_id, -1)
        .expect("the first page reads");
    assert_eq!(sequences(&page), [first, second]);
    assert!(page.oversized.is_none());

    let page = reads
        .read_page_hydrated(&log.session_id, second)
        .expect("the long row's page reads");
    assert_eq!(sequences(&page), Vec::<i64>::new());
    let unloaded = page.oversized.expect("the long row comes back unloaded");
    assert_eq!(i64::from(unloaded.event.sequence), long);
    assert_eq!(unloaded.pieces.len(), 1);

    let page = reads
        .read_page_hydrated(&log.session_id, long)
        .expect("the last page reads");
    assert_eq!(sequences(&page), [last]);
}
