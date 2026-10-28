//! The `removed_worktrees` table as the kept worktrees' store writes and reads it: each write's
//! statement, and the reads of a kept copy's row, of the mounts its repository is on and of the
//! trees put back from it.

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use rusqlite::types::{Value, ValueRef};
use rusqlite::{Connection, OptionalExtension, Row, params};
use sidekicks_contracts::free_form_string::{FILE_PATH_MAX_LEN, FilesystemPath};
use sidekicks_contracts::git::shared::GitRefName;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::project::ProjectId;
use sidekicks_contracts::repo::git_reads::GitObjectId;
use sidekicks_contracts::repo::mount::{RepoMountId, RepoMountState};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_contracts::worktree::lifecycle::{RemovedWorktreeId, WorktreeId, WorktreeState};
use sidekicks_store::database::statement::{
    StatementBindings, WriteStatement, nullable_text_binding, text_binding,
};
use sidekicks_store::database::stored_column::{
    optional_text_column, safe_int_column, text_column,
};

use crate::git::worktree::kept_copy::KeptWorktreeState;
use crate::git::worktree::put_back::{PutBackBranch, PutBackMark};
use crate::git::worktree::rows::{WorktreeRow, live_worktree_state_predicate};
use crate::git::worktree::service::place_of;
use crate::row_guards::COMMON_DIR_METADATA_PATH;

// Written before anything it lists is made, so it names no `removed_at` until the retirement sets
// it, and no `head_commit` until the copy's state is read.
const INSERT_PENDING_SQL: &str = "INSERT INTO removed_worktrees (
    id, mount_id, project_id, created_by_session_id, worktree_name, original_path, kept_path,
    branch, base_ref
  )
  SELECT @id, repo_mounts.id, repo_mounts.project_id, @created_by_session_id, @worktree_name,
         @original_path, @kept_path, @branch, @base_ref
    FROM repo_mounts
   WHERE repo_mounts.id = @mount_id";

// What the kept copy records, filled in before the tree moves; a detached HEAD keeps the tree's
// own branch for the list.
const RECORD_KEPT_STATE_SQL: &str = "UPDATE removed_worktrees SET head_commit = @head_commit,
         branch = coalesce(@branch, branch), is_on_branch = @branch IS NOT NULL,
         record_folder = @record_folder
  WHERE id = @id AND removed_at IS NULL";

const FINISH_SQL: &str = "UPDATE removed_worktrees SET removed_at = @removed_at
  WHERE id = @id AND removed_at IS NULL";

// Links the kept copy to the tree put back, in the put-back's own write, and clears the put-back's
// mark. A rebuild moves the link from the unreadable tree it read, compared and swapped here.
const MARK_RESTORED_SQL: &str = "UPDATE removed_worktrees SET restored_worktree_id = @worktree_id,
         restoring_to = NULL, restoring_record = NULL, restoring_branch = NULL,
         restoring_branch_commit = NULL
  WHERE id = @id AND restored_worktree_id IS @read_restored_worktree_id";

// What a put-back is doing, written before its tree moves, only while the copy is linked as the
// put-back read it.
const MARK_PUT_BACK_SQL: &str = "UPDATE removed_worktrees SET restoring_to = @restoring_to,
         restoring_record = @restoring_record, restoring_branch = @restoring_branch,
         restoring_branch_commit = @restoring_branch_commit
  WHERE id = @id AND restoring_to IS NULL
    AND restored_worktree_id IS @read_restored_worktree_id";

const CLEAR_PUT_BACK_MARK_SQL: &str = "UPDATE removed_worktrees SET restoring_to = NULL,
         restoring_record = NULL, restoring_branch = NULL, restoring_branch_commit = NULL
  WHERE id = @id";

const DELETE_ROW_SQL: &str = "DELETE FROM removed_worktrees WHERE id = @id";

const FORGET_PENDING_SQL: &str =
    "DELETE FROM removed_worktrees WHERE id = @id AND removed_at IS NULL";

const RECORD_SIZE_SQL: &str = "UPDATE removed_worktrees SET size_bytes = @size_bytes,
         size_read_at = @size_read_at
  WHERE id = @id";

