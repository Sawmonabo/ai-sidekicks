//! Whether a background service holds an account's data folder, read without changing it, and
//! whether that holder is the account's system service, as a run under `sudo` reads them before
//! it installs the system service.

use std::fs::{self, File, TryLockError};
use std::io;
use std::path::Path;

use anyhow::Context as _;
use sidekicks_contracts::daemon::data::{DAEMON_LOCK_FILE_NAME, DAEMON_PROCESS_ID_FILE_NAME};
use sidekicks_contracts::daemon::lifecycle::SYSTEM_SERVICE_MODE;
use sidekicks_platforms::read_process_start;

/// Whether a service holds the data folder at `data_folder`: its lock file locked, read through a
/// shared lock tried once on the file opened read only, which neither creates nor changes it. A
/// folder with no lock file is not held. Fails, naming the file, when it cannot be opened or
/// locked.
pub(super) fn is_data_folder_held(data_folder: &Path) -> anyhow::Result<bool> {
    let path = data_folder.join(DAEMON_LOCK_FILE_NAME);
    let unreadable = |failure: io::Error| {
        anyhow::Error::new(failure).context(format!(
            "could not read whether a background service holds {}",
            path.display()
        ))
    };
    let file = match File::open(&path) {
        Ok(file) => file,
        Err(failure) if failure.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(failure) => return Err(unreadable(failure)),
    };
    // The probe's shared lock is freed as the file closes on return.
    match file.try_lock_shared() {
        Ok(()) => Ok(false),
        Err(TryLockError::WouldBlock) => Ok(true),
        Err(TryLockError::Error(failure)) => Err(unreadable(failure)),
    }
}

/// Whether the holder of the data folder at `data_folder` is this account's system service: the
/// process whose id its holder wrote beside the lock runs the daemon's system service mode. A
/// missing or unreadable id is no system service's. Fails, naming the file or the process, when
/// the id's file or the process cannot be read.
pub(super) fn is_system_service_holding(data_folder: &Path) -> anyhow::Result<bool> {
    let path = data_folder.join(DAEMON_PROCESS_ID_FILE_NAME);
    let process_id = match fs::read_to_string(&path) {
        Ok(text) => text.trim().parse::<u32>().ok(),
        Err(failure) if failure.kind() == io::ErrorKind::NotFound => None,
        Err(failure) => {
            return Err(anyhow::Error::new(failure).context(format!(
                "could not read which process holds {}",
                data_folder.display()
            )));
        }
    };
    let Some(process_id) = process_id else {
        return Ok(false);
    };
    let start = read_process_start(process_id).with_context(|| {
        format!("could not read the process {process_id} that holds the data folder")
    })?;
    Ok(start.is_some_and(|start| {
        start
            .arguments
            .iter()
            .any(|argument| argument == SYSTEM_SERVICE_MODE)
    }))
}

#[cfg(test)]
mod tests {
    use sidekicks_contracts::daemon::data::DAEMON_PROCESS_ID_FILE_NAME;

    use super::is_system_service_holding;

    // Fails when any process whose id the holder wrote reads as the system service, its arguments
    // not read for the system service's mode: this test's own process runs no such mode.
    #[test]
    fn a_holder_that_is_not_the_system_service_reads_as_not_holding() {
        let data_folder = tempfile::tempdir().expect("a temporary data folder");
        std::fs::write(
            data_folder.path().join(DAEMON_PROCESS_ID_FILE_NAME),
            format!("{}\n", std::process::id()),
        )
        .expect("the process id is written");

        let is_holding =
            is_system_service_holding(data_folder.path()).expect("the holder's process reads");

        assert!(
            !is_holding,
            "this test's own process read as the system service"
        );
    }
}
