//! The memory import: the person's own provider memory copied into one account's home once, on
//! their press, under the home's lock. The provider's legs name each store and where it lands;
//! here each is copied, never over a file already there and never back, the files copied counted
//! once each however many folders took them, and the outcome kept on the account's row. Nothing
//! is written in the person's own home, and the two homes are never joined.

use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::account::record::{
    ProviderAccountId, ProviderAccountMemoryImportOutcome,
};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_platforms::create_missing_private_folders;
use sidekicks_std::file::tree_copy::{TreeCopyError, TreeCopyFollower, TreeCopyPolicy, copy_tree};
use sidekicks_std::mutex_lock::lock;

use crate::account::credential_home::CredentialHome;
use crate::account::errors::ProviderAccountRegistryError;
use crate::account::home_lock::AccountHomeLock;
use crate::account::registry::ProviderAccountRegistry;
use crate::driver::contract::account::{MemoryImportStore, ProviderMemoryImportLegs};

/// Why a memory import did not run or did not finish. A copy that failed partway keeps what it
/// copied and records no outcome, so the import can run again and copies only what is missing.
#[derive(Debug, thiserror::Error)]
pub enum MemoryImportError {
    /// The account's one memory import has already run; nothing was copied.
    #[error("the account's memory has already been imported")]
    AlreadyImported,
    /// A memory folder could not be read, a file not copied, or the person's provider settings not
    /// read; a folder's or a file's failure names no path.
    #[error("the memory could not be copied")]
    Copy(#[source] io::Error),
    /// The account could not be read, its home is not there, or the outcome was not stored.
    #[error(transparent)]
    Registry(#[from] ProviderAccountRegistryError),
}

impl From<MemoryImportError> for HandlerError {
    /// A repeat refuses `provider.account.memory.alreadyImported`, a registry failure answers as
    /// the registry answers it, and a failed copy is the daemon's own.
    fn from(error: MemoryImportError) -> Self {
        match error {
            MemoryImportError::AlreadyImported => Self::Refused(DomainError::new(
                "The account's memory has already been imported",
                RefusalCode::ProviderAccountMemoryAlreadyImported,
            )),
            MemoryImportError::Registry(failure) => failure.into(),
            error @ MemoryImportError::Copy(_) => Self::Internal(Box::new(error)),
        }
    }
}

/// Copies the person's own memory into `account_id`'s home as `legs` name it, holding the home's
/// lock on `home_lock` from the once check until the outcome is stored, and answers the outcome:
/// `imported` with how many memory files were copied, else `nothingToImport`. Fails with
/// [`MemoryImportError::AlreadyImported`] for an account whose import has run, copying nothing,
/// and as [`MemoryImportError`] says otherwise.
pub async fn import_memory(
    registry: &ProviderAccountRegistry,
    home_lock: &AccountHomeLock,
    legs: Arc<dyn ProviderMemoryImportLegs>,
    account_id: ProviderAccountId,
) -> Result<ProviderAccountMemoryImportOutcome, MemoryImportError> {
    let _hold = home_lock.hold(account_id.clone()).await;
    let account = registry.read(account_id.clone()).await?;
    if account.memory_import.is_some() {
        return Err(MemoryImportError::AlreadyImported);
    }
    let home = account.credential_home;
    let copied = tokio::task::spawn_blocking(move || copy_memory(legs.as_ref(), &home))
        .await
        .map_err(|error| MemoryImportError::Copy(io::Error::other(error)))??;
    let outcome = SafeInt::new(copied).map_or(
        ProviderAccountMemoryImportOutcome::NothingToImport {},
        |count| ProviderAccountMemoryImportOutcome::Imported {
            count,
            imported_at: WireInstant::now(),
        },
    );
    registry.record_memory_import(&account_id, &outcome).await?;
    Ok(outcome)
}

// Copies every store `legs` name for `home`, a store whose folder does not stand skipped, and
// answers how many of the person's files were copied.
fn copy_memory(
    legs: &dyn ProviderMemoryImportLegs,
    home: &CredentialHome,
) -> Result<u64, MemoryImportError> {
    if !fs::symlink_metadata(home.path())
        .map_err(ProviderAccountRegistryError::CredentialHome)?
        .is_dir()
    {
        return Err(ProviderAccountRegistryError::CredentialHome(
            io::ErrorKind::NotADirectory.into(),
        )
        .into());
    }
    let mut copied = 0;
    for store in legs
        .memory_import_stores(home)
        .map_err(MemoryImportError::Copy)?
    {
        copied += copy_store(&store).map_err(MemoryImportError::Copy)?;
    }
    Ok(copied)
}

// Copies `store` into each of its folders and answers how many of its files at least one took.
fn copy_store(store: &MemoryImportStore) -> io::Result<u64> {
    match fs::symlink_metadata(&store.source) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => return Ok(0),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error),
    }
    let mut copied = HashSet::new();
    for destination in &store.destinations {
        if let Some(parent) = destination.parent() {
            create_missing_private_folders(parent)?;
        }
        let follower = CopiedFiles {
            destination,
            began: Mutex::default(),
            copied: Mutex::default(),
        };
        copy_tree(
            &store.source,
            destination,
            TreeCopyPolicy::KeepExisting,
            Some(&follower),
        )
        .map_err(copy_failure)?;
        copied.extend(lock(&follower.copied).drain());
    }
    Ok(u64::try_from(copied.len()).expect("a count of files fits a u64"))
}

// The files one copy made, each by its path under the copy's folder, so the same file copied into
// two folders counts once; a file the folder already had is never told as copied.
struct CopiedFiles<'copy> {
    destination: &'copy Path,
    began: Mutex<Option<PathBuf>>,
    copied: Mutex<HashSet<PathBuf>>,
}

impl TreeCopyFollower for CopiedFiles<'_> {
    fn file_began(&self, destination: &Path) {
        *lock(&self.began) = destination
            .strip_prefix(self.destination)
            .ok()
            .map(Path::to_path_buf);
    }

    fn file_copied(&self, _bytes: u64) {
        if let Some(file) = lock(&self.began).take() {
            lock(&self.copied).insert(file);
        }
    }
}

// The copy's failure as the system gave it, without the path the copy's own error names.
fn copy_failure(error: TreeCopyError) -> io::Error {
    match error {
        TreeCopyError::Entry { source, .. } => source,
        TreeCopyError::Walk(walk) => walk
            .into_io_error()
            .unwrap_or_else(|| io::Error::other("a memory folder could not be walked")),
    }
}

#[cfg(test)]
pub(crate) mod test_fixture;

#[cfg(test)]
mod tests;