/// The kept copies whose put-back a crash cut short.
pub(crate) const SELECT_INTERRUPTED_PUT_BACK_IDS_SQL: &str = "SELECT id FROM removed_worktrees
  WHERE restoring_to IS NOT NULL ORDER BY id";

/// The kept copies whose discard finished.
pub(crate) const SELECT_LISTED_IDS_SQL: &str = "SELECT id FROM removed_worktrees
  WHERE removed_at IS NOT NULL ORDER BY id";

/// The kept copies of trees put back, whose deletion a crash or a failure left undone.
pub(crate) const SELECT_RESTORED_IDS_SQL: &str = "SELECT id FROM removed_worktrees
  WHERE restored_worktree_id IS NOT NULL ORDER BY id";

// The columns `removed_worktree_of` reads, in its order, for a query naming the table `kept` and
// the mount the copy was made on `mount`.
const REMOVED_WORKTREE_COLUMNS: &str = "kept.id, kept.mount_id, kept.project_id,
  kept.created_by_session_id, kept.worktree_name, kept.original_path, kept.kept_path, kept.branch,
  kept.is_on_branch, kept.base_ref, kept.head_commit, kept.record_folder, kept.removed_at,
  kept.size_bytes, kept.size_read_at, kept.restored_worktree_id, kept.restoring_to,
  kept.restoring_record, kept.restoring_branch, kept.restoring_branch_commit, mount.place";

const LISTED_FROM: &str = "FROM removed_worktrees AS kept
  JOIN repo_mounts AS mount ON mount.id = kept.mount_id";

static SELECT_ALL_LISTED_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {REMOVED_WORKTREE_COLUMNS} {LISTED_FROM}
  WHERE kept.removed_at IS NOT NULL ORDER BY kept.removed_at DESC, kept.id"
    )
});

static SELECT_PROJECT_LISTED_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {REMOVED_WORKTREE_COLUMNS} {LISTED_FROM}
  WHERE kept.project_id = ? AND kept.removed_at IS NOT NULL
  ORDER BY kept.removed_at DESC, kept.id"
    )
});

static SELECT_ONE_LISTED_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {REMOVED_WORKTREE_COLUMNS} {LISTED_FROM}
  WHERE kept.id = ? AND kept.removed_at IS NOT NULL"
    )
});

// The columns `mount_of` reads, in its order.
static MOUNT_COLUMNS: LazyLock<String> = LazyLock::new(|| {
    format!(
        "repo_mounts.id, repo_mounts.canonical_root,
  json_extract(repo_mounts.metadata, '{COMMON_DIR_METADATA_PATH}'), repo_mounts.place"
    )
});

// The project's mount now, which a detach and re-attach may have replaced since the discard.
static SELECT_PROJECT_MOUNT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {} FROM repo_mounts WHERE project_id = ? AND state = '{}'",
        MOUNT_COLUMNS.as_str(),
        <&'static str>::from(RepoMountState::Attached)
    )
});

// The mount the discard was made on, attached or not: its repository holds the pins.
static SELECT_MOUNT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {} FROM repo_mounts WHERE id = ?",
        MOUNT_COLUMNS.as_str()
    )
});

// The mount a kept copy's discard was made on, for a discard a crash cut short.
static SELECT_MOUNT_OF_KEPT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {} FROM repo_mounts JOIN removed_worktrees AS kept ON kept.mount_id = repo_mounts.id
  WHERE kept.id = ?",
        MOUNT_COLUMNS.as_str()
    )
});

// No row for a tree gone through its own removal or a session purge.
static SELECT_LIVE_TREE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT wt.fs_root, mount.place
  FROM worktrees AS wt JOIN repo_mounts AS mount ON mount.id = wt.repo_mount_id
  WHERE wt.id = ? AND {}",
        live_worktree_state_predicate("wt")
    )
});

// A retired tree's folder the cleanup still owns: a put-back there would be taken for it.
static SELECT_UNCLEANED_RETIRED_AT_FOLDER_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT 1 FROM worktrees WHERE fs_root = ? AND state = '{}' AND cleaned_at IS NULL LIMIT 1",
        <&'static str>::from(WorktreeState::Retired)
    )
});

