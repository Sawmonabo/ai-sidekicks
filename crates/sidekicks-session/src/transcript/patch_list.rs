//! `transcript.patch.list`: every patch one tool call's row left out, read from the call's
//! completion. A completion that holds patches names its files in its payload's `omittedPatches`
//! and stores each file in parts that join the completion's row: a header part holding the file
//! up to its text, the parts of its text, each placed by the offset its text starts at, and a
//! tail. A read answers the files from its cursor on, as many as fit one page, loading only the
//! parts of the text it answers and at most one more, a file too long for what is left of the page
//! cut at a character boundary and continued by the next read from `{fileIndex, offset}`. A file
//! the log cannot read whole is answered in its place as damaged.

use std::sync::LazyLock;

use rusqlite::{Connection, OptionalExtension, ToSql, named_params};
use serde_json::json;
use sidekicks_contracts::jsonrpc::byte_length::json_utf8_byte_length;
use sidekicks_contracts::jsonrpc::page::PAGE_MAX_BYTES;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::content::{
    BodyReadOffsetRefused, TranscriptPatchCursor, TranscriptPatchDamagedReason,
    TranscriptPatchFile, TranscriptPatchFileAbsent, TranscriptPatchFileDamaged,
    TranscriptPatchFileRead, TranscriptPatchFileUnreadable, TranscriptPatchListRequest,
    TranscriptPatchListResponse,
};
use sidekicks_contracts::transcript::row::TranscriptOmittedPatch;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::BoundedText;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_store::database::connection::read_pool::DatabaseReadError;
use sidekicks_store::events::content::append::stored_index;
use sidekicks_store::events::content::codec::{StoredBodyColumns, stored_body_columns_sql};
use sidekicks_store::events::session::read::{SessionEventReads, readable_event_sql};
use sidekicks_store::transcript::whole_patch::{
    OMITTED_PATCHES_PAYLOAD_KEY, WholePatchFile, patch_file_of_header, text_of_part,
};

use crate::transcript::window::{TranscriptReadError, read_transcript_head};

// The call's newest readable completion row, found by the call the insert stamped on it: its
// sequence and the files it names.
static COMPLETION_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT event.sequence, json_extract(event.payload, '$.{OMITTED_PATCHES_PAYLOAD_KEY}')
       FROM session_events AS event
      WHERE event.session_id = @session_id AND event.tool_call_id = @tool_call_id
        AND {readable}
      ORDER BY event.sequence DESC
      LIMIT 1",
        readable = readable_event_sql("event"),
    )
});

// The stored parts of one of the completion's files: how many there are, and how many of them the
// log can read, counted on the parts' index alone.
static FILE_PARTS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT count(*), coalesce(sum({readable}), 0)
       FROM session_events AS part
      WHERE part.session_id = @session_id AND part.joins_sequence = @completion_sequence
        AND part.patch_file_index = @file_index",
        readable = readable_event_sql("part"),
    )
});

// A file's header part, the first of its parts placed at no text offset.
static FILE_HEADER_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {body} FROM session_events AS part
  WHERE session_id = @session_id AND joins_sequence = @completion_sequence
    AND patch_file_index = @file_index AND patch_text_offset IS NULL
  ORDER BY sequence
  LIMIT 1",
        body = stored_body_columns_sql("part"),
    )
});

// The part of a file's text holding `@offset`: the last one starting at or before it.
static TEXT_PART_AT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT patch_text_offset, {body} FROM session_events AS part
  WHERE session_id = @session_id AND joins_sequence = @completion_sequence
    AND patch_file_index = @file_index AND patch_text_offset <= @offset
  ORDER BY patch_text_offset DESC
  LIMIT 1",
        body = stored_body_columns_sql("part"),
    )
});

