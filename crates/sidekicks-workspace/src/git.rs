//! Git: the one runner every git call goes through, the branch-name pattern's check, a
//! repository's exclude list, turn snapshots and worktrees.

pub mod branch_name_pattern;
pub mod exclude;
pub mod process;
pub mod turn_snapshot;
pub mod worktree;

/// The mode git records for a gitlink, a repository embedded in the tree whose commit lives in
/// that repository, not this one.
pub const GITLINK_MODE: &str = "160000";
