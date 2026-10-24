//! The erase of every item the app made, from the operating system's store and the items file,
//! checked before the erase answers and done before the data folder goes.

use std::error::Error;
use std::sync::Arc;

use crate::credential_store::KeychainRefusal;
use crate::credential_store::items::SecretItems;
use crate::credential_store::os::OsCredentialStore;
use crate::credential_store::place;
use crate::credential_store::service::KeychainService;

// How an erase treats the operating system's store: one it must empty refuses the erase when it
// cannot be used; one it empties as far as it answers is left, logged, when it does not.
#[derive(Clone, Copy)]
enum OperatingSystemSweep {
    Required,
    WhenAnswering,
}

#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the erase checks and empties the secret items")
)]
impl SecretItems {
    /// Lists every service's items in every place the erase must empty, before the erase answers,
    /// so a locked store raises its unlock prompt while the person is at the screen. Fails with
    /// [`KeychainRefusal`] when the operating system's store must be emptied and is locked or
    /// cannot be used; nothing is erased then.
    pub(crate) async fn check_for_erase(&self) -> Result<(), KeychainRefusal> {
        let _state = self.state.write().await;
        if let Some((os_store, sweep)) = self.operating_system_sweep().await {
            for service in KeychainService::ALL {
                if let Err(refusal) = os_store.check_items(service.as_str()).await {
                    self.skip_sweep(sweep, refusal)?;
                    break;
                }
            }
        }
        Ok(())
    }

    /// Deletes every item the app made: each service's items in the operating system's store,
    /// probe leftovers and items it cannot name included, and the items file, sealed or plain,
    /// opening none of its items. Fails with [`KeychainRefusal`] at the first item a store that
    /// must be emptied refuses, before the data folder goes, so the erase can run again.
    pub(crate) async fn erase_all(&self) -> Result<(), KeychainRefusal> {
        let _state = self.state.write().await;
        if let Some((os_store, sweep)) = self.operating_system_sweep().await {
            for service in KeychainService::ALL {
                if let Err(refusal) = os_store.erase_items(service.as_str()).await {
                    self.skip_sweep(sweep, refusal)?;
                    break;
                }
            }
        }
        self.plain_file.remove_all().await
    }

    // The operating system's store and how the erase treats it, or `None` where the machine offers
    // none, as on Linux. It must be emptied when the record names it, and when the record cannot be
    // read, since the record may name it. Otherwise it is emptied as far as it answers, for the
    // items a data folder removed by hand left there.
    async fn operating_system_sweep(
        &self,
    ) -> Option<(&Arc<OsCredentialStore>, OperatingSystemSweep)> {
        let os_store = self.os_store.as_ref()?;
        let sweep = match place::read_record(&self.record_path).await {
            Ok(Some(record)) if record.names_operating_system() => OperatingSystemSweep::Required,
            Err(unreadable) => {
                tracing::warn!(
                    error = &unreadable as &(dyn Error + 'static),
                    "the secrets' place record cannot be read, so the erase must empty the \
                     operating system's store"
                );
                OperatingSystemSweep::Required
            }
            Ok(_record) => OperatingSystemSweep::WhenAnswering,
        };
        Some((os_store, sweep))
    }

    // A store the erase must empty refuses with `refusal`; one it empties as far as it answers is
    // left, logged.
    fn skip_sweep(
        &self,
        sweep: OperatingSystemSweep,
        refusal: KeychainRefusal,
    ) -> Result<(), KeychainRefusal> {
        match sweep {
            OperatingSystemSweep::Required => Err(refusal),
            OperatingSystemSweep::WhenAnswering => {
                tracing::info!(
                    error = &refusal as &(dyn Error + 'static),
                    file = %self.plain_file.file_path().display(),
                    "the erase leaves the operating system's store, which does not hold the \
                     secrets and does not answer"
                );
                Ok(())
            }
        }
    }
}
