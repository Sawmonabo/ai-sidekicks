//! `transcript.patch.list`: every patch one tool call's row left out, read from the call's
//! completion. A completion that holds patches names its files in its payload's `omittedPatches`
//! and stores each file in a row of its own that joins the completion's, in the shape the read
//! answers but never cut. A read answers the files from its cursor on, as many as fit one page,
//! loading only the files it answers and at most one more, a file too long for what is left of
//! the page cut at a character boundary and continued by the next read from `{fileIndex, offset}`.

use std::sync::LazyLock;

use rusqlite::{Connection, OptionalExtension, named_params};
use serde_json::json;
use sidekicks_contracts::event::declared_variants::CONTENT_PAYLOAD_PLAINTEXT_MAX;
use sidekicks_contracts::jsonrpc::byte_length::json_utf8_byte_length;
use sidekicks_contracts::jsonrpc::page::PAGE_MAX_BYTES;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::content::{
    BodyReadOffsetRefused, TranscriptPatchCursor, TranscriptPatchFile, TranscriptPatchFileAbsent,
    TranscriptPatchFileRead, TranscriptPatchFileUnreadable, TranscriptPatchListRequest,
    TranscriptPatchListResponse,
};
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::BoundedText;

use crate::database::connection::read_pool::DatabaseReadError;
use crate::database::stored_column::optional_utf8_blob_column;
use crate::events::session::read::{SessionEventReads, readable_event_sql};
use crate::ipc::domain_error::DomainError;
use crate::ipc::registry::HandlerError;
use crate::transcript::whole_patch::{
    OMITTED_PATCHES_PAYLOAD_KEY, WholePatchFile, patch_file_of_piece,
};
use crate::transcript::window::{TranscriptReadError, read_transcript_head};

// The call's newest readable completion row, found by the call the insert stamped on it: its
// sequence and how many patched files it names.
static COMPLETION_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT event.sequence,
            coalesce(json_array_length(event.payload, '$.{OMITTED_PATCHES_PAYLOAD_KEY}'), 0)
       FROM session_events AS event
      WHERE event.session_id = @session_id AND event.tool_call_id = @tool_call_id
        AND {readable}
      ORDER BY event.sequence DESC
      LIMIT 1",
        readable = readable_event_sql("event"),
    )
});

// One patched file's row of a completion, the `@file_index`th in log order, with whether it can
// be read and its stored body.
static FILE_PIECE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {readable}, event.content_payload
       FROM session_events AS event
      WHERE event.session_id = @session_id AND event.joins_sequence = @completion_sequence
      ORDER BY event.sequence
      LIMIT 1 OFFSET @file_index",
        readable = readable_event_sql("event"),
    )
});

/// Why a patch read failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum PatchListError {
    /// The session is not one this daemon holds, the call is not one it holds, or a read failed.
    #[error(transparent)]
    Read(#[from] TranscriptReadError),
    /// The cursor names no file of the call, or no place in its text.
    #[error(transparent)]
    Cursor(#[from] BodyReadOffsetRefused),
    /// A completion that names patches holds no readable stored file where its list names one,
    /// which only a write outside the producer or a damaged log can leave.
    #[error("the completion of tool call {tool_call_id} holds no readable file {file_index}")]
    StoredFile {
        /// The call.
        tool_call_id: String,
        /// The file's place in the call's list.
        file_index: usize,
        /// Why the file did not read; absent when its row is missing or skipped.
        #[source]
        cause: Option<serde_json::Error>,
    },
}

impl From<PatchListError> for HandlerError {
    /// A refusal answers by its code; a failed read is a fault in the daemon.
    fn from(error: PatchListError) -> Self {
        match error {
            PatchListError::Read(error) => error.into(),
            PatchListError::Cursor(refused) => refused.into(),
            fault @ PatchListError::StoredFile { .. } => Self::Internal(Box::new(fault)),
        }
    }
}

impl From<DatabaseReadError> for PatchListError {
    fn from(error: DatabaseReadError) -> Self {
        Self::Read(error.into())
    }
}

/// The stored files of one completion, each loaded when the page first reaches it.
struct StoredPatchFiles<'read> {
    reader: &'read Connection,
    session_id: &'read SessionId,
    tool_call_id: &'read str,
    read_bound: i64,
    completion_sequence: i64,
    count: usize,
}

