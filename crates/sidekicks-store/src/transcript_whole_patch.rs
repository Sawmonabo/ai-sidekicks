//! One file's whole patch as a driver reads it from a provider's file change and as a tool
//! completion stores it, before the patch read pages it into the bounded pieces a client reads. A
//! completion's file list `{"files": [...]}` is stored in parts: the completion's own row keeps the
//! list's opening, and each file is a header part, holding the file up to its text, the parts of
//! its text, each at most one stored body's cap, and a tail closing it, so the parts' bodies joined
//! read as the list again and a read of a range of one file's text loads only the parts it covers.

use serde::de::Error as _;
use serde::{Deserialize, Serialize};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::jsonrpc::page::PAGE_MAX_BYTES;
use sidekicks_contracts::transcript::content::{
    TranscriptPatchAbsentReason, TranscriptPatchUnreadableReason,
};
use sidekicks_contracts::transcript::row::TranscriptOmittedPatch;
use sidekicks_contracts::wire::integer::SafeInt;

/// The payload member of a tool completion that names the files its body's patches cover; a
/// completion naming one or more stores its body in parts of each file.
pub(crate) const OMITTED_PATCHES_PAYLOAD_KEY: &str = "omittedPatches";

/// What a patch-bearing completion's own row stores: the file list's opening.
pub(crate) const PATCH_FILES_OPENING: &str = "{\"files\":[";

/// What stands between two files of the list.
const PATCH_FILES_SEPARATOR: &str = ",";

/// What closes the list, after its last file.
const PATCH_FILES_CLOSING: &str = "]}";

/// What closes a file's text and the file, before any close of the list.
const PATCH_TEXT_CLOSING: &str = "\"}";

/// One file's whole patch with the lines it adds and removes, or why there is none. Unlike a
/// page's `TranscriptPatchFile`, the patch and the raw text are never cut: the patch read pages
/// them. `old_path` is set on a file the call moved, which `path` names by its new path. A stored
/// file reads in the page's shape, as the arm whose members it carries, an unknown member refused:
/// a patch, the raw text of one that could not be read, or neither. It writes its text last, so a
/// stored file's text can be cut into parts after the members before it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged, rename_all_fields = "camelCase", deny_unknown_fields)]
pub(crate) enum WholePatchFile {
    /// The patch.
    Read {
        /// The file's path.
        path: FilesystemPath,
        /// The old path of a moved file.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        old_path: Option<FilesystemPath>,
        /// The lines it adds.
        additions: u64,
        /// The lines it removes.
        deletions: u64,
        /// The whole patch.
        patch: String,
    },
    /// A patch came in a form this version cannot read.
    Unreadable {
        /// The file's path.
        path: FilesystemPath,
        /// The old path of a moved file.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        old_path: Option<FilesystemPath>,
        /// Always `unreadable`.
        unavailable: TranscriptPatchUnreadableReason,
        /// The whole patch as the provider sent it.
        raw_patch: String,
    },
    /// No patch came.
    Absent {
        /// The file's path.
        path: FilesystemPath,
        /// The old path of a moved file.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        old_path: Option<FilesystemPath>,
        /// Always `absent`.
        unavailable: TranscriptPatchAbsentReason,
    },
}

impl WholePatchFile {
    /// The file's path, its new one for a file the call moved.
    pub(crate) fn path(&self) -> &FilesystemPath {
        match self {
            Self::Read { path, .. } | Self::Unreadable { path, .. } | Self::Absent { path, .. } => {
                path
            }
        }
    }

    /// The old path of a file the call moved.
    pub(crate) fn old_path(&self) -> Option<&FilesystemPath> {
        match self {
            Self::Read { old_path, .. }
            | Self::Unreadable { old_path, .. }
            | Self::Absent { old_path, .. } => old_path.as_ref(),
        }
    }

    /// The text a part of the file is cut from: its patch or the raw text as sent; `None` when no
    /// patch came.
    pub(crate) fn text(&self) -> Option<&str> {
        match self {
            Self::Read { patch, .. } => Some(patch),
            Self::Unreadable { raw_patch, .. } => Some(raw_patch),
            Self::Absent { .. } => None,
        }
    }

    // The file with an empty text, which its header part is written from.
    fn without_text(&self) -> Self {
        match self {
            Self::Read {
                path,
                old_path,
                additions,
                deletions,
                ..
            } => Self::Read {
                path: path.clone(),
                old_path: old_path.clone(),
                additions: *additions,
                deletions: *deletions,
                patch: String::new(),
            },
            Self::Unreadable {
                path,
                old_path,
                unavailable,
                ..
            } => Self::Unreadable {
                path: path.clone(),
                old_path: old_path.clone(),
                unavailable: *unavailable,
                raw_patch: String::new(),
            },
            Self::Absent { .. } => self.clone(),
        }
    }
}

/// The body a tool completion whose patches cover `files` carries before it is stored in parts:
/// the file list `{"files": [...]}`, each file whole.
pub(crate) fn stored_patch_files_body(files: &[WholePatchFile]) -> String {
    serde_json::json!({ "files": files }).to_string()
}