/// What one discard keeps, for the row it writes before it makes anything the row lists.
#[derive(Clone, Debug)]
pub(crate) struct KeptWorktreeRecord {
    /// The kept copy.
    pub(crate) removed_worktree_id: RemovedWorktreeId,
    /// The tree being discarded, as its row stands.
    pub(crate) worktree: WorktreeRow,
    /// Where its kept copy goes.
    pub(crate) kept_folder: PathBuf,
}

/// A listed kept copy's row, with the place of the mount it was made on.
#[derive(Clone, Debug)]
pub(crate) struct RemovedWorktreeRow {
    /// The kept copy.
    pub(crate) removed_worktree_id: RemovedWorktreeId,
    /// The mount the discard was made on.
    pub(crate) mount_id: RepoMountId,
    /// Its project.
    pub(crate) project_id: ProjectId,
    /// The session that made the tree, carried to the tree a put-back makes.
    pub(crate) created_by_session_id: SessionId,
    /// The tree's name.
    pub(crate) worktree_name: FreeFormText<FILE_PATH_MAX_LEN>,
    /// Where the tree lived.
    pub(crate) original_path: FilesystemPath,
    /// The kept folder under the project's `.removed/`.
    pub(crate) kept_path: FilesystemPath,
    /// The branch the kept HEAD names, or in a rebase the one being rebased; else the tree's own.
    pub(crate) branch: GitRefName,
    /// Whether `branch` is the one the kept HEAD names.
    pub(crate) is_on_branch: bool,
    /// The tree's base, carried to its put-back.
    pub(crate) base_ref: GitRefName,
    /// The commit the tree stood on.
    pub(crate) head_commit: GitObjectId,
    /// Git's record of the tree as git named it at the discard.
    pub(crate) record_folder: FilesystemPath,
    /// When the tree was removed.
    pub(crate) removed_at: WireInstant,
    /// The kept copy's size in bytes, `None` until read.
    pub(crate) size_bytes: Option<SafeInt<0>>,
    /// When its size was read.
    pub(crate) size_read_at: Option<WireInstant>,
    /// The tree put back from this copy, once one is.
    pub(crate) restored_worktree_id: Option<WorktreeId>,
    /// What a put-back a crash cut short was doing.
    pub(crate) put_back_mark: Option<PutBackMark>,
    /// Where the project of the mount the discard was made on lives.
    pub(crate) place: Option<Place>,
}

/// A repository mount as the store reads it.
#[derive(Clone, Debug)]
pub(crate) struct KeptCopyMount {
    /// The mount.
    pub(crate) id: RepoMountId,
    /// The repository's main checkout.
    pub(crate) canonical_root: FilesystemPath,
    /// The repository's git common folder, its identity; `None` for a mount that records none.
    pub(crate) common_folder: Option<PathBuf>,
    /// Where the mount's project lives.
    pub(crate) place: Option<Place>,
}

/// The statement writing a discard's row before anything it lists is made.
pub(crate) fn insert_pending_statement(record: &KeptWorktreeRecord) -> WriteStatement {
    let fs_root = record.worktree.fs_root.as_str();
    let worktree_name = Path::new(fs_root)
        .file_name()
        .expect("a tree's folder ends in its name")
        .to_string_lossy();
    statement(
        INSERT_PENDING_SQL,
        vec![
            id_binding(&record.removed_worktree_id),
            text_binding("@mount_id", record.worktree.repo_mount_id.text().as_str()),
            text_binding(
                "@created_by_session_id",
                record.worktree.created_by_session_id.text().as_str(),
            ),
            text_binding("@worktree_name", &worktree_name),
            text_binding("@original_path", fs_root),
            text_binding("@kept_path", &record.kept_folder.to_string_lossy()),
            text_binding("@branch", record.worktree.branch_name.as_str()),
            text_binding("@base_ref", record.worktree.base_ref.as_str()),
        ],
        Some(1),
    )
}

