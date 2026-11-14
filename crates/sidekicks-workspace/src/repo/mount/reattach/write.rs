//! The re-attach's one write: the running and holder checks tested again, the old mount's detach
//! and the new mount's insert with its owed first verdict, the workspaces' and listed trees' move,
//! the other trees' retirement, and for a move to a picked folder the project's folder and the
//! workspaces' paths inside the old root carried to the new one, with the old common folder
//! recorded for the carry of its captures after those the old mount still carried; and what the
//! committed write read back.

use std::borrow::Cow;
use std::sync::LazyLock;

use rusqlite::types::Value;
use sidekicks_contracts::repo::mount::{RepoMountId, RepoMountState, WorkspaceId, WorkspaceState};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::worktree::lifecycle::{WorktreeId, WorktreeState};
use sidekicks_store::database::statement::{
    StatementBindings, StatementResult, WriteStatement, nullable_text_binding, text_binding,
};
use sidekicks_store::database::stored_column::returned_parsed;

use super::moved_captures::CAPTURES_MOVED_FROM_METADATA_PATH;
use crate::git::worktree::rows::LIVE_WORKTREE_STATE_PREDICATE;
use crate::repo::mount::health::first_verdict::REPLACED_REPO_MOUNT_METADATA_PATH;
use crate::repo::mount::service::detach::SELECT_RUNNING_RUN_SQL;
use crate::row_guards::{
    COMMON_DIR_METADATA_PATH, LAST_ERROR_METADATA_PATH, ROOT_COMMIT_METADATA_PATH,
};

/// The position of the write's running check, whose refusal names the run that holds the project.
pub(super) const RUNNING_RUN_STATEMENT: usize = 0;
/// The position of the write's check for another mount of the repository.
pub(super) const IDENTITY_HOLDER_STATEMENT: usize = 1;
const MOVED_WORKSPACES_STATEMENT: usize = 2;
/// The position of the old mount's detach, which refuses once another call moved the mount.
pub(super) const DETACH_OLD_MOUNT_STATEMENT: usize = 3;
const INSERT_NEW_MOUNT_STATEMENT: usize = 4;
const UNLISTED_WORKTREES_STATEMENT: usize = 8;

/// Another attached mount of the repository the folder holds now, or of the folder's root, on this
/// machine in the mount's place; bound to `@repo_mount_id`, `@common_dir` and `@canonical_root`.
pub(super) static SELECT_IDENTITY_HOLDER_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT holder.id, holder.project_id
   FROM repo_mounts AS holder
   JOIN repo_mounts AS mount ON mount.id = @repo_mount_id
  WHERE holder.machine_id = mount.machine_id
    AND coalesce(holder.place, '') = coalesce(mount.place, '')
    AND holder.state = '{}'
    AND holder.id <> mount.id
    AND (json_extract(holder.metadata, '{COMMON_DIR_METADATA_PATH}') = @common_dir
         OR holder.canonical_root = @canonical_root)
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

// The new mount takes the old one's machine, place and project at the folder bound, anchored on
// the repository there now, and owes its first verdict naming the old one to each session on it;
// its project is answered for the service log.
static INSERT_NEW_MOUNT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "INSERT INTO repo_mounts (
    id, machine_id, local_path, canonical_root, place, vcs_type, origin, project_id, state,
    attached_at, updated_at, metadata
  )
  SELECT @new_repo_mount_id, machine_id, @local_path, @canonical_root, place, vcs_type, origin,
         project_id, '{}', @now, @now,
         json_set('{{}}', '{COMMON_DIR_METADATA_PATH}', @common_dir,
                  '{ROOT_COMMIT_METADATA_PATH}', @root_commit,
                  '{REPLACED_REPO_MOUNT_METADATA_PATH}', @repo_mount_id)
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

// The project's folder follows its mount's root; unchanged by a re-attach in place.
const UPDATE_PROJECT_FOLDER_SQL: &str = "UPDATE projects
    SET folder_path = @canonical_root, updated_at = @now
  WHERE id = (SELECT project_id FROM repo_mounts WHERE id = @new_repo_mount_id)
    AND folder_path <> @canonical_root";

// A move records the old common folder its captures are carried from until the carry clears it,
// after the ones the old mount still carried, oldest first, so a carry a later move cut off is
// finished by the newest mount's carry; a re-attach in place of a mount still carrying takes its
// record forward the same way. Read before the old row's record is removed below.
static RECORD_CAPTURES_MOVED_FROM_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE repo_mounts
    SET metadata = json_set(metadata, '{CAPTURES_MOVED_FROM_METADATA_PATH}', json_insert(
          json(coalesce(
            (SELECT json_extract(old.metadata, '{CAPTURES_MOVED_FROM_METADATA_PATH}')
               FROM repo_mounts AS old WHERE old.id = @repo_mount_id),
            '[]')),
          '$[#]', @old_common_dir))
  WHERE id = @new_repo_mount_id
    AND (@is_moved OR EXISTS (
      SELECT 1 FROM repo_mounts AS old
       WHERE old.id = @repo_mount_id
         AND json_extract(old.metadata, '{CAPTURES_MOVED_FROM_METADATA_PATH}') IS NOT NULL))"
    )
});

