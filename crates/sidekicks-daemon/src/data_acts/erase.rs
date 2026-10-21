//! `Erase all data`: the keychain is checked before the erase answers, so a locked or unusable one
//! refuses it with nothing changed; then, in order, every run and shell stops as Runtime's `Stop`
//! stops them, every provider service ends, every credential-store item the app made is deleted,
//! everything that holds a file in the data folder closes, the data folder goes with the account
//! homes in it, and the process ends so its caller starts it again, empty. The default `backups/`
//! folder stays, since a backup taken earlier keeps its copy, and no project folder is touched.
//! An item the store refuses to delete leaves the data folder whole, so the erase can run again.

use std::error::Error;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures::future::BoxFuture;
use sidekicks_contracts::daemon::backup::BACKUP_DEFAULT_FOLDER_NAME;

use crate::credential_store::KeychainRefusal;
use crate::credential_store::items::SecretItems;
use crate::provider::driver::daemon_stop::DaemonStopIntent;
use crate::provider::driver::registry::ProviderRegistry;

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
    /// Ends the process; its caller starts it again.
    pub(crate) end_process: Arc<dyn Fn() + Send + Sync>,
}

/// The erase of everything the service keeps.
pub(crate) struct DataErase {
    deps: DataEraseDeps,
}

impl DataErase {
    /// The erase, acting through `deps`.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the daemon's start makes the erase once the store is open"
        )
    )]
    pub(crate) fn new(deps: DataEraseDeps) -> Self {
        Self { deps }
    }

    /// Checks that every credential-store item the erase must delete can be, then starts the
    /// erase and answers, so the reply is written while the erase stops the work; a locked store
    /// raises its unlock prompt while the person is at the screen. Fails with
    /// [`KeychainRefusal`] when the store is locked or cannot be used; nothing is erased then.
    pub(crate) async fn begin(self: &Arc<Self>) -> Result<(), KeychainRefusal> {
        self.deps.secret_items.check_for_erase().await?;
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
                    "A provider's services did not end before the erase"
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
                        "The data folder was not deleted whole"
                    );
                }
            }
            Err(refusal) => tracing::warn!(
                error = &refusal as &(dyn Error + 'static),
                "The keychain refused to delete an item, so the data folder stays and the erase \
                 can run again"
            ),
        }
        (self.deps.end_process)();
    }
}

// Deletes every entry of `data_folder` but the default backups folder, then the folder itself
// once nothing is left in it. A link is deleted as a link, never followed. Each entry is tried;
// the first failure is answered once all were.
fn delete_data_folder(data_folder: &Path) -> io::Result<()> {
    let mut first_failure = None;
    for entry in fs::read_dir(data_folder)? {
        let entry = entry?;
        if entry.file_name() == BACKUP_DEFAULT_FOLDER_NAME {
            continue;
        }
        let deleted = if entry.file_type()?.is_dir() {
            fs::remove_dir_all(entry.path())
        } else {
            fs::remove_file(entry.path())
        };
        if let Err(failure) = deleted {
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
