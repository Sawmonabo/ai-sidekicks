//! Git LFS for a clone: whether it is installed, the filter settings a clone runs with so large
//! files arrive whole without the person's global git config being written, and whether a
//! repository keeps files in it.

use std::io;
use std::path::Path;

use memchr::memmem;
use sidekicks_contracts::place::Place;

use crate::git::process::{GitCall, GitError, GitRunner};
use crate::missing_entry::MissingEntry;

/// The four filter settings `git lfs install` writes, exactly as Git LFS writes them, passed to
/// the clone as `-c` options so its checkout fetches large files; the clone's own config gets them
/// from `git lfs install --local` afterwards.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the clone method's large-file step")
)]
pub(crate) const LARGE_FILES_CLONE_OPTIONS: [&str; 8] = [
    "-c",
    "filter.lfs.required=true",
    "-c",
    "filter.lfs.clean=git-lfs clean -- %f",
    "-c",
    "filter.lfs.smudge=git-lfs smudge -- %f",
    "-c",
    "filter.lfs.process=git-lfs filter-process",
];

// The `.gitattributes` setting that sends files through Git LFS.
const LARGE_FILES_ATTRIBUTE: &[u8] = b"filter=lfs";

/// Whether Git LFS is installed for the git a project at `place` runs: `git lfs version` exits 0.
/// A git that exits with any failure means no; fails with the run's error when git did not run to
/// an exit code (not found, not started, timed out, ended by a signal).
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the clone method's large-file step")
)]
pub(crate) async fn is_large_files_installed(
    git: &GitRunner,
    place: Option<&Place>,
) -> Result<bool, GitError> {
    match git.run(place, GitCall::read(["lfs", "version"])).await {
        Ok(_) => Ok(true),
        Err(refused) if refused.exit_code().is_some() => Ok(false),
        Err(failure) => Err(failure),
    }
}

/// Whether the repository at `root` keeps files in Git LFS, read from its top `.gitattributes` as
/// bytes, so a name that is not UTF-8 does not fail the read. A missing file means no; fails with
/// any other read's error.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the clone method's large-file step")
)]
pub(crate) async fn keeps_large_files(root: &Path) -> io::Result<bool> {
    let attributes = tokio::fs::read(root.join(".gitattributes"))
        .await
        .none_if_missing()?;
    Ok(attributes.is_some_and(|attributes| names_large_files_filter(&attributes)))
}

// Whether `attributes` holds `filter=lfs` as a whole word, a byte that is no ASCII letter, digit
// or underscore (or the text's end) on each side, as a regular expression's `\b` reads it.
fn names_large_files_filter(attributes: &[u8]) -> bool {
    let is_word_byte = |byte: &u8| byte.is_ascii_alphanumeric() || *byte == b'_';
    memmem::find_iter(attributes, LARGE_FILES_ATTRIBUTE).any(|start| {
        let before = start
            .checked_sub(1)
            .and_then(|before| attributes.get(before));
        let after = attributes.get(start + LARGE_FILES_ATTRIBUTE.len());
        !before.is_some_and(is_word_byte) && !after.is_some_and(is_word_byte)
    })
}
