//! The preparation bracket's rows: a workspace enters `preparing`, then reaches `ready` with the
//! root its preparation made or `rootLost` with why it failed; and the `rootLost` move a read or
//! the write gate makes when a root is gone.

use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::LazyLock;

use sidekicks_contracts::repo::mount::{ExecutionMode, WorkspaceId, WorkspaceState};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_store::database::statement::{
    StatementBindings, WriteStatement, nullable_text_binding, text_binding,
};

use super::{WorkspaceRow, WorkspaceService, WorkspaceServiceError, prelude};
use crate::errors::{WorkspaceServiceInvariantError, WorkspaceServiceInvariantKind};
use crate::event_emitter::EmitWorkspaceEventInput;
use crate::last_error::normalize_workspace_last_error;
use crate::row_guards::{
    BOUND_ROOT_METADATA_PATH, CHECKOUT_ROOT_METADATA_PATH, LAST_ERROR_METADATA_PATH,
    assert_absolute_execution_root, assert_mode_offered, expect_single_row_changed,
    refused_append_index,
};

// `rootLost` is a legal predecessor so a failed preparation can be retried. The root is cleared,
// since a lost root would keep matching approvals, and so is `lastError`, so the retried row does
// not show the last failure; the mode is written here because completion takes none.
static BEGIN_ROOT_PREPARATION_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE workspaces
      SET execution_mode = @execution_mode, fs_root = NULL, state = '{preparing}',
          metadata = json_remove(metadata, '{LAST_ERROR_METADATA_PATH}'), updated_at = @now
    WHERE id = @workspace_id AND state IN ('{ready}', '{root_lost}')",
        preparing = <&'static str>::from(WorkspaceState::Preparing),
        ready = <&'static str>::from(WorkspaceState::Ready),
        root_lost = <&'static str>::from(WorkspaceState::RootLost),
    )
});

// A bind's first preparation completes without a begin, so the mode the preparation made is
// written here too, `lastError` cleared, the checkout rewritten, and the bound folder only when a
// move changed it.
static COMPLETE_ROOT_PREPARATION_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE workspaces
      SET fs_root = @fs_root,
          execution_mode = coalesce(@execution_mode, execution_mode),
          state = '{ready}',
          metadata = CASE
            WHEN @bound_root IS NULL
              THEN json_set(json_remove(metadata, '{LAST_ERROR_METADATA_PATH}'),
                            '{CHECKOUT_ROOT_METADATA_PATH}', @checkout_root)
            ELSE json_set(json_remove(metadata, '{LAST_ERROR_METADATA_PATH}'),
                          '{CHECKOUT_ROOT_METADATA_PATH}', @checkout_root,
                          '{BOUND_ROOT_METADATA_PATH}', @bound_root)
          END,
          updated_at = @now
    WHERE id = @workspace_id AND state = '{preparing}'",
        ready = <&'static str>::from(WorkspaceState::Ready),
        preparing = <&'static str>::from(WorkspaceState::Preparing),
    )
});

// `json_set` and `json_remove`, never a whole rewrite: `metadata` holds keys other writers own.
static FAIL_ROOT_PREPARATION_WITH_DETAIL_SQL: LazyLock<String> =
    LazyLock::new(|| move_to_root_lost(&[WorkspaceState::Preparing], true));

static FAIL_ROOT_PREPARATION_WITHOUT_DETAIL_SQL: LazyLock<String> =
    LazyLock::new(|| move_to_root_lost(&[WorkspaceState::Preparing], false));

// A workspace already `rootLost` makes no move, and an archived one is history.
static MARK_ROOT_LOST_WITH_DETAIL_SQL: LazyLock<String> =
    LazyLock::new(|| move_to_root_lost(&[WorkspaceState::Preparing, WorkspaceState::Ready], true));

static MARK_ROOT_LOST_WITHOUT_DETAIL_SQL: LazyLock<String> =
    LazyLock::new(|| move_to_root_lost(&[WorkspaceState::Preparing, WorkspaceState::Ready], false));

/// What a finished preparation made: the root runs work in and the checkout it sits in, with the
/// mode it was made in and, after a move, the folder now bound.
#[derive(Clone, Debug)]
pub(crate) struct CompletedRootPreparation {
    /// The execution root, which becomes the approvals' scope.
    pub(crate) execution_root: PathBuf,
    /// The top level of the working tree the root sits in, which every turn snapshot captures.
    pub(crate) checkout_root: PathBuf,
    /// The mode the root was made in; `None` keeps the stored one.
    pub(crate) execution_mode: Option<ExecutionMode>,
    /// The folder a `boundRoot` workspace binds now, when a move changed it.
    pub(crate) bound_root: Option<PathBuf>,
}

