//! What a snapshot capture needs besides the service: the commit's message, trailers and identity,
//! the listings it reads from the index, and the object format of the repository it writes to.

use std::borrow::Cow;
use std::time::Duration;

use jiff::Timestamp;
use sidekicks_contracts::app_identity::APP_DISPLAY_NAME;

/// Outside the worktree, so scratch indexes never show up in `ls-files -o` or `git status`.
pub(crate) const SNAPSHOT_INDEX_SEGMENT: &str = ".snapshot-indexes";

/// The same bytes for every snapshot: the message is an object id input, so identity content would
/// make identical state hash differently. Trailers derived from project state keep that property.
pub(crate) const SNAPSHOT_COMMIT_MESSAGE: &str = "sidekicks: turn-boundary snapshot";

/// Names the embedded repositories the capture could not record. A skipped one is absent from the
/// tree, so a restore would delete it and its `.git` as untracked. Written only when non-empty,
/// JSON-encoded (a newline cannot forge a trailer) and sorted (message bytes are an object id
/// input).
pub(crate) const SKIPPED_EMBEDDED_REPOSITORIES_TRAILER: &str = "Skipped-Embedded-Repositories:";

/// Names out-of-cone paths at the boundary that the tree lacks (untracked, or intent-to-add:
/// `write-tree` omits them, git 2.50.1); a restore would delete them. Written in every sparse root
/// (`[]` when empty), so presence is the format marker. JSON and sorted, each byte of a path
/// written as the one character of the same number. A trailing slash marks a directory git did not
/// descend into (a restore exempts everything beneath it).
pub(crate) const SPARSE_BOUNDARY_PATHS_TRAILER: &str = "Sparse-Boundary-Paths:";

/// An explicit identity: without one `commit-tree` fails in a container with no passwd entry, and
/// elsewhere stamps the system user.
pub(crate) const SNAPSHOT_IDENTITY_NAME: &str = APP_DISPLAY_NAME;

/// The committer email that goes with the snapshot identity name.
pub(crate) const SNAPSHOT_IDENTITY_EMAIL: &str = "snapshots@ai-sidekicks.invalid";

/// The listing's only exclude source: porcelain `add -A` also honors `core.excludesFile` and
/// `$GIT_DIR/info/exclude`, which are not project declarations.
pub(crate) const EXCLUDE_PER_DIRECTORY_GITIGNORE: &str = "--exclude-per-directory=.gitignore";

/// The config key that turns sparse checkout on.
pub(crate) const CORE_SPARSE_CHECKOUT_KEY: &str = "core.sparseCheckout";

/// The lock is held for one index write, so contention clears at once. A stale lock from a crashed
/// git must fail fast as a typed error; this code never removes a lock it did not create.
pub(crate) const SPARSE_SEED_INDEX_LOCK_ATTEMPTS: u32 = 4;

/// The wait between the lock attempts.
pub(crate) const SPARSE_SEED_INDEX_LOCK_RETRY_DELAY: Duration = Duration::from_millis(25);

/// A repository's object format, as `rev-parse --show-object-format` names it. A valid id can be
/// un-insertable in a repository of the other width.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ObjectFormat {
    /// SHA-1 object ids, 40 hex digits.
    Sha1,
    /// SHA-256 object ids, 64 hex digits.
    Sha256,
}

/// git named an object format this code does not know.
#[derive(Debug, thiserror::Error)]
#[error("git reported an unrecognized object format: {reported}")]
pub(crate) struct UnrecognizedObjectFormat {
    /// The name git printed, trimmed.
    reported: String,
}

impl ObjectFormat {
    /// The format `rev-parse --show-object-format` printed in `stdout`. Fails with
    /// `UnrecognizedObjectFormat` for any name but `sha1` and `sha256`.
    pub(crate) fn from_show_object_format(stdout: &[u8]) -> Result<Self, UnrecognizedObjectFormat> {
        match String::from_utf8_lossy(stdout).trim() {
            "sha1" => Ok(Self::Sha1),
            "sha256" => Ok(Self::Sha256),
            reported => Err(UnrecognizedObjectFormat {
                reported: reported.to_owned(),
            }),
        }
    }

    /// The hex digits in one object id of this format.
    pub(crate) fn object_id_hex_length(self) -> usize {
        match self {
            Self::Sha1 => 40,
            Self::Sha256 => 64,
        }
    }
}

/// An instant as git's raw `<unix seconds> +0000` date; the fixed offset keeps the snapshot id
/// independent of the host's time zone.
pub(crate) fn to_raw_git_date(instant: Timestamp) -> String {
    format!("{} +0000", instant.as_second())
}

/// The entries of a NUL-terminated listing, undecoded, since a decode would break the match with
/// git's echo of them. Empty entries are dropped and an unterminated last entry is kept, so no
/// path is silently omitted.
pub(crate) fn split_nul_terminated_listing_bytes(listing: &[u8]) -> impl Iterator<Item = &[u8]> {
    listing
        .split(|&byte| byte == 0)
        .filter(|entry| !entry.is_empty())
}

/// Joins entries into one listing, each entry followed by a NUL: the inverse of splitting one.
pub(crate) fn join_nul_terminated_listing<Entry: AsRef<[u8]>>(
    entries: impl IntoIterator<Item = Entry>,
) -> Vec<u8> {
    let mut listing = Vec::new();
    for entry in entries {
        listing.extend_from_slice(entry.as_ref());
        listing.push(0);
    }
    listing
}

/// The cone partition of one `-z` listing. The out-of-cone entries stay undecoded slices of the
/// listing, a trailing slash kept, because the boundary subtraction compares them against another
/// git listing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SparseListingPartition<'listing> {
    /// The in-cone entries as one NUL-terminated listing; the whole listing when nothing is sparse.
    pub(crate) in_cone_listing: Cow<'listing, [u8]>,
    /// The entries outside the cone, each as the listing holds it.
    pub(crate) out_of_cone_entries: Vec<&'listing [u8]>,
}

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::{join_nul_terminated_listing, split_nul_terminated_listing_bytes};

    // Paths reach git and the snapshot's trailers byte for byte, so a split that decoded, dropped a
    // tail or kept an empty entry would record a different tree.
    #[rstest]
    #[case::non_utf8_entry(
        b"a\xff\xfeb\0c\0",
        &[b"a\xff\xfeb".as_slice(), b"c".as_slice()],
        b"a\xff\xfeb\0c\0"
    )]
    #[case::unterminated_tail(b"a\0tail", &[b"a".as_slice(), b"tail".as_slice()], b"a\0tail\0")]
    #[case::empty_entries_drop(b"\0\0a\0\0b\0", &[b"a".as_slice(), b"b".as_slice()], b"a\0b\0")]
    #[case::only_terminators(b"\0\0", &[], b"")]
    #[case::terminated_round_trip(
        b"dir/\0file\0",
        &[b"dir/".as_slice(), b"file".as_slice()],
        b"dir/\0file\0"
    )]
    fn a_listing_splits_and_joins_byte_for_byte(
        #[case] listing: &[u8],
        #[case] entries: &[&[u8]],
        #[case] joined: &[u8],
    ) {
        let split = split_nul_terminated_listing_bytes(listing).collect::<Vec<_>>();

        assert_eq!(split, entries);
        assert_eq!(join_nul_terminated_listing(&split), joined);
    }
}
