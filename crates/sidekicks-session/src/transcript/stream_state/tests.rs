//! The stream's reads of stored pieces against damaged rows.

use rusqlite::params;
use sidekicks_contracts::wire::id::mint_uuid_v7;

use super::read_streamed_pieces;
use crate::transcript::test_log::TranscriptTestLog;
use sidekicks_store::events::content::codec::BodyDecodeError;
use sidekicks_store::events::session::read::MalformedStoredEventError;

// Writes a reply row at `sequence` holding `body`, its payload stored as `payload`, past the
// append path, as only damage leaves one.
fn plant_row(log: &TranscriptTestLog, sequence: i64, payload: &str, body: &[u8]) {
    log.session_log
        .writer
        .execute(
            "INSERT INTO session_events (id, session_id, sequence, occurred_at, monotonic_ns,
               category, type, payload, content_payload)
             VALUES (?1, ?2, ?3, '2026-10-21T09:00:00.000Z', 0, 'agentLifecycle',
               'agent.message.sent', ?4, ?5)",
            params![
                mint_uuid_v7().to_string(),
                log.session_log.session_id.text().as_str(),
                sequence,
                payload,
                body
            ],
        )
        .expect("the planted row is written");
}

// A body whose payload states no length is a damaged row, as the row read takes it, never a row
// with no body. Killed by sizing the body from its stated length, which reads a missing one as
// no body.
#[test]
fn a_body_with_no_stated_length_is_refused() {
    let log = TranscriptTestLog::new(crate::questions::schema::schema_parts());
    plant_row(&log, 0, "{}", b"a body with no stated length");
    let reader = log.session_log.reader();
    let Err(rusqlite::Error::FromSqlConversionFailure(_, _, cause)) =
        read_streamed_pieces(&reader, &log.session_log.session_id, &[0])
    else {
        panic!("the row is refused");
    };
    assert!(
        matches!(
            cause.downcast_ref::<BodyDecodeError>(),
            Some(BodyDecodeError::NoLength)
        ),
        "{cause}"
    );
}

// A payload no JSON function reads fails the read as the damaged row it is, named by its
// sequence. Killed by answering SQLite's bare failure, which names no row.
#[test]
fn a_payload_that_is_no_json_is_named_as_damage() {
    let log = TranscriptTestLog::new(crate::questions::schema::schema_parts());
    plant_row(&log, 0, "{\"contentLength\": 4}", b"good");
    plant_row(&log, 1, "{not json", b"damaged");
    let reader = log.session_log.reader();
    let Err(rusqlite::Error::FromSqlConversionFailure(_, _, cause)) =
        read_streamed_pieces(&reader, &log.session_log.session_id, &[0, 1])
    else {
        panic!("the read is refused");
    };
    let malformed = cause
        .downcast_ref::<MalformedStoredEventError>()
        .expect("the refusal names the damaged row");
    assert_eq!(malformed.sequence, 1);
    assert_eq!(
        malformed.session_id,
        log.session_log.session_id.text().as_str()
    );
}
