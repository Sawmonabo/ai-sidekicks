//! Git: the one runner every git call goes through, a repository's exclude list, turn snapshots
//! and worktrees.

pub(crate) mod exclude;
pub(crate) mod process;
pub(crate) mod turn_snapshot;
pub(crate) mod worktree;
