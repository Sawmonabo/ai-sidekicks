//! How a driver reads the repository a working folder belongs to: the daemon's git reads, which
//! its start registers, and whether the person owns an entry, read as the operating system tells.

use std::path::{Path, PathBuf};

use futures::future::BoxFuture;

/// A working folder's repository, as the daemon's git reads found it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RepositoryReading {
    /// The repository's root, the main checkout's for a worktree.
    pub(crate) root: PathBuf,
    /// The repository's common git folder.
    pub(crate) common_git_folder: PathBuf,
}

/// Reads repositories and the owner of their entries, registered through a `PortRegistration`.
pub(crate) trait RepositoryReader: Send + Sync {
    /// The repository of `working_folder`, `None` outside git.
    fn read_repository<'a>(
        &'a self,
        working_folder: &'a Path,
    ) -> BoxFuture<'a, Option<RepositoryReading>>;

    /// Whether the person the daemon runs as owns the entry at `path`; `false` for an entry that
    /// is absent or cannot be read.
    fn is_owned_by_user<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, bool>;
}
