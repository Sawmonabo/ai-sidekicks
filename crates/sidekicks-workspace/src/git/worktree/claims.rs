//! What live trees and put-backs under way hold in a repository: the folders live worktree rows
//! stand at, the records put-backs are making and the branches either is on. A kept copy's stale
//! record removal and a put-back's undo read them, so neither takes another tree's record or
//! branch. A branch is claimed only in its own repository, known by its git common folder: another
//! repository's branch of the same name is another branch.

use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use rusqlite::Connection;

use crate::git::worktree::reads::common_folder_of_record;
use crate::git::worktree::rows::live_worktree_state_predicate;
use crate::row_guards::COMMON_DIR_METADATA_PATH;
use crate::trust_envelope::components_equal;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};

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

/// What live trees and put-backs under way hold, read from the database each time it is asked, so
/// a kept copy never removes another tree's record or branch, one claimed since included.
pub(crate) struct KeptCopyClaims {
    reads: Arc<DatabaseReadPool>,
}

impl KeptCopyClaims {
    /// The claims as `reads` holds them whenever asked.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "a kept copy's stale record removal and a put-back's undo read the claims"
        )
    )]
    pub(crate) fn new(reads: Arc<DatabaseReadPool>) -> Self {
        Self { reads }
    }

    /// Whether a live worktree row has its folder at `folder`, compared by components as stored.
    /// Fails with the pool's or SQLite's failure.
    #[expect(dead_code, reason = "a kept copy's stale record removal")]
    pub(crate) async fn is_live_tree_at(
        &self,
        folder: &Path,
    ) -> Result<bool, KeptCopyClaimsReadError> {
        Ok(self
            .read_live_trees()
            .await?
            .iter()
            .any(|tree| components_equal(&tree.folder, folder)))
    }

    /// The records the put-backs under way are making, as their marks name them. Fails with the
    /// pool's or SQLite's failure.
    #[expect(dead_code, reason = "a kept copy's stale record removal")]
    pub(crate) async fn restoring_records(&self) -> Result<Vec<PathBuf>, KeptCopyClaimsReadError> {
        Ok(self
            .read_restoring()
            .await?
            .into_iter()
            .map(|claim| claim.record)
            .collect())
    }

    /// Whether, in the repository whose git common folder is `common_folder`, a live worktree row
    /// is on `branch` or a put-back other than the one making `record_folder` is making it, both
    /// read when asked in one read transaction, so a put-back that finishes meanwhile is seen as
    /// one or the other. A live tree whose mount records no common folder may be in this
    /// repository, so it claims. Fails with the pool's or SQLite's failure.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "a kept copy's stale record removal and a put-back's undo"
        )
    )]
    pub(crate) async fn is_branch_claimed(
        &self,
        branch: &str,
        common_folder: &Path,
        record_folder: &Path,
    ) -> Result<bool, KeptCopyClaimsReadError> {
        let is_this_repository = |claim_common_folder: Option<&Path>| {
            claim_common_folder.is_none_or(|claim| components_equal(claim, common_folder))
        };
        let (live_trees, restoring) = self
            .reads
            .read(ReadLength::Short, |connection| {
                // One snapshot for both reads: a put-back's finish links its tree and clears its
                // mark in one write.
                let snapshot = connection.unchecked_transaction()?;
                let claims = (query_live_trees(&snapshot)?, query_restoring(&snapshot)?);
                snapshot.commit()?;
                Ok::<_, KeptCopyClaimsReadError>(claims)
            })
            .await?;
        let is_live_tree_on = live_trees
            .iter()
            .filter(|tree| tree.branch == branch)
            .any(|tree| is_this_repository(tree.common_folder.as_deref()));
        Ok(is_live_tree_on
            || restoring
                .iter()
                .filter(|claim| {
                    claim.branch.as_deref() == Some(branch)
                        && !components_equal(&claim.record, record_folder)
                })
                .any(|claim| is_this_repository(common_folder_of_record(&claim.record))))
    }

    // The live trees, with the common folder each one's mount records.
    async fn read_live_trees(&self) -> Result<Vec<LiveTreeClaim>, KeptCopyClaimsReadError> {
        self.reads
            .read(ReadLength::Short, |connection| {
                Ok(query_live_trees(connection)?)
            })
            .await
    }

    // The put-backs under way.
    async fn read_restoring(&self) -> Result<Vec<RestoringClaim>, KeptCopyClaimsReadError> {
        self.reads
            .read(ReadLength::Short, |connection| {
                Ok(query_restoring(connection)?)
            })
            .await
    }
}

// The live trees, with the common folder each one's mount records.
fn query_live_trees(connection: &Connection) -> rusqlite::Result<Vec<LiveTreeClaim>> {
    connection
        .prepare_cached(SELECT_LIVE_TREES_SQL.as_str())?
        .query_map([], |row| {
            Ok(LiveTreeClaim {
                folder: PathBuf::from(row.get::<_, String>(0)?),
                branch: row.get(1)?,
                common_folder: row.get::<_, Option<String>>(2)?.map(PathBuf::from),
            })
        })?
        .collect()
}

// The put-backs under way.
fn query_restoring(connection: &Connection) -> rusqlite::Result<Vec<RestoringClaim>> {
    connection
        .prepare_cached(SELECT_RESTORING_RECORDS_SQL)?
        .query_map([], |row| {
            Ok(RestoringClaim {
                record: PathBuf::from(row.get::<_, String>(0)?),
                branch: row.get(1)?,
            })
        })?
        .collect()
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::Arc;

    use rusqlite::params;

    use super::KeptCopyClaims;
    use crate::git::worktree::schema::schema_parts;
    use crate::test_rows::project_and_mount_rows;
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::writer::test_file::TestDatabase;
    use sidekicks_store::events::log_service::test_log::open_log;

    const READ_STATEMENT_CAPACITY: usize = 4;

    // Kills the claims answered from a read taken when the reader was made, which lets a put-back
    // delete a branch another put-back marked since.
    #[tokio::test]
    async fn a_put_back_s_mark_made_after_the_claims_are_made_is_seen() {
        let database = TestDatabase::new(schema_parts());
        // Opening the log makes the database's tables.
        let _log = open_log(&database, None).await;
        let connection = database.reader();
        for row in project_and_mount_rows("mount", None) {
            connection
                .execute_batch(&row)
                .expect("the project and its mount are stored");
        }
        let claims = KeptCopyClaims::new(Arc::new(DatabaseReadPool::new(
            database.path(),
            READ_STATEMENT_CAPACITY,
        )));
        let common_folder = Path::new("/repos/app/.git");
        let own_record = Path::new("/repos/app/.git/worktrees/own");
        assert!(
            !claims
                .is_branch_claimed("fix", common_folder, own_record)
                .await
                .expect("the claims read")
        );

        connection
            .execute(
                "INSERT INTO removed_worktrees (id, mount_id, project_id, created_by_session_id, \
                 worktree_name, original_path, kept_path, branch, base_ref, restoring_to, \
                 restoring_record, restoring_branch, restoring_branch_commit) \
                 VALUES ('other', 'mount', 'mount', 'session', 'fix', '/trees/fix', \
                 '/kept/fix', 'fix', 'main', '/trees/fix', ?1, 'fix', ?2)",
                params!["/repos/app/.git/worktrees/other", "0".repeat(40)],
            )
            .expect("another put-back marks the branch");

        assert!(
            claims
                .is_branch_claimed("fix", common_folder, own_record)
                .await
                .expect("the claims read"),
            "the mark made since is seen"
        );
    }
}
