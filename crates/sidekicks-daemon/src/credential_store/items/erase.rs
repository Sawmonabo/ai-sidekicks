//! The erase of every item the app made, from the operating system's store and the items file,
//! checked before the erase answers and done before the data folder goes.

use std::error::Error;

use crate::credential_store::KeychainRefusal;
use crate::credential_store::items::SecretItems;
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
        if let Some(sweep) = self.operating_system_sweep().await {
            for service in KeychainService::ALL {
                if let Err(refusal) = self.os_store.check_items(service.as_str()).await {
                    self.skip_sweep(sweep, refusal)?;
                    break;
                }
            }
        }
        Ok(())
    }

    /// Deletes every item the app made: each service's items in the operating system's store,
    /// probe leftovers and items it cannot name included, and the items file. Fails with
    /// [`KeychainRefusal`] at the first item a store that must be emptied refuses, before the data
    /// folder goes, so the erase can run again.
    pub(crate) async fn erase_all(&self) -> Result<(), KeychainRefusal> {
        let mut state = self.state.write().await;
        if let Some(sweep) = self.operating_system_sweep().await {
            for service in KeychainService::ALL {
                if let Err(refusal) = self.os_store.erase_items(service.as_str()).await {
                    self.skip_sweep(sweep, refusal)?;
                    break;
                }
            }
        }
        self.items_file.remove_all().await?;
        state.is_move_stopped = true;
        Ok(())
    }

    // How the erase treats the operating system's store, or `None` when it leaves it. It must be
    // emptied when the record names it, and when the record cannot be read and the store can be
    // reached, since the record may name it. Otherwise it is emptied as far as it answers, for the
    // items a data folder removed by hand left there, and left, logged, when it cannot be reached.
    async fn operating_system_sweep(&self) -> Option<OperatingSystemSweep> {
        let record = place::read_record(&self.record_path).await;
        if let Ok(Some(record)) = &record
            && record.names_operating_system()
        {
            return Some(OperatingSystemSweep::Required);
        }
        match (record, self.access.check_reachable().await) {
            (Err(_unreadable), Ok(())) => Some(OperatingSystemSweep::Required),
            (Ok(_record), Ok(())) => Some(OperatingSystemSweep::WhenAnswering),
            (Err(unreadable), Err(unreachable)) => {
                tracing::warn!(
                    error = &unreadable as &(dyn Error + 'static),
                    unreachable = &unreachable as &(dyn Error + 'static),
                    "The secrets' place record cannot be read and the operating system's store \
                     cannot be reached, so the erase leaves that store"
                );
                None
            }
            (Ok(_record), Err(unreachable)) => {
                tracing::info!(
                    error = &unreachable as &(dyn Error + 'static),
                    "The erase leaves the operating system's store, which does not hold the \
                     secrets and cannot be reached"
                );
                None
            }
        }
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
                    file = %self.items_file.file_path().display(),
                    "The erase leaves the operating system's store, which does not hold the \
                     secrets and does not answer"
                );
                Ok(())
            }
        }
    }
}
