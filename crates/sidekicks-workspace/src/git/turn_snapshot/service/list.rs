//! The list of an owner's turn snapshots of one repository, read from its capture folder in one
//! git call.

use std::io;
use std::path::Path;

use jiff::Timestamp;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::repo::git_reads::GitObjectId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::wire::instant::WireInstant;

use super::TurnSnapshotService;
use crate::git::process::{GitCall, GitError};
use crate::git::turn_snapshot::capture_folder::{CaptureFolder, git_folder_argument};
use crate::git::turn_snapshot::refs::{SNAPSHOT_REFS_PREFIX, read_turn_snapshot_ref};
use crate::git::turn_snapshot::retention::parse_snapshot_ref_line;

/// One turn snapshot an owner holds, as its ref and its commit name it.
#[derive(Debug)]
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the session's snapshot list reads each snapshot")
)]
pub(crate) struct TurnSnapshotEntry {
    /// The run whose turn it records.
    pub(crate) run_id: RunId,
    /// The run's execution epoch at the turn.
    pub(crate) epoch: u64,
    /// The turn's ordinal within the epoch.
    pub(crate) turn_ordinal: u64,
    /// The snapshot commit the ref names.
    pub(crate) snapshot_commit: GitObjectId,
    /// When the turn ended: the commit's committer time, to the second.
    pub(crate) created_at: WireInstant,
}

/// Why an owner's turn snapshots could not be listed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum TurnSnapshotListError {
    /// Whether the owner's capture folder exists could not be found out.
    #[error("the capture folder could not be reached")]
    CaptureFolder(#[source] io::Error),
    /// git could not list the folder's refs.
    #[error(transparent)]
    Git(#[from] GitError),
}

impl TurnSnapshotService {
    /// Every turn snapshot the owner whose folder is `owner_folder` holds of the repository whose
    /// common git folder is `git_common_dir`, in ref order, from one git call for the project at
    /// `place`; none when the owner has no capture folder for it. A ref under the snapshot prefix
    /// that this service does not write is left out. Fails as reaching the folder or git does.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the session's snapshot list reads it")
    )]
    pub(crate) async fn list_turn_snapshots(
        &self,
        place: Option<&Place>,
        owner_folder: &Path,
        git_common_dir: &Path,
    ) -> Result<Vec<TurnSnapshotEntry>, TurnSnapshotListError> {
        let Some(capture_folder) = CaptureFolder::open_existing(owner_folder, git_common_dir)
            .await
            .map_err(TurnSnapshotListError::CaptureFolder)?
        else {
            return Ok(Vec::new());
        };
        // The commit is the capture folder's own object, so its time reads with nothing attached.
        let listing = GitCall::read([
            git_folder_argument(capture_folder.folder()),
            "for-each-ref".into(),
            "--format=%(committerdate:unix) %(objectname) %(refname)".into(),
            SNAPSHOT_REFS_PREFIX.into(),
        ]);
        let output = self.git.run(place, listing).await?;
        Ok(String::from_utf8_lossy(&output.stdout)
            .split('\n')
            .filter_map(read_listed_snapshot)
            .collect())
    }
}

// One `<committer seconds> <object id> <ref name>` line as a snapshot; `None` for a malformed line
// or a ref name this service does not write. The time leads, since a ref name holds no space.
fn read_listed_snapshot(line: &str) -> Option<TurnSnapshotEntry> {
    let (committed_at, listed) = line.split_once(' ')?;
    let listed = parse_snapshot_ref_line(listed, SNAPSHOT_REFS_PREFIX)?;
    let (run_id, epoch, turn_ordinal) = read_turn_snapshot_ref(&listed.snapshot_ref)?;
    let committed_at = Timestamp::from_second(committed_at.parse().ok()?).ok()?;
    Some(TurnSnapshotEntry {
        run_id,
        epoch,
        turn_ordinal,
        snapshot_commit: listed.object_id,
        created_at: WireInstant::from_timestamp(committed_at)?,
    })
}
