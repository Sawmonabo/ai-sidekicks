//! Git: the one runner every git call goes through, the branch-name pattern's check, a
//! repository's exclude list, turn snapshots and worktrees.

pub mod branch_name_pattern;
pub mod exclude;
pub mod process;
pub mod turn_snapshot;
pub mod worktree;