/// The statement filling in what the kept copy records, before the tree moves.
pub(crate) fn record_kept_state_statement(
    removed_worktree_id: &RemovedWorktreeId,
    state: &KeptWorktreeState,
) -> WriteStatement {
    statement(
        RECORD_KEPT_STATE_SQL,
        vec![
            id_binding(removed_worktree_id),
            text_binding("@head_commit", state.head_commit.as_str()),
            nullable_text_binding("@branch", state.branch.as_deref()),
            text_binding("@record_folder", &state.record_folder.to_string_lossy()),
        ],
        Some(1),
    )
}

/// The statement setting the kept copy's `removed_at` to now, which the tree's retirement writes
/// in its own write.
pub(crate) fn finish_statement(removed_worktree_id: &RemovedWorktreeId) -> WriteStatement {
    statement(
        FINISH_SQL,
        vec![
            id_binding(removed_worktree_id),
            text_binding("@removed_at", WireInstant::now().as_str()),
        ],
        Some(1),
    )
}

/// The statement marking the kept copy with what a put-back does, while the copy is linked to
/// `read_restored_worktree_id` as the put-back read it.
pub(crate) fn mark_put_back_statement(
    removed_worktree_id: &RemovedWorktreeId,
    read_restored_worktree_id: Option<&WorktreeId>,
    mark: &PutBackMark,
) -> WriteStatement {
    let new_branch = mark.new_branch.as_ref();
    statement(
        MARK_PUT_BACK_SQL,
        vec![
            id_binding(removed_worktree_id),
            restored_worktree_binding("@read_restored_worktree_id", read_restored_worktree_id),
            text_binding("@restoring_to", &mark.target_folder.to_string_lossy()),
            text_binding("@restoring_record", &mark.record_folder.to_string_lossy()),
            nullable_text_binding(
                "@restoring_branch",
                new_branch.map(|branch| branch.name.as_str()),
            ),
            nullable_text_binding(
                "@restoring_branch_commit",
                new_branch.map(|branch| branch.commit.as_str()),
            ),
        ],
        Some(1),
    )
}

/// The statement clearing the kept copy's put-back mark.
pub(crate) fn clear_put_back_mark_statement(
    removed_worktree_id: &RemovedWorktreeId,
) -> WriteStatement {
    statement(
        CLEAR_PUT_BACK_MARK_SQL,
        vec![id_binding(removed_worktree_id)],
        Some(1),
    )
}

/// The statement linking the kept copy to `worktree_id`, the tree put back, and clearing its
/// mark, while the copy is linked to `read_restored_worktree_id` as the put-back read it.
pub(crate) fn mark_restored_statement(
    removed_worktree_id: &RemovedWorktreeId,
    worktree_id: &WorktreeId,
    read_restored_worktree_id: Option<&WorktreeId>,
) -> WriteStatement {
    statement(
        MARK_RESTORED_SQL,
        vec![
            id_binding(removed_worktree_id),
            text_binding("@worktree_id", worktree_id.text().as_str()),
            restored_worktree_binding("@read_restored_worktree_id", read_restored_worktree_id),
        ],
        Some(1),
    )
}

/// The statement deleting the kept copy's row, the last step of its deletion.
pub(crate) fn delete_row_statement(removed_worktree_id: &RemovedWorktreeId) -> WriteStatement {
    statement(
        DELETE_ROW_SQL,
        vec![id_binding(removed_worktree_id)],
        Some(1),
    )
}

/// The statement deleting the row of a kept copy whose tree never moved.
pub(crate) fn forget_pending_statement(removed_worktree_id: &RemovedWorktreeId) -> WriteStatement {
    statement(
        FORGET_PENDING_SQL,
        vec![id_binding(removed_worktree_id)],
        Some(1),
    )
}

/// The statement recording the kept copy's size, read now.
pub(crate) fn record_size_statement(
    removed_worktree_id: &RemovedWorktreeId,
    size_bytes: SafeInt<0>,
) -> WriteStatement {
    statement(
        RECORD_SIZE_SQL,
        vec![
            id_binding(removed_worktree_id),
            (
                Cow::Borrowed("@size_bytes"),
                Value::Integer(i64::from(size_bytes)),
            ),
            text_binding("@size_read_at", WireInstant::now().as_str()),
        ],
        None,
    )
}

