//! Git: the one runner every git call goes through, the reading of `cat-file`'s batch answers, the
//! branch-name pattern's check, a repository's exclude list, the objects an index names, turn
//! snapshots and worktrees.

pub mod branch_name_pattern;
pub mod cat_file;
pub mod exclude;
pub mod index_objects;
pub mod process;
pub mod turn_snapshot;
pub mod worktree;

/// The mode git records for a gitlink, a repository embedded in the tree whose commit lives in
/// that repository, not this one.
pub const GITLINK_MODE: &str = "160000";

/// The `.git` entry at the top of a work tree: the repository's folder in a main tree, and in a
/// linked tree the `gitdir:` file that names its record.
pub const GIT_ENTRY_NAME: &str = ".git";
