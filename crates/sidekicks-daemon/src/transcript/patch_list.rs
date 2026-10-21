//! `transcript.patch.list`: every patch one tool call's row left out, read from the call's
//! completion. A completion that holds patches stores its body whole as `{"files": [...]}`, each
//! file in the shape the read answers but never cut, and names its files in its payload's
//! `omittedPatches`. A read answers the files from its cursor on, as many as fit one page, a file
//! too long for what is left of the page cut at a character boundary and continued by the next
//! read from `{fileIndex, offset}`.

use std::sync::LazyLock;

use rusqlite::{Connection, OptionalExtension, named_params};
use serde::Deserialize;
use serde_json::json;
use sidekicks_contracts::event::declared_variants::CONTENT_PAYLOAD_PLAINTEXT_MAX;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::jsonrpc::byte_length::json_utf8_byte_length;
use sidekicks_contracts::jsonrpc::page::PAGE_MAX_BYTES;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::content::{
    BodyReadOffsetRefused, TranscriptPatchAbsentReason, TranscriptPatchCursor, TranscriptPatchFile,
    TranscriptPatchFileAbsent, TranscriptPatchFileRead, TranscriptPatchFileUnreadable,
    TranscriptPatchListRequest, TranscriptPatchListResponse, TranscriptPatchUnreadableReason,
};
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::BoundedText;

use crate::database::connection::read_pool::DatabaseReadError;
use crate::database::stored_column::optional_utf8_blob_column;
use crate::events::session::read::{SessionEventReads, readable_event_sql};
use crate::ipc::domain_error::DomainError;
use crate::ipc::registry::HandlerError;
use crate::transcript::whole_patch::WholePatchFile;
use crate::transcript::window::{TranscriptReadError, read_transcript_head};

/// The payload member of a tool completion that names the files its body's patches cover.
const OMITTED_PATCHES_PAYLOAD_KEY: &str = "omittedPatches";

// The call's newest readable completion: whether it names patches, and its body.
static COMPLETION_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT json_type(event.payload, '$.{OMITTED_PATCHES_PAYLOAD_KEY}') IS NOT NULL,
            event.content_payload
       FROM session_events AS event
      WHERE event.session_id = @session_id AND event.type = '{completed}'
        AND event.run_id IS NOT NULL
        AND json_extract(event.payload, '$.toolCallId') = @tool_call_id AND {readable}
      ORDER BY event.sequence DESC
      LIMIT 1",
        completed = SessionEventType::AgentToolCallCompleted.as_str(),
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
    /// A completion that names patches holds a body that is not its stored file list, which only
    /// a write outside the producer can leave.
    #[error("the completion of tool call {tool_call_id} holds no readable file list")]
    StoredFiles {
        /// The call.
        tool_call_id: String,
        /// Why the body did not read.
        #[source]
        cause: serde_json::Error,
    },
}

impl From<PatchListError> for HandlerError {
    /// A refusal answers by its code; a failed read is a fault in the daemon.
    fn from(error: PatchListError) -> Self {
        match error {
            PatchListError::Read(error) => error.into(),
            PatchListError::Cursor(refused) => refused.into(),
            fault @ PatchListError::StoredFiles { .. } => Self::Internal(Box::new(fault)),
        }
    }
}

impl From<DatabaseReadError> for PatchListError {
    fn from(error: DatabaseReadError) -> Self {
        Self::Read(error.into())
    }
}

/// The stored file list of a patch-bearing completion.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredPatchFiles {
    files: Vec<StoredPatchFile>,
}

/// One stored file: its patch, no patch, or the text a provider sent that could not be read.
#[derive(Deserialize)]
#[serde(untagged)]
enum StoredPatchFile {
    Read {
        path: FilesystemPath,
        #[serde(default, rename = "oldPath")]
        old_path: Option<FilesystemPath>,
        patch: String,
        additions: u64,
        deletions: u64,
    },
    Unreadable {
        path: FilesystemPath,
        #[serde(default, rename = "oldPath")]
        old_path: Option<FilesystemPath>,
        unavailable: TranscriptPatchUnreadableReason,
        #[serde(rename = "rawPatch")]
        raw_patch: String,
    },
    Absent {
        path: FilesystemPath,
        #[serde(default, rename = "oldPath")]
        old_path: Option<FilesystemPath>,
        unavailable: TranscriptPatchAbsentReason,
    },
}

