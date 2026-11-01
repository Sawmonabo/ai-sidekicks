//! The files a conversion did not copy, read back page by page in key order, each with its reason.
//! A page's cursor is the key of the last file it carried, written as base64url without padding, so
//! a client reads nothing into it.

use std::sync::LazyLock;

use base64::Engine as _;
use base64::alphabet::URL_SAFE;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use rusqlite::named_params;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::jsonrpc::byte_length::json_utf8_byte_length;
use sidekicks_contracts::jsonrpc::page::{PAGE_MAX_BYTES, count_entries_fitting_one_frame};
use sidekicks_contracts::session::convert::{
    SESSION_CONVERT_SKIPPED_FILE_PAGE_LIMIT_MAX, SessionConversionSkippedFileListRequest,
    SessionConversionSkippedFileListResponse, SessionConvertSkippedFile,
    SessionConvertSkippedFileCursor, SessionConvertSkippedFilesContinuing,
    SessionConvertSkippedFilesTerminal,
};
use sidekicks_contracts::wire::list::BoundedVec;
use sidekicks_contracts::wire::{False, True};
use sidekicks_ipc::not_found::session::session_not_found;
use sidekicks_store::database::connection::read_pool::ReadLength;
use sidekicks_store::database::schema::session_directory::ConvertedFileOutcome;
use sidekicks_store::database::stored_column::{closed_word, text_column};

use crate::convert::{SessionConversion, SessionConversionError};
use crate::directory::lookups::session_exists;

// The cursor's encoding: base64url, no padding written, and any cursor read as some key.
const CURSOR_BASE64: GeneralPurpose = GeneralPurpose::new(
    &URL_SAFE,
    GeneralPurposeConfig::new()
        .with_encode_padding(false)
        .with_decode_allow_trailing_bits(true)
        .with_decode_padding_mode(DecodePaddingMode::RequireNone),
);

// One row past the page shows whether more remain; the first page reads after the empty key,
// which sorts before every key.
static SELECT_SKIPPED_FILES_PAGE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT path_key, path, outcome FROM session_convert_files
  WHERE session_id = @session_id AND path_key > @after_key AND outcome <> '{copied}'
  ORDER BY path_key
  LIMIT @row_count",
        copied = <&'static str>::from(ConvertedFileOutcome::Copied),
    )
});

impl SessionConversion {
    /// `session.conversion.skippedFile.list`: one page of the files the session's conversion did
    /// not copy, in key order, each with its reason, cut at the page limit or the page's byte
    /// budget, whichever comes first. A session never converted, or one whose conversion copied
    /// every file, answers an empty last page. Refuses `session.notFound`.
    pub async fn list_skipped_files(
        &self,
        request: &SessionConversionSkippedFileListRequest,
    ) -> Result<SessionConversionSkippedFileListResponse, SessionConversionError> {
        let session_id = request.session_id;
        let limit = request
            .limit
            .map_or(SESSION_CONVERT_SKIPPED_FILE_PAGE_LIMIT_MAX, |limit| {
                usize::try_from(limit.get()).expect("a page limit is from 1 to the page maximum")
            });
        let after_key = request
            .after_cursor
            .as_ref()
            .map_or_else(Vec::new, key_of_cursor);
        let row_count = i64::try_from(limit + 1).expect("a page limit is far below i64's bound");
        let read = self
            .reads
            .read(ReadLength::Short, move |connection| {
                let snapshot = connection.unchecked_transaction()?;
                if !session_exists(&snapshot, &session_id)? {
                    return Ok::<_, SessionConversionError>(None);
                }
                let files = snapshot
                    .prepare_cached(&SELECT_SKIPPED_FILES_PAGE_SQL)?
                    .query_map(
                        named_params! {
                            "@session_id": session_id.text().as_str(),
                            "@after_key": after_key,
                            "@row_count": row_count,
                        },
                        |row| {
                            Ok((
                                row.get::<_, Vec<u8>>(0)?,
                                SessionConvertSkippedFile {
                                    path: text_column(row, 1, FilesystemPath::new)?,
                                    reason: text_column(row, 2, closed_word)?,
                                },
                            ))
                        },
                    )?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(Some(files))
            })
            .await?;
        let Some(rows) = read else {
            return Err(session_not_found(&session_id).into());
        };
        let (mut keys, mut files): (Vec<_>, Vec<_>) = rows.into_iter().unzip();
        let page_size =
            count_entries_fitting_one_frame(&files, limit, PAGE_MAX_BYTES, json_utf8_byte_length)
                .expect("a skipped file serializes: it holds only text");
        let has_more = files.len() > page_size;
        files.truncate(page_size);
        keys.truncate(page_size);
        let next_cursor = keys
            .last()
            .filter(|_| has_more)
            .map(|last| cursor_of(last.as_slice()));
        Ok(match next_cursor {
            Some(next_cursor) => SessionConversionSkippedFileListResponse::Continuing(
                SessionConvertSkippedFilesContinuing {
                    files: BoundedVec::new(files)
                        .expect("a page with more after it holds 1 to the page maximum's files"),
                    has_more: True::default(),
                    next_cursor,
                },
            ),
            None => SessionConversionSkippedFileListResponse::Terminal(
                SessionConvertSkippedFilesTerminal {
                    files: BoundedVec::new(files)
                        .expect("a last page holds at most the page maximum's files"),
                    has_more: False::default(),
                },
            ),
        })
    }
}

fn cursor_of(key: &[u8]) -> SessionConvertSkippedFileCursor {
    SessionConvertSkippedFileCursor::new(CURSOR_BASE64.encode(key))
        .expect("a stored key's base64url fits the cursor's bound")
}

// Any cursor reads as some key, and a page simply starts after it: a last character carrying less
// than a byte is dropped.
fn key_of_cursor(cursor: &SessionConvertSkippedFileCursor) -> Vec<u8> {
    let text = cursor.as_str();
    let whole = if text.len() % 4 == 1 {
        &text[..text.len() - 1]
    } else {
        text
    };
    CURSOR_BASE64
        .decode(whole)
        .expect("base64url characters in whole groups always decode")
}
