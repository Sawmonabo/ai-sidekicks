//! The worktrees, removed worktrees, branch contexts and run execution contexts tables, which the
//! daemon's schema runs with the rest, after the workspace tables they reference. Every closed set
//! a column holds is written from its enum.

use std::sync::LazyLock;

use sidekicks_contracts::repo::mount::ExecutionMode;
use sidekicks_contracts::worktree::lifecycle::WorktreeState;
use sidekicks_store::database::schema::{SchemaPart, SchemaParts};
use sidekicks_store::database::sql_list::{sql_list_of, sql_list_of_every};
use strum::VariantArray;

/// The worktree part of the daemon's schema: worktrees, the kept copies of removed ones, branch
/// contexts and each run's execution context, in foreign-key order.
pub(crate) static WORKTREE_SCHEMA_SQL: LazyLock<String> = LazyLock::new(worktree_schema_sql);

/// The workspace's list and the worktree part.
pub fn schema_parts() -> SchemaParts {
    crate::schema::schema_parts()
        .with_part(SchemaPart::new("worktree", WORKTREE_SCHEMA_SQL.as_str()))
}

/// The worktree states that release their branch, as a SQL list: a tree in any other state is live
/// and holds its branch. The partial unique index and every live-tree read take this one text, so
/// SQLite can use the index for them.
pub(crate) static BRANCH_RELEASING_STATE_LIST: LazyLock<String> = LazyLock::new(|| {
    sql_list_of(
        WorktreeState::VARIANTS
            .iter()
            .copied()
            .filter(|&state| !is_holding_its_branch(state))
            .map(<&'static str>::from),
    )
});

// Git's own rule: a checkout on disk holds its branch, so a tree in any state but these two keeps
// another from being made on it.
fn is_holding_its_branch(state: WorktreeState) -> bool {
    match state {
        WorktreeState::Creating
        | WorktreeState::Ready
        | WorktreeState::Dirty
        | WorktreeState::Merged => true,
        WorktreeState::Retired | WorktreeState::Failed => false,
    }
}

// The run execution context's mode names which root id is present; both modes carry their branch
// context.
fn execution_mode_clauses() -> String {
    ExecutionMode::VARIANTS
        .iter()
        .map(|&mode| {
            let worktree_clause = match mode {
                // The mount's own checkout has no worktree row.
                ExecutionMode::BoundRoot => "worktree_id IS NULL",
                ExecutionMode::ProvisionedWorktree => "worktree_id IS NOT NULL",
            };
            format!(
                "(execution_mode = '{}' AND {worktree_clause} AND branch_context_id IS NOT NULL)",
                <&'static str>::from(mode)
            )
        })
        .collect::<Vec<_>>()
        .join("\n    OR ")
}

fn worktree_schema_sql() -> String {
    let worktree_states = sql_list_of_every::<WorktreeState>();
    let creating = <&'static str>::from(WorktreeState::Creating);
    let branch_releasing_states = BRANCH_RELEASING_STATE_LIST.as_str();
    let execution_modes = sql_list_of_every::<ExecutionMode>();
    let execution_mode_clauses = execution_mode_clauses();
    format!(
        "
-- ---------------------------------------------------------------------------
-- Worktrees, branch contexts and run execution contexts.
-- ---------------------------------------------------------------------------
-- Session and run ids are event-sourced, so they carry no foreign key.
CREATE TABLE worktrees (
  id                    TEXT PRIMARY KEY,
  repo_mount_id         TEXT NOT NULL REFERENCES repo_mounts(id),
  created_by_session_id TEXT NOT NULL,
  created_by_run_id     TEXT,                   -- NULL for a prepare before any run
  branch_name           TEXT NOT NULL,
  base_ref              TEXT NOT NULL,          -- the base the branch was cut from, as given
  fs_root               TEXT NOT NULL,          -- the tree's folder
  state                 TEXT NOT NULL DEFAULT '{creating}'
    CHECK(state IN ({worktree_states})),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  -- What the risk read showed when the daemon retired a tree it made and could not hand over, as
  -- a digest; NULL for any other retirement, whose removal showed nothing to lose. The sweep
  -- deletes the folder only while a read shows nothing to lose or this same digest.
  retired_risk_digest   TEXT,
  -- Set once the sweep has decided to delete the folder, before git's record of it goes, so a pass
  -- after a crash finishes the removal without reading a tree git no longer knows.
  cleanup_started_at    TEXT,
  -- Stamped once the folder is gone, kept aside, or left on disk for good.
  cleaned_at            TEXT
) STRICT;

CREATE INDEX idx_worktrees_repo ON worktrees(repo_mount_id);
-- Git's own rule: a checkout on disk holds its branch. This index arbitrates a creation race.
CREATE UNIQUE INDEX idx_worktrees_active_branch ON worktrees(repo_mount_id, branch_name)
  WHERE state NOT IN ({branch_releasing_states});

-- A worktree removed with Discard and remove, kept whole until the person deletes it; nothing
-- deletes it on its own. The folder sits in the project's worktrees folder under .removed/, and
-- the commits it names stay pinned in the repository until Put back or Delete now. Put back moves
-- it back into the tree, and what is left of it goes after the answer.
CREATE TABLE removed_worktrees (
  id              TEXT PRIMARY KEY,
  mount_id        TEXT NOT NULL REFERENCES repo_mounts(id),
  project_id      TEXT NOT NULL,                -- the project record the worktree belonged to
  -- The session that made the worktree, carried to the tree a put-back makes.
  created_by_session_id TEXT NOT NULL,
  worktree_name   TEXT NOT NULL,
  original_path   TEXT NOT NULL,                -- where the worktree lived, for Put back
  kept_path       TEXT NOT NULL,                -- the kept folder under the project's .removed/
  branch          TEXT NOT NULL,
  -- 1 when branch is the one the kept HEAD names, or in a rebase the one being rebased; 0 for a
  -- detached HEAD, whose row keeps the worktree's own branch. Set with head_commit.
  is_on_branch    INTEGER NOT NULL DEFAULT 0 CHECK (is_on_branch IN (0, 1)),
  base_ref        TEXT NOT NULL,                -- the worktree's base, carried to its put-back
  -- Set just before the tree moves, from what the copy records; NULL while nothing has moved.
  head_commit     TEXT,
  -- Git's record of the tree as git named it from inside the live tree; set with head_commit.
  record_folder   TEXT,
  -- Set in the tree's retirement write. NULL while the tree is being moved aside: no list shows
  -- the row, and the daemon's start finishes or undoes it.
  removed_at      TEXT,
  size_bytes      INTEGER,                      -- read once after the discard; NULL until read
  size_read_at    TEXT,
  -- Set in the put-back's write: the tree is back, and what is left here goes once it stands
  -- sound or has gone through its own removal, a failure retried at the next cleanup. No foreign
  -- key: a session purge may delete that tree's row, which counts as its own removal.
  restored_worktree_id TEXT,
  -- Written by a put-back before its tree moves and cleared in its record write or once it is
  -- undone; a row still marked names a put-back a crash cut short, which the daemon undoes.
  restoring_to    TEXT,                         -- the folder the tree is being put back at
  restoring_record TEXT,                        -- git's record the put-back made for it
  restoring_branch TEXT,                        -- a branch the put-back makes; NULL keeps its own
  restoring_branch_commit TEXT,                 -- the commit that branch is made at
  CHECK (removed_at IS NULL OR head_commit IS NOT NULL),
  CHECK ((head_commit IS NULL) = (record_folder IS NULL)),
  CHECK ((restoring_to IS NULL) = (restoring_record IS NULL)),
  CHECK ((restoring_branch IS NULL) = (restoring_branch_commit IS NULL)),
  CHECK (restoring_to IS NOT NULL OR restoring_branch IS NULL)
) STRICT;

CREATE INDEX idx_removed_worktrees_project ON removed_worktrees(project_id);

-- A provisioned worktree's row names its worktree; a bound root's names none (the mount's own
-- checkout has no root row).
CREATE TABLE branch_contexts (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  worktree_id   TEXT REFERENCES worktrees(id),
  base_branch   TEXT NOT NULL,
  head_branch   TEXT NOT NULL,
  upstream_ref  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
) STRICT;

CREATE INDEX idx_branch_contexts_workspace ON branch_contexts(workspace_id);
-- One binding row per (worktree, workspace): the upsert key.
CREATE UNIQUE INDEX idx_branch_contexts_worktree_workspace
  ON branch_contexts(worktree_id, workspace_id) WHERE worktree_id IS NOT NULL;

-- released_at stamps the run-terminal release of the root.
CREATE TABLE run_execution_contexts (
  run_id             TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id),
  execution_mode     TEXT NOT NULL
                     CHECK(execution_mode IN ({execution_modes})),
  execution_root     TEXT NOT NULL,
  -- The top level of the working tree the run works in, written while the tree
  -- exists, so a snapshot captures the whole tree even from a nested root.
  checkout_root      TEXT NOT NULL,
  -- git rev-parse --git-common-dir (absolute) at creation: the git dir that
  -- outlives a retired worktree, so snapshot refs can still be pruned.
  git_common_dir     TEXT NOT NULL,
  worktree_id        TEXT REFERENCES worktrees(id),
  branch_context_id  TEXT REFERENCES branch_contexts(id),
  created_at         TEXT NOT NULL,
  released_at        TEXT,
  -- The mode names which root id is present; both modes carry their branch
  -- context.
  CHECK(
    {execution_mode_clauses}
  )
) STRICT;

CREATE INDEX idx_run_execution_contexts_workspace ON run_execution_contexts(workspace_id);
"
    )
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use rusqlite::{Connection, ErrorCode};
    use serde::Serialize;
    use sidekicks_contracts::repo::mount::ExecutionMode;
    use sidekicks_contracts::worktree::lifecycle::WorktreeState;
    use strum::VariantArray;

    use crate::git::worktree::test_rows::{
        PARENT_WORKTREE_ID, RunContextRow, create_worktree_tables, insert_worktree_rows,
        worktree_row,
    };

    // A closed-set value in serde's spelling, the text the wire and the rows carry.
    fn serde_text(value: &impl Serialize) -> String {
        serde_json::to_value(value)
            .expect("a closed-set value writes as JSON")
            .as_str()
            .expect("a closed-set value writes as a string")
            .to_owned()
    }

    // One row a case stores.
    type TestRow = Box<dyn Fn(&Connection) -> rusqlite::Result<()>>;

    // The row an insert statement stores.
    fn statement_row(sql: String) -> TestRow {
        Box::new(move |connection| connection.execute_batch(&sql))
    }

    // A run context in the shape its mode asks for, the mode written in serde's spelling.
    fn run_context_in_shape(run_id: String, mode: ExecutionMode) -> TestRow {
        let worktree_id = match mode {
            ExecutionMode::BoundRoot => None,
            ExecutionMode::ProvisionedWorktree => Some(PARENT_WORKTREE_ID),
        };
        let execution_mode = serde_text(&mode);
        Box::new(move |connection| {
            RunContextRow {
                run_id: &run_id,
                execution_mode: &execution_mode,
                worktree_id,
                ..RunContextRow::BOUND_ROOT
            }
            .insert(connection)
        })
    }

    // The bound-root run with `change` made to it, as a case's one row.
    fn bound_root_row(change: fn(&mut RunContextRow<'static>)) -> Vec<TestRow> {
        vec![Box::new(move |connection| {
            let mut row = RunContextRow::BOUND_ROOT;
            change(&mut row);
            row.insert(connection)
        })]
    }

    fn live_and_then(first: WorktreeState, second: WorktreeState) -> Vec<TestRow> {
        vec![
            statement_row(worktree_row(
                "first",
                "feature",
                <&'static str>::from(first),
            )),
            statement_row(worktree_row(
                "second",
                "feature",
                <&'static str>::from(second),
            )),
        ]
    }

    // One tree per state, each on its own branch, since two live trees cannot share one.
    fn one_row_per_state() -> Vec<TestRow> {
        WorktreeState::VARIANTS
            .iter()
            .enumerate()
            .map(|(index, state)| {
                statement_row(worktree_row(
                    &format!("state-{index}"),
                    &format!("branch-{index}"),
                    &serde_text(state),
                ))
            })
            .collect()
    }

    fn one_row_per_mode() -> Vec<TestRow> {
        ExecutionMode::VARIANTS
            .iter()
            .enumerate()
            .map(|(index, &mode)| run_context_in_shape(format!("run-{index}"), mode))
            .collect()
    }

    // Each case's rows go in order after the parents; every row but the last must be admitted,
    // and the last is admitted or refused by a constraint as the case says.
    #[rstest]
    #[case::two_live_trees_on_one_branch(
        live_and_then(WorktreeState::Ready, WorktreeState::Creating),
        false
    )]
    #[case::retired_tree_beside_a_live_one(
        live_and_then(WorktreeState::Retired, WorktreeState::Ready),
        true
    )]
    #[case::provisioned_without_its_worktree(
        bound_root_row(|row| {
            row.execution_mode = <&'static str>::from(ExecutionMode::ProvisionedWorktree);
        }),
        false
    )]
    #[case::bound_root_naming_a_worktree(
        bound_root_row(|row| row.worktree_id = Some(PARENT_WORKTREE_ID)),
        false
    )]
    #[case::without_a_checkout_root(bound_root_row(|row| row.checkout_root = None), false)]
    #[case::without_a_git_common_dir(bound_root_row(|row| row.git_common_dir = None), false)]
    #[case::every_state_admitted(one_row_per_state(), true)]
    #[case::every_mode_admitted(one_row_per_mode(), true)]
    #[case::a_state_outside_the_set(
        vec![statement_row(worktree_row("tree", "feature", "archived"))],
        false
    )]
    #[case::a_mode_outside_the_set(
        bound_root_row(|row| row.execution_mode = "worktree"),
        false
    )]
    fn admits_only_rows_the_worktree_tables_allow(
        #[case] rows: Vec<TestRow>,
        #[case] is_last_admitted: bool,
    ) {
        let connection = Connection::open_in_memory().expect("an in-memory database opens");
        create_worktree_tables(&connection).expect("the workspace and worktree schemas run");
        insert_worktree_rows(&connection);
        let (last, earlier) = rows.split_last().expect("each case writes a row");
        for row in earlier {
            row(&connection).expect("each row before the last is admitted");
        }
        // `None` is a failure other than a constraint's, such as a mistyped statement.
        let outcome = match last(&connection) {
            Ok(()) => Some(true),
            Err(error) => {
                (error.sqlite_error_code() == Some(ErrorCode::ConstraintViolation)).then_some(false)
            }
        };
        assert_eq!(outcome, Some(is_last_admitted));
    }
}