#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the execution roots' preparation")
)]
impl WorkspaceService {
    /// Enters the preparation, `ready` or `rootLost` to `preparing`, in `target_mode`, with
    /// `workspace.preparing`. Refuses `workspace.notFound`, `repoMount.notFound` for a mount no
    /// longer attached and `workspace.modeUnsupported`; fails with an illegal-transition invariant
    /// from any other state, or when the row moved before the write committed.
    pub(crate) async fn begin_root_preparation(
        &self,
        workspace_id: WorkspaceId,
        target_mode: ExecutionMode,
    ) -> Result<(), WorkspaceServiceError> {
        let row = self.require_workspace_row(workspace_id).await?;
        let mount = self.require_attached_mount(row.repo_mount_id).await?;
        assert_mode_offered(target_mode, mount.managed_session_id.is_some())?;
        // The precise refusal before the compare-and-swap, which can only say the row moved.
        refuse_illegal_predecessor(
            &row,
            &[WorkspaceState::Ready, WorkspaceState::RootLost],
            "begin preparing",
        )?;
        let statement = WriteStatement {
            sql: Cow::Borrowed(BEGIN_ROOT_PREPARATION_SQL.as_str()),
            bindings: StatementBindings::Named(vec![
                text_binding("@workspace_id", workspace_id.text().as_str()),
                text_binding("@execution_mode", <&'static str>::from(target_mode)),
                text_binding("@now", WireInstant::now().as_str()),
            ]),
            expected_row_count: Some(1),
        };
        let appended = self
            .events
            .emit_workspace_preparing(event_input(&row), prelude(statement))
            .await;
        expect_single_row_changed(appended, workspace_id, "begin preparing", "it")?;
        Ok(())
    }

    /// Finishes the preparation, `preparing` to `ready`, with `workspace.prepared`, keeping the
    /// root, checkout, mode and bound folder `completed` names and clearing any recorded failure.
    /// Fails with a non-absolute-root invariant for a path that names no complete location, and
    /// with an illegal-transition invariant from any state but `preparing`; refuses
    /// `workspace.notFound`.
    pub(crate) async fn complete_root_preparation(
        &self,
        workspace_id: WorkspaceId,
        completed: &CompletedRootPreparation,
    ) -> Result<(), WorkspaceServiceError> {
        // Each path becomes a scope or a snapshot root, so none may need the daemon to complete it.
        assert_absolute_execution_root(&completed.execution_root, workspace_id)?;
        assert_absolute_execution_root(&completed.checkout_root, workspace_id)?;
        if let Some(bound_root) = &completed.bound_root {
            assert_absolute_execution_root(bound_root, workspace_id)?;
        }
        let row = self.require_workspace_row(workspace_id).await?;
        refuse_illegal_predecessor(&row, &[WorkspaceState::Preparing], "finish preparing")?;
        let statement = WriteStatement {
            sql: Cow::Borrowed(COMPLETE_ROOT_PREPARATION_SQL.as_str()),
            bindings: StatementBindings::Named(vec![
                text_binding("@workspace_id", workspace_id.text().as_str()),
                text_binding("@fs_root", &completed.execution_root.to_string_lossy()),
                nullable_text_binding(
                    "@execution_mode",
                    completed.execution_mode.map(<&'static str>::from),
                ),
                text_binding("@checkout_root", &completed.checkout_root.to_string_lossy()),
                nullable_text_binding(
                    "@bound_root",
                    completed
                        .bound_root
                        .as_ref()
                        .map(|bound_root| bound_root.to_string_lossy())
                        .as_deref(),
                ),
                text_binding("@now", WireInstant::now().as_str()),
            ]),
            expected_row_count: Some(1),
        };
        let appended = self
            .events
            .emit_workspace_prepared(event_input(&row), prelude(statement))
            .await;
        expect_single_row_changed(appended, workspace_id, "finish preparing", "it")?;
        Ok(())
    }

    /// Abandons the preparation, `preparing` to `rootLost`, with `workspace.rootLost`, keeping
    /// `failure_detail` scrubbed and cut as `lastError` (none when nothing publishable is left).
    /// Refuses `workspace.notFound`; fails with an illegal-transition invariant from any state but
    /// `preparing`.
    pub(crate) async fn fail_root_preparation(
        &self,
        workspace_id: WorkspaceId,
        failure_detail: &str,
    ) -> Result<(), WorkspaceServiceError> {
        let row = self.require_workspace_row(workspace_id).await?;
        refuse_illegal_predecessor(
            &row,
            &[WorkspaceState::Preparing],
            "record a preparation failure for",
        )?;
        let last_error = normalize_workspace_last_error(failure_detail);
        let statement = root_lost_statement(
            workspace_id,
            last_error.as_ref().map(AsRef::as_ref),
            &FAIL_ROOT_PREPARATION_WITH_DETAIL_SQL,
            &FAIL_ROOT_PREPARATION_WITHOUT_DETAIL_SQL,
        );
        let appended = self
            .events
            .emit_workspace_root_lost(event_input(&row), prelude(statement))
            .await;
        expect_single_row_changed(
            appended,
            workspace_id,
            "record a preparation failure for",
            "it",
        )?;
        Ok(())
    }
}

impl WorkspaceService {
    /// Moves a `preparing` or `ready` workspace to `rootLost` with `workspace.rootLost`, keeping
    /// `last_error` scrubbed and cut as why. Answers `false`, writing nothing, when the workspace
    /// does not exist, is already `rootLost` or archived, or another reader moved it first, so
    /// every read path can call it; fails as the read or the append fails otherwise.
    pub(crate) async fn mark_root_lost(
        &self,
        workspace_id: WorkspaceId,
        last_error: &str,
    ) -> Result<bool, WorkspaceServiceError> {
        let Some(row) = self.find_workspace_row(workspace_id).await? else {
            return Ok(false);
        };
        match row.state {
            WorkspaceState::Preparing | WorkspaceState::Ready => {}
            WorkspaceState::RootLost | WorkspaceState::Archived => return Ok(false),
        }
        #[cfg(test)]
        self.root_lost_pause.pass().await;
        let last_error = normalize_workspace_last_error(last_error);
        let statement = root_lost_statement(
            workspace_id,
            last_error.as_ref().map(AsRef::as_ref),
            &MARK_ROOT_LOST_WITH_DETAIL_SQL,
            &MARK_ROOT_LOST_WITHOUT_DETAIL_SQL,
        );
        match self
            .events
            .emit_workspace_root_lost(event_input(&row), prelude(statement))
            .await
        {
            Ok(_receipt) => Ok(true),
            // The guard refused: another reader moved the row since the read.
            Err(error) if refused_append_index(&error).is_some() => Ok(false),
            Err(error) => Err(WorkspaceServiceError::Append(error)),
        }
    }
}

// The move to `rootLost` from `predecessors`, recording `@last_error` when `with_detail`, else
// clearing any older one.
fn move_to_root_lost(predecessors: &[WorkspaceState], with_detail: bool) -> String {
    let predecessors = predecessors
        .iter()
        .map(|&state| format!("'{}'", <&'static str>::from(state)))
        .collect::<Vec<_>>()
        .join(", ");
    let metadata = if with_detail {
        format!("json_set(metadata, '{LAST_ERROR_METADATA_PATH}', @last_error)")
    } else {
        format!("json_remove(metadata, '{LAST_ERROR_METADATA_PATH}')")
    };
    format!(
        "UPDATE workspaces
      SET state = '{}', metadata = {metadata}, updated_at = @now
    WHERE id = @workspace_id AND state IN ({predecessors})",
        <&'static str>::from(WorkspaceState::RootLost)
    )
}

// The move's statement, with the detail when one is left after scrubbing.
fn root_lost_statement(
    workspace_id: WorkspaceId,
    last_error: Option<&str>,
    with_detail_sql: &'static str,
    without_detail_sql: &'static str,
) -> WriteStatement {
    let mut bindings = vec![
        text_binding("@workspace_id", workspace_id.text().as_str()),
        text_binding("@now", WireInstant::now().as_str()),
    ];
    let sql = match last_error {
        Some(last_error) => {
            bindings.push(text_binding("@last_error", last_error));
            with_detail_sql
        }
        None => without_detail_sql,
    };
    WriteStatement {
        sql: Cow::Borrowed(sql),
        bindings: StatementBindings::Named(bindings),
        expected_row_count: Some(1),
    }
}

// Every bracket event names the workspace's session and no actor: the daemon moves it.
fn event_input(row: &WorkspaceRow) -> EmitWorkspaceEventInput {
    EmitWorkspaceEventInput {
        session_id: row.session_id,
        workspace_id: row.id,
        repo_mount_id: None,
        actor: None,
    }
}

// Fails with an illegal-transition invariant when the row is in none of `legal_predecessors`.
fn refuse_illegal_predecessor(
    row: &WorkspaceRow,
    legal_predecessors: &[WorkspaceState],
    attempted_action: &str,
) -> Result<(), WorkspaceServiceInvariantError> {
    if legal_predecessors.contains(&row.state) {
        return Ok(());
    }
    Err(WorkspaceServiceInvariantError {
        message: format!(
            "cannot {attempted_action} workspace \"{}\" in state \"{}\"",
            row.id,
            <&'static str>::from(row.state)
        ),
        kind: WorkspaceServiceInvariantKind::IllegalStateTransition,
        workspace_id: Some(row.id),
        source: None,
    })
}