// The last part of a file's text.
static LAST_TEXT_PART_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT patch_text_offset, {body} FROM session_events AS part
  WHERE session_id = @session_id AND joins_sequence = @completion_sequence
    AND patch_file_index = @file_index
  ORDER BY patch_text_offset DESC
  LIMIT 1",
        body = stored_body_columns_sql("part"),
    )
});

// The part of a file's text after the one starting at `@offset`.
static TEXT_PART_AFTER_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT patch_text_offset, {body} FROM session_events AS part
  WHERE session_id = @session_id AND joins_sequence = @completion_sequence
    AND patch_file_index = @file_index AND patch_text_offset > @offset
  ORDER BY patch_text_offset
  LIMIT 1",
        body = stored_body_columns_sql("part"),
    )
});

/// Why a patch read failed.
#[derive(Debug, thiserror::Error)]
pub enum PatchListError {
    /// The session is not one this daemon holds, the call is not one it holds, or a read failed.
    #[error(transparent)]
    Read(#[from] TranscriptReadError),
    /// The cursor names no file of the call, or no place in its text.
    #[error(transparent)]
    Cursor(#[from] BodyReadOffsetRefused),
    /// The completion's payload names its files in a shape no list of files reads as, which only
    /// a write outside the producer can leave.
    #[error("the completion of tool call {tool_call_id} names its files in no list's shape")]
    StoredFileNames {
        /// The call.
        tool_call_id: String,
        /// Why the list did not read.
        #[source]
        cause: serde_json::Error,
    },
    /// A readable stored file of the completion does not read as its file, which only a write
    /// outside the producer can leave.
    #[error("the completion of tool call {tool_call_id} holds no readable file {file_index}")]
    StoredFile {
        /// The call.
        tool_call_id: String,
        /// The file's place in the call's list.
        file_index: usize,
        /// Why the file did not read; absent when a part of it is missing.
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
            fault
            @ (PatchListError::StoredFileNames { .. } | PatchListError::StoredFile { .. }) => {
                Self::Internal(Box::new(fault))
            }
        }
    }
}

impl From<DatabaseReadError> for PatchListError {
    fn from(error: DatabaseReadError) -> Self {
        Self::Read(error.into())
    }
}

impl From<rusqlite::Error> for PatchListError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Read(error.into())
    }
}

/// The stored files of one completion, each part loaded only when the page reaches it.
struct StoredPatchFiles<'read> {
    reader: &'read Connection,
    session_id: &'read SessionId,
    tool_call_id: &'read str,
    read_bound: i64,
    completion_sequence: i64,
    named: Vec<TranscriptOmittedPatch>,
}