fn statement(
    sql: &'static str,
    bindings: Vec<(Cow<'static, str>, Value)>,
    expected_row_count: Option<usize>,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(sql),
        bindings: StatementBindings::Named(bindings),
        expected_row_count,
    }
}

fn id_binding(removed_worktree_id: &RemovedWorktreeId) -> (Cow<'static, str>, Value) {
    text_binding("@id", removed_worktree_id.text().as_str())
}

fn restored_worktree_binding(
    name: &'static str,
    worktree_id: Option<&WorktreeId>,
) -> (Cow<'static, str>, Value) {
    let text = worktree_id.map(|worktree_id| worktree_id.text());
    nullable_text_binding(name, text.as_ref().map(|text| text.as_str()))
}

/// The listed kept copies, newest first: one project's, or every project's. Fails with SQLite's
/// error, or a conversion failure for a stored value that does not read as its type.
pub(crate) fn query_listed(
    connection: &Connection,
    project_id: Option<&ProjectId>,
) -> rusqlite::Result<Vec<RemovedWorktreeRow>> {
    match project_id {
        Some(project_id) => connection
            .prepare_cached(&SELECT_PROJECT_LISTED_SQL)?
            .query_map(params![project_id.text().as_str()], removed_worktree_of)?
            .collect(),
        None => connection
            .prepare_cached(&SELECT_ALL_LISTED_SQL)?
            .query_map([], removed_worktree_of)?
            .collect(),
    }
}

/// The listed kept copy `removed_worktree_id`, `None` when none is. Fails as [`query_listed`].
pub(crate) fn query_listed_one(
    connection: &Connection,
    removed_worktree_id: &RemovedWorktreeId,
) -> rusqlite::Result<Option<RemovedWorktreeRow>> {
    connection
        .prepare_cached(&SELECT_ONE_LISTED_SQL)?
        .query_row(
            params![removed_worktree_id.text().as_str()],
            removed_worktree_of,
        )
        .optional()
}

/// The kept copy ids one of the id listings (`SELECT_*_IDS_SQL`) answers. Fails as
/// [`query_listed`].
pub(crate) fn query_ids(
    connection: &Connection,
    sql: &'static str,
) -> rusqlite::Result<Vec<RemovedWorktreeId>> {
    connection
        .prepare_cached(sql)?
        .query_map([], |row| {
            text_column(row, 0, |text| RemovedWorktreeId::new(&text))
        })?
        .collect()
}

/// The project's attached mount, `None` when it has none. Fails as [`query_listed`].
pub(crate) fn query_project_mount(
    connection: &Connection,
    project_id: &ProjectId,
) -> rusqlite::Result<Option<KeptCopyMount>> {
    connection
        .prepare_cached(&SELECT_PROJECT_MOUNT_SQL)?
        .query_row(params![project_id.text().as_str()], mount_of)
        .optional()
}

/// The mount `mount_id`, attached or not, `None` when none is. Fails as [`query_listed`].
pub(crate) fn query_mount(
    connection: &Connection,
    mount_id: &RepoMountId,
) -> rusqlite::Result<Option<KeptCopyMount>> {
    connection
        .prepare_cached(&SELECT_MOUNT_SQL)?
        .query_row(params![mount_id.text().as_str()], mount_of)
        .optional()
}

/// The mount the discard of `removed_worktree_id` was made on, listed or not. Fails as
/// [`query_listed`].
pub(crate) fn query_mount_of_kept_copy(
    connection: &Connection,
    removed_worktree_id: &RemovedWorktreeId,
) -> rusqlite::Result<Option<KeptCopyMount>> {
    connection
        .prepare_cached(&SELECT_MOUNT_OF_KEPT_SQL)?
        .query_row(params![removed_worktree_id.text().as_str()], mount_of)
        .optional()
}

