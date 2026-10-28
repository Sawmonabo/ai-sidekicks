//! `Erase all data`: the keychain is checked before the erase answers, so a locked or unusable one
//! refuses it with nothing changed; then, in order, every run and shell stops as Runtime's `Stop`
//! stops them, every provider service ends, every credential-store item the app made is deleted,
//! everything that holds a file in the data folder closes, the data folder goes with the account
//! homes in it, and the process ends so its caller starts it again, empty. The default `backups/`
//! folder stays, since a backup taken earlier keeps its copy, and no project folder is touched.
//! An item the store refuses to delete leaves the data folder whole, so the erase can run again.
//! One erase runs at a time: a second sent while it runs is refused and starts nothing.

use std::error::Error;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use futures::future::BoxFuture;
use sidekicks_contracts::daemon::backup::BACKUP_DEFAULT_FOLDER_NAME;
use sidekicks_provider::driver::daemon_stop::DaemonStopIntent;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_store::credential_store::KeychainRefusal;
use sidekicks_store::credential_store::items::SecretItems;

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
        let erased = self.deps.secret_items.erase_all().await;
        (self.deps.close_data_folder)().await;
        match erased {
            Ok(()) => {
                let data_folder = self.deps.data_folder.clone();
                let deleted = tokio::task::spawn_blocking(move || delete_data_folder(&data_folder))
                    .await
                    .map_err(io::Error::other)
                    .and_then(|deleted| deleted);
                if let Err(failure) = deleted {
                    tracing::warn!(
                        folder = %self.deps.data_folder.display(),
                        error = &failure as &(dyn Error + 'static),
                        "the data folder was not deleted whole"
                    );
                }
            }
            Err(refusal) => tracing::warn!(
                error = &refusal as &(dyn Error + 'static),
                "the secrets could not all be deleted, so the data folder stays and the erase can \
                 run again"
            ),
        }
        (self.deps.end_process)();
    }
}

// Deletes every entry of `data_folder` but the default backups folder, then the folder itself
// once nothing is left in it. A link is deleted as a link, never followed. Each entry is tried,
// one that cannot be listed or read among them; each failure is written to the service log with
// its entry, and the first is answered once all were tried.
fn delete_data_folder(data_folder: &Path) -> io::Result<()> {
    let mut first_failure = None;
    for entry in fs::read_dir(data_folder)? {
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
        if let Err(failure) = deleted {
            tracing::warn!(
                entry = %path.display(),
                error = &failure as &(dyn Error + 'static),
                "an entry of the data folder was not deleted"
            );
            first_failure.get_or_insert(failure);
        }
    }
    if let Some(failure) = first_failure {
        return Err(failure);
    }
    if fs::read_dir(data_folder)?.next().is_none() {
        fs::remove_dir(data_folder)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
