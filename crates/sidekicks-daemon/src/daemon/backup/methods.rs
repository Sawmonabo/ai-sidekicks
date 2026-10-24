//! The backup methods on Settings › Runtime: where the backups stand, and `Back up now`, which
//! queues a run at once whether `Back up automatically` is on or off and joins a run already
//! queued, or running and not yet copying.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::daemon::backup::{
    BackupListEntry, DaemonBackupRead, DaemonBackupReadResponse, DaemonBackupStart,
};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_contracts::wire::integer::SafeInt;
use walkdir::WalkDir;

use crate::daemon::backup::run::{BackupTrigger, Backups, read_backups};
use crate::daemon::scheduler::Scheduler;
use crate::ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};

/// What the backup methods read and run through.
pub(crate) struct BackupMethodsDeps {
    /// The service's backups.
    pub(crate) backups: Arc<Backups>,
    /// The scheduler `Back up now` queues its run on.
    pub(crate) scheduler: Arc<Scheduler>,
}

/// Registers `daemon.backup.read` and `daemon.backup.start`. Fails the start when a method is
/// already registered.
#[expect(dead_code, reason = "the daemon's start registers the backup methods")]
pub(crate) fn register_backup_methods(
    registry: &mut MethodRegistryBuilder,
    deps: BackupMethodsDeps,
) -> Result<(), RegistrationError> {
    let deps = Arc::new(deps);
    let reading = Arc::clone(&deps);
    registry.register::<DaemonBackupRead, _>(
        move |_: EmptyPayload, _context: HandlerContext| {
            let backups = Arc::clone(&reading.backups);
            async move { read_backup_standing(&backups).await }.boxed()
        },
    )?;
    registry.register::<DaemonBackupStart, _>(move |_: EmptyPayload, _context: HandlerContext| {
        let deps = Arc::clone(&deps);
        async move {
            deps.backups
                .request(&deps.scheduler, BackupTrigger::Now)
                .map_err(|failure| HandlerError::Internal(Box::new(failure)))?;
            Ok(EmptyPayload {})
        }
        .boxed()
    })
}

// The folder, whether it sits on the service's disk, its size, the last run and every backup in
// it, newest first.
async fn read_backup_standing(backups: &Backups) -> Result<DaemonBackupReadResponse, HandlerError> {
    let folder = backups.folder().await?;
    let internal = |failure: io::Error| HandlerError::Internal(Box::new(failure));
    let measured_folder = folder.clone();
    let data_folder = backups.data_folder();
    let (mut listed, total_bytes, folder_on_service_disk) =
        tokio::task::spawn_blocking(move || {
            Ok::<_, io::Error>((
                read_backups(&measured_folder)?,
                folder_bytes(&measured_folder)?,
                is_on_same_volume(&measured_folder, &data_folder)?,
            ))
        })
        .await
        .map_err(|failure| HandlerError::Internal(Box::new(failure)))?
        .map_err(internal)?;
    listed.sort_by(|(_, left), (_, right)| {
        right
            .taken_at
            .unix_millisecond()
            .cmp(&left.taken_at.unix_millisecond())
    });
    let last_run = backups
        .read_last_run()
        .await
        .map_err(|failure| HandlerError::Internal(Box::new(failure)))?;
    Ok(DaemonBackupReadResponse {
        folder: FilesystemPath::new(folder.to_string_lossy().into_owned())
            .map_err(|failure| HandlerError::Internal(Box::new(failure)))?,
        folder_on_service_disk,
        total_bytes: SafeInt::new(total_bytes).expect("a folder's size is a safe integer"),
        last_run,
        backups: listed
            .into_iter()
            .map(|(_, manifest)| BackupListEntry {
                backup_id: manifest.backup_id,
                taken_at: manifest.taken_at,
                total_bytes: manifest.total_bytes,
                app_version: manifest.app_version,
                computer_name: manifest.computer_name,
            })
            .collect(),
    })
}

// The bytes of every file under `folder`, none when it is missing.
fn folder_bytes(folder: &Path) -> io::Result<u64> {
    let mut total = 0_u64;
    for entry in WalkDir::new(folder) {
        let entry = match entry {
            Ok(entry) => entry,
            Err(failure)
                if failure.depth() == 0
                    && failure
                        .io_error()
                        .is_some_and(|error| error.kind() == io::ErrorKind::NotFound) =>
            {
                return Ok(0);
            }
            Err(failure) => return Err(failure.into()),
        };
        if entry.file_type().is_file() {
            total = total.saturating_add(entry.metadata().map_err(io::Error::from)?.len());
        }
    }
    Ok(total)
}

// Whether `folder`, or the nearest folder above it that exists, sits on the volume holding
// `data_folder`; an entry's identity text leads with its volume.
fn is_on_same_volume(folder: &Path, data_folder: &Path) -> io::Result<bool> {
    let volume_of = |path: &Path| -> io::Result<String> {
        let mut existing: PathBuf = path.to_path_buf();
        loop {
            match sidekicks_platforms::entry_identity(&existing) {
                Ok(entry) => {
                    let identity = entry.identity.to_string();
                    let (volume, _file) = identity
                        .split_once(':')
                        .expect("an entry identity's text is `<volume>:<file>`");
                    return Ok(volume.to_owned());
                }
                Err(failure) if failure.kind() == io::ErrorKind::NotFound => {
                    if !existing.pop() {
                        return Err(failure);
                    }
                }
                Err(failure) => return Err(failure),
            }
        }
    };
    Ok(volume_of(folder)? == volume_of(data_folder)?)
}