/// The folder and place of the live tree `worktree_id`, `None` once it went through its own
/// removal. Fails as [`query_listed`].
pub(crate) fn query_live_tree(
    connection: &Connection,
    worktree_id: &WorktreeId,
) -> rusqlite::Result<Option<(FilesystemPath, Option<Place>)>> {
    connection
        .prepare_cached(&SELECT_LIVE_TREE_SQL)?
        .query_row(params![worktree_id.text().as_str()], |row| {
            Ok((text_column(row, 0, FilesystemPath::new)?, place_of(row, 1)?))
        })
        .optional()
}

/// Whether a retired tree whose folder the cleanup still owns stands at `folder`, compared as
/// stored. Fails with SQLite's error.
pub(crate) fn query_is_uncleaned_retired_at(
    connection: &Connection,
    folder: &str,
) -> rusqlite::Result<bool> {
    connection
        .prepare_cached(&SELECT_UNCLEANED_RETIRED_AT_FOLDER_SQL)?
        .exists(params![folder])
}

fn removed_worktree_of(row: &Row<'_>) -> rusqlite::Result<RemovedWorktreeRow> {
    let restoring_branch = match (
        row.get::<_, Option<String>>(18)?,
        optional_text_column(row, 19, |text| {
            GitObjectId::new(text).ok_or(StoredObjectIdInvalid)
        })?,
    ) {
        (Some(name), Some(commit)) => Some(PutBackBranch { name, commit }),
        // The table's checks set both or neither.
        (Some(_), None) | (None, Some(_)) | (None, None) => None,
    };
    let put_back_mark = match (
        optional_text_column(row, 16, FilesystemPath::new)?,
        optional_text_column(row, 17, FilesystemPath::new)?,
    ) {
        (Some(target_folder), Some(record_folder)) => Some(PutBackMark {
            kept_folder: PathBuf::from(text_column(row, 6, FilesystemPath::new)?.as_str()),
            target_folder: PathBuf::from(target_folder.as_str()),
            record_folder: PathBuf::from(record_folder.as_str()),
            new_branch: restoring_branch,
        }),
        // The table's checks set both or neither.
        (Some(_), None) | (None, Some(_)) | (None, None) => None,
    };
    let size_bytes = match row.get_ref(13)? {
        ValueRef::Null => None,
        ValueRef::Integer(_) | ValueRef::Real(_) | ValueRef::Text(_) | ValueRef::Blob(_) => {
            Some(safe_int_column(row, 13)?)
        }
    };
    Ok(RemovedWorktreeRow {
        removed_worktree_id: text_column(row, 0, |text| RemovedWorktreeId::new(&text))?,
        mount_id: text_column(row, 1, |text| RepoMountId::new(&text))?,
        project_id: text_column(row, 2, |text| ProjectId::new(&text))?,
        created_by_session_id: text_column(row, 3, |text| SessionId::new(&text))?,
        worktree_name: text_column(row, 4, FreeFormText::new)?,
        original_path: text_column(row, 5, FilesystemPath::new)?,
        kept_path: text_column(row, 6, FilesystemPath::new)?,
        branch: text_column(row, 7, GitRefName::new)?,
        is_on_branch: row.get(8)?,
        base_ref: text_column(row, 9, GitRefName::new)?,
        head_commit: text_column(row, 10, |text| {
            GitObjectId::new(text).ok_or(StoredObjectIdInvalid)
        })?,
        record_folder: text_column(row, 11, FilesystemPath::new)?,
        removed_at: text_column(row, 12, WireInstant::try_from)?,
        size_bytes,
        size_read_at: optional_text_column(row, 14, WireInstant::try_from)?,
        restored_worktree_id: optional_text_column(row, 15, |text| WorktreeId::new(&text))?,
        put_back_mark,
        place: place_of(row, 20)?,
    })
}

fn mount_of(row: &Row<'_>) -> rusqlite::Result<KeptCopyMount> {
    Ok(KeptCopyMount {
        id: text_column(row, 0, |text| RepoMountId::new(&text))?,
        canonical_root: text_column(row, 1, FilesystemPath::new)?,
        common_folder: row.get::<_, Option<String>>(2)?.map(PathBuf::from),
        place: place_of(row, 3)?,
    })
}

// A stored commit that is no git object name.
#[derive(Debug, thiserror::Error)]
#[error("the stored commit is no git object name")]
struct StoredObjectIdInvalid;
