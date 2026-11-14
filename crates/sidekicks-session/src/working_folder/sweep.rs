//! The sweep out of a removed tree: every session standing in it, on any mount of its repository,
//! moved to its own mount's checkout and every pending move into it cleared, one
//! `session.sweptToCheckout` per session either touched. A session whose own workspace has a run
//! still bound in the tree, by the one test the tree's removal refuses on, is passed over until
//! that run's end, which sweeps it.
//!
//! - Who stands in the tree is the occupancy's own read, and each session is read again under its
//!   workspace's hold, so a session that moved out since is left where it chose.
//! - A move that completes sweeps its session again, so a session that moved into a tree removed
//!   meanwhile is swept at once.

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
use sidekicks_store::events::session::appender::{SessionEventEmitError, SessionEventLinkage};
use sidekicks_workspace::execution_root::WorkspacePreparationHold;
use sidekicks_workspace::git::worktree::occupancy::{
    StandingWorkspace, read_standing_folder_of, read_standing_in_repository, repository_mounts_of,
    standing_folder,
};
use sidekicks_workspace::git::worktree::removal::{WorktreeSessionSweep, WorktreeSweep};
use sidekicks_workspace::git::worktree::rows::{
    live_worktree_state_predicate, read_unreleased_runs,
};

use super::pending::{CLEAR_INDEX, PendingClear};
use super::{
    SessionSweepFailure, SessionWorkingFolderError, SessionWorkingFolders, canonical, held_for,
};

const SELECT_EVERY_PENDING_SQL: &str =
    "SELECT id, pending_working_folder FROM sessions WHERE pending_working_folder IS NOT NULL";

// The removed tree the session's own live workspace stands in, if any: a retired tree of its own
// mount, or one not yet cleaned of another mount of its repository, which a detached project
// left. A live tree at the same folder, one put back there, owns the folder now.
static SELECT_REMOVED_TREE_OF_SESSION_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT tree.id, tree.repo_mount_id, tree.fs_root
   FROM workspaces AS workspace
   JOIN worktrees AS tree
     ON tree.state = '{retired}'
    AND tree.fs_root = {folder}
    AND (tree.repo_mount_id = workspace.repo_mount_id
         OR (tree.cleaned_at IS NULL AND tree.repo_mount_id IN ({repository})))
  WHERE workspace.session_id = @session_id AND workspace.state <> '{archived}'
    AND workspace.workflow_run_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM worktrees AS live WHERE live.fs_root = tree.fs_root AND {live})
  ORDER BY tree.updated_at DESC, tree.id DESC
  LIMIT 1",
        retired = <&'static str>::from(WorktreeState::Retired),
        folder = standing_folder("workspace"),
        repository = repository_mounts_of("workspace.repo_mount_id"),
        archived = <&'static str>::from(WorkspaceState::Archived),
        live = live_worktree_state_predicate("live"),
    )
});

