//! What a terminal service's start does with the records lasting services left on its Codex
//! folder, all read under the folder's one lock: a service still running is found again by its
//! record, and one gone has what it left ended and its record removed, so a fresh start leaves no
//! tree of a former one running.

use std::io;
use std::path::Path;
use std::sync::Arc;

use sidekicks_platforms::{ProcessRecord, read_socket_link};

use crate::provider::driver::codex::service::process::{
    LastingCodexService, codex_lasting_service_environment_entry, repin_lasting_codex_service,
};
use crate::provider::driver::codex::service::record::{
    LastingServiceRecordFile, LockedServiceRecord,
};
use crate::provider::driver::codex::service::supervisor::CodexService;
use crate::provider::driver::codex::service::supervisor::runner::SERVICE_STOP_GRACE;
use crate::provider::driver::codex::service::supervisor::start::{StartFailure, start_failed};
use crate::provider::driver::codex::session::errors::CodexError;

/// One record kept for the folder, held under the folder's lock, with what it names.
pub(super) type KeptRecord = (Arc<LockedServiceRecord>, ProcessRecord);

/// Takes the lock of the folder's records for `record_file` on the blocking pool. Fails as the
/// lock does.
pub(super) async fn lock_record(
    record_file: LastingServiceRecordFile,
) -> Result<Arc<LockedServiceRecord>, StartFailure> {
    tokio::task::spawn_blocking(move || record_file.lock())
        .await
        .map_err(io::Error::other)
        .and_then(|locked| locked)
        .map(Arc::new)
        .map_err(|error| start_failed("The Codex service's record could not be locked.", error))
}

/// Runs `access` on the held record on the blocking pool, since each reads or writes a file.
pub(super) async fn on_record<Answer: Send + 'static>(
    locked: &Arc<LockedServiceRecord>,
    access: impl FnOnce(&LockedServiceRecord) -> io::Result<Answer> + Send + 'static,
) -> io::Result<Answer> {
    let locked = Arc::clone(locked);
    tokio::task::spawn_blocking(move || access(&locked))
        .await
        .map_err(io::Error::other)?
}

/// The lasting service `record` names while it still runs, read from the process table on the
/// blocking pool; `None` once it has ended. Fails when the process table cannot be read.
pub(super) async fn repin(
    record: ProcessRecord,
) -> Result<Option<LastingCodexService>, StartFailure> {
    tokio::task::spawn_blocking(move || repin_lasting_codex_service(record))
        .await
        .map_err(io::Error::other)
        .and_then(|repinned| repinned)
        .map_err(|error| start_failed("The Codex service could not be found again.", error))
}

/// Lets go of a former lasting service its record no longer pins: ends what it left running, then
/// removes the record, so the fresh start that follows leaves no tree of the former one running.
/// Fails when the record cannot be removed.
pub(super) async fn retire_former_service(
    locked: &Arc<LockedServiceRecord>,
    record: ProcessRecord,
) -> Result<(), StartFailure> {
    let entry = codex_lasting_service_environment_entry();
    let ended = tokio::task::spawn_blocking(move || record.end_survivors(&entry)).await;
    if let Err(error) = ended.map_err(io::Error::other).and_then(|ended| ended) {
        tracing::warn!(
            error = &error as &(dyn std::error::Error + 'static),
            "what a former Codex service left running could not be ended"
        );
    }
    on_record(locked, LockedServiceRecord::remove)
        .await
        .map_err(|error| start_failed("The Codex service's record could not be removed.", error))
}

/// Retires the record `locked` holds, when one is kept: the service it names is stopped where it
/// still runs, or what it left is ended where it is gone, and the record goes either way. Fails as
/// the read, the re-pin or the removal does.
pub(super) async fn retire_kept_record(
    locked: &Arc<LockedServiceRecord>,
    control_socket: &Path,
) -> Result<(), StartFailure> {
    let Some(record) = on_record(locked, LockedServiceRecord::read)
        .await
        .map_err(|error| start_failed("The Codex service's record could not be read.", error))?
    else {
        return Ok(());
    };
    let Some(lasting) = repin(record.clone()).await? else {
        return retire_former_service(locked, record).await;
    };
    if let Err(error) = lasting.stop(SERVICE_STOP_GRACE, control_socket).await {
        tracing::warn!(
            error = &error as &(dyn std::error::Error + 'static),
            "a former Codex service could not be stopped"
        );
    }
    on_record(locked, LockedServiceRecord::remove)
        .await
        .map_err(|error| start_failed("The Codex service's record could not be removed.", error))
}

/// Retires the record kept for `service`'s own socket once its process has ended and nothing
/// starts it again. Fails as the record's lock or its retire does.
pub(in super::super) async fn retire_own_record(service: &CodexService) -> Result<(), CodexError> {
    let socket = service.socket_path().to_owned();
    let record_file = LastingServiceRecordFile::of_socket(
        &service.dependencies().data_folder,
        &service.home().codex_home,
        &socket,
    )
    .map_err(|error| start_failed("The Codex service's record could not be named.", error).error)?;
    let locked = lock_record(record_file)
        .await
        .map_err(|failure| failure.error)?;
    retire_kept_record(&locked, &socket)
        .await
        .map_err(|failure| failure.error)
}

/// Every record kept for the folder's services under the start's own hold `own`: its own first,
/// then every other, each under the same hold. Fails as a record's read fails.
pub(super) async fn read_kept_records(
    own: &Arc<LockedServiceRecord>,
) -> Result<Vec<KeptRecord>, StartFailure> {
    let held = Arc::clone(own);
    tokio::task::spawn_blocking(move || {
        let mut kept = Vec::new();
        if let Some(record) = held.read()? {
            kept.push((Arc::clone(&held), record));
        }
        for other in held.others()? {
            if let Some(record) = other.read()? {
                kept.push((Arc::new(other), record));
            }
        }
        Ok::<_, io::Error>(kept)
    })
    .await
    .map_err(io::Error::other)
    .and_then(|kept| kept)
    .map_err(|error| start_failed("The Codex services' records could not be read.", error))
}

/// Which of `kept` is the service the home's link at `home_socket` reaches: the one on a socket of
/// its own whose link names the same real socket, else the record of the home's own socket, the
/// link never moved off it. Blocking. Fails with a link's read error.
pub(super) fn find_link_holder(
    kept: &[KeptRecord],
    home_socket: &Path,
) -> io::Result<Option<usize>> {
    let home_target = read_socket_link(home_socket)?;
    let control_folder = home_socket
        .parent()
        .expect("the home's socket sits in its control folder");
    let home_name = home_socket
        .file_name()
        .expect("the home's socket has a name")
        .to_string_lossy();
    let mut home_record = None;
    for (index, (locked, _record)) in kept.iter().enumerate() {
        let name = locked.file().socket_name();
        if name == home_name {
            home_record = Some(index);
        } else if home_target.is_some()
            && read_socket_link(&control_folder.join(&name))? == home_target
        {
            return Ok(Some(index));
        }
    }
    Ok(home_record)
}
