//! The status file a failed start leaves in the run folder, which says why the service cannot
//! start to the clients that read it while no service answers; a start that succeeds removes it.

use std::error::Error;
use std::io;

use sidekicks_contracts::daemon::service_status::{DaemonCannotStart, ServiceStatusFile};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_platforms::{DaemonRunFolder, RUN_FOLDER_FILE_MODE};

use crate::daemon::process::DaemonStartError;
use crate::daemon::process::database::DatabaseFileOpenError;
use sidekicks_std::file::atomic_write::{AtomicWriteError, write_and_flush};

/// Writes `status` to the run folder's status file, replacing it whole, readable by the person
/// alone; on Linux the file is sticky, so a session manager that cleans the runtime folder keeps
/// it. Blocking. Fails with the write's or the folder flush's error.
pub(crate) fn write_service_status(
    run_folder: &DaemonRunFolder,
    status: &ServiceStatusFile,
) -> Result<(), AtomicWriteError> {
    let contents = serde_json::to_vec(status).expect("the status file serializes as JSON");
    write_and_flush(&run_folder.status_path, &contents, RUN_FOLDER_FILE_MODE)
}

/// Removes the run folder's status file; one already gone counts as removed. Blocking. Fails with
/// the system's error.
pub(crate) fn remove_service_status(run_folder: &DaemonRunFolder) -> io::Result<()> {
    match std::fs::remove_file(&run_folder.status_path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

/// Records why the start failed with `error` where a client reads it: a damaged or another
/// version's saved sessions write the status file, and any other failure removes an older one, so
/// no client refuses a restart over a reason that no longer holds. Blocking. A failed write or
/// removal is logged beside the start's own error, which it never replaces.
pub(crate) fn record_start_failure(run_folder: &DaemonRunFolder, error: &DaemonStartError) {
    let cannot_start =
        if let DaemonStartError::DatabaseFile(DatabaseFileOpenError::SavedSessionsUnrepaired {
            aside_folder,
            ..
        }) = error
        {
            let aside_folder = FilesystemPath::new(aside_folder.to_string_lossy().into_owned())
                .expect("a folder's path is not empty, holds no NUL and fits the file path cap");
            Some(DaemonCannotStart::SavedSessionsUnrepaired { aside_folder })
        } else if let DaemonStartError::DatabaseFile(
            DatabaseFileOpenError::SavedSessionsFromAnotherVersion { .. },
        ) = error
        {
            Some(DaemonCannotStart::SavedSessionsFromAnotherVersion {})
        } else {
            None
        };
    let path = &run_folder.status_path;
    match cannot_start {
        Some(cannot_start) => {
            if let Err(failure) =
                write_service_status(run_folder, &ServiceStatusFile { cannot_start })
            {
                tracing::error!(
                    path = %path.display(),
                    error = &failure as &(dyn Error + 'static),
                    "the service status file could not be written for the failed start"
                );
            }
        }
        None => {
            if let Err(failure) = remove_service_status(run_folder) {
                tracing::error!(
                    path = %path.display(),
                    error = &failure as &(dyn Error + 'static),
                    "the service status file of an earlier start could not be removed"
                );
            }
        }
    }
}
