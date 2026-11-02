//! `Erase all data`: the keychain is checked before the erase answers, so a locked or unusable one
//! refuses it with nothing changed; then, in order, every run and shell stops as Runtime's `Stop`
//! stops them, every provider service ends, every credential-store item the app made is deleted,
//! everything that holds a file in the data folder closes, the data folder goes with the account
//! homes in it, and the process ends so its caller starts it again, empty. The default `backups/`
//! folder stays, since a backup taken earlier keeps its copy, and no project folder is touched.
//! An item the store refuses to delete leaves the data folder whole, so the erase can run again.
//! One erase runs at a time: a second sent while it runs is refused and starts nothing. The
//! program's `data erase` mode, run with the service stopped, shares the end of each provider's
//! recorded services and the last steps, the secrets' delete and then the data folder's.

use std::error::Error;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use futures::future::BoxFuture;
use sidekicks_contracts::daemon::backup::BACKUP_DEFAULT_FOLDER_NAME;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::daemon_stop::{DaemonStopIntent, RecordedServicesStop};
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_store::credential_store::KeychainRefusal;
use sidekicks_store::credential_store::items::SecretItems;

pub(crate) mod mode;

/// One step of the erase that the running daemon carries out.
pub(crate) type EraseStep = Arc<dyn Fn() -> BoxFuture<'static, ()> + Send + Sync>;

/// What the erase acts on.
pub(crate) struct DataEraseDeps {
    /// The data folder.
    pub(crate) data_folder: PathBuf,
    /// The daemon's secrets, whose items the erase checks and deletes.
    pub(crate) secret_items: Arc<SecretItems>,
    /// The registered drivers, each of whose services ends.
    pub(crate) providers: Arc<ProviderRegistry>,
    /// Stops every run and shell as Runtime's `Stop` does, once the erase's reply is written.
    pub(crate) stop_work: EraseStep,
    /// Closes everything that holds a file in the data folder: the read pool and the writer, the
    /// run folder, the service log's file, the data-folder lock and the crash monitor.
    pub(crate) close_data_folder: EraseStep,
    /// Ends the process once the erase's reply is written, as the daemon's stop waits for the
    /// reply that asked for it; its caller starts it again.
    pub(crate) end_process: Arc<dyn Fn() + Send + Sync>,
}

/// Why an erase did not start; nothing was erased by this call.
#[derive(Debug, thiserror::Error)]
pub(crate) enum DataEraseRefusal {
    /// An erase already runs, and erases everything.
    #[error("an erase is already running")]
    Running,
    /// The keychain the erase must empty is locked or cannot be used.
    #[error(transparent)]
    Keychain(#[from] KeychainRefusal),
}

/// What the erase's last steps left: everything gone, or what stayed and why.
pub(crate) enum DataEraseOutcome {
    /// Every secret and the data folder but its backups are gone.
    Erased,
    /// The keychain refused an item, so the data folder stays whole and the erase can run again.
    SecretsKept(KeychainRefusal),
    /// The secrets are gone, but these entries of the data folder are not.
    FolderNotDeletedWhole(DataFolderLeft),
}

/// The entries of the data folder the erase could not delete, each with its failure.
#[derive(Debug, thiserror::Error)]
#[error("the data folder was not deleted whole (entries left: {})", .entries.len())]
pub(crate) struct DataFolderLeft {
    /// Each entry left, in the order it was tried.
    pub(crate) entries: Vec<DataFolderEntryLeft>,
}

/// One entry of the data folder the erase could not delete; an entry that could not be listed,
/// and the folder itself, are named by the folder.
#[derive(Debug, thiserror::Error)]
#[error("{} was not deleted", .path.display())]
pub(crate) struct DataFolderEntryLeft {
    /// The entry.
    pub(crate) path: PathBuf,
    /// The system's failure.
    #[source]
    pub(crate) source: io::Error,
}

/// The erase of everything the service keeps.
pub(crate) struct DataErase {
    deps: DataEraseDeps,
    is_running: AtomicBool,
}

impl DataErase {
    /// The erase, acting through `deps`.
    pub(crate) fn new(deps: DataEraseDeps) -> Self {
        Self {
            deps,
            is_running: AtomicBool::new(false),
        }
    }

    /// Checks that every credential-store item the erase must delete can be, then starts the
    /// erase and answers, so the reply is written while the erase stops the work; a locked store
    /// raises its unlock prompt while the person is at the screen. Fails with
    /// [`DataEraseRefusal::Running`] while an erase runs, and with
    /// [`DataEraseRefusal::Keychain`] when the store is locked or cannot be used; this call then
    /// starts nothing.
    pub(crate) async fn begin(self: &Arc<Self>) -> Result<(), DataEraseRefusal> {
        if self.is_running.load(Ordering::Acquire) {
            return Err(DataEraseRefusal::Running);
        }
        self.deps.secret_items.check_for_erase().await?;
        // Two erases sent together may both pass the check; only the first to get here starts.
        if self.is_running.swap(true, Ordering::AcqRel) {
            return Err(DataEraseRefusal::Running);
        }
        let erase = Arc::clone(self);
        tokio::spawn(async move { erase.erase().await });
        Ok(())
    }

