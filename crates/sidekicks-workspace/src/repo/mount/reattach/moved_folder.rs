//! A lost mount moved to a picked folder that holds its repository: the repository is known by the
//! first commit its attach recorded, never by the folder's name or path, so a folder holding
//! another repository is refused for the screen to attach as its own project. The move commits
//! through the re-attach's write with the picked root: git repairs the moved main checkout's links
//! to the daemon's worktrees, which stay where they are, and the project's folder and each
//! workspace path inside the old root are carried to the new one.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use notify::Watcher;
use rusqlite::{Connection, OptionalExtension, named_params};
use serde_json::{Map, Value};
use sidekicks_contracts::repo::folders::{RepoMountMoveRequest, RepoMountReattachResponse};
use sidekicks_contracts::repo::mount::{RepoMountHealth, RepoMountId, WorkspaceId, WorkspaceState};
use sidekicks_store::database::connection::read_pool::ReadLength;
use sidekicks_store::database::stored_column::text_column;

use super::write::RebasedWorkspace;
use super::{ReattachTarget, RepoMountReattachError, RepoMountReattachService};
use crate::repo::errors::{RepoRefusal, refuse_distribution};
use crate::repo::mount::service::wire_root;
use crate::row_guards::{
    BOUND_ROOT_METADATA_PATH, CHECKOUT_ROOT_METADATA_PATH, ROOT_COMMIT_METADATA_PATH,
};
use crate::trust_envelope::is_contained_within;

static SELECT_ROOT_COMMIT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT json_extract(metadata, '{ROOT_COMMIT_METADATA_PATH}') FROM repo_mounts
  WHERE id = @repo_mount_id"
    )
});

// The stored paths of the mount's live workspaces.
static SELECT_WORKSPACE_PATHS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT id, fs_root, json_extract(metadata, '{BOUND_ROOT_METADATA_PATH}'),
        json_extract(metadata, '{CHECKOUT_ROOT_METADATA_PATH}')
   FROM workspaces
  WHERE repo_mount_id = @repo_mount_id AND state <> '{}'
  ORDER BY id",
        <&'static str>::from(WorkspaceState::Archived)
    )
});

// The member names under the paths' `$.`, so each key and its path are one fact.
const BOUND_ROOT_METADATA_KEY: &str = BOUND_ROOT_METADATA_PATH.split_at(2).1;
const CHECKOUT_ROOT_METADATA_KEY: &str = CHECKOUT_ROOT_METADATA_PATH.split_at(2).1;

// One live workspace's stored paths.
struct WorkspacePaths {
    workspace_id: WorkspaceId,
    fs_root: Option<String>,
    bound_root: Option<String>,
    checkout_root: Option<String>,
}

impl<W: Watcher + Send + 'static> RepoMountReattachService<W> {
    /// Moves the lost mount to the picked folder when it holds the mount's repository, answering
    /// the new mount; the project, its sessions and every workspace keep their ids. Refuses,
    /// writing nothing: `repoMount.notFound` for a mount that is not attached, `repoMount.managed`
    /// for a chat's managed workspace, `repoMount.reattachRefused` when the mount reads `healthy`,
    /// `repoMount.distributionNotFound` for a folder in a WSL distribution,
    /// `repoMount.rootResolutionFailed` for a folder attach would refuse,
    /// `repoMount.repositoryDiffers` when the folder does not hold the mount's repository or the
    /// mount recorded no first commit to know it by, `repoMount.reattachConflict` while a run is
    /// live in the project, and `repoMount.alreadyAttached` when another mount holds the
    /// repository or the folder. Fails as [`Self::reattach`] fails after its write.
    pub async fn move_to_folder(
        &self,
        request: &RepoMountMoveRequest,
    ) -> Result<RepoMountReattachResponse, RepoMountReattachError> {
        let repo_mount_id = request.repo_mount_id;
        let (mount, old_anchor) = self.require_project_mount(repo_mount_id).await?;
        match self.probe_health(&mount, &old_anchor).await? {
            RepoMountHealth::Unreachable { .. } | RepoMountHealth::IdentityMismatch { .. } => {}
            RepoMountHealth::Healthy { .. } => {
                return Err(RepoRefusal::ReattachRefused { repo_mount_id }.into());
            }
        }
        refuse_distribution(request.place.as_ref())?;
        let resolution = self
            .resolver
            .resolve_canonical_root(Path::new(request.local_path.as_str()))
            .await?;
        wire_root(&resolution.canonical_root)?;

        let (root_commit, workspaces) = self
            .reads
            .read(ReadLength::Short, move |connection| {
                Ok::<_, RepoMountReattachError>((
                    read_recorded_root_commit(connection, repo_mount_id)?,
                    read_workspace_paths(connection, repo_mount_id)?,
                ))
            })
            .await?;
        let Some(root_commit) = root_commit else {
            return Err(RepoRefusal::RepositoryDiffers { repo_mount_id }.into());
        };
        if !self
            .resolver
            .holds_commit(&resolution.canonical_root, &root_commit)
            .await?
        {
            return Err(RepoRefusal::RepositoryDiffers { repo_mount_id }.into());
        }

        let rebased_workspaces = workspaces
            .into_iter()
            .filter_map(|paths| {
                rebase_workspace(paths, &mount.canonical_root, &resolution.canonical_root)
            })
            .collect();
        let target = ReattachTarget {
            local_path: PathBuf::from(request.local_path.as_str()),
            canonical_root: resolution.canonical_root,
            common_folder: resolution.common_folder,
            root_commit: Some(root_commit),
            rebased_workspaces,
        };
        self.commit(mount, &old_anchor, target).await
    }
}