impl<W: Watcher + Send + Sync + 'static> SessionWorkingFolders<W> {
    /// Moves every session standing in the removed tree to its mount's own checkout and clears
    /// every pending move to it, as the module doc says. Each session is tried, each under its own
    /// workspace's hold, and the failures answered together. Events of the session `append_hold`
    /// holds go under it. Under `held`, the caller's hold of one workspace, only that workspace
    /// moves, since taking another's while holding one could wait on a holder waiting on this one.
    pub(super) async fn sweep(
        &self,
        sweep: &WorktreeSweep,
        append_hold: Option<&SessionAppendHold>,
        held: Option<&WorkspacePreparationHold<'_>>,
    ) -> Result<(), SessionWorkingFolderError> {
        let folder = canonical(Path::new(sweep.folder.as_str())).await?;
        let mut pending_sessions = BTreeSet::new();
        for (session_id, pending) in self.read_every_pending().await? {
            if canonical(&pending).await? == folder {
                pending_sessions.insert(session_id);
            }
        }
        let mut standing = Vec::new();
        for workspace in self.read_standing(sweep.repo_mount_id).await? {
            // A workflow run's own workspace stays on the root its run recorded.
            if workspace.is_run_owned
                || held.is_some_and(|hold| hold.workspace_id() != workspace.workspace_id)
            {
                continue;
            }
            if canonical(&workspace.folder).await? == folder {
                standing.push(workspace);
            }
        }
        let bound = self.read_bound_in_tree(sweep, &folder, &standing).await?;

        let mut outcomes = Vec::new();
        for workspace in standing {
            if bound.contains(&workspace.workspace_id) {
                // Its pending move to the tree is cleared with its sweep, in one event.
                pending_sessions.remove(&workspace.session_id);
                continue;
            }
            let is_pending_cleared = pending_sessions.remove(&workspace.session_id);
            let session_id = workspace.session_id;
            let swept = self
                .sweep_session(
                    sweep,
                    &folder,
                    session_id,
                    Some(SweptMove {
                        workspace_id: workspace.workspace_id,
                        checkout: &workspace.repository_root,
                        held,
                    }),
                    is_pending_cleared,
                    held_for(append_hold, session_id),
                )
                .await;
            outcomes.push(swept.map_err(|failure| sweep_failure(session_id, failure)));
        }
        for session_id in pending_sessions {
            let swept = self
                .sweep_session(
                    sweep,
                    &folder,
                    session_id,
                    None,
                    true,
                    held_for(append_hold, session_id),
                )
                .await;
            outcomes.push(swept.map_err(|failure| sweep_failure(session_id, failure)));
        }
        settle_all(outcomes, "sweeping the sessions out of a removed worktree")?;
        Ok(())
    }

    /// Sweeps `session_id` out of the removed tree its own live workspace stands in, if any, as the
    /// sweep of that tree does under `append_hold` and `held`.
    pub(super) async fn sweep_session_from_removed_tree(
        &self,
        session_id: SessionId,
        append_hold: Option<&SessionAppendHold>,
        held: Option<&WorkspacePreparationHold<'_>>,
    ) -> Result<(), SessionWorkingFolderError> {
        if let Some(sweep) = self.read_removed_tree_of(session_id).await? {
            self.sweep(&sweep, append_hold, held).await?;
        }
        Ok(())
    }

    // The removed tree the session's own live workspace stands in, if any.
    async fn read_removed_tree_of(
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

    // Moves `session_id`'s workspace to the checkout `moved` names, when it still stands in the
    // tree whose key is `folder` under its hold, then records its sweep, clearing its pending move
    // into the tree when `is_pending_cleared` and the move still waits there; a move a request
    // replaced since the sweep read it is left to that request, and so is a session that moved out.
    async fn sweep_session(
        &self,
        sweep: &WorktreeSweep,
        folder: &Path,
        session_id: SessionId,
        moved: Option<SweptMove<'_, '_>>,
        is_pending_cleared: bool,
        append_hold: Option<&SessionAppendHold>,
    ) -> Result<(), SessionWorkingFolderError> {
        let is_moved = match moved {
            Some(moved) => {
                if let Some(held) = moved.held {
                    self.move_if_standing(held, moved.checkout, folder, append_hold)
                        .await?
                } else {
                    let hold = self
                        .execution_roots
                        .hold_preparation(moved.workspace_id)
                        .await;
                    self.move_if_standing(&hold, moved.checkout, folder, append_hold)
                        .await?
                }
            }
            None => false,
        };
        let mut clear = None;
        if is_pending_cleared {
            // The clear names the stored spelling, which the sweep matched by its resolved form.
            if let Some(Some(pending)) = self.read_pending(session_id).await?
                && canonical(Path::new(&pending.path)).await?.as_path() == folder
            {
                clear = Some(PendingClear::of(session_id, &pending)?);
            }
        }
        if !is_moved && clear.is_none() {
            return Ok(());
        }
        let is_clearing = clear.is_some();
        match self
            .record_sweep(sweep, session_id, clear, append_hold)
            .await
        {
            Err(error) if is_clearing && error.refused_statement_index() == Some(CLEAR_INDEX) => {
                if is_moved {
                    self.record_sweep(sweep, session_id, None, append_hold)
                        .await?;
                }
                Ok(())
            }
            recorded => Ok(recorded?),
        }
    }

    // Appends the session's `session.sweptToCheckout`, after `clear` and the event saying no move
    // waits in the same write when given.
    async fn record_sweep(
        &self,
        sweep: &WorktreeSweep,
        session_id: SessionId,
        clear: Option<PendingClear>,
        append_hold: Option<&SessionAppendHold>,
    ) -> Result<(), SessionEventEmitError> {
        let payload = SessionSweptToCheckoutPayload {
            session_id,
            repo_mount_id: sweep.repo_mount_id,
            worktree_id: sweep.worktree_id,
            pending_move_cleared: clear.is_some().then(True::default),
        };
        let linkage = match clear {
            Some(clear) => SessionEventLinkage {
                transactional_prelude: vec![clear.statement],
                preceding_events: vec![clear.event],
                ..SessionEventLinkage::default()
            },
            None => SessionEventLinkage::default(),
        };
        self.worktree_events
            .emit_session_swept_to_checkout(payload, linkage, append_hold)
            .await?;
        Ok(())
    }

    // Which of the `standing` workspaces have a run bound in the swept tree, whose folder resolves
    // to `folder`, tested as the tree's removal tests it; only their own runs are tested.
    async fn read_bound_in_tree(
        &self,
        sweep: &WorktreeSweep,
        folder: &Path,
        standing: &[StandingWorkspace],
    ) -> Result<BTreeSet<WorkspaceId>, SessionWorkingFolderError> {
        let standing_ids = standing
            .iter()
            .map(|workspace| workspace.workspace_id)
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

    // The live workspaces standing in a folder on any mount of the repository `repo_mount_id`
    // holds.
    async fn read_standing(
        &self,
        repo_mount_id: RepoMountId,
    ) -> Result<Vec<StandingWorkspace>, SessionWorkingFolderError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                Ok(read_standing_in_repository(connection, repo_mount_id)?)
            })
            .await
    }

    // Moves the workspace `hold` holds to `checkout` when, read again under the hold, it still
    // stands in the folder whose key is `folder`; answers whether it moved.
    async fn move_if_standing(
        &self,
        hold: &WorkspacePreparationHold<'_>,
        checkout: &Path,
        folder: &Path,
        append_hold: Option<&SessionAppendHold>,
    ) -> Result<bool, SessionWorkingFolderError> {
        let workspace_id = hold.workspace_id();
        let standing = self
            .reads
            .read(ReadLength::Short, move |connection| {
                Ok::<_, SessionWorkingFolderError>(read_standing_folder_of(
                    connection,
                    workspace_id,
                )?)
            })
            .await?;
        let Some(standing) = standing else {
            return Ok(false);
        };
        if canonical(&standing).await? != folder {
            return Ok(false);
        }
        self.execution_roots
            .move_to_folder_held(hold, checkout, append_hold)
            .await?;
        Ok(true)
    }
}

/// A sweep's move of one workspace to its mount's checkout, under `held` when the caller holds the
/// workspace's hold, else under the sweep's own.
struct SweptMove<'a, 'lock> {
    workspace_id: WorkspaceId,
    checkout: &'a Path,
    held: Option<&'a WorkspacePreparationHold<'lock>>,
}

impl<W: Watcher + Send + Sync + 'static> WorktreeSessionSweep for SessionWorkingFolders<W> {
    /// Sweeps every session standing in the removed tree, and every pending move into it.
    fn sweep_to_repo_root<'a>(
        &'a self,
        sweep: &'a WorktreeSweep,
    ) -> BoxFuture<'a, Result<(), Box<dyn Error + Send + Sync>>> {
        async move {
            self.sweep(sweep, None, None).await?;
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