// The old mount's record, taken forward onto the new one above.
static CLEAR_TAKEN_CARRY_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE repo_mounts
    SET metadata = json_remove(metadata, '{CAPTURES_MOVED_FROM_METADATA_PATH}')
  WHERE id = @repo_mount_id"
    )
});

// A moved workspace's paths inside the old root, carried to the new one; the root guard leaves a
// row whose root changed since it was read to its admission.
const REBASE_WORKSPACE_SQL: &str = "UPDATE workspaces
    SET fs_root = coalesce(@fs_root, fs_root), metadata = json_patch(metadata, @metadata_patch),
        updated_at = @now
  WHERE id = @workspace_id AND repo_mount_id = @new_repo_mount_id AND fs_root IS @read_fs_root";

/// One moved workspace whose stored paths sit inside the old root, with those paths in the new
/// root.
pub(super) struct RebasedWorkspace {
    /// The workspace.
    pub(super) workspace_id: WorkspaceId,
    /// Its root as read before the write.
    pub(super) read_fs_root: Option<String>,
    /// Its root in the new folder; `None` keeps the stored one.
    pub(super) fs_root: Option<String>,
    /// The metadata members that move, as the JSON object `json_patch` merges.
    pub(super) metadata_patch: String,
}

/// What the write's statements bind: each binds only the names its SQL holds.
pub(super) struct ReattachBindings {
    /// The mount re-attached.
    pub(super) repo_mount_id: RepoMountId,
    /// The mount that takes its place.
    pub(super) new_repo_mount_id: RepoMountId,
    /// The old mount's anchor, which the detach compares.
    pub(super) old_common_dir: String,
    /// Whether the root moved, so the old anchor is recorded on the new mount until its captures
    /// are carried.
    pub(super) is_moved: bool,
    /// The repository's common folder now, the new mount's anchor.
    pub(super) common_dir: String,
    /// The new mount's path as entered: the old one's for a re-attach in place.
    pub(super) local_path: String,
    /// The new mount's root: the old one's for a re-attach in place.
    pub(super) canonical_root: String,
    /// The first commit of the repository there now, `None` while it has none.
    pub(super) root_commit: Option<String>,
    /// The workspaces whose paths move with the root; none for a re-attach in place.
    pub(super) rebased_workspaces: Vec<RebasedWorkspace>,
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
    let canonical_root = text_binding("@canonical_root", &bindings.canonical_root);
    let statement = |sql: &'static str, bindings, expected_row_count| WriteStatement {
        sql: Cow::Borrowed(sql),
        bindings: StatementBindings::Named(bindings),
        expected_row_count,
    };
    let mut statements = vec![
        statement(
            SELECT_RUNNING_RUN_SQL.as_str(),
            vec![mount.clone()],
            Some(0),
        ),
        statement(
            SELECT_IDENTITY_HOLDER_SQL.as_str(),
            vec![mount.clone(), common_dir.clone(), canonical_root.clone()],
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
            vec![
                new_mount.clone(),
                mount.clone(),
                text_binding("@local_path", &bindings.local_path),
                canonical_root.clone(),
                common_dir,
                nullable_text_binding("@root_commit", bindings.root_commit.as_deref()),
                now.clone(),
            ],
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
                new_mount.clone(),
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
            vec![mount.clone(), now.clone()],
            None,
        ),
        statement(
            UPDATE_PROJECT_FOLDER_SQL,
            vec![canonical_root, new_mount.clone(), now.clone()],
            None,
        ),
        statement(
            RECORD_CAPTURES_MOVED_FROM_SQL.as_str(),
            vec![
                new_mount.clone(),
                mount.clone(),
                text_binding("@old_common_dir", &bindings.old_common_dir),
                (
                    "@is_moved".into(),
                    Value::Integer(i64::from(bindings.is_moved)),
                ),
            ],
            None,
        ),
        statement(CLEAR_TAKEN_CARRY_SQL.as_str(), vec![mount], None),
    ];
    // Last, so every statement position named above holds.
    statements.extend(bindings.rebased_workspaces.iter().map(|rebased| {
        statement(
            REBASE_WORKSPACE_SQL,
            vec![
                nullable_text_binding("@fs_root", rebased.fs_root.as_deref()),
                text_binding("@metadata_patch", &rebased.metadata_patch),
                now.clone(),
                text_binding("@workspace_id", rebased.workspace_id.text().as_str()),
                new_mount.clone(),
                nullable_text_binding("@read_fs_root", rebased.read_fs_root.as_deref()),
            ],
            None,
        )
    }));
    statements
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
        .map(|row| returned_parsed(row, 0, WorkspaceId::new))
        .collect::<Result<_, _>>()?;
    let retired_worktrees = rows(UNLISTED_WORKTREES_STATEMENT)
        .iter()
        .map(|row| {
            let worktree_id = returned_parsed(row, 0, WorktreeId::new)?;
            let session_id = returned_parsed(row, 1, SessionId::new)?;
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