impl StoredPatchFiles<'_> {
    // A fault naming file `file_index`.
    fn stored_file_fault(
        &self,
        file_index: usize,
        cause: Option<serde_json::Error>,
    ) -> PatchListError {
        PatchListError::StoredFile {
            tool_call_id: self.tool_call_id.to_owned(),
            file_index,
            cause,
        }
    }

    // Whether file `file_index` has stored parts and the log can read every one of them.
    fn is_whole(&self, file_index: usize) -> rusqlite::Result<bool> {
        let (held, readable): (i64, i64) = self.reader.prepare_cached(&FILE_PARTS_SQL)?.query_row(
            named_params! {
                "@session_id": self.session_id.text().as_str(),
                "@completion_sequence": self.completion_sequence,
                "@file_index": stored_index(file_index),
                "@read_bound": self.read_bound,
            },
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok(held > 0 && readable == held)
    }

    // File `file_index` as its header part names it, its text empty. Fails when the header is
    // missing or does not read as a file's.
    fn header(&self, file_index: usize) -> Result<WholePatchFile, PatchListError> {
        let body: Option<Option<String>> = self
            .reader
            .prepare_cached(&FILE_HEADER_SQL)?
            .query_row(
                named_params! {
                    "@session_id": self.session_id.text().as_str(),
                    "@completion_sequence": self.completion_sequence,
                    "@file_index": stored_index(file_index),
                },
                |row| StoredBodyColumns::read(row, 0)?.decode(0),
            )
            .optional()?;
        let body = body
            .flatten()
            .ok_or_else(|| self.stored_file_fault(file_index, None))?;
        patch_file_of_header(&body, file_index, self.named.len())
            .map_err(|cause| self.stored_file_fault(file_index, Some(cause)))
    }

    // The part of file `file_index`'s text that `sql` picks, against `offset` where the statement
    // takes one: where its text starts and its text. Fails when the part does not read as JSON
    // string content.
    fn text_part(
        &self,
        sql: &str,
        file_index: usize,
        offset: Option<usize>,
    ) -> Result<Option<(usize, String)>, PatchListError> {
        let session_id = self.session_id.text();
        let session_id = session_id.as_str();
        let file_index_column = stored_index(file_index);
        let offset_column = offset.map(stored_index);
        let mut bindings: Vec<(&str, &dyn ToSql)> = vec![
            ("@session_id", &session_id),
            ("@completion_sequence", &self.completion_sequence),
            ("@file_index", &file_index_column),
        ];
        if let Some(offset_column) = &offset_column {
            bindings.push(("@offset", offset_column));
        }
        let part: Option<(i64, Option<String>)> = self
            .reader
            .prepare_cached(sql)?
            .query_row(bindings.as_slice(), |row| {
                Ok((row.get(0)?, StoredBodyColumns::read(row, 1)?.decode(1)?))
            })
            .optional()?;
        let Some((part_offset, body)) = part else {
            return Ok(None);
        };
        let body = body.ok_or_else(|| self.stored_file_fault(file_index, None))?;
        let text =
            text_of_part(&body).map_err(|cause| self.stored_file_fault(file_index, Some(cause)))?;
        let part_offset =
            usize::try_from(part_offset).expect("a stored text offset is not negative");
        Ok(Some((part_offset, text)))
    }
}

/// Reads one page of the patches `request`'s tool call left out, on `reader`;
/// `read_damaged_from_sequence` answers where a damaged session's reads stop. Fails with
/// [`TranscriptReadError::Refused`] for a session this daemon holds no events for
/// (`session.notFound`) or a call it holds no completion of (`transcript.row.notFound`), with
/// [`PatchListError::Cursor`] for a cursor that names no file or no place in its text, and with
/// [`PatchListError::StoredFile`] or [`PatchListError::StoredFileNames`] for a stored completion
/// that does not read as one.
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
    let completion: Option<(i64, Option<String>)> = reader
        .prepare_cached(&COMPLETION_SQL)?
        .query_row(
            named_params! {
                "@session_id": request.session_id.text().as_str(),
                "@tool_call_id": request.tool_call_id.as_str(),
                "@read_bound": read_bound,
            },
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((completion_sequence, named)) = completion else {
        return Err(TranscriptReadError::from(
            DomainError::new(
                "This session holds no completed tool call with that id.",
                RefusalCode::TranscriptRowNotFound,
            )
            .with_detail(json!({ "toolCallId": request.tool_call_id })),
        )
        .into());
    };
    let named = named
        .map(|named| serde_json::from_str(&named))
        .transpose()
        .map_err(|cause| PatchListError::StoredFileNames {
            tool_call_id: request.tool_call_id.as_str().to_owned(),
            cause,
        })?
        .unwrap_or_default();
    let files = StoredPatchFiles {
        reader,
        session_id: &request.session_id,
        tool_call_id: request.tool_call_id.as_str(),
        read_bound,
        completion_sequence,
        named,
    };
    let page = patch_page_of(&files, request.cursor)?;
    snapshot.commit().map_err(TranscriptReadError::from)?;
    Ok(page)
}

