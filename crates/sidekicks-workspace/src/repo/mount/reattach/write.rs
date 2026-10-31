//! The re-attach's one write: the running and holder checks tested again, the old mount's detach
//! and the new mount's insert, the workspaces' and listed trees' move, and the other trees'
//! retirement; and what the committed write read back.

use std::borrow::Cow;
use std::error::Error;
use std::sync::LazyLock;

use rusqlite::types::Value;
use sidekicks_contracts::repo::mount::{RepoMountId, RepoMountState, WorkspaceId, WorkspaceState};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::worktree::lifecycle::{WorktreeId, WorktreeState};
use sidekicks_store::database::statement::{
    StatementBindings, StatementResult, WriteStatement, text_binding,
};

use crate::git::worktree::rows::LIVE_WORKTREE_STATE_PREDICATE;
use crate::repo::mount::service::detach::SELECT_RUNNING_RUN_SQL;
use crate::row_guards::{COMMON_DIR_METADATA_PATH, LAST_ERROR_METADATA_PATH};

/// The position of the write's running check, whose refusal names the run that holds the project.
pub(super) const RUNNING_RUN_STATEMENT: usize = 0;
/// The position of the write's check for another mount of the repository.
pub(super) const IDENTITY_HOLDER_STATEMENT: usize = 1;
const MOVED_WORKSPACES_STATEMENT: usize = 2;
/// The position of the old mount's detach, which refuses once another call moved the mount.
pub(super) const DETACH_OLD_MOUNT_STATEMENT: usize = 3;
const INSERT_NEW_MOUNT_STATEMENT: usize = 4;
const UNLISTED_WORKTREES_STATEMENT: usize = 8;

/// Another attached mount of the repository the folder holds now, on this machine in the mount's
/// place; bound to `@repo_mount_id` and `@common_dir`.
pub(super) static SELECT_IDENTITY_HOLDER_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT holder.id, holder.project_id
   FROM repo_mounts AS holder
   JOIN repo_mounts AS mount ON mount.id = @repo_mount_id
  WHERE holder.machine_id = mount.machine_id
    AND coalesce(holder.place, '') = coalesce(mount.place, '')
    AND holder.state = '{}'
    AND holder.id <> mount.id
    AND json_extract(holder.metadata, '{COMMON_DIR_METADATA_PATH}') = @common_dir
  ORDER BY holder.id
  LIMIT 1",
        <&'static str>::from(RepoMountState::Attached)
    )
});

// The workspaces that move, read inside the write so the list and the move agree.
static SELECT_MOVED_WORKSPACES_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT id
   FROM workspaces
  WHERE repo_mount_id = @repo_mount_id AND state <> '{}'
  ORDER BY created_at, id",
        <&'static str>::from(WorkspaceState::Archived)
    )
});

// Compare-and-swap on the anchor the decision read: a concurrent re-attach or detach refuses it.
// The old row leaves `attached` first, since one root holds one attached row.
static DETACH_OLD_MOUNT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE repo_mounts
    SET state = '{}', updated_at = @now
  WHERE id = @repo_mount_id AND state = '{}'
    AND json_extract(metadata, '{COMMON_DIR_METADATA_PATH}') = @old_common_dir",
        <&'static str>::from(RepoMountState::Detached),
        <&'static str>::from(RepoMountState::Attached),
    )
});

// The new mount takes the old one's machine, place, root and project, anchored on the repository
// there now; its project is answered for the service log.
static INSERT_NEW_MOUNT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "INSERT INTO repo_mounts (
    id, machine_id, local_path, canonical_root, place, vcs_type, origin, project_id, state,
    attached_at, updated_at, metadata
  )
  SELECT @new_repo_mount_id, machine_id, local_path, canonical_root, place, vcs_type, origin,
         project_id, '{}', @now, @now, json_set('{{}}', '{COMMON_DIR_METADATA_PATH}', @common_dir)
    FROM repo_mounts
   WHERE id = @repo_mount_id
  RETURNING project_id",
        <&'static str>::from(RepoMountState::Attached)
    )
});

