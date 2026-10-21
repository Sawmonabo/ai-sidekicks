//! What live trees and put-backs under way hold in a repository: the folders live worktree rows
//! stand at, the records put-backs are making and the branches either is on. A kept copy's stale
//! record removal and a put-back's undo read them, so neither takes another tree's record or
//! branch. A branch is claimed only in its own repository, known by its git common folder: another
//! repository's branch of the same name is another branch.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use crate::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool, ReadLength};
use crate::git::worktree::reads::common_folder_of_record;
use crate::git::worktree::rows::live_worktree_state_predicate;
use crate::workspace::row_guards::COMMON_DIR_METADATA_PATH;
use crate::workspace::trust_envelope::components_equal;

// Each live tree's folder and branch, with the common folder its mount records, `NULL` for a mount
// that records none.
static SELECT_LIVE_TREES_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT wt.fs_root, wt.branch_name, json_extract(mount.metadata, '{}')
  FROM worktrees AS wt JOIN repo_mounts AS mount ON mount.id = wt.repo_mount_id
 WHERE {}",
        COMMON_DIR_METADATA_PATH,
        live_worktree_state_predicate("wt")
    )
});

const SELECT_RESTORING_RECORDS_SQL: &str = "SELECT restoring_record, restoring_branch
  FROM removed_worktrees WHERE restoring_record IS NOT NULL";

/// Why the claims could not be read.
#[derive(Debug, thiserror::Error)]
pub(crate) enum KeptCopyClaimsReadError {
    /// The read did not reach the database.
    #[error("the claims of live trees and put-backs did not reach the database")]
    Pool(#[from] DatabaseReadError),
    /// The rows could not be read.
    #[error("the claims of live trees and put-backs could not be read")]
    Database(#[from] rusqlite::Error),
}

// A live tree as its row stands.
struct LiveTreeClaim {
    folder: PathBuf,
    branch: String,
    common_folder: Option<PathBuf>,
}

// A put-back under way: the record it is making and the branch it makes, when it makes one.
struct RestoringClaim {
    record: PathBuf,
    branch: Option<String>,
}

/// What live trees and put-backs under way held when the claims were read, so a kept copy never
/// removes another tree's record or branch.
pub(crate) struct KeptCopyClaims {
    live_trees: Vec<LiveTreeClaim>,
    restoring: Vec<RestoringClaim>,
}

/// Reads the live trees, with the common folder each one's mount records, and the put-backs under
/// way, once, on `reads`. Fails with the pool's or SQLite's failure.
#[expect(
    dead_code,
    reason = "a kept copy's stale record removal and a put-back's undo read the claims"
)]
pub(crate) async fn prepare_kept_copy_claims(
    reads: &DatabaseReadPool,
) -> Result<KeptCopyClaims, KeptCopyClaimsReadError> {
    reads
        .read(ReadLength::Short, |connection| {
            let live_trees = connection
                .prepare_cached(SELECT_LIVE_TREES_SQL.as_str())?
                .query_map([], |row| {
                    Ok(LiveTreeClaim {
                        folder: PathBuf::from(row.get::<_, String>(0)?),
                        branch: row.get(1)?,
                        common_folder: row.get::<_, Option<String>>(2)?.map(PathBuf::from),
                    })
                })?
                .collect::<rusqlite::Result<_>>()?;
            let restoring = connection
                .prepare_cached(SELECT_RESTORING_RECORDS_SQL)?
                .query_map([], |row| {
                    Ok(RestoringClaim {
                        record: PathBuf::from(row.get::<_, String>(0)?),
                        branch: row.get(1)?,
                    })
                })?
                .collect::<rusqlite::Result<_>>()?;
            Ok(KeptCopyClaims {
                live_trees,
                restoring,
            })
        })
        .await
}

impl KeptCopyClaims {
    /// Whether a live worktree row has its folder at `folder`, compared by components as stored.
    #[expect(dead_code, reason = "a kept copy's stale record removal")]
    pub(crate) fn is_live_tree_at(&self, folder: &Path) -> bool {
        self.live_trees
            .iter()
            .any(|tree| components_equal(&tree.folder, folder))
    }

    /// The records the put-backs under way are making, as their marks name them.
    #[expect(dead_code, reason = "a kept copy's stale record removal")]
    pub(crate) fn restoring_records(&self) -> impl Iterator<Item = &Path> {
        self.restoring.iter().map(|claim| claim.record.as_path())
    }

    /// Whether, in the repository whose git common folder is `common_folder`, a live worktree row
    /// is on `branch` or a put-back other than the one making `record_folder` is making it. A live
    /// tree whose mount records no common folder may be in this repository, so it claims.
    #[expect(
        dead_code,
        reason = "a kept copy's stale record removal and a put-back's undo"
    )]
    pub(crate) fn is_branch_claimed(
        &self,
        branch: &str,
        common_folder: &Path,
        record_folder: &Path,
    ) -> bool {
        let is_this_repository = |claim_common_folder: Option<&Path>| {
            claim_common_folder.is_none_or(|claim| components_equal(claim, common_folder))
        };
        self.live_trees
            .iter()
            .filter(|tree| tree.branch == branch)
            .any(|tree| is_this_repository(tree.common_folder.as_deref()))
            || self
                .restoring
                .iter()
                .filter(|claim| {
                    claim.branch.as_deref() == Some(branch)
                        && !components_equal(&claim.record, record_folder)
                })
                .any(|claim| is_this_repository(common_folder_of_record(&claim.record)))
    }
}
