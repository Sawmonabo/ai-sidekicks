//! One file's whole patch as a driver reads it from a provider's file change, before the patch
//! read pages it into the bounded pieces a client reads.

use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::transcript::content::TranscriptPatchFileUnavailable;

/// One file's whole patch with the lines it adds and removes, or why it cannot be read. Unlike a
/// page's `TranscriptPatchFile`, the patch is never cut: the patch read pages it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum WholePatchFile {
    /// The patch.
    Read {
        /// The file's path.
        path: FilesystemPath,
        /// The whole patch.
        patch: String,
        /// The lines it adds.
        additions: u64,
        /// The lines it removes.
        deletions: u64,
    },
    /// Why it cannot be read.
    Unavailable(TranscriptPatchFileUnavailable),
}