static MOVE_WORKSPACES_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE workspaces
    SET repo_mount_id = @new_repo_mount_id, updated_at = @now
  WHERE repo_mount_id = @repo_mount_id AND state <> '{}'",
        <&'static str>::from(WorkspaceState::Archived)
    )
});

// A moved workspace with a root waits, `preparing` with that root kept, until it is admitted
// again, so a run's gate admits it before binding rather than binding the old repository's root.
static BEGIN_MOVED_PREPARATION_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE workspaces
    SET state = '{}', metadata = json_remove(metadata, '{LAST_ERROR_METADATA_PATH}'),
        updated_at = @now
  WHERE repo_mount_id = @new_repo_mount_id AND state IN ('{}', '{}') AND fs_root IS NOT NULL",
        <&'static str>::from(WorkspaceState::Preparing),
        <&'static str>::from(WorkspaceState::Ready),
        <&'static str>::from(WorkspaceState::RootLost),
    )
});

// A tree the new repository lists stays the daemon's, on the new mount.
static MOVE_LISTED_WORKTREES_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE worktrees
    SET repo_mount_id = @new_repo_mount_id, updated_at = @now
  WHERE repo_mount_id = @repo_mount_id AND {}
    AND id IN (SELECT value FROM json_each(@listed_worktree_ids))",
        *LIVE_WORKTREE_STATE_PREDICATE
    )
});

// The live trees left on the old mount once the listed ones moved: the ones retired next, read in
// the same write so the events sent after it name exactly those.
static SELECT_UNLISTED_WORKTREES_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT id, created_by_session_id FROM worktrees
  WHERE repo_mount_id = @repo_mount_id AND {}
  ORDER BY id",
        *LIVE_WORKTREE_STATE_PREDICATE
    )
});

// Every other live tree leaves the daemon's care: retired, and stamped cleaned in the same
// statement, so the sweep never removes its folder.
static RETIRE_UNLISTED_WORKTREES_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE worktrees
    SET state = '{}', cleaned_at = @now, updated_at = @now
  WHERE repo_mount_id = @repo_mount_id AND {}",
        <&'static str>::from(WorktreeState::Retired),
        *LIVE_WORKTREE_STATE_PREDICATE
    )
});

/// What the write's statements bind: each binds only the names its SQL holds.
pub(super) struct ReattachBindings {
    /// The mount re-attached.
    pub(super) repo_mount_id: RepoMountId,
    /// The mount that takes its place.
    pub(super) new_repo_mount_id: RepoMountId,
    /// The old mount's anchor, which the detach compares.
    pub(super) old_common_dir: String,
    /// The repository's common folder now, the new mount's anchor.
    pub(super) common_dir: String,
    /// The ids of the trees that move, as a JSON array.
    pub(super) listed_worktree_ids: String,
    /// When the write happens.
    pub(super) now: WireInstant,
}

/// What the committed write read: the workspaces it moved and the trees it retired, each with the
/// session that made it, and the project the new mount serves.
pub(super) struct ReattachWritten {
    /// The workspaces moved, in creation order.
    pub(super) moved_workspaces: Vec<WorkspaceId>,
    /// The trees retired, each with the session that made it.
    pub(super) retired_worktrees: Vec<(WorktreeId, SessionId)>,
    /// The new mount's project, as stored.
    pub(super) project_id: Option<String>,
}

