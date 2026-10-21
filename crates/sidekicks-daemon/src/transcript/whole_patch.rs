//! One file's whole patch as a driver reads it from a provider's file change and as a tool
//! completion stores it, before the patch read pages it into the bounded pieces a client reads.

use serde::Deserialize;
use sidekicks_contracts::free_form_string::FilesystemPath;

/// The payload member of a tool completion that names the files its body's patches cover; a
/// completion carrying it stores its body whole.
pub(crate) const OMITTED_PATCHES_PAYLOAD_KEY: &str = "omittedPatches";

/// One file's whole patch with the lines it adds and removes, or why there is none. Unlike a
/// page's `TranscriptPatchFile`, the patch and the raw text are never cut: the patch read pages
/// them. `old_path` is set on a file the call moved, which `path` names by its new path. A stored
/// file reads in the page's shape, as the arm whose text it carries: a patch, the raw text of one
/// that could not be read, or neither; the stored list is the producer's own write, so the
/// `unavailable` word beside the text is not read again.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(untagged, rename_all_fields = "camelCase")]
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
    },
}