// The page of `files` from `cursor` on, the first file's start when absent, loading the parts it
// reaches. Refuses a cursor past the last file, past its file's text, inside a character, or into
// a file that has no text.
fn patch_page_of(
    files: &StoredPatchFiles<'_>,
    cursor: Option<TranscriptPatchCursor>,
) -> Result<TranscriptPatchListResponse, PatchListError> {
    let count = files.named.len();
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
    if file_index > count || (file_index == count && offset > 0) {
        return Err(refused(0).into());
    }
    let mut start = usize::try_from(offset).unwrap_or(usize::MAX);
    // The two brackets are charged up front; every entry past the first also charges a comma.
    let mut used_bytes = 2;
    let mut page = Vec::new();
    for index in file_index..count {
        let separator_bytes = usize::from(!page.is_empty());
        let budget = PAGE_MAX_BYTES.saturating_sub(used_bytes + separator_bytes);
        let ended_before = |page: Vec<TranscriptPatchFile>| TranscriptPatchListResponse {
            files: page,
            next: Some(patch_cursor(index, start)),
        };
        // A file the log cannot read whole takes its place as damaged, from any cursor into it.
        if !files.is_whole(index)? {
            let entry = damaged_entry(&files.named[index]);
            if !fits(&entry, budget) {
                return Ok(ended_before(page));
            }
            used_bytes += separator_bytes + entry_bytes(&entry);
            page.push(entry);
            start = 0;
            continue;
        }
        let header = files.header(index)?;
        let text = if header.text().is_some() {
            match text_from(files, &header, index, start, budget)? {
                FileText::Read(text) => Some(text),
                FileText::Refused(text_length) => return Err(refused(text_length).into()),
                FileText::AtItsEnd => {
                    start = 0;
                    continue;
                }
            }
        } else if start > 0 {
            return Err(refused(0).into());
        } else {
            None
        };
        let loaded = text.as_ref().map_or("", |text| text.loaded.as_str());
        // A file with text left takes at least one character, else the page ends before it.
        let Some(end) =
            part_end(&header, loaded, budget).filter(|&end| end > 0 || loaded.is_empty())
        else {
            return Ok(ended_before(page));
        };
        let entry = entry_of(&header, &loaded[..end]);
        used_bytes += separator_bytes + entry_bytes(&entry);
        page.push(entry);
        if text.is_some_and(|text| end < text.loaded.len() || !text.is_whole_rest) {
            return Ok(TranscriptPatchListResponse {
                files: page,
                next: Some(patch_cursor(index, start + end)),
            });
        }
        start = 0;
    }
    Ok(TranscriptPatchListResponse {
        files: page,
        next: None,
    })
}

/// The text of a file from a cursor on, as far as one page part can take it.
struct LoadedText {
    /// The text loaded from the cursor on.
    loaded: String,
    /// Whether it runs to the text's end.
    is_whole_rest: bool,
}

/// What a file's text holds from a cursor on.
enum FileText {
    /// The text loaded for the page.
    Read(LoadedText),
    /// The cursor lies inside a character or past the text, whose length this is.
    Refused(usize),
    /// The cursor is at the end of the file's text, so nothing of it is left.
    AtItsEnd,
}