impl From<StoredPatchFile> for WholePatchFile {
    fn from(file: StoredPatchFile) -> Self {
        match file {
            StoredPatchFile::Read {
                path,
                old_path,
                patch,
                additions,
                deletions,
            } => Self::Read {
                path,
                old_path,
                patch,
                additions,
                deletions,
            },
            StoredPatchFile::Unreadable {
                path,
                old_path,
                unavailable: TranscriptPatchUnreadableReason::Value,
                raw_patch,
            } => Self::Unreadable {
                path,
                old_path,
                raw_patch,
            },
            StoredPatchFile::Absent {
                path,
                old_path,
                unavailable: TranscriptPatchAbsentReason::Value,
            } => Self::Absent { path, old_path },
        }
    }
}

/// Reads one page of the patches `request`'s tool call left out, on `reader`;
/// `read_damaged_from_sequence` answers where a damaged session's reads stop. Fails with
/// [`TranscriptReadError::Refused`] for a session this daemon holds no events for
/// (`session.notFound`) or a call it holds no completion of (`transcript.row.notFound`), and with
/// [`PatchListError::Cursor`] for a cursor that names no file or no place in its text.
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
    let completion: Option<(bool, Option<String>)> = reader
        .prepare_cached(&COMPLETION_SQL)
        .and_then(|mut statement| {
            statement
                .query_row(
                    named_params! {
                        "@session_id": request.session_id.text().as_str(),
                        "@tool_call_id": request.tool_call_id.as_str(),
                        "@read_bound": reads.read_bound(&request.session_id, None),
                    },
                    |row| Ok((row.get(0)?, optional_utf8_blob_column(row, 1)?)),
                )
                .optional()
        })
        .map_err(TranscriptReadError::from)?;
    snapshot.commit().map_err(TranscriptReadError::from)?;
    let Some((names_patches, body)) = completion else {
        return Err(TranscriptReadError::from(
            DomainError::new(
                "This session holds no completed tool call with that id.",
                RefusalCode::TranscriptRowNotFound,
            )
            .with_detail(json!({ "toolCallId": request.tool_call_id })),
        )
        .into());
    };
    let files: Vec<WholePatchFile> = match body.filter(|_| names_patches) {
        None => Vec::new(),
        Some(body) => serde_json::from_str::<StoredPatchFiles>(&body)
            .map_err(|cause| PatchListError::StoredFiles {
                tool_call_id: request.tool_call_id.as_str().to_owned(),
                cause,
            })?
            .files
            .into_iter()
            .map(WholePatchFile::from)
            .collect(),
    };
    Ok(patch_page_of(&files, request.cursor)?)
}

// The page of `files` from `cursor` on, the first file's start when absent. Refuses a cursor past
// the last file, past its file's text, inside a character, or into a file that has no text.
fn patch_page_of(
    files: &[WholePatchFile],
    cursor: Option<TranscriptPatchCursor>,
) -> Result<TranscriptPatchListResponse, BodyReadOffsetRefused> {
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
    if file_index > files.len() || (file_index == files.len() && offset > 0) {
        return Err(refused(0));
    }
    let mut start = usize::try_from(offset).unwrap_or(usize::MAX);
    if let Some(first) = files.get(file_index) {
        let text = text_of(first);
        if !text.is_char_boundary(start) {
            return Err(refused(text.len()));
        }
    }
    // The two brackets are charged up front; every entry past the first also charges a comma.
    let mut used_bytes = 2;
    let mut page = Vec::new();
    for (index, file) in files.iter().enumerate().skip(file_index) {
        let text = text_of(file);
        let separator_bytes = usize::from(!page.is_empty());
        let budget = PAGE_MAX_BYTES.saturating_sub(used_bytes + separator_bytes);
        // A file with text left takes at least one character, else the page ends before it.
        let Some(end) = part_end(file, start, budget).filter(|&end| end > start || text.is_empty())
        else {
            return Ok(TranscriptPatchListResponse {
                files: page,
                next: Some(patch_cursor(index, start)),
            });
        };
        let entry = entry_of(file, start, end);
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
        WholePatchFile::Absent { path, old_path } => {
            TranscriptPatchFile::Absent(TranscriptPatchFileAbsent {
                path: path.clone(),
                old_path: old_path.clone(),
                unavailable: TranscriptPatchAbsentReason::Value,
                patch: None,
                additions: None,
                deletions: None,
                raw_patch: None,
            })
        }
        WholePatchFile::Unreadable {
            path,
            old_path,
            raw_patch,
        } => TranscriptPatchFile::Unreadable(TranscriptPatchFileUnreadable {
            path: path.clone(),
            old_path: old_path.clone(),
            unavailable: TranscriptPatchUnreadableReason::Value,
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
