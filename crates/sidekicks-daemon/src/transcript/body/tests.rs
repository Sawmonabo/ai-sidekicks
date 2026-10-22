//! A long reply's parts read against its kept cut.

use sidekicks_contracts::jsonrpc::page::PAGE_MAX_BYTES;
use sidekicks_contracts::session::id::SessionId;
use zstd::zstd_safe;

use super::read_row_body;
use super::starts_cache::BlockCuts;
use crate::transcript::block_cut::MARKDOWN_PARSE;
use crate::transcript::test_log::{TranscriptTestLog, wire_message};

// A reply of three pages of paragraphs, stored as three frames.
fn long_reply() -> String {
    let paragraph = format!("{}\n\n", "A sentence of the reply's words. ".repeat(6));
    paragraph.repeat(3 * PAGE_MAX_BYTES / paragraph.len() + 1)
}

// Reads the part of `row_id`'s body from `offset` against `block_cuts`, answering its next offset,
// or the failure.
fn read_part(
    log: &TranscriptTestLog,
    block_cuts: &BlockCuts,
    row_id: &str,
    offset: u64,
) -> Result<Option<u64>, String> {
    let reader = log.reader();
    read_row_body(
        &reader,
        &|_: &SessionId| None,
        &log.session_id,
        row_id,
        offset,
        MARKDOWN_PARSE,
        block_cuts,
    )
    .map(|part| {
        let part = part.expect("a row stands at the reply");
        wire_message(&part).0["nextOffset"].as_u64()
    })
    .map_err(|error| error.to_string())
}

// Flips the checksum of the first frame of the body stored at `sequence`, so decoding it fails.
fn damage_first_frame(log: &TranscriptTestLog, sequence: i64) {
    let mut stored: Vec<u8> = log
        .writer
        .query_row(
            "SELECT content_payload FROM session_events WHERE sequence = ?1",
            [sequence],
            |row| row.get(0),
        )
        .expect("the body reads");
    let first_frame_bytes =
        zstd_safe::find_frame_compressed_size(&stored).expect("the first frame is whole");
    stored[first_frame_bytes - 1] ^= 0xff;
    log.writer
        .execute(
            "UPDATE session_events SET content_payload = ?1 WHERE sequence = ?2",
            rusqlite::params![stored, sequence],
        )
        .expect("the damaged body is written");
}

// Once an ended reply's first part has cut it, a later part decodes only the frames it covers:
// the first frame, damaged after that read, is never decoded again. A reply still taking pieces
// is read whole for each part, so the same damage fails its later part. Killed by an ended reply
// read whole for each part, and by a cut kept for a reply still taking pieces.
#[test]
fn an_ended_replys_later_part_reads_only_its_frames() {
    for is_ended in [true, false] {
        let log = TranscriptTestLog::new();
        let block_cuts = BlockCuts::default();
        let (sequence, row_id) = log.reply("m1", None, &long_reply());
        if is_ended {
            log.turn_end(log.run_id, 1);
        }
        let second = read_part(&log, &block_cuts, &row_id, 0)
            .expect("the first part reads")
            .expect("the reply has a second part");
        let third = read_part(&log, &block_cuts, &row_id, second)
            .expect("the second part reads")
            .expect("the reply has a third part");
        assert!(
            third > PAGE_MAX_BYTES as u64,
            "the third part starts past the first frame"
        );
        damage_first_frame(&log, sequence);
        let read = read_part(&log, &block_cuts, &row_id, third);
        assert_eq!(read.is_ok(), is_ended, "ended: {is_ended}, read: {read:?}");
    }
}
