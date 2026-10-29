//! The switcher's list: a project's own checkout and every tree git lists for its repository, each
//! with its base, its distance from its upstream, its uncommitted and unpushed counts and the
//! sessions standing in it, from one read so no row shows a tree free that another read calls
//! occupied. A tree this daemon made carries its record; one the person made carries none. A
//! record git no longer lists (a tree that failed before git made it) still has its row, with no
//! figures to read.

use std::collections::HashMap;
use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use futures::future::BoxFuture;
use rusqlite::{Connection, OptionalExtension};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::git::shared::GitRefName;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::project::ProjectId;
use sidekicks_contracts::repo::mount::{RepoMountId, RepoMountState};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::TextError;
use sidekicks_contracts::worktree::lifecycle::{
    NewWorktreeSuggestion, RepoRootStatus, WorktreeId, WorktreeState, WorktreeStatusReadRequest,
    WorktreeStatusReadResponse,
};
use sidekicks_ipc::registry::HandlerError;
use sidekicks_ipc::session_not_found::session_not_found;
use sidekicks_std::processor_bound::map_with_processor_bound;
use sidekicks_std::settle_all::SettleFailures;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::stored_column::{closed_word, optional_text_column, text_column};

use crate::folder::canonical_path::canonical_folder_path;
use crate::git::process::{GitError, GitRunner};
use crate::git::worktree::fetch::read_counts_as_of;
use crate::git::worktree::occupancy::{MountOccupancy, MountOccupancyReader, OccupancyReadError};
use crate::git::worktree::projector::{
    WorktreeRecordRow, WorktreeStatusProjectionError, WorktreeStatusReading, WorktreeStatusRow,
    project_worktree_status_read,
};
use crate::git::worktree::reads::{
    ListedWorktree, commit_count, read_branch_figures, read_listed_worktrees, tree_name_of,
};
use crate::git::worktree::risks::{RemovalRiskReadError, read_removal_risks};
use crate::repo::errors::RepoRefusal;

static SELECT_PROJECT_MOUNT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT id, canonical_root, place FROM repo_mounts WHERE project_id = ? AND state = '{}'",
        <&'static str>::from(RepoMountState::Attached)
    )
});

// The base is the one the tree's first branch context recorded when the tree was prepared.
static SELECT_WORKTREE_RECORDS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT wt.id, wt.repo_mount_id, wt.created_by_session_id, wt.created_by_run_id, wt.state,
       wt.created_at, wt.updated_at,
       (SELECT bc.base_branch FROM branch_contexts AS bc
         WHERE bc.worktree_id = wt.id
         ORDER BY bc.created_at
         LIMIT 1),
       wt.branch_name, wt.fs_root
  FROM worktrees AS wt
 WHERE wt.repo_mount_id = ? AND wt.state <> '{}'
 ORDER BY wt.created_at, wt.id",
        <&'static str>::from(WorktreeState::Retired)
    )
});

/// The distinct statements the status read keeps prepared on each read connection.
pub const WORKTREE_STATUS_READER_STATEMENT_CAPACITY: usize = 4;

const SELECT_SESSION_EXISTS_SQL: &str = "SELECT EXISTS (SELECT 1 FROM sessions WHERE id = ?)";

/// The one daemon function that names and creates a tree, answering what the new-worktree form
/// opens with for a session of the project.
pub trait NewWorktreeSuggestionSource: Send + Sync {
    /// The suggestion for `session_id` on `repo_mount_id`. Fails with the naming's failure.
    fn suggest_new_worktree<'a>(
        &'a self,
        repo_mount_id: &'a RepoMountId,
        session_id: &'a SessionId,
    ) -> BoxFuture<'a, Result<NewWorktreeSuggestion, Box<dyn Error + Send + Sync>>>;
}

