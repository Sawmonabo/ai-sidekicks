//! The status file in the run folder, which holds one fact of three for the clients that read it
//! while no service answers: a failed start leaves why the service cannot start; each stop of a
//! running service records each step it waits on as `stopping` and removes the record as it
//! returns, or leaves why the person's Stop failed as `cannotStop`; a start that succeeds removes
//! the file.

use std::error::Error;
use std::io;

use sidekicks_contracts::daemon::service_status::{
    DaemonCannotStart, DaemonCannotStop, DaemonStopStep, DaemonStopping, ServiceStatusFile,
};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::process_identity::ProcessIdentity;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_platforms::{DaemonRunFolder, RUN_FOLDER_FILE_MODE};
use sidekicks_std::file::atomic_write::{AtomicWriteError, write_and_flush, write_without_flush};

use crate::daemon::process::database::DatabaseFileOpenError;
use crate::daemon::process::start_error::DaemonStartError;

/// Writes `status`, a failed start or a failed stop, to the run folder's status file, replacing it
/// whole and flushed to disk, readable by the person alone; on Linux the file is sticky, so a
/// session manager that cleans the runtime folder keeps it. Runs on the blocking pool, whole before
/// this answers. Fails with the write's or the folder flush's error, or when the write's task ends
/// first.
pub(crate) async fn write_service_status(
    run_folder: &DaemonRunFolder,
    status: &ServiceStatusFile,
) -> Result<(), AtomicWriteError> {
    let contents = serde_json::to_vec(status).expect("the status file serializes as JSON");
    let path = run_folder.status_path.clone();
    tokio::task::spawn_blocking(move || write_and_flush(&path, &contents, RUN_FOLDER_FILE_MODE))
        .await
        .unwrap_or_else(|failure| {
            Err(AtomicWriteError::Interrupted {
                path: run_folder.status_path.clone(),
                failure,
            })
        })
}

/// Writes the stop under way to the run folder's status file, replacing it whole with no flush,
/// since its readers take it only while this process lives. Blocking; fails with the write's error.
pub(crate) fn write_stopping(
    run_folder: &DaemonRunFolder,
    stopping: &DaemonStopping,
) -> Result<(), AtomicWriteError> {
    // A crash can leave the bytes torn, which a reader takes as no fact.
    let contents = serde_json::to_vec(&ServiceStatusFile::Stopping(stopping.clone()))
        .expect("the status file serializes as JSON");
    write_without_flush(&run_folder.status_path, &contents, RUN_FOLDER_FILE_MODE)
}

/// The record in the status file of each stop of a running service: each step it waits on as it
/// starts, then, as the stop returns, why the person's Stop failed or no file. Only a begun stop
/// writes, so a failed start's release and the erase's steps record no step.
pub(crate) struct StopRecord {
    /// Where the status file sits, which a failed start's release also records in.
    pub(crate) run_folder: DaemonRunFolder,
    /// This service's own process, which the record names.
    process: ProcessIdentity,
    /// When the stop began, on the wall clock; `None` until it begins.
    stop_started: Option<WireInstant>,
}

impl StopRecord {
    /// The record of the service running as `process`, its status file in `run_folder`, not yet
    /// begun.
    pub(crate) fn new(run_folder: DaemonRunFolder, process: ProcessIdentity) -> Self {
        Self {
            run_folder,
            process,
            stop_started: None,
        }
    }

    /// Begins the stop's record, its start read from the wall clock now.
    pub(crate) fn begin(&mut self) {
        self.stop_started = Some(WireInstant::now());
    }

    /// Records `step` as the one the stop waits on, whole before it answers, so no write runs on
    /// past the stop's end; nothing before [`StopRecord::begin`]. A failed write is logged and the
    /// stop goes on.
    pub(crate) async fn write_step(&self, step: DaemonStopStep) {
        let Some(stop_started) = self.stop_started.clone() else {
            return;
        };
        let run_folder = self.run_folder.clone();
        let stopping = DaemonStopping {
            step,
            stop_started,
            process: self.process.clone(),
        };
        let path = &self.run_folder.status_path;
        let written = tokio::task::spawn_blocking(move || write_stopping(&run_folder, &stopping))
            .await
            .unwrap_or_else(|failure| {
                Err(AtomicWriteError::Interrupted {
                    path: path.clone(),
                    failure,
                })
            });
        if let Err(failure) = written {
            tracing::warn!(
                path = %path.display(),
                ?step,
                error = &failure as &(dyn Error + 'static),
                "the stop's step could not be recorded in the service status file"
            );
        }
    }

    /// Ends the record as the stop returns: `cannotStop` when `is_intent_unsaved`, since the
    /// person's Stop could not keep its intent, else no file; nothing before [`StopRecord::begin`].
    /// A failed write or removal is logged beside the stop's own failures, which it never replaces.
    pub(crate) async fn write_end(&self, is_intent_unsaved: bool) {
        if self.stop_started.is_none() {
            return;
        }
        let path = &self.run_folder.status_path;
        if is_intent_unsaved {
            if let Err(failure) = write_service_status(
                &self.run_folder,
                &ServiceStatusFile::CannotStop(DaemonCannotStop::StopIntent {}),
            )
            .await
            {
                tracing::error!(
                    path = %path.display(),
                    error = &failure as &(dyn Error + 'static),
                    "the service status file could not be written for the failed stop"
                );
            }
        } else if let Err(failure) = remove_service_status(&self.run_folder).await {
            tracing::error!(
                path = %path.display(),
                error = &failure as &(dyn Error + 'static),
                "the stop's record could not be removed from the service status file"
            );
        }
    }
}

/// Removes the run folder's status file; one already gone counts as removed. Runs on the blocking
/// pool, whole before this answers. Fails with the system's error, or when the removal's task ends
/// first.
pub(crate) async fn remove_service_status(run_folder: &DaemonRunFolder) -> io::Result<()> {
    let path = run_folder.status_path.clone();
    tokio::task::spawn_blocking(move || match std::fs::remove_file(&path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    })
    .await
    .unwrap_or_else(|ended| Err(io::Error::other(ended)))
}

/// Records why the start failed with `error` where a client reads it: a damaged or another
/// version's saved sessions write the status file, and any other failure removes an older one, so
/// no client refuses a restart over a reason that no longer holds. The write or removal runs on the
/// blocking pool, whole before this answers. A failed write or removal is logged beside the start's
/// own error, which it never replaces.
pub(crate) async fn record_start_failure(run_folder: &DaemonRunFolder, error: &DaemonStartError) {
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
    if let Some(cannot_start) = cannot_start {
        if let Err(failure) =
            write_service_status(run_folder, &ServiceStatusFile::CannotStart(cannot_start)).await
        {
            tracing::error!(
                path = %path.display(),
                error = &failure as &(dyn Error + 'static),
                "the service status file could not be written for the failed start"
            );
        }
    } else if let Err(failure) = remove_service_status(run_folder).await {
        tracing::error!(
            path = %path.display(),
            error = &failure as &(dyn Error + 'static),
            "the service status file of an earlier start could not be removed"
        );
    }
}
