//! The patch read's tests.

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::event::declared_variants::CONTENT_PAYLOAD_PLAINTEXT_MAX;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::content::TranscriptPatchListRequest;
use sidekicks_contracts::transcript::limits::TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES;

use super::{PatchListError, list_patches};
use crate::transcript::block_cut::MARKDOWN_PARSE;
use crate::transcript::body::read_row_body;
use crate::transcript::test_log::{TranscriptTestLog, wire_message};
use crate::transcript::whole_patch::text_of_part;
use crate::transcript::window::{TranscriptReadError, read_transcript_window};

fn list(log: &TranscriptTestLog, tool_call_id: &str, cursor: Option<&Value>) -> Value {
    let page = list_patches(
        &log.reader(),
        &|_: &SessionId| None,
        &request(log, tool_call_id, cursor),
    )
    .expect("the patches read");
    wire_message(&page).0
}

// The session's first window page, as JSON.
fn window(log: &TranscriptTestLog) -> Value {
    let request = serde_json::from_value(json!({ "sessionId": log.session_id }))
        .expect("the test's request reads");
    let window = read_transcript_window(
        &log.reader(),
        &|_: &SessionId| None,
        &request,
        MARKDOWN_PARSE,
    )
    .expect("the window reads");
    wire_message(&window).0
}

fn request(
    log: &TranscriptTestLog,
    tool_call_id: &str,
    cursor: Option<&Value>,
) -> TranscriptPatchListRequest {
    let mut request = json!({ "sessionId": log.session_id, "toolCallId": tool_call_id });
    if let Some(cursor) = cursor {
        request["cursor"] = cursor.clone();
    }
    serde_json::from_value(request).expect("the test's request reads")
}

// The `omittedPatches` entry naming each of `files`, sized as its text.
fn named(files: &[Value]) -> Value {
    files
        .iter()
        .map(|file| {
            let text = file["patch"].as_str().or(file["rawPatch"].as_str());
            let mut entry = json!({ "path": file["path"], "size": text.map_or(0, str::len) });
            if !file["oldPath"].is_null() {
                entry["oldPath"] = file["oldPath"].clone();
            }
            entry
        })
        .collect()
}

// Writes a completion of `tool_call_id` holding `files`; returns its sequence and event id.
fn completion_of(log: &TranscriptTestLog, tool_call_id: &str, files: &[Value]) -> (i64, String) {
    let body = json!({ "files": files }).to_string();
    log.tool_completion(log.run_id, tool_call_id, Some(named(files)), Some(&body))
}

// The stored parts of file `file_index`'s text of the completion at `completion`: each one's
// sequence, the offset its text starts at, its decoded length and its stored body.
fn text_parts(
    log: &TranscriptTestLog,
    completion: i64,
    file_index: i64,
) -> Vec<(i64, usize, usize, Vec<u8>)> {
    let reader = log.reader();
    let mut statement = reader
        .prepare(
            "SELECT sequence, patch_text_offset, content_payload FROM session_events
              WHERE joins_sequence = ?1 AND patch_file_index = ?2
                AND patch_text_offset IS NOT NULL
              ORDER BY sequence",
        )
        .expect("the test's read prepares");
    statement
        .query_map([completion, file_index], |row| {
            let body: Vec<u8> = row.get(2)?;
            let text = text_of_part(std::str::from_utf8(&body).expect("a part is UTF-8"))
                .expect("a part reads as string content");
            let offset: i64 = row.get(1)?;
            let offset = usize::try_from(offset).expect("an offset is not negative");
            Ok((row.get(0)?, offset, text.len(), body))
        })
        .expect("the test reads the parts")
        .collect::<rusqlite::Result<_>>()
        .expect("the test reads the parts")
}

// One page read: the cursor it was asked from, the page, and the range of one file's text it
// answered, where it answered any.
type PageRead = (Option<Value>, Value, Option<(usize, usize)>);

// Each page's read and the range of `file_index`'s text it answered, from the first file on
// until no page follows.
fn pages_of(log: &TranscriptTestLog, tool_call_id: &str, file_index: u64) -> Vec<PageRead> {
    let mut pages = Vec::new();
    let mut cursor: Option<Value> = None;
    loop {
        let page = list(log, tool_call_id, cursor.as_ref());
        let start = cursor
            .as_ref()
            .filter(|cursor| cursor["fileIndex"] == file_index)
            .and_then(|cursor| cursor["offset"].as_u64())
            .map_or(0, |offset| usize::try_from(offset).expect("an offset fits"));
        let first = cursor
            .as_ref()
            .and_then(|cursor| cursor["fileIndex"].as_u64())
            .unwrap_or(0);
        let files = page["files"].as_array().expect("a page holds files");
        let range = usize::try_from(file_index.checked_sub(first).unwrap_or(u64::MAX))
            .ok()
            .and_then(|place| files.get(place))
            .and_then(|file| file["patch"].as_str().or(file["rawPatch"].as_str()))
            .map(|text| (start, start + text.len()));
        let next = page["next"].clone();
        pages.push((cursor, page, range));
        if next.is_null() {
            return pages;
        }
        cursor = Some(next);
    }
}

