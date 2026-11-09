//! How a driver reads the repository a working folder belongs to: the daemon's git reads, which
//! its start registers, and whether the person owns an entry, read as the operating system tells.

use std::path::{Path, PathBuf};

use futures::future::BoxFuture;
use sidekicks_ipc::domain_error::DomainError;

/// A working folder's repository, as the daemon's git reads found it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepositoryReading {
    /// The repository's root, the main checkout's for a worktree.
    pub root: PathBuf,
    /// The repository's common git folder.
    pub common_git_folder: PathBuf,
}

/// Reads repositories and the owner of their entries, registered through a `PortRegistration`.
pub trait RepositoryReader: Send + Sync {
    /// The repository of `working_folder`, `None` outside git. Fails with the refusal the read
    /// gave, such as git's error or a folder that cannot be read.
    fn read_repository<'a>(
        &'a self,
        working_folder: &'a Path,
    ) -> BoxFuture<'a, Result<Option<RepositoryReading>, DomainError>>;

    /// Whether the person the daemon runs as owns the entry at `path`; `false` for an absent
    /// entry. Fails with the refusal the owner's read gave.
    fn is_owned_by_user<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, Result<bool, DomainError>>;
}