/// What a tool completion's payload names for each of `files`, so the append stores its body in
/// parts: the file's path, the old path of a moved one, and its text's size in bytes, zero for a
/// file with no patch.
pub(crate) fn omitted_patches_of(files: &[WholePatchFile]) -> Vec<TranscriptOmittedPatch> {
    files
        .iter()
        .map(|file| TranscriptOmittedPatch {
            path: file.path().clone(),
            old_path: file.old_path().cloned(),
            size: SafeInt::new(u64::try_from(file.text().map_or(0, str::len)).unwrap_or(u64::MAX))
                .expect("a patch held in memory is shorter than a safe integer"),
        })
        .collect()
}

/// One stored part of a file of a completion's list: its body and, on a part of the file's text,
/// the UTF-8 offset in the text of its first byte.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct PatchFilePart {
    /// Where its text starts in the file's text; `None` on the header and on the tail.
    pub(crate) text_offset: Option<usize>,
    /// The body it stores.
    pub(crate) body: String,
}

/// The stored parts of `file`, file `index` of a list of `count`: a file with no text as one part;
/// else its header, through its text member's opening quote, the parts of its text, each JSON
/// string content of at most a page of UTF-8 ([`PAGE_MAX_BYTES`]) cut between two
/// characters, so never inside an escape, and its tail. The first part opens with a separator
/// unless the file is the list's first, and the last closes the list when it is its last.
pub(crate) fn patch_file_parts(
    file: &WholePatchFile,
    index: usize,
    count: usize,
) -> Vec<PatchFilePart> {
    let separator = if index == 0 {
        ""
    } else {
        PATCH_FILES_SEPARATOR
    };
    let closing = if index + 1 == count {
        PATCH_FILES_CLOSING
    } else {
        ""
    };
    let whole = |file: &WholePatchFile| serde_json::to_string(file).expect("a file serializes");
    let Some(text) = file.text() else {
        return vec![PatchFilePart {
            text_offset: None,
            body: format!("{separator}{}{closing}", whole(file)),
        }];
    };
    // The text member is written last and empty, so dropping the file's close leaves its quote.
    let header = whole(&file.without_text());
    let header = header
        .strip_suffix(PATCH_TEXT_CLOSING)
        .expect("a file written with an empty text ends in its text's close");
    let mut parts = vec![PatchFilePart {
        text_offset: None,
        body: format!("{separator}{header}"),
    }];
    let mut text_part = |start: usize, end: usize| {
        let quoted = serde_json::to_string(&text[start..end]).expect("a text serializes");
        parts.push(PatchFilePart {
            text_offset: Some(start),
            body: quoted[1..quoted.len() - 1].to_owned(),
        });
    };
    let (mut start, mut escaped_bytes) = (0, 0);
    for (at, character) in text.char_indices() {
        let width = escaped_byte_length(character);
        if escaped_bytes + width > PAGE_MAX_BYTES {
            text_part(start, at);
            (start, escaped_bytes) = (at, 0);
        }
        escaped_bytes += width;
    }
    if start < text.len() {
        text_part(start, text.len());
    }
    parts.push(PatchFilePart {
        text_offset: None,
        body: format!("{PATCH_TEXT_CLOSING}{closing}"),
    });
    parts
}

// How many UTF-8 bytes JSON writes `character` as inside a string, as `serde_json` escapes it: a
// quote, a reverse solidus and the five short control escapes as two, any other control character
// as a six-byte `\u` escape, and every other character as its own UTF-8.
fn escaped_byte_length(character: char) -> usize {
    match character {
        '"' | '\\' | '\u{8}' | '\t' | '\n' | '\u{c}' | '\r' => 2,
        '\0'..='\u{1f}' => 6,
        _ => character.len_utf8(),
    }
}

/// The file the header part `body` of file `index` of `count` names, its text empty: the whole
/// file when it has no text. Fails when the body lacks its separators or is not a file's header.
pub(crate) fn patch_file_of_header(
    body: &str,
    index: usize,
    count: usize,
) -> Result<WholePatchFile, serde_json::Error> {
    let missing = || serde_json::Error::custom("a stored file lacks the separators around it");
    let file = if index == 0 {
        body
    } else {
        body.strip_prefix(PATCH_FILES_SEPARATOR)
            .ok_or_else(missing)?
    };
    // A header ends in the opening quote of its text; a whole file in its close.
    if file.ends_with('"') {
        return serde_json::from_str(&format!("{file}{PATCH_TEXT_CLOSING}"));
    }
    let file = if index + 1 == count {
        file.strip_suffix(PATCH_FILES_CLOSING).ok_or_else(missing)?
    } else {
        file
    };
    serde_json::from_str(file)
}

/// The text a part of a file's text stores as JSON string content. Fails when the body is not.
pub(crate) fn text_of_part(body: &str) -> Result<String, serde_json::Error> {
    serde_json::from_str(&format!("\"{body}\""))
}