// Killed by a moved file's old path dropped, by a text part over the stored cap or cut inside
// an escape or a character, by a cursor inside a character accepted, by the parts' bodies not
// joining back into the file list, by an absent file read as another, by a page loading a part
// of the text it does not answer beyond the one after it, by a malformed part read as text,
// and by a call the session does not hold read as one with no patches.
#[test]
fn patch_list_reads_a_file_over_the_cap_across_pages_loading_only_the_parts_each_answers() {
    let log = TranscriptTestLog::new();
    let patch = "@@ -1 +1 @@\n-old\n+new\n";
    // Twelve code points stored per five characters: an astral one, two short escapes and a
    // six-character one; several parts past the cap.
    let raw_patch = "\u{1f600}\"\n\u{1}x".repeat(80_000);
    let files = [
        json!({
            "path": "/repo/new.rs",
            "oldPath": "/repo/old.rs",
            "patch": patch,
            "additions": 1,
            "deletions": 1,
        }),
        json!({ "path": "/repo/odd.bin", "unavailable": "unreadable", "rawPatch": raw_patch }),
        json!({ "path": "/repo/gone.rs", "unavailable": "absent" }),
    ];
    let (completion, row_id) = completion_of(&log, "call-1", &files);

    let parts = text_parts(&log, completion, 1);
    assert!(parts.len() > 2);
    for (_, _, _, body) in &parts {
        let body = std::str::from_utf8(body).expect("a part is UTF-8");
        assert!(body.chars().count() <= CONTENT_PAYLOAD_PLAINTEXT_MAX);
    }
    let window = window(&log);
    assert_eq!(window["entries"].as_array().map(Vec::len), Some(1));
    assert_eq!(
        window["entries"][0]["omittedPatches"][0]["oldPath"],
        "/repo/old.rs"
    );
    let mut joined = String::new();
    let mut offset = Some(0);
    while let Some(part_offset) = offset {
        let part = read_row_body(
            &log.reader(),
            &|_: &SessionId| None,
            &log.session_id,
            &row_id,
            part_offset,
            MARKDOWN_PARSE,
        )
        .expect("the body reads")
        .expect("a row stands at the completion");
        let part = wire_message(&part).0;
        joined.push_str(part["body"].as_str().expect("the part is available"));
        offset = part["nextOffset"].as_u64();
    }
    let joined: Value = serde_json::from_str(&joined).expect("the joined body reads");
    assert_eq!(joined, json!({ "files": files }));

    let pages = pages_of(&log, "call-1", 1);
    assert!(pages.len() > 1);
    let mut texts = [String::new(), String::new()];
    let mut is_absent_read = false;
    for (_, page, _) in &pages {
        for file in page["files"].as_array().expect("a page holds files") {
            if file["path"] == "/repo/gone.rs" {
                assert_eq!(file["unavailable"], "absent");
                is_absent_read = true;
                continue;
            }
            let index = usize::from(file["path"] == "/repo/odd.bin");
            if index == 0 {
                assert_eq!(file["oldPath"], "/repo/old.rs");
            }
            let text = file["patch"].as_str().or(file["rawPatch"].as_str());
            texts[index].push_str(text.expect("a file carries its text"));
        }
    }
    assert!(is_absent_read);
    assert_eq!(texts, [patch.to_owned(), raw_patch]);

    // Every part a page does not answer, but the one starting where it stops, is broken, and
    // the page still reads the same.
    for (cursor, page, range) in &pages {
        let Some((start, end)) = *range else {
            continue;
        };
        let unanswered: Vec<i64> = parts
            .iter()
            .filter(|&&(_, offset, length, _)| {
                let is_answered = offset < end && offset + length > start;
                !is_answered && offset != end
            })
            .map(|(sequence, ..)| *sequence)
            .collect();
        for sequence in &unanswered {
            log.writer
                .execute(
                    "UPDATE session_events SET content_payload = ?1 WHERE sequence = ?2",
                    (br"\q".as_slice(), sequence),
                )
                .expect("the test breaks a part");
        }
        assert_eq!(&list(&log, "call-1", cursor.as_ref()), page);
        for (sequence, _, _, body) in &parts {
            log.writer
                .execute(
                    "UPDATE session_events SET content_payload = ?1 WHERE sequence = ?2",
                    (body.as_slice(), sequence),
                )
                .expect("the test restores a part");
        }
    }

    let inside_a_character = json!({ "fileIndex": 1, "offset": 1 });
    let refused = list_patches(
        &log.reader(),
        &|_: &SessionId| None,
        &request(&log, "call-1", Some(&inside_a_character)),
    );
    assert!(matches!(refused, Err(PatchListError::Cursor(_))));
    log.writer
        .execute(
            "UPDATE session_events SET content_payload = ?1 WHERE sequence = ?2",
            (br"\q".as_slice(), parts[0].0),
        )
        .expect("the test breaks a part");
    let malformed = list_patches(
        &log.reader(),
        &|_: &SessionId| None,
        &request(
            &log,
            "call-1",
            Some(&json!({ "fileIndex": 1, "offset": 0 })),
        ),
    );
    assert!(
        matches!(
            malformed,
            Err(PatchListError::StoredFile {
                file_index: 1,
                cause: Some(_),
                ..
            })
        ),
        "{malformed:?}"
    );
    let unknown = list_patches(
        &log.reader(),
        &|_: &SessionId| None,
        &request(&log, "call-2", None),
    );
    let Err(PatchListError::Read(TranscriptReadError::Refused(refusal))) = unknown else {
        panic!("a call the session does not hold is refused");
    };
    assert_eq!(refusal.code, RefusalCode::TranscriptRowNotFound);
}

