//! The record file a service names as its own lasting process's: the name a start publishes and
//! a daemon stop reads under the folder's lock, the socket's record it falls back on, its retire
//! once that process ended, its mark once a service started beside it took its place, and a later
//! start's retire of the record its last process was kept in.

use std::collections::HashSet;
use std::io;
use std::path::Path;
use std::sync::Arc;

use sidekicks_std::mutex_lock::lock;

use crate::driver::codex::service::record::{LastingServiceRecordFile, LockedServiceRecord};
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::service::supervisor::start::StartFailure;
use crate::driver::codex::service::supervisor::start::kept_records::{
    lock_record, on_record, retire_kept_record,
};
use crate::driver::codex::session::errors::CodexError;

impl CodexService {
    /// The record file of the lasting process the last start brought up, or the one a launch under
    /// way writes; `None` before any start and for a service with no lasting process.
    pub(crate) fn process_record_file(&self) -> Option<LastingServiceRecordFile> {
        lock(&self.process_record_file).clone()
    }

    /// Publishes `record_file` as the record of the service's lasting process: a launch publishes
    /// it before it writes the record, so a daemon stop leaves that record to this service, and an
    /// adopted start publishes what it brought up.
    pub(crate) fn set_process_record_file(&self, record_file: Option<LastingServiceRecordFile>) {
        *lock(&self.process_record_file) = record_file;
    }
}

/// The record file a launch or a join publishes on its service for as long as its process lives:
/// unless it is handed back with that process, the name published before it comes back once it is
/// dropped, so a retire and the next start act on the service's own record.
pub(super) struct PublishedRecordFile<'service> {
    service: &'service CodexService,
    // The name before the publish, put back unless the attempt is kept.
    previous: Option<LastingServiceRecordFile>,
    is_kept: bool,
}

impl<'service> PublishedRecordFile<'service> {
    /// Publishes `record_file` on `service`, so a daemon stop leaves that record to it.
    pub(super) fn publish(
        service: &'service CodexService,
        record_file: LastingServiceRecordFile,
    ) -> Self {
        let previous = lock(&service.process_record_file).replace(record_file);
        Self {
            service,
            previous,
            is_kept: false,
        }
    }

    /// Keeps the published name while the process the attempt brought up lives, and answers the
    /// name before it, which a teardown puts back once it stopped that process.
    pub(super) fn hand_back(mut self) -> EarlierRecordFile {
        self.is_kept = true;
        EarlierRecordFile(self.previous.take())
    }
}

/// The name a launch or join published its own over, held while the process it brought up lives,
/// so a daemon stop until then leaves that process to the service's own stop alone.
pub(super) struct EarlierRecordFile(Option<LastingServiceRecordFile>);

impl EarlierRecordFile {
    /// Puts the name back on `service`, once the process was stopped.
    pub(super) fn restore(self, service: &CodexService) {
        service.set_process_record_file(self.0);
    }
}

impl Drop for PublishedRecordFile<'_> {
    fn drop(&mut self) {
        if !self.is_kept {
            self.service.set_process_record_file(self.previous.take());
        }
    }
}

/// The record file of the lasting service on the socket `service` dials, where a start of it
/// records the process it launches. Fails as [`LastingServiceRecordFile::of_socket`] does.
pub(crate) fn socket_record_file(service: &CodexService) -> io::Result<LastingServiceRecordFile> {
    LastingServiceRecordFile::of_socket(
        &service.dependencies().data_folder,
        &service.home().codex_home,
        service.socket_path(),
    )
}

/// The record files a daemon stop leaves to `services`, which the kept stop skips: the record of
/// each of the daemon's own services, which its supervisor stops, the one a launch or a join under
/// way publishes first among them, and a joined service's, left alone because the daemon never
/// stops it. Each service's socket's record is among them too; a record whose Codex folder no
/// longer resolves cannot be named, so the kept stop takes it.
pub(super) fn live_record_files(
    services: &[Arc<CodexService>],
) -> HashSet<LastingServiceRecordFile> {
    services
        .iter()
        .flat_map(|service| {
            [
                service.process_record_file(),
                socket_record_file(service).ok(),
            ]
        })
        .flatten()
        .collect()
}

/// Retires the record of the process `service`'s last start brought up, else of its own socket,
/// once that process has ended and nothing starts it again. Fails as the record's lock or its
/// retire does.
pub(super) async fn retire_own_record(service: &CodexService) -> Result<(), CodexError> {
    let socket = service.socket_path().to_owned();
    let locked = lock_record(own_record_file(service)?)
        .await
        .map_err(|failure| failure.error)?;
    retire_kept_record(&locked, &socket)
        .await
        .map_err(|failure| failure.error)
}

/// Marks the record of `service`'s lasting process replaced, as a service started beside it on
/// an account's home takes its place, so a daemon restarted before it is retired joins that one
/// and drains this one; a missing record is left missing. Fails as the record's name, lock, read
/// or write does.
pub(crate) async fn mark_own_record_replaced(service: &CodexService) -> Result<(), CodexError> {
    let locked = lock_record(own_record_file(service)?)
        .await
        .map_err(|failure| failure.error)?;
    on_record(&locked, |locked| {
        let Some(mut record) = locked.read()? else {
            return Ok(());
        };
        record.is_replaced = true;
        locked.write(&record)
    })
    .await
    .map_err(|error| CodexError::Transport {
        detail: "The replaced Codex service's record could not be marked.".to_owned(),
        cause: Some(Box::new(error)),
    })
}

// The record file of the process `service`'s last start brought up, else of its own socket.
fn own_record_file(service: &CodexService) -> Result<LastingServiceRecordFile, CodexError> {
    match service.process_record_file() {
        Some(record_file) => Ok(record_file),
        None => socket_record_file(service).map_err(|error| CodexError::Transport {
            detail: "The Codex service's record could not be named.".to_owned(),
            cause: Some(Box::new(error)),
        }),
    }
}

/// Retires the record `service`'s last process was kept in, under the start's hold `locked` of
/// the home socket's record, where that is another record; the home socket's own is left to the
/// caller. Fails as the record's retire does.
pub(super) async fn retire_last_process_record(
    service: &CodexService,
    locked: &LockedServiceRecord,
    socket: &Path,
) -> Result<(), StartFailure> {
    if let Some(last) = service.process_record_file()
        && last != *locked.file()
    {
        retire_kept_record(&Arc::new(locked.sibling(last)), socket).await?;
    }
    Ok(())
}