// The workspace's paths that sit inside `old_root`, carried into `new_root`; `None` when none does.
fn rebase_workspace(
    paths: WorkspacePaths,
    old_root: &Path,
    new_root: &Path,
) -> Option<RebasedWorkspace> {
    let rebase = |path: Option<&str>| {
        path.and_then(|path| rebased_path(Path::new(path), old_root, new_root))
    };
    let fs_root = rebase(paths.fs_root.as_deref());
    let mut metadata_patch = Map::new();
    for (key, path) in [
        (BOUND_ROOT_METADATA_KEY, paths.bound_root.as_deref()),
        (CHECKOUT_ROOT_METADATA_KEY, paths.checkout_root.as_deref()),
    ] {
        if let Some(rebased) = rebase(path) {
            metadata_patch.insert(key.to_owned(), Value::String(rebased));
        }
    }
    if fs_root.is_none() && metadata_patch.is_empty() {
        return None;
    }
    Some(RebasedWorkspace {
        workspace_id: paths.workspace_id,
        read_fs_root: paths.fs_root,
        fs_root,
        metadata_patch: Value::Object(metadata_patch).to_string(),
    })
}

// `path` in `new_root` where it sits in `old_root`, compared by components as the trust envelope
// compares them, its components below the root kept as they are.
fn rebased_path(path: &Path, old_root: &Path, new_root: &Path) -> Option<String> {
    if !is_contained_within(path, old_root) {
        return None;
    }
    let mut rebased = new_root.to_path_buf();
    rebased.extend(path.components().skip(old_root.components().count()));
    Some(rebased.to_string_lossy().into_owned())
}

fn read_recorded_root_commit(
    connection: &Connection,
    repo_mount_id: RepoMountId,
) -> Result<Option<String>, RepoMountReattachError> {
    Ok(connection
        .prepare_cached(&SELECT_ROOT_COMMIT_SQL)?
        .query_row(
            named_params! { "@repo_mount_id": repo_mount_id.text().as_str() },
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten())
}

fn read_workspace_paths(
    connection: &Connection,
    repo_mount_id: RepoMountId,
) -> Result<Vec<WorkspacePaths>, RepoMountReattachError> {
    Ok(connection
        .prepare_cached(&SELECT_WORKSPACE_PATHS_SQL)?
        .query_map(
            named_params! { "@repo_mount_id": repo_mount_id.text().as_str() },
            |row| {
                Ok(WorkspacePaths {
                    workspace_id: text_column(row, 0, |text| WorkspaceId::new(&text))?,
                    fs_root: row.get(1)?,
                    bound_root: row.get(2)?,
                    checkout_root: row.get(3)?,
                })
            },
        )?
        .collect::<rusqlite::Result<_>>()?)
}