// The text of file `index`, whose header is `header`, from `start` on: the part holding `start`
// and each next part while the page's part can still grow, at most one past what it takes.
fn text_from(
    files: &StoredPatchFiles<'_>,
    header: &WholePatchFile,
    index: usize,
    start: usize,
    budget: usize,
) -> Result<FileText, PatchListError> {
    let Some((mut part_offset, part)) = files.text_part(&TEXT_PART_AT_SQL, index, Some(start))?
    else {
        // A file whose text is empty stores no part of it.
        return Ok(if start == 0 {
            FileText::Read(LoadedText {
                loaded: String::new(),
                is_whole_rest: true,
            })
        } else {
            FileText::Refused(0)
        });
    };
    let within = start - part_offset;
    if within > part.len() || !part.is_char_boundary(within) {
        return text_length_of(files, index).map(FileText::Refused);
    }
    let mut text_end = part_offset + part.len();
    let mut loaded = part[within..].to_owned();
    loop {
        if loaded.len() >= PAGE_MAX_BYTES || !fits(&entry_of(header, &loaded), budget) {
            return Ok(FileText::Read(LoadedText {
                loaded,
                is_whole_rest: false,
            }));
        }
        let Some((next_offset, next)) =
            files.text_part(&TEXT_PART_AFTER_SQL, index, Some(part_offset))?
        else {
            if loaded.is_empty() && start > 0 {
                return Ok(FileText::AtItsEnd);
            }
            return Ok(FileText::Read(LoadedText {
                loaded,
                is_whole_rest: true,
            }));
        };
        // Each part starts where the one before it ends, so a gap is a damaged store.
        if next_offset != text_end {
            return Err(files.stored_file_fault(index, None));
        }
        loaded.push_str(&next);
        part_offset = next_offset;
        text_end = next_offset + next.len();
    }
}

// The length of file `index`'s text: where its last part starts and that part's length, read only
// to name it in a refusal.
fn text_length_of(files: &StoredPatchFiles<'_>, index: usize) -> Result<usize, PatchListError> {
    Ok(files
        .text_part(&LAST_TEXT_PART_SQL, index, None)?
        .map_or(0, |(offset, text)| offset + text.len()))
}

// Where the part of `text`, the loaded text of `header`'s file, ends: the furthest character
// boundary, at most a page of UTF-8 on, whose entry's JSON fits `budget`; `None` when not even the
// entry with no text fits.
fn part_end(header: &WholePatchFile, text: &str, budget: usize) -> Option<usize> {
    let cap_end = text.floor_char_boundary(PAGE_MAX_BYTES);
    let fits_to = |end: usize| fits(&entry_of(header, &text[..end]), budget);
    if fits_to(cap_end) {
        return Some(cap_end);
    }
    if !fits_to(0) {
        return None;
    }
    // The fitting ends form a prefix of the boundaries, so the last one is found by halving.
    let (mut fitting, mut over) = (0, cap_end);
    loop {
        let middle = text.floor_char_boundary(fitting + (over - fitting) / 2);
        if middle == fitting {
            return Some(fitting);
        }
        if fits_to(middle) {
            fitting = middle;
        } else {
            over = middle;
        }
    }
}

fn entry_bytes(entry: &TranscriptPatchFile) -> usize {
    json_utf8_byte_length(entry).expect("a file serializes")
}

fn fits(entry: &TranscriptPatchFile, budget: usize) -> bool {
    entry_bytes(entry) <= budget
}

// The entry of `header`'s file carrying `part` of its text.
fn entry_of(header: &WholePatchFile, part: &str) -> TranscriptPatchFile {
    let part = || BoundedText::new(part.to_owned()).expect("a part is within one stored cap");
    match header {
        WholePatchFile::Read {
            path,
            old_path,
            additions,
            deletions,
            ..
        } => TranscriptPatchFile::Read(TranscriptPatchFileRead {
            path: path.clone(),
            old_path: old_path.clone(),
            patch: part(),
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
            ..
        } => TranscriptPatchFile::Unreadable(TranscriptPatchFileUnreadable {
            path: path.clone(),
            old_path: old_path.clone(),
            unavailable: *unavailable,
            raw_patch: part(),
            patch: None,
            additions: None,
            deletions: None,
        }),
    }
}

// The entry of a file whose stored parts the log cannot read whole, named as its completion names
// it.
fn damaged_entry(named: &TranscriptOmittedPatch) -> TranscriptPatchFile {
    TranscriptPatchFile::Damaged(TranscriptPatchFileDamaged {
        path: named.path.clone(),
        old_path: named.old_path.clone(),
        unavailable: TranscriptPatchDamagedReason::Value,
        patch: None,
        additions: None,
        deletions: None,
        raw_patch: None,
    })
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
mod tests;