// Killed by a file with a skipped part answered from its readable parts or failing the page,
// and by its path taken from anywhere but the completion's list.
#[test]
fn patch_list_answers_a_file_with_a_skipped_part_as_damaged_in_its_place() {
    let log = TranscriptTestLog::new();
    let files = [
        json!({ "path": "/repo/a.rs", "patch": "@@ a", "additions": 0, "deletions": 0 }),
        json!({
            "path": "/repo/b.rs",
            "oldPath": "/repo/was.rs",
            "patch": "@@ b",
            "additions": 0,
            "deletions": 0,
        }),
        json!({ "path": "/repo/c.rs", "unavailable": "absent" }),
    ];
    let (completion, _) = completion_of(&log, "call-1", &files);
    let (skipped, ..) = text_parts(&log, completion, 1)[0];
    log.skip(skipped, skipped);

    let damaged =
        json!({ "path": "/repo/b.rs", "oldPath": "/repo/was.rs", "unavailable": "damaged" });
    assert_eq!(
        list(&log, "call-1", None),
        json!({
            "files": [
                { "path": "/repo/a.rs", "patch": "@@ a", "additions": 0, "deletions": 0 },
                damaged,
                files[2],
            ],
            "next": null,
        })
    );
    assert_eq!(
        list(
            &log,
            "call-1",
            Some(&json!({ "fileIndex": 1, "offset": 2 }))
        )["files"][0],
        damaged
    );
}

// Killed by a completion's parts joined by anything but its own id: a second completion of
// the same call in the turn would then join the first, and its parts with it.
#[test]
fn patch_list_keeps_two_completions_of_one_call_in_one_turn_apart() {
    let log = TranscriptTestLog::new();
    let file = |path: &str| json!({ "path": path, "unavailable": "absent" });
    let (first, _) = completion_of(&log, "call-1", &[file("/repo/a.rs")]);
    let (second, _) = completion_of(&log, "call-1", &[file("/repo/b.rs"), file("/repo/c.rs")]);

    let joins: Vec<(i64, Option<i64>)> = log
        .reader()
        .prepare("SELECT sequence, joins_sequence FROM session_events ORDER BY sequence")
        .expect("the test's read prepares")
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("the test reads the stamps")
        .collect::<rusqlite::Result<_>>()
        .expect("the test reads the stamps");
    assert_eq!(
        joins,
        [
            (first, None),
            (first + 1, Some(first)),
            (second, None),
            (second + 1, Some(second)),
            (second + 2, Some(second)),
        ]
    );
    assert_eq!(
        list(&log, "call-1", None),
        json!({ "files": [file("/repo/b.rs"), file("/repo/c.rs")], "next": null })
    );
}

// Killed by an empty list taken as naming files, whose body would be stored as the list's opening
// alone, and by an empty list on a body over the inline cap read as a malformed row.
#[rstest]
#[case::an_inline_body(r#"{"files":[]}"#.to_owned())]
#[case::a_body_over_the_inline_cap(format!(
    r#"{{"files":[],"note":"{}"}}"#,
    "a".repeat(TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES)
))]
fn a_completion_naming_no_files_stores_its_body_whole(#[case] body: String) {
    let log = TranscriptTestLog::new();
    let (completion, row_id) =
        log.tool_completion(log.run_id, "call-1", Some(json!([])), Some(&body));

    let parts: i64 = log
        .reader()
        .query_row(
            "SELECT count(*) FROM session_events WHERE joins_sequence = ?1",
            [completion],
            |row| row.get(0),
        )
        .expect("the test counts the completion's parts");
    assert_eq!(parts, 0);
    let read_back = read_row_body(
        &log.reader(),
        &|_: &SessionId| None,
        &log.session_id,
        &row_id,
        0,
        MARKDOWN_PARSE,
    )
    .expect("the body reads")
    .expect("a row stands at the completion");
    let read_back = wire_message(&read_back).0;
    assert_eq!(read_back["body"], body.as_str());
    assert_eq!(read_back["nextOffset"], Value::Null);
    assert_eq!(
        list(&log, "call-1", None),
        json!({ "files": [], "next": null })
    );
    let window = window(&log);
    assert_eq!(window["entries"].as_array().map(Vec::len), Some(1));
    assert!(window["entries"][0].get("omittedPatches").is_none());
}
