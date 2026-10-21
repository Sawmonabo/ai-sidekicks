//! One file's whole patch as a driver reads it from a provider's file change and as a tool
//! completion stores it, before the patch read pages it into the bounded pieces a client reads. A
//! completion's file list `{"files": [...]}` is stored one file to a row: the completion's own row
//! keeps the list's opening, and each file's row the file with the separators that join it back.

use serde::Deserialize;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::transcript::content::{
    TranscriptPatchAbsentReason, TranscriptPatchUnreadableReason,
};

/// The payload member of a tool completion that names the files its body's patches cover; a
/// completion carrying it stores its body one file to a row, each whole.
pub(crate) const OMITTED_PATCHES_PAYLOAD_KEY: &str = "omittedPatches";

/// What a patch-bearing completion's own row stores: the file list's opening.
pub(crate) const PATCH_FILES_OPENING: &str = "{\"files\":[";

/// What stands between two files of the list.
const PATCH_FILES_SEPARATOR: &str = ",";

/// What closes the list, after its last file.
const PATCH_FILES_CLOSING: &str = "]}";

/// The stored body of `file`, the JSON of file `index` of `count`: after a separator unless it is
/// the first, and before the list's close when it is the last.
pub(crate) fn patch_file_piece(file: &str, index: usize, count: usize) -> String {
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
    format!("{separator}{file}{closing}")
}

/// The JSON of the file that `piece`, the stored body of file `index` of `count`, holds; `None`
/// when the piece lacks the separators [`patch_file_piece`] puts around it.
pub(crate) fn patch_file_of_piece(piece: &str, index: usize, count: usize) -> Option<&str> {
    let file = if index == 0 {
        piece
    } else {
        piece.strip_prefix(PATCH_FILES_SEPARATOR)?
    };
    if index + 1 == count {
        file.strip_suffix(PATCH_FILES_CLOSING)
    } else {
        Some(file)
    }
}

/// One file's whole patch with the lines it adds and removes, or why there is none. Unlike a
/// page's `TranscriptPatchFile`, the patch and the raw text are never cut: the patch read pages
/// them. `old_path` is set on a file the call moved, which `path` names by its new path. A stored
/// file reads in the page's shape, as the arm whose members it carries, an unknown member refused:
/// a patch, the raw text of one that could not be read, or neither.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(untagged, rename_all_fields = "camelCase", deny_unknown_fields)]
pub(crate) enum WholePatchFile {
    /// The patch.
    Read {
        /// The file's path.
        path: FilesystemPath,
        /// The old path of a moved file.
        #[serde(default)]
        old_path: Option<FilesystemPath>,
        /// The whole patch.
        patch: String,
        /// The lines it adds.
        additions: u64,
        /// The lines it removes.
        deletions: u64,
    },
    /// A patch came in a form this version cannot read.
    Unreadable {
        /// The file's path.
        path: FilesystemPath,
        /// The old path of a moved file.
        #[serde(default)]
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
        #[serde(default)]
        old_path: Option<FilesystemPath>,
        /// Always `absent`.
        unavailable: TranscriptPatchAbsentReason,
    },
}
