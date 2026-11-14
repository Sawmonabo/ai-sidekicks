//! The sweep out of a removed tree: every session standing in it moved to the repository's own
//! checkout and every pending move into it cleared, one `session.sweptToCheckout` per session
//! either touched. A session whose own workspace has a run still bound in the tree, by the one test
//! the tree's removal refuses on, is passed over until that run's end, which sweeps it.

use std::collections::BTreeSet;
use std::error::Error;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use notify::Watcher;
use rusqlite::{OptionalExtension, named_params};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::repo::mount::{RepoMountId, WorkspaceId, WorkspaceState};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::True;
use sidekicks_contracts::worktree::events::SessionSweptToCheckoutPayload;
use sidekicks_contracts::worktree::lifecycle::{WorktreeId, WorktreeState};
use sidekicks_std::settle_all::settle_all;
use sidekicks_store::database::connection::read_pool::ReadLength;
use sidekicks_store::database::stored_column::text_column;
use sidekicks_store::events::session::append_lock::SessionAppendHold;
use sidekicks_store::events::session::appender::SessionEventLinkage;
use sidekicks_workspace::git::worktree::removal::{WorktreeSessionSweep, WorktreeSweep};
use sidekicks_workspace::git::worktree::rows::read_unreleased_runs;
use sidekicks_workspace::row_guards::CHECKOUT_ROOT_METADATA_PATH;

use super::{
    SessionSweepFailure, SessionWorkingFolderError, SessionWorkingFolders, canonical,
    clear_pending_statement, held_for,
};

const SELECT_EVERY_PENDING_SQL: &str =
    "SELECT id, pending_working_folder FROM sessions WHERE pending_working_folder IS NOT NULL";

const SELECT_MOUNT_ROOT_SQL: &str = "SELECT canonical_root FROM repo_mounts WHERE id = @id";

// Each session's own live workspace on the mount by the checkout it works in, so one bound to a
// folder inside a tree stands in that tree; a workspace without a recorded checkout stands at its
// root.
static SELECT_MOUNT_WORKSPACES_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT id, session_id,
        coalesce(json_extract(metadata, '{CHECKOUT_ROOT_METADATA_PATH}'), fs_root)
   FROM workspaces
  WHERE repo_mount_id = @repo_mount_id AND state <> '{archived}' AND workflow_run_id IS NULL
  ORDER BY created_at, id",
        archived = <&'static str>::from(WorkspaceState::Archived),
    )
});

// The removed tree the session's own live workspace still works in, if any.
static SELECT_REMOVED_TREE_OF_SESSION_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT tree.id, tree.repo_mount_id, tree.fs_root
   FROM workspaces AS workspace
   JOIN worktrees AS tree
     ON tree.repo_mount_id = workspace.repo_mount_id
    AND tree.state = '{retired}'
    AND tree.fs_root = coalesce(json_extract(workspace.metadata, '{CHECKOUT_ROOT_METADATA_PATH}'),
                                workspace.fs_root)
  WHERE workspace.session_id = @session_id AND workspace.state <> '{archived}'
    AND workspace.workflow_run_id IS NULL
  ORDER BY tree.updated_at DESC, tree.id DESC
  LIMIT 1",
        retired = <&'static str>::from(WorktreeState::Retired),
        archived = <&'static str>::from(WorkspaceState::Archived),
    )
});

/// A live workspace on a swept mount.
struct MountWorkspace {
    id: WorkspaceId,
    session_id: SessionId,
    // The checkout it works in, else its root.
    folder: Option<PathBuf>,
}

