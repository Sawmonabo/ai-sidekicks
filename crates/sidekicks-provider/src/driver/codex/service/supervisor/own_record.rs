//! The record file a service names as its own lasting process's: the name a start publishes and
//! a daemon stop reads, the socket's record it falls back on, its retire once that process ended,
//! and a later start's retire of the record its last process was kept in.

use std::io;
use std::path::Path;
use std::sync::Arc;

use sidekicks_std::mutex_lock::lock;

use crate::driver::codex::service::record::{LastingServiceRecordFile, LockedServiceRecord};
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::service::supervisor::start::StartFailure;
use crate::driver::codex::service::supervisor::start::kept_records::{
    lock_record, retire_kept_record,
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

/// The record file a launch or a join publishes on its service for as long as it can succeed:
/// unless it is kept, the name published before it comes back once it fails or is dropped, so a
/// retire and the next start act on the service's own record.
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

    /// Keeps the published name once the attempt succeeded.
    pub(super) fn keep(mut self) {
        self.is_kept = true;
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

/// Retires the record of the process `service`'s last start brought up, else of its own socket,
/// once that process has ended and nothing starts it again. Fails as the record's lock or its
/// retire does.
pub(super) async fn retire_own_record(service: &CodexService) -> Result<(), CodexError> {
    let socket = service.socket_path().to_owned();
    let record_file = match service.process_record_file() {
        Some(record_file) => record_file,
        None => socket_record_file(service).map_err(|error| CodexError::Transport {
            detail: "The Codex service's record could not be named.".to_owned(),
            cause: Some(Box::new(error)),
        })?,
    };
    let locked = lock_record(record_file)
        .await
        .map_err(|failure| failure.error)?;
    retire_kept_record(&locked, &socket)
        .await
        .map_err(|failure| failure.error)
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