/// The re-attach's one write, in the order its statement positions name.
pub(super) fn reattach_statements(bindings: &ReattachBindings) -> Vec<WriteStatement> {
    let mount = text_binding("@repo_mount_id", bindings.repo_mount_id.text().as_str());
    let new_mount = text_binding(
        "@new_repo_mount_id",
        bindings.new_repo_mount_id.text().as_str(),
    );
    let now = text_binding("@now", bindings.now.as_str());
    let common_dir = text_binding("@common_dir", &bindings.common_dir);
    let statement = |sql: &'static str, bindings, expected_row_count| WriteStatement {
        sql: Cow::Borrowed(sql),
        bindings: StatementBindings::Named(bindings),
        expected_row_count,
    };
    vec![
        statement(
            SELECT_RUNNING_RUN_SQL.as_str(),
            vec![mount.clone()],
            Some(0),
        ),
        statement(
            SELECT_IDENTITY_HOLDER_SQL.as_str(),
            vec![mount.clone(), common_dir.clone()],
            Some(0),
        ),
        statement(
            SELECT_MOVED_WORKSPACES_SQL.as_str(),
            vec![mount.clone()],
            None,
        ),
        statement(
            DETACH_OLD_MOUNT_SQL.as_str(),
            vec![
                mount.clone(),
                text_binding("@old_common_dir", &bindings.old_common_dir),
                now.clone(),
            ],
            Some(1),
        ),
        statement(
            INSERT_NEW_MOUNT_SQL.as_str(),
            vec![new_mount.clone(), mount.clone(), common_dir, now.clone()],
            Some(1),
        ),
        statement(
            MOVE_WORKSPACES_SQL.as_str(),
            vec![new_mount.clone(), mount.clone(), now.clone()],
            None,
        ),
        statement(
            BEGIN_MOVED_PREPARATION_SQL.as_str(),
            vec![new_mount.clone(), now.clone()],
            None,
        ),
        statement(
            MOVE_LISTED_WORKTREES_SQL.as_str(),
            vec![
                new_mount,
                mount.clone(),
                now.clone(),
                text_binding("@listed_worktree_ids", &bindings.listed_worktree_ids),
            ],
            None,
        ),
        statement(
            SELECT_UNLISTED_WORKTREES_SQL.as_str(),
            vec![mount.clone()],
            None,
        ),
        statement(
            RETIRE_UNLISTED_WORKTREES_SQL.as_str(),
            vec![mount, now],
            None,
        ),
    ]
}

/// What the committed write read back, each row in its typed facts. Fails for a row the contracts
/// refuse.
pub(super) fn read_written(
    results: &[StatementResult],
) -> Result<ReattachWritten, rusqlite::Error> {
    let rows = |index: usize| {
        results
            .get(index)
            .map_or(&[][..], |result| &result.rows[..])
    };
    let moved_workspaces = rows(MOVED_WORKSPACES_STATEMENT)
        .iter()
        .map(|row| {
            WorkspaceId::new(text_value(row, 0)?).map_err(|error| conversion_failure(0, error))
        })
        .collect::<Result<_, _>>()?;
    let retired_worktrees = rows(UNLISTED_WORKTREES_STATEMENT)
        .iter()
        .map(|row| {
            let worktree_id = WorktreeId::new(text_value(row, 0)?)
                .map_err(|error| conversion_failure(0, error))?;
            let session_id = SessionId::new(text_value(row, 1)?)
                .map_err(|error| conversion_failure(1, error))?;
            Ok((worktree_id, session_id))
        })
        .collect::<Result<_, rusqlite::Error>>()?;
    let project_id = rows(INSERT_NEW_MOUNT_STATEMENT)
        .first()
        .and_then(|row| row.first())
        .and_then(|value| match value {
            Value::Text(project_id) => Some(project_id.clone()),
            Value::Null | Value::Integer(_) | Value::Real(_) | Value::Blob(_) => None,
        });
    Ok(ReattachWritten {
        moved_workspaces,
        retired_worktrees,
        project_id,
    })
}

// The TEXT value at `index` of a row the write returned.
fn text_value(row: &[Value], index: usize) -> Result<&str, rusqlite::Error> {
    match row.get(index) {
        Some(Value::Text(text)) => Ok(text),
        Some(value) => Err(rusqlite::Error::InvalidColumnType(
            index,
            String::new(),
            value.data_type(),
        )),
        None => Err(rusqlite::Error::InvalidColumnIndex(index)),
    }
}

fn conversion_failure(
    index: usize,
    failure: impl Error + Send + Sync + 'static,
) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(index, rusqlite::types::Type::Text, Box::new(failure))
}