impl<W: Watcher + Send + Sync + 'static> SessionWorkingFolders<W> {
    /// Moves every session standing in the removed tree to the repository's own checkout and
    /// clears every pending move to it, as the module doc says. Each session is tried, each under
    /// its own workspace's hold, and the failures answered together. Events of the session
    /// `append_hold` holds go under it.
    pub(super) async fn sweep(
        &self,
        sweep: &WorktreeSweep,
        append_hold: Option<&SessionAppendHold>,
    ) -> Result<(), SessionWorkingFolderError> {
        let checkout = self.read_mount_root(sweep).await?;
        let folder = canonical(Path::new(sweep.folder.as_str())).await?;
        let mut pending_sessions = BTreeSet::new();
        for (session_id, pending) in self.read_every_pending().await? {
            if canonical(&pending).await? == folder {
                pending_sessions.insert(session_id);
            }
        }
        let mut standing = Vec::new();
        for workspace in self.read_mount_workspaces(sweep.repo_mount_id).await? {
            if let Some(workspace_folder) = &workspace.folder
                && canonical(workspace_folder).await? == folder
            {
                standing.push(workspace);
            }
        }
        let bound = self.read_bound_in_tree(sweep, &folder, &standing).await?;

        let mut outcomes = Vec::new();
        for workspace in standing {
            if bound.contains(&workspace.id) {
                // Its pending move to the tree is cleared with its sweep, in one event.
                pending_sessions.remove(&workspace.session_id);
                continue;
            }
            let is_pending_cleared = pending_sessions.remove(&workspace.session_id);
            let session_id = workspace.session_id;
            let swept = self
                .sweep_session(
                    sweep,
                    session_id,
                    Some((workspace.id, checkout.as_path())),
                    is_pending_cleared.then_some(folder.as_path()),
                    held_for(append_hold, session_id),
                )
                .await;
            outcomes.push(swept.map_err(|failure| sweep_failure(session_id, failure)));
        }
        for session_id in pending_sessions {
            let swept = self
                .sweep_session(
                    sweep,
                    session_id,
                    None,
                    Some(folder.as_path()),
                    held_for(append_hold, session_id),
                )
                .await;
            outcomes.push(swept.map_err(|failure| sweep_failure(session_id, failure)));
        }
        settle_all(outcomes, "sweeping the sessions out of a removed worktree")?;
        Ok(())
    }

    /// The removed tree the session's own live workspace still works in, if any.
    pub(super) async fn read_removed_tree_of(
        &self,
        session_id: SessionId,
    ) -> Result<Option<WorktreeSweep>, SessionWorkingFolderError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                Ok(connection
                    .prepare_cached(&SELECT_REMOVED_TREE_OF_SESSION_SQL)?
                    .query_row(
                        named_params! { "@session_id": session_id.text().as_str() },
                        |row| {
                            Ok(WorktreeSweep {
                                worktree_id: text_column(row, 0, |text| WorktreeId::new(&text))?,
                                repo_mount_id: text_column(row, 1, |text| RepoMountId::new(&text))?,
                                folder: text_column(row, 2, FilesystemPath::new)?,
                            })
                        },
                    )
                    .optional()?)
            })
            .await
    }

    // Moves `session_id`'s workspace to the checkout when `moved` names one, then records its
    // sweep, clearing its pending move into the tree `cleared_folder` keys when given.
    async fn sweep_session(
        &self,
        sweep: &WorktreeSweep,
        session_id: SessionId,
        moved: Option<(WorkspaceId, &Path)>,
        cleared_folder: Option<&Path>,
        append_hold: Option<&SessionAppendHold>,
    ) -> Result<(), SessionWorkingFolderError> {
        if let Some((workspace_id, checkout)) = moved {
            let hold = self.execution_roots.hold_preparation(workspace_id).await;
            self.execution_roots
                .move_to_folder_held(&hold, checkout, append_hold)
                .await?;
        }
        let mut transactional_prelude = Vec::new();
        if let Some(folder) = cleared_folder {
            // The clear names the stored spelling, which the sweep matched by its resolved form.
            if let Some(Some(pending)) = self.read_pending(session_id).await?
                && canonical(Path::new(&pending.path)).await?.as_path() == folder
            {
                transactional_prelude.push(clear_pending_statement(session_id, &pending));
            }
        }
        let payload = SessionSweptToCheckoutPayload {
            session_id,
            repo_mount_id: sweep.repo_mount_id,
            worktree_id: sweep.worktree_id,
            pending_move_cleared: cleared_folder.is_some().then(True::default),
        };
        self.worktree_events
            .emit_session_swept_to_checkout(
                payload,
                SessionEventLinkage {
                    transactional_prelude,
                    ..SessionEventLinkage::default()
                },
                append_hold,
            )
            .await?;
        Ok(())
    }

    // Which of the `standing` workspaces have a run bound in the swept tree, whose folder resolves
    // to `folder`, tested as the tree's removal tests it; only their own runs are tested.
    async fn read_bound_in_tree(
        &self,
        sweep: &WorktreeSweep,
        folder: &Path,
        standing: &[MountWorkspace],
    ) -> Result<BTreeSet<WorkspaceId>, SessionWorkingFolderError> {
        let standing_ids = standing
            .iter()
            .map(|workspace| workspace.id)
            .collect::<BTreeSet<_>>();
        let runs = self
            .reads
            .read(ReadLength::Short, |connection| {
                Ok::<_, SessionWorkingFolderError>(read_unreleased_runs(connection)?)
            })
            .await?;
        let mut bound = BTreeSet::new();
        for run in runs {
            if standing_ids.contains(&run.workspace_id)
                && run
                    .is_in_tree(sweep.worktree_id, folder)
                    .await
                    .map_err(SessionWorkingFolderError::Folder)?
            {
                bound.insert(run.workspace_id);
            }
        }
        Ok(bound)
    }

    async fn read_every_pending(
        &self,
    ) -> Result<Vec<(SessionId, PathBuf)>, SessionWorkingFolderError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                Ok(connection
                    .prepare_cached(SELECT_EVERY_PENDING_SQL)?
                    .query_map([], |row| {
                        Ok((
                            text_column(row, 0, |text| SessionId::new(&text))?,
                            PathBuf::from(row.get::<_, String>(1)?),
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?)
            })
            .await
    }

    async fn read_mount_workspaces(
        &self,
        repo_mount_id: RepoMountId,
    ) -> Result<Vec<MountWorkspace>, SessionWorkingFolderError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                Ok(connection
                    .prepare_cached(&SELECT_MOUNT_WORKSPACES_SQL)?
                    .query_map(
                        named_params! { "@repo_mount_id": repo_mount_id.text().as_str() },
                        |row| {
                            Ok(MountWorkspace {
                                id: text_column(row, 0, |text| WorkspaceId::new(&text))?,
                                session_id: text_column(row, 1, |text| SessionId::new(&text))?,
                                folder: row.get::<_, Option<String>>(2)?.map(PathBuf::from),
                            })
                        },
                    )?
                    .collect::<rusqlite::Result<Vec<_>>>()?)
            })
            .await
    }

    async fn read_mount_root(
        &self,
        sweep: &WorktreeSweep,
    ) -> Result<PathBuf, SessionWorkingFolderError> {
        let repo_mount_id = sweep.repo_mount_id;
        let root = self
            .reads
            .read(ReadLength::Short, move |connection| {
                Ok::<_, SessionWorkingFolderError>(
                    connection
                        .prepare_cached(SELECT_MOUNT_ROOT_SQL)?
                        .query_row(
                            named_params! { "@id": repo_mount_id.text().as_str() },
                            |row| row.get::<_, String>(0),
                        )
                        .optional()?,
                )
            })
            .await?;
        root.map(PathBuf::from)
            .ok_or(SessionWorkingFolderError::MountMissing {
                worktree_id: sweep.worktree_id,
                repo_mount_id,
            })
    }
}

impl<W: Watcher + Send + Sync + 'static> WorktreeSessionSweep for SessionWorkingFolders<W> {
    /// Sweeps every session standing in the removed tree, and every pending move into it.
    fn sweep_to_repo_root<'a>(
        &'a self,
        sweep: &'a WorktreeSweep,
    ) -> BoxFuture<'a, Result<(), Box<dyn Error + Send + Sync>>> {
        async move {
            self.sweep(sweep, None).await?;
            Ok(())
        }
        .boxed()
    }
}

fn sweep_failure(session_id: SessionId, failure: SessionWorkingFolderError) -> SessionSweepFailure {
    SessionSweepFailure {
        session_id,
        failure: Box::new(failure),
    }
}