impl StoredPatchFiles<'_> {
    /// File `file_index` of the completion's list. Fails when SQLite refuses the read or the file
    /// is missing, skipped or does not read as a file.
    fn file(&self, file_index: usize) -> Result<WholePatchFile, PatchListError> {
        let missing = |cause| PatchListError::StoredFile {
            tool_call_id: self.tool_call_id.to_owned(),
            file_index,
            cause,
        };
        let piece: Option<(bool, Option<String>)> = self
            .reader
            .prepare_cached(&FILE_PIECE_SQL)
            .and_then(|mut statement| {
                statement
                    .query_row(
                        named_params! {
                            "@session_id": self.session_id.text().as_str(),
                            "@completion_sequence": self.completion_sequence,
                            "@file_index": i64::try_from(file_index).unwrap_or(i64::MAX),
                            "@read_bound": self.read_bound,
                        },
                        |row| Ok((row.get(0)?, optional_utf8_blob_column(row, 1)?)),
                    )
                    .optional()
            })
            .map_err(TranscriptReadError::from)?;
        let Some((true, Some(piece))) = piece else {
            return Err(missing(None));
        };
        let file =
            patch_file_of_piece(&piece, file_index, self.count).ok_or_else(|| missing(None))?;
        serde_json::from_str(file).map_err(|cause| missing(Some(cause)))
    }
}

