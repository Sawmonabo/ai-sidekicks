//! Git: the one runner every git call goes through, the branch-name pattern's check, a
//! repository's exclude list, turn snapshots and worktrees.

pub(crate) mod branch_name_pattern;
pub(crate) mod exclude;
pub(crate) mod process;
pub(crate) mod turn_snapshot;
pub(crate) mod worktree;
