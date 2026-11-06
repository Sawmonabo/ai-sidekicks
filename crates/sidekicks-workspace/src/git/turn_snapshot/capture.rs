//! What every capture shares besides its steps: the checkout input it takes, the commit's
//! subjects, trailers and identity, the listings it reads from the index, the size bound past which
//! a file is left out, the once-only reports of a git too old, and the object format of the
//! repository it writes to.

use std::borrow::Cow;
use std::collections::HashSet;
use std::io;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use jiff::Timestamp;
use sidekicks_contracts::app_identity::APP_DISPLAY_NAME;
use sidekicks_contracts::place::Place;
use sidekicks_std::mutex_lock::lock;

use crate::git::process::version::{GitFeature, GitVersion};
use crate::git::turn_snapshot::diagnostics::CaptureDiagnostic;
use crate::git::turn_snapshot::held_checkout::CaptureRoots;

/// The checkout one capture records, every field resolved by the caller.
#[derive(Clone, Debug)]
pub struct CheckoutCaptureInput {
    /// The folder of the capture's owner, whose capture folders hold its captures: a session's
    /// storage folder, or the folder a workflow run's caller names.
    pub owner_folder: PathBuf,
    /// Where the run or the command works: the worktree, or the bound folder of a bound root.
    pub execution_root: PathBuf,
    /// The top level of the working tree holding `execution_root`, as its caller records it; a
    /// value the live tree disagrees with fails the capture.
    pub checkout_root: PathBuf,
    /// When the capture is taken: both of its commit's dates, so its id never depends on the
    /// host's time zone or on when the capture ran.
    pub captured_at: Timestamp,
}

impl CheckoutCaptureInput {
    /// The folders the capture's start checks and holds.
    pub(crate) fn roots(&self) -> CaptureRoots<'_> {
        CaptureRoots {
            owner_folder: &self.owner_folder,
            execution_root: &self.execution_root,
            checkout_root: &self.checkout_root,
        }
    }
}

/// Set on every git call that reads or writes an index outside the repository: a split index
/// would put its shared part in the repository's git folder and could expire one the live index
/// still uses, and a file-system monitor would answer for the live index, not this one.
pub(crate) const INDEX_COPY_GUARDS: [&str; 6] = [
    "-c",
    "core.splitIndex=false",
    "-c",
    "splitIndex.sharedIndexExpire=never",
    "-c",
    "core.fsmonitor=false",
];

/// Every capture write flushes its objects and its ref to disk before git answers, whatever the
/// host sets, so a crash after the answer loses no capture.
pub(crate) const CORE_FSYNC_PIN: [&str; 2] = ["-c", "core.fsync=objects,reference"];

/// The same bytes for every turn snapshot: the message is an object id input, so identity content
/// would make identical state hash differently. Trailers derived from project state keep that
/// property.
pub(crate) const TURN_SNAPSHOT_SUBJECT: &str = "sidekicks: turn-boundary snapshot";

/// The same bytes for every snapshot of a workflow run's checkout, for the same reason: the
/// message is an object id input, so identity content would make identical state hash differently.
pub(crate) const WORKFLOW_RUN_SNAPSHOT_SUBJECT: &str = "sidekicks: workflow run snapshot";

/// The subject of each of a command's two captures, the same bytes every time for the same reason.
pub(crate) const COMMAND_CAPTURE_SUBJECT: &str = "sidekicks: command capture";

/// A file larger than this, in bytes, is never hashed into a capture: it is left out of the
/// capture's tree and named in its `Left-Out-Paths:` trailer.
pub const LARGE_FILE_BYTES: u64 = 10 * 1024 * 1024;

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

/// Names the listed paths the tree lacks because the capture left them out: a file over
/// [`LARGE_FILE_BYTES`], or one whose size could not be read. A restore would otherwise delete an
/// untracked one or put back an older blob of a tracked one. Written only when non-empty, JSON and
/// sorted by bytes, each byte of a path written as the one character of the same number.
pub(crate) const LEFT_OUT_PATHS_TRAILER: &str = "Left-Out-Paths:";

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

/// A listed file over [`LARGE_FILE_BYTES`], left out of a capture.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LargeFile {
    /// The file's path within the checkout, as git listed it.
    pub path: PathBuf,
    /// Its size in bytes when the capture read it.
    pub size: u64,
}

/// A listed path whose size could not be read, so the capture left it out rather than hash a file
/// that may be over the bound.
#[derive(Debug)]
pub struct UnreadPath {
    /// The path within the checkout, as git listed it, read as UTF-8 with any other byte replaced
    /// where this system cannot name it.
    pub path: PathBuf,
    /// Why its size could not be read.
    pub error: io::Error,
}

/// A listing split by size: what is staged, and what is left out and why.
#[derive(Debug)]
pub(crate) struct SizePartition {
    /// The entries to stage, as one NUL-terminated listing, each as the listing held it.
    pub(crate) staged_listing: Vec<u8>,
    /// The regular files over [`LARGE_FILE_BYTES`].
    pub(crate) large_files: Vec<LargeFile>,
    /// The paths whose size could not be read.
    pub(crate) unread_paths: Vec<UnreadPath>,
    /// The large files' entries as the listing held them, in the order of `large_files`.
    pub(crate) large_entries: Vec<Vec<u8>>,
    /// Every left-out entry's bytes as the listing held them, for the `Left-Out-Paths:` trailer.
    pub(crate) left_out_entries: Vec<Vec<u8>>,
}

/// The daemon run's one record of the old gits already reported: the places and features whose git
/// was reported too old, so each is logged once whichever capture or packing meets it.
#[derive(Debug, Default)]
pub struct GitFloorReports {
    /// The place and the feature of each report made.
    reported: Mutex<HashSet<(Option<Place>, GitFeature)>>,
}

impl GitFloorReports {
    /// Logs that the git at `place`, `git_version`, lacks `feature`, the first time this daemon run
    /// meets that place and feature.
    pub(crate) fn report_once(
        &self,
        place: Option<&Place>,
        git_version: GitVersion,
        feature: GitFeature,
    ) {
        if lock(&self.reported).insert((place.cloned(), feature)) {
            CaptureDiagnostic::GitBelowFloor {
                place: place.cloned(),
                git_version,
                feature,
            }
            .warn();
        }
    }
}

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
        let reported = String::from_utf8_lossy(stdout);
        let reported = reported.trim();
        [Self::Sha1, Self::Sha256]
            .into_iter()
            .find(|format| format.name() == reported)
            .ok_or_else(|| UnrecognizedObjectFormat {
                reported: reported.to_owned(),
            })
    }

    /// The format's name as `--object-format` takes it.
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Sha1 => "sha1",
            Self::Sha256 => "sha256",
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