/// Reads one page of the patches `request`'s tool call left out, on `reader`;
/// `read_damaged_from_sequence` answers where a damaged session's reads stop. Fails with
/// [`TranscriptReadError::Refused`] for a session this daemon holds no events for
/// (`session.notFound`) or a call it holds no completion of (`transcript.row.notFound`), with
/// [`PatchListError::Cursor`] for a cursor that names no file or no place in its text, and with
/// [`PatchListError::StoredFile`] for a named file that is not stored readable.
pub(crate) fn list_patches<DamagedFrom>(
    reader: &Connection,
    read_damaged_from_sequence: &DamagedFrom,
    request: &TranscriptPatchListRequest,
) -> Result<TranscriptPatchListResponse, PatchListError>
where
    DamagedFrom: Fn(&SessionId) -> Option<i64> + ?Sized,
{
    let snapshot = reader
        .unchecked_transaction()
        .map_err(TranscriptReadError::from)?;
    let reads = SessionEventReads::new(reader, read_damaged_from_sequence);
    read_transcript_head(&reads, read_damaged_from_sequence, &request.session_id)?;
    let read_bound = reads.read_bound(&request.session_id, None);
    let completion: Option<(i64, i64)> = reader
        .prepare_cached(&COMPLETION_SQL)
        .and_then(|mut statement| {
            statement
                .query_row(
                    named_params! {
                        "@session_id": request.session_id.text().as_str(),
                        "@tool_call_id": request.tool_call_id.as_str(),
                        "@read_bound": read_bound,
                    },
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
        })
        .map_err(TranscriptReadError::from)?;
    let Some((completion_sequence, count)) = completion else {
        return Err(TranscriptReadError::from(
            DomainError::new(
                "This session holds no completed tool call with that id.",
                RefusalCode::TranscriptRowNotFound,
            )
            .with_detail(json!({ "toolCallId": request.tool_call_id })),
        )
        .into());
    };
    let files = StoredPatchFiles {
        reader,
        session_id: &request.session_id,
        tool_call_id: request.tool_call_id.as_str(),
        read_bound,
        completion_sequence,
        count: usize::try_from(count).expect("a list's length is not negative"),
    };
    let page = patch_page_of(&files, request.cursor)?;
    snapshot.commit().map_err(TranscriptReadError::from)?;
    Ok(page)
}

// The page of `files` from `cursor` on, the first file's start when absent, loading each file it
// reaches. Refuses a cursor past the last file, past its file's text, inside a character, or into
// a file that has no text.
fn patch_page_of(
    files: &StoredPatchFiles<'_>,
    cursor: Option<TranscriptPatchCursor>,
) -> Result<TranscriptPatchListResponse, PatchListError> {
    let (file_index, offset) = cursor.map_or((0, 0), |cursor| {
        (
            usize::try_from(cursor.file_index.get()).unwrap_or(usize::MAX),
            cursor.offset.get(),
        )
    });
    let refused = |text_length: usize| BodyReadOffsetRefused {
        offset,
        body_length: text_length,
    };
    if file_index > files.count || (file_index == files.count && offset > 0) {
        return Err(refused(0).into());
    }
    let mut start = usize::try_from(offset).unwrap_or(usize::MAX);
    // The two brackets are charged up front; every entry past the first also charges a comma.
    let mut used_bytes = 2;
    let mut page = Vec::new();
    for index in file_index..files.count {
        let file = files.file(index)?;
        let text = text_of(&file);
        if index == file_index && !text.is_char_boundary(start) {
            return Err(refused(text.len()).into());
        }
        let separator_bytes = usize::from(!page.is_empty());
        let budget = PAGE_MAX_BYTES.saturating_sub(used_bytes + separator_bytes);
        // A file with text left takes at least one character, else the page ends before it.
        let Some(end) =
            part_end(&file, start, budget).filter(|&end| end > start || text.is_empty())
        else {
            return Ok(TranscriptPatchListResponse {
                files: page,
                next: Some(patch_cursor(index, start)),
            });
        };
        let entry = entry_of(&file, start, end);
        used_bytes += separator_bytes + json_utf8_byte_length(&entry).expect("a file serializes");
        page.push(entry);
        if end < text.len() {
            return Ok(TranscriptPatchListResponse {
                files: page,
                next: Some(patch_cursor(index, end)),
            });
        }
        start = 0;
    }
    Ok(TranscriptPatchListResponse {
        files: page,
        next: None,
    })
}

// The text a file's part is cut from: its patch, the raw text as sent, or none.
fn text_of(file: &WholePatchFile) -> &str {
    match file {
        WholePatchFile::Read { patch, .. } => patch,
        WholePatchFile::Unreadable { raw_patch, .. } => raw_patch,
        WholePatchFile::Absent { .. } => "",
    }
}

// Where the part of `file` from `start` ends: the furthest character boundary, at most one stored
// text's cap in code points on, whose entry's JSON fits `budget`; `None` when not even the entry
// with no text fits.
fn part_end(file: &WholePatchFile, start: usize, budget: usize) -> Option<usize> {
    let text = text_of(file);
    let cap_end = text[start..]
        .char_indices()
        .nth(CONTENT_PAYLOAD_PLAINTEXT_MAX)
        .map_or(text.len(), |(index, _)| start + index);
    let fits = |end: usize| {
        json_utf8_byte_length(&entry_of(file, start, end)).is_ok_and(|length| length <= budget)
    };
    if fits(cap_end) {
        return Some(cap_end);
    }
    if !fits(start) {
        return None;
    }
    // The fitting ends form a prefix of the boundaries, so the last one is found by halving.
    let (mut fitting, mut over) = (start, cap_end);
    loop {
        let middle = text.floor_char_boundary(fitting + (over - fitting) / 2);
        if middle == fitting {
            return Some(fitting);
        }
        if fits(middle) {
            fitting = middle;
        } else {
            over = middle;
        }
    }
}

// The entry of `file` carrying its text from `start` to `end`.
fn entry_of(file: &WholePatchFile, start: usize, end: usize) -> TranscriptPatchFile {
    let part = |text: &str| {
        BoundedText::new(text[start..end].to_owned()).expect("a part is within one stored cap")
    };
    match file {
        WholePatchFile::Read {
            path,
            old_path,
            patch,
            additions,
            deletions,
        } => TranscriptPatchFile::Read(TranscriptPatchFileRead {
            path: path.clone(),
            old_path: old_path.clone(),
            patch: part(patch),
            additions: safe_count(*additions),
            deletions: safe_count(*deletions),
            unavailable: None,
            raw_patch: None,
        }),
        WholePatchFile::Absent {
            path,
            old_path,
            unavailable,
        } => TranscriptPatchFile::Absent(TranscriptPatchFileAbsent {
            path: path.clone(),
            old_path: old_path.clone(),
            unavailable: *unavailable,
            patch: None,
            additions: None,
            deletions: None,
            raw_patch: None,
        }),
        WholePatchFile::Unreadable {
            path,
            old_path,
            unavailable,
            raw_patch,
        } => TranscriptPatchFile::Unreadable(TranscriptPatchFileUnreadable {
            path: path.clone(),
            old_path: old_path.clone(),
            unavailable: *unavailable,
            raw_patch: part(raw_patch),
            patch: None,
            additions: None,
            deletions: None,
        }),
    }
}

fn safe_count(count: u64) -> SafeInt<0> {
    SafeInt::new(count).expect("a patch's line count is a safe integer")
}

fn patch_cursor(file_index: usize, offset: usize) -> TranscriptPatchCursor {
    let safe = |value: usize| {
        u64::try_from(value)
            .ok()
            .and_then(SafeInt::new)
            .expect("a file index or byte offset lies far below 2^53")
    };
    TranscriptPatchCursor {
        file_index: safe(file_index),
        offset: safe(offset),
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::{Value, json};
    use sidekicks_contracts::event::declared_variants::CONTENT_PAYLOAD_PLAINTEXT_MAX;
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::transcript::content::TranscriptPatchListRequest;

    use super::{PatchListError, list_patches};
    use crate::transcript::block_cut::MARKDOWN_PARSE;
    use crate::transcript::body::read_row_body;
    use crate::transcript::test_log::{TranscriptTestLog, wire_message};
    use crate::transcript::window::{TranscriptReadError, read_transcript_window};

    fn list(log: &TranscriptTestLog, tool_call_id: &str, cursor: Option<&Value>) -> Value {
        let request = request(log, tool_call_id, cursor);
        let page =
            list_patches(&log.reader(), &|_: &SessionId| None, &request).expect("the patches read");
        wire_message(&page).0
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
                json!({ "path": file["path"], "size": text.map_or(0, str::len) })
            })
            .collect()
    }

    // Killed by a moved file's old path dropped from the row or the read, by a part cut inside a
    // character or a cursor there accepted, by a file left out of the joined read, by a file cut
    // at the stored cap, by the files stored in one row, which the window would stand as several
    // or a read would load whole, by the rows' bodies not joining back into the file list, by an
    // absent file read as another, and by a call the session does not hold read as one with no
    // patches.
    #[test]
    fn patch_list_reads_every_left_out_file_whole_across_pages() {
        let log = TranscriptTestLog::new();
        let patch = "@@ -1 +1 @@\n-old\n+new\n";
        // Four bytes a character and past the stored cut, which a patched file is stored whole
        // outside of.
        let raw_patch = "\u{1f600}".repeat(CONTENT_PAYLOAD_PLAINTEXT_MAX + 10_000);
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
        let body = json!({ "files": files }).to_string();
        let mut omitted = named(&files);
        omitted[0]["oldPath"] = json!("/repo/old.rs");
        let (completion, row_id) =
            log.tool_completion(log.run_id, "call-1", Some(omitted), Some(&body));

        let file_rows: i64 = log
            .reader()
            .query_row(
                "SELECT count(*) FROM session_events WHERE joins_sequence = ?1",
                [completion],
                |row| row.get(0),
            )
            .expect("the test counts the file rows");
        assert_eq!(file_rows, 3);
        let window_request = serde_json::from_value(json!({ "sessionId": log.session_id }))
            .expect("the test's request reads");
        let page = read_transcript_window(
            &log.reader(),
            &|_: &SessionId| None,
            &window_request,
            MARKDOWN_PARSE,
        )
        .expect("the window reads");
        let page = wire_message(&page).0;
        assert_eq!(page["entries"].as_array().map(Vec::len), Some(1));
        assert_eq!(
            page["entries"][0]["omittedPatches"][0]["oldPath"],
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
        assert_eq!(joined, body);

        let mut texts = [String::new(), String::new()];
        let mut is_absent_read = false;
        let mut cursor: Option<Value> = None;
        let mut reads = 0;
        loop {
            let part = list(&log, "call-1", cursor.as_ref());
            reads += 1;
            for file in part["files"].as_array().expect("a page holds files") {
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
            if part["next"].is_null() {
                break;
            }
            cursor = Some(part["next"].clone());
        }
        assert!(reads > 1);
        assert!(is_absent_read);
        assert_eq!(texts, [patch.to_owned(), raw_patch]);

        let inside_a_character = json!({ "fileIndex": 1, "offset": 1 });
        let refused = list_patches(
            &log.reader(),
            &|_: &SessionId| None,
            &request(&log, "call-1", Some(&inside_a_character)),
        );
        assert!(matches!(refused, Err(PatchListError::Cursor(_))));
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

    // Killed by a stored file read as absent when it carries no `unavailable: "absent"` or a
    // member no arm takes.
    #[rstest]
    #[case::a_patch_of_the_wrong_type(json!({ "path": "/repo/a.rs", "patch": 5 }))]
    #[case::an_unreadable_file_with_no_raw_text(
        json!({ "path": "/repo/a.rs", "unavailable": "unreadable" })
    )]
    #[case::an_absent_file_with_a_member_no_arm_takes(
        json!({ "path": "/repo/a.rs", "unavailable": "absent", "patch": "@@" })
    )]
    #[case::a_file_with_no_reason(json!({ "path": "/repo/a.rs" }))]
    fn patch_list_fails_on_a_stored_file_no_arm_reads(#[case] file: Value) {
        let log = TranscriptTestLog::new();
        let body = json!({ "files": [file] }).to_string();
        log.tool_completion(
            log.run_id,
            "call-1",
            Some(json!([{ "path": "/repo/a.rs", "size": 0 }])),
            Some(&body),
        );

        let read = list_patches(
            &log.reader(),
            &|_: &SessionId| None,
            &request(&log, "call-1", None),
        );
        assert!(
            matches!(
                read,
                Err(PatchListError::StoredFile {
                    file_index: 0,
                    cause: Some(_),
                    ..
                })
            ),
            "{read:?}"
        );
    }
}