    // Erases everything and ends the process. Never fails: a provider service that does not end
    // and a data-folder entry that cannot be deleted are told in the service log, and a store that
    // refuses an item keeps the data folder whole.
    async fn erase(&self) {
        (self.deps.stop_work)().await;
        for (provider, driver) in self.deps.providers.drivers() {
            if let Err(failure) = driver.shutdown(DaemonStopIntent::Stop).await {
                tracing::warn!(
                    provider = provider.as_str(),
                    error = &failure as &(dyn Error + 'static),
                    "a provider's services did not end before the erase"
                );
            }
        }
        // A draining service outlives its driver's stop, so its record ends it.
        let recorded_stops = self.deps.providers.recorded_service_stops();
        for failure in stop_every_recorded_service(recorded_stops, &self.deps.data_folder).await {
            tracing::warn!(
                error = &failure as &(dyn Error + 'static),
                "a provider's recorded service did not end before the erase"
            );
        }
        let erased = erase_data(&self.deps.secret_items, &self.deps.data_folder, || {
            (self.deps.close_data_folder)()
        })
        .await;
        match erased {
            DataEraseOutcome::Erased => {}
            DataEraseOutcome::SecretsKept(refusal) => tracing::warn!(
                error = &refusal as &(dyn Error + 'static),
                "the secrets could not all be deleted, so the data folder stays and the erase can \
                 run again"
            ),
            DataEraseOutcome::FolderNotDeletedWhole(left) => {
                for entry in &left.entries {
                    tracing::warn!(
                        entry = %entry.path.display(),
                        error = &entry.source as &(dyn Error + 'static),
                        "an entry of the data folder was not deleted"
                    );
                }
            }
        }
        (self.deps.end_process)();
    }
}

/// Ends, with `data_folder` the data folder, the lasting services each provider's records name,
/// one provider after another, and answers every failure met; an empty list when all ended.
pub(crate) async fn stop_every_recorded_service(
    stops: impl IntoIterator<Item = RecordedServicesStop>,
    data_folder: &Path,
) -> Vec<DriverError> {
    let mut failures = Vec::new();
    for stop in stops {
        if let Err(stopped) = stop(data_folder).await {
            failures.extend(stopped.failures);
        }
    }
    failures
}

/// The erase's last steps: deletes every credential-store item the app made, runs
/// `close_data_folder` whatever that answered, and only once every item is gone deletes the data
/// folder but its backups. Never fails: what stayed is the outcome.
pub(crate) async fn erase_data(
    secret_items: &SecretItems,
    data_folder: &Path,
    close_data_folder: impl FnOnce() -> BoxFuture<'static, ()>,
) -> DataEraseOutcome {
    let erased = secret_items.erase_all().await;
    close_data_folder().await;
    if let Err(refusal) = erased {
        return DataEraseOutcome::SecretsKept(refusal);
    }
    let folder = data_folder.to_path_buf();
    let deleted = tokio::task::spawn_blocking(move || delete_data_folder(&folder))
        .await
        .unwrap_or_else(|ended| {
            Err(DataFolderLeft {
                entries: vec![DataFolderEntryLeft {
                    path: data_folder.to_path_buf(),
                    source: io::Error::other(ended),
                }],
            })
        });
    match deleted {
        Ok(()) => DataEraseOutcome::Erased,
        Err(left) => DataEraseOutcome::FolderNotDeletedWhole(left),
    }
}

// Deletes every entry of `data_folder` but the default backups folder, then the folder itself
// once nothing is left in it. A link is deleted as a link, never followed. Each entry is tried,
// one that cannot be listed or read among them, and every entry left is answered once all were
// tried; a listing that fails and a folder that cannot be removed are named by the folder.
fn delete_data_folder(data_folder: &Path) -> Result<(), DataFolderLeft> {
    let folder_left = |source| DataFolderEntryLeft {
        path: data_folder.to_path_buf(),
        source,
    };
    let listing = fs::read_dir(data_folder).map_err(|source| DataFolderLeft {
        entries: vec![folder_left(source)],
    })?;
    let mut entries = Vec::new();
    for entry in listing {
        let (path, deleted) = match entry {
            Ok(entry) if entry.file_name() == BACKUP_DEFAULT_FOLDER_NAME => continue,
            Ok(entry) => {
                let path = entry.path();
                let deleted = entry.file_type().and_then(|file_type| {
                    if file_type.is_dir() {
                        fs::remove_dir_all(&path)
                    } else {
                        fs::remove_file(&path)
                    }
                });
                (path, deleted)
            }
            // An entry that cannot be listed is named by its folder.
            Err(failure) => (data_folder.to_path_buf(), Err(failure)),
        };
        if let Err(source) = deleted {
            entries.push(DataFolderEntryLeft { path, source });
        }
    }
    if entries.is_empty() {
        // The backups folder, when there is one, keeps the folder.
        let removed = fs::read_dir(data_folder).and_then(|mut rest| match rest.next() {
            None => fs::remove_dir(data_folder),
            Some(_) => Ok(()),
        });
        if let Err(source) = removed {
            entries.push(folder_left(source));
        }
    }
    if entries.is_empty() {
        return Ok(());
    }
    Err(DataFolderLeft { entries })
}

#[cfg(test)]
mod tests;