/// Why a project's trees could not be read; no message names a path.
#[derive(Debug, thiserror::Error)]
pub enum WorktreeStatusReadError {
    /// The project has no attached repository.
    #[error("project {project_id} has no attached repository to read")]
    NoAttachedRepository {
        /// The project asked for.
        project_id: ProjectId,
    },
    /// The session the read is asked for holds no row.
    #[error("session {session_id} holds no row to suggest a worktree for")]
    UnknownSession {
        /// The session named.
        session_id: SessionId,
    },
    /// git listed no checkout of the repository's own.
    #[error("project {project_id} has no checkout of its own to read")]
    NoCheckout {
        /// The project asked for.
        project_id: ProjectId,
    },
    /// git listed a tree on neither a branch nor a commit.
    #[error("git listed a tree on neither a branch nor a commit")]
    TreeWithoutHead,
    /// The read did not reach the database.
    #[error("the worktree status rows did not reach the database")]
    Pool(#[from] DatabaseReadError),
    /// The rows could not be read.
    #[error("the worktree status rows could not be read")]
    Database(#[from] rusqlite::Error),
    /// A git read failed.
    #[error("the repository's trees could not be read")]
    Git(#[from] GitError),
    /// What a tree holds could not be read, for one tree or several.
    #[error("what the repository's trees hold could not be read")]
    Risks(#[from] SettleFailures<RemovalRiskReadError>),
    /// Who stands in the trees could not be read.
    #[error(transparent)]
    Occupancy(#[from] OccupancyReadError),
    /// A tree's folder could not be resolved (a permission refusal).
    #[error("a tree's folder could not be resolved")]
    Folder(#[source] io::Error),
    /// A folder or a branch git printed is no text the list can carry.
    #[error("a tree's folder or branch cannot be listed")]
    Text(#[source] TextError),
    /// The reading could not be folded onto the answer.
    #[error(transparent)]
    Projection(#[from] WorktreeStatusProjectionError),
    /// The new-worktree form's suggestion could not be made.
    #[error("the new worktree's suggestion could not be made")]
    Suggestion(#[source] Box<dyn Error + Send + Sync>),
}

impl From<WorktreeStatusReadError> for HandlerError {
    /// A project with no attached repository is refused `project.notFound` and an unknown session
    /// `session.notFound`; every other failure is a fault.
    fn from(error: WorktreeStatusReadError) -> Self {
        match error {
            WorktreeStatusReadError::NoAttachedRepository { project_id } => {
                Self::Refused(RepoRefusal::ProjectNotFound { project_id }.into())
            }
            WorktreeStatusReadError::UnknownSession { session_id } => {
                Self::Refused(session_not_found(&session_id))
            }
            fault @ (WorktreeStatusReadError::NoCheckout { .. }
            | WorktreeStatusReadError::TreeWithoutHead
            | WorktreeStatusReadError::Pool(_)
            | WorktreeStatusReadError::Database(_)
            | WorktreeStatusReadError::Git(_)
            | WorktreeStatusReadError::Risks(_)
            | WorktreeStatusReadError::Occupancy(_)
            | WorktreeStatusReadError::Folder(_)
            | WorktreeStatusReadError::Text(_)
            | WorktreeStatusReadError::Projection(_)
            | WorktreeStatusReadError::Suggestion(_)) => Self::Internal(Box::new(fault)),
        }
    }
}

// A record the read found, with the folder and branch it stands at.
struct RecordWithFolder {
    record: WorktreeRecordRow,
    branch_name: GitRefName,
    folder: PathBuf,
}

// What the database says about the project.
struct StatusRows {
    repo_mount_id: RepoMountId,
    repository_root: PathBuf,
    place: Option<Place>,
    records: Vec<RecordWithFolder>,
    counts_as_of: Option<WireInstant>,
}

/// What the status reader runs with.
pub struct WorktreeStatusReaderDeps {
    /// The daemon's git entry point, running with the repository's own config.
    pub git: GitRunner,
    /// The daemon's read pool.
    pub reads: Arc<DatabaseReadPool>,
    /// The daemon's one occupancy reader, for the sessions in each tree.
    pub occupancy: MountOccupancyReader,
    /// The new-worktree form's suggestion.
    pub new_worktree: Arc<dyn NewWorktreeSuggestionSource>,
}

/// Answers `worktree.status.read` for a project.
pub struct WorktreeStatusReader {
    deps: WorktreeStatusReaderDeps,
}

impl WorktreeStatusReader {
    /// A reader over `deps`.
    pub fn new(deps: WorktreeStatusReaderDeps) -> Self {
        Self { deps }
    }

    /// `worktree.status.read`: the project's checkout and trees, each tree's risks read alongside
    /// the others, with the new-worktree form's suggestion for the session asking. Fails with
    /// [`WorktreeStatusReadError::NoAttachedRepository`] when the project has no attached
    /// repository, [`WorktreeStatusReadError::UnknownSession`] for a session with no row, and
    /// when a read fails, so the list is never drawn from figures the daemon could not read.
    pub async fn read(
        &self,
        request: &WorktreeStatusReadRequest,
    ) -> Result<WorktreeStatusReadResponse, WorktreeStatusReadError> {
        let project_id = request.project_id;
        let session_id = request.session_id;
        let rows = self
            .deps
            .reads
            .read(ReadLength::Short, move |connection| {
                read_rows(connection, &project_id, session_id.as_ref())
            })
            .await?
            .ok_or(WorktreeStatusReadError::NoAttachedRepository { project_id })?;
        let git = &self.deps.git;
        let place = rows.place.as_ref();
        let root = rows.repository_root.as_path();
        let (listed, branch_figures) = tokio::try_join!(
            read_listed_worktrees(git, place, root, None),
            read_branch_figures(git, place, root),
        )?;
        let main_checkout = listed
            .iter()
            .find(|tree| tree.is_main_checkout)
            .ok_or(WorktreeStatusReadError::NoCheckout { project_id })?;
        let distance_by_branch: HashMap<String, (Option<u64>, Option<u64>)> = branch_figures
            .into_iter()
            .map(|branch| (branch.name, (branch.ahead, branch.behind)))
            .collect();
        let mut records: Vec<(PathBuf, Option<RecordWithFolder>)> = Vec::new();
        for record in rows.records {
            records.push((
                canonical_folder_path(&record.folder)
                    .await
                    .map_err(WorktreeStatusReadError::Folder)?,
                Some(record),
            ));
        }
        let occupancy = self.deps.occupancy.read(&rows.repo_mount_id).await?;

        // Trees git lists, in its order; the checkout itself is the separate root row, and a bare
        // repository's own record has no folder to stand in.
        let mut listed_trees = Vec::new();
        for tree in &listed {
            if tree.is_main_checkout || tree.is_bare || tree.is_prunable {
                continue;
            }
            let folder = canonical_folder_path(&tree.path)
                .await
                .map_err(WorktreeStatusReadError::Folder)?;
            let record = records
                .iter_mut()
                .find(|(key, _)| *key == folder)
                .and_then(|(_, record)| record.take());
            listed_trees.push((tree, folder, record));
        }
        // The same read the removal confirm draws its risks from, so a row and its confirm agree.
        // Each tree's folder and occupants taken first, so the reads hold no borrow of a row.
        let risk_reads: Vec<(PathBuf, Vec<SessionId>)> = listed_trees
            .iter()
            .map(|(tree, folder, _)| (tree.path.clone(), occupants_of(&occupancy, folder).0))
            .collect();
        let risks = map_with_processor_bound(
            risk_reads,
            "reading what the trees hold",
            |(tree_path, occupants)| async move {
                read_removal_risks(git, place, &tree_path, occupants).await
            },
        )
        .await?;

        let mut worktrees = Vec::with_capacity(listed_trees.len() + records.len());
        for ((tree, folder, record), risks) in listed_trees.into_iter().zip(risks) {
            let distance = tree
                .branch_name
                .as_ref()
                .and_then(|branch| distance_by_branch.get(branch))
                .copied();
            let (occupying_session_ids, running_session_id) = occupants_of(&occupancy, &folder);
            worktrees.push(WorktreeStatusRow {
                path: path_text(&tree.path)?,
                name: tree_name_of(&tree.path).map_err(WorktreeStatusReadError::Text)?,
                branch_name: branch_name_of(tree)?,
                ahead: distance.and_then(|(ahead, _)| ahead).map(commit_count),
                behind: distance.and_then(|(_, behind)| behind).map(commit_count),
                uncommitted_file_count: risks.uncommitted_file_count,
                unpushed_commit_count: risks.unpushed_commit_count,
                occupying_session_ids,
                running_session_id,
                record: record.map(|record| record.record),
            });
        }
        // Records git does not list: trees that failed or are still being made, or whose folder is
        // gone. Their rows stand with their recorded branch and nothing to count.
        for (folder, record) in records {
            let Some(record) = record else { continue };
            let (occupying_session_ids, running_session_id) = occupants_of(&occupancy, &folder);
            worktrees.push(WorktreeStatusRow {
                path: path_text(&record.folder)?,
                name: tree_name_of(&record.folder).map_err(WorktreeStatusReadError::Text)?,
                branch_name: record.branch_name,
                ahead: None,
                behind: None,
                uncommitted_file_count: SafeInt::ZERO,
                unpushed_commit_count: SafeInt::ZERO,
                occupying_session_ids,
                running_session_id,
                record: Some(record.record),
            });
        }

        let new_worktree = match request.session_id {
            Some(session_id) => Some(
                self.deps
                    .new_worktree
                    .suggest_new_worktree(&rows.repo_mount_id, &session_id)
                    .await
                    .map_err(WorktreeStatusReadError::Suggestion)?,
            ),
            None => None,
        };
        Ok(project_worktree_status_read(WorktreeStatusReading {
            repo_mount_id: rows.repo_mount_id,
            repo_root: RepoRootStatus {
                path: path_text(&main_checkout.path)?,
                branch_name: branch_name_of(main_checkout)?,
            },
            worktrees,
            counts_as_of: rows.counts_as_of,
            new_worktree,
        })?)
    }
}

// The project's attached mount and its records, `None` when it has no attached mount. Refuses a
// named session with no row.
fn read_rows(
    connection: &Connection,
    project_id: &ProjectId,
    session_id: Option<&SessionId>,
) -> Result<Option<StatusRows>, WorktreeStatusReadError> {
    let Some((repo_mount_id, repository_root, place)) = connection
        .prepare_cached(SELECT_PROJECT_MOUNT_SQL.as_str())?
        .query_row([project_id.to_string()], |row| {
            Ok((
                text_column(row, 0, |text| RepoMountId::new(&text))?,
                PathBuf::from(row.get::<_, String>(1)?),
                // The column holds the place's wire JSON.
                optional_text_column(row, 2, |text| serde_json::from_str::<Place>(&text))?,
            ))
        })
        .optional()?
    else {
        return Ok(None);
    };
    if let Some(session_id) = session_id
        && !connection
            .prepare_cached(SELECT_SESSION_EXISTS_SQL)?
            .query_row([session_id.to_string()], |row| row.get::<_, bool>(0))?
    {
        return Err(WorktreeStatusReadError::UnknownSession {
            session_id: *session_id,
        });
    }
    let records = connection
        .prepare_cached(SELECT_WORKTREE_RECORDS_SQL.as_str())?
        .query_map([repo_mount_id.to_string()], |row| {
            Ok(RecordWithFolder {
                record: WorktreeRecordRow {
                    id: text_column(row, 0, |text| WorktreeId::new(&text))?,
                    repo_mount_id: text_column(row, 1, |text| RepoMountId::new(&text))?,
                    created_by_session_id: text_column(row, 2, |text| SessionId::new(&text))?,
                    created_by_run_id: optional_text_column(row, 3, |text| RunId::new(&text))?,
                    state: text_column(row, 4, closed_word)?,
                    created_at: text_column(row, 5, WireInstant::try_from)?,
                    updated_at: text_column(row, 6, WireInstant::try_from)?,
                    base_branch_name: optional_text_column(row, 7, GitRefName::new)?,
                },
                branch_name: text_column(row, 8, GitRefName::new)?,
                folder: PathBuf::from(row.get::<_, String>(9)?),
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Some(StatusRows {
        counts_as_of: read_counts_as_of(connection, &repo_mount_id)?,
        repo_mount_id,
        repository_root,
        place,
        records,
    }))
}

// The sessions standing in `folder`, and the one whose agent runs there.
fn occupants_of(occupancy: &MountOccupancy, folder: &Path) -> (Vec<SessionId>, Option<SessionId>) {
    (
        occupancy
            .standing_by_folder
            .get(folder)
            .map(|standing| standing.iter().map(|session| session.session_id).collect())
            .unwrap_or_default(),
        occupancy.running_by_folder.get(folder).copied(),
    )
}

// A detached HEAD has no branch to name, so the row names the commit it stands on.
fn branch_name_of(tree: &ListedWorktree) -> Result<GitRefName, WorktreeStatusReadError> {
    let name = tree
        .branch_name
        .as_ref()
        .or(tree.head_commit.as_ref())
        .ok_or(WorktreeStatusReadError::TreeWithoutHead)?;
    GitRefName::new(name.clone()).map_err(WorktreeStatusReadError::Text)
}

// The folder as the wire carries it.
fn path_text(folder: &Path) -> Result<FilesystemPath, WorktreeStatusReadError> {
    FilesystemPath::new(folder.to_string_lossy().into_owned())
        .map_err(WorktreeStatusReadError::Text)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use futures::FutureExt as _;
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_store::database::writer::test_file::TestDatabase;

    use super::*;
    use crate::git::process::test_git_runner;
    use crate::git::worktree::schema::schema_parts;

    // A project with no attached repository asks for no suggestion.
    struct NoSuggestion;

    impl NewWorktreeSuggestionSource for NoSuggestion {
        fn suggest_new_worktree<'a>(
            &'a self,
            _repo_mount_id: &'a RepoMountId,
            _session_id: &'a SessionId,
        ) -> BoxFuture<'a, Result<NewWorktreeSuggestion, Box<dyn Error + Send + Sync>>> {
            async { panic!("no suggestion is asked for a project with no repository") }.boxed()
        }
    }

    // Kills mapping a project with no attached repository to an internal failure.
    #[tokio::test]
    async fn a_project_with_no_attached_repository_is_refused_project_not_found() {
        let database = TestDatabase::new(schema_parts());
        let reads = Arc::new(DatabaseReadPool::new(
            database.path(),
            WORKTREE_STATUS_READER_STATEMENT_CAPACITY,
        ));
        let reader = WorktreeStatusReader::new(WorktreeStatusReaderDeps {
            git: test_git_runner(),
            reads: Arc::clone(&reads),
            occupancy: MountOccupancyReader::new(reads),
            new_worktree: Arc::new(NoSuggestion),
        });
        let project_id =
            ProjectId::try_from(mint_uuid_v7()).expect("a minted UUID is a project id");

        let failure = reader
            .read(&WorktreeStatusReadRequest {
                project_id,
                session_id: None,
            })
            .await
            .expect_err("a project with no repository has no trees to read");

        match HandlerError::from(failure) {
            HandlerError::Refused(refusal) => {
                assert_eq!(refusal.code, RefusalCode::ProjectNotFound);
            }
            other @ (HandlerError::Internal(_) | HandlerError::Canceled) => {
                panic!("the read is refused, not {other:?}")
            }
        }
    }
}
