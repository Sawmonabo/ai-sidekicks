//! One file's whole patch as a driver reads it from a provider's file change, before the patch
//! read pages it into the bounded pieces a client reads.

use serde_json::{Value, json};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::transcript::content::{
    TranscriptPatchAbsentReason, TranscriptPatchUnreadableReason,
};

/// One file's whole patch with the lines it adds and removes, or why there is none. Unlike a
/// page's `TranscriptPatchFile`, the patch and the raw text are never cut: the patch read pages
/// them. `old_path` is set on a file the call moved, which `path` names by its new path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum WholePatchFile {
    /// The patch.
    Read {
        /// The file's path.
        path: FilesystemPath,
        /// The old path of a moved file.
        old_path: Option<FilesystemPath>,
        /// The whole patch.
        patch: String,
        /// The lines it adds.
        additions: u64,
        /// The lines it removes.
        deletions: u64,
    },
    /// No patch came.
    Absent {
        /// The file's path.
        path: FilesystemPath,
        /// The old path of a moved file.
        old_path: Option<FilesystemPath>,
    },
    /// A patch came in a form this version cannot read.
    Unreadable {
        /// The file's path.
        path: FilesystemPath,
        /// The old path of a moved file.
        old_path: Option<FilesystemPath>,
        /// The whole patch as the provider sent it.
        raw_patch: String,
    },
}

/// The stored body of a tool call's result that names patches: `{files: [...]}`, each file as the
/// patch read answers it, its patch with its counts, or the word for why there is none.
pub(crate) fn stored_patch_files_body(files: &[WholePatchFile]) -> String {
    let files: Vec<Value> = files.iter().map(stored_patch_file).collect();
    json!({ "files": files }).to_string()
}

fn stored_patch_file(file: &WholePatchFile) -> Value {
    let (path, old_path, mut stored) = match file {
        WholePatchFile::Read {
            path,
            old_path,
            patch,
            additions,
            deletions,
        } => (
            path,
            old_path,
            json!({ "patch": patch, "additions": additions, "deletions": deletions }),
        ),
        WholePatchFile::Absent { path, old_path } => (
            path,
            old_path,
            json!({ "unavailable": TranscriptPatchAbsentReason::Value }),
        ),
        WholePatchFile::Unreadable {
            path,
            old_path,
            raw_patch,
        } => (
            path,
            old_path,
            json!({ "unavailable": TranscriptPatchUnreadableReason::Value, "rawPatch": raw_patch }),
        ),
    };
    stored["path"] = Value::from(path.as_str());
    if let Some(old_path) = old_path {
        stored["oldPath"] = Value::from(old_path.as_str());
    }
    stored
}

impl WholePatchFile {
    /// The file's path, its new one for a file the call moved.
    pub(crate) fn path(&self) -> &FilesystemPath {
        match self {
            Self::Read { path, .. } | Self::Absent { path, .. } | Self::Unreadable { path, .. } => {
                path
            }
        }
    }
}
