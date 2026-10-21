//! What a terminal service's start does with the records lasting services left on its Codex
//! folder, all read under the folder's one lock: a service still running is found again by its
//! record, and one gone has what it left ended and its record removed, so a fresh start leaves no
//! tree of a former one running. The service's first start joins the running service the home's
//! link names, or with none, points the link under Codex's start lock at a running one not
//! draining, the home's own first, and drains every other; a later start reads only its own.

use std::io;
use std::path::Path;
use std::sync::Arc;

use sidekicks_platforms::{ProcessRecord, read_socket_link};
use tokio::sync::oneshot;
use tokio::time::Instant;

use crate::provider::driver::codex::service::process::{
    LastingCodexService, codex_lasting_service_environment_entry, repin_lasting_codex_service,
};
use crate::provider::driver::codex::service::record::{
    LastingServiceRecord, LastingServiceRecordFile, LockedServiceRecord,
};
use crate::provider::driver::codex::service::socket_link::restore_socket_link;
use crate::provider::driver::codex::service::supervisor::CodexService;
use crate::provider::driver::codex::service::supervisor::drain::drain_in_background;
use crate::provider::driver::codex::service::supervisor::runner::SERVICE_STOP_GRACE;
use crate::provider::driver::codex::service::supervisor::start::{
    StartFailure, start_failed, take_start_lock,
};
use crate::provider::driver::codex::session::errors::CodexError;

// One record kept for the folder, held under the folder's lock, with what it keeps.
type KeptRecord = (Arc<LockedServiceRecord>, LastingServiceRecord);

/// What a home service's start does once it settled the folder's records.
pub(super) enum KeptRecordsOutcome {
    /// It joins a former daemon's running service, whose record `record_file` keeps.
    Join {
        /// The service.
        lasting: LastingCodexService,
        /// Its record's file.
        record_file: LastingServiceRecordFile,
    },
    /// No former service is joined: the start goes on to the folder's socket.
    NoFormerService,
}

// A kept record whose service still runs.
struct RunningRecord {
    locked: Arc<LockedServiceRecord>,
    record: LastingServiceRecord,
    lasting: LastingCodexService,
}

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

// The lasting service `record` names while it still runs, read from the process table on the
// blocking pool; `None` once it has ended. Fails when the process table cannot be read.
async fn repin(record: ProcessRecord) -> Result<Option<LastingCodexService>, StartFailure> {
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
/// still runs, or what it left is ended where it is gone, and the record goes either way; one
/// draining is left to its drain, which removes it. Fails as the read, the re-pin or the removal
/// does.
pub(super) async fn retire_kept_record(
    locked: &Arc<LockedServiceRecord>,
    control_socket: &Path,
) -> Result<(), StartFailure> {
    let Some(record) = read_record(locked).await? else {
        return Ok(());
    };
    let Some(lasting) = repin(record.process.clone()).await? else {
        return retire_former_service(locked, record.process).await;
    };
    if record.is_draining {
        return Ok(());
    }
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

/// Retires the record of the process `service`'s last start brought up, else of its own socket,
/// once that process has ended and nothing starts it again. Fails as the record's lock or its
/// retire does.
pub(in super::super) async fn retire_own_record(service: &CodexService) -> Result<(), CodexError> {
    let socket = service.socket_path().to_owned();
    let record_file = match service.process_record_file() {
        Some(record_file) => record_file,
        None => LastingServiceRecordFile::of_socket(
            &service.dependencies().data_folder,
            &service.home().codex_home,
            &socket,
        )
        .map_err(|error| CodexError::Transport {
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

// Every record kept for the folder's services under the start's own hold `own`: its own first,
// then every other, each under the same hold. Fails as a record's read fails.
async fn read_kept_records(
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

// The record `locked` holds, `None` when none is kept.
async fn read_record(
    locked: &Arc<LockedServiceRecord>,
) -> Result<Option<LastingServiceRecord>, StartFailure> {
    on_record(locked, LockedServiceRecord::read)
        .await
        .map_err(|error| start_failed("The Codex service's record could not be read.", error))
}

/// The first start of the home's service settles every record its folder keeps, under the start's
/// own hold `locked`, the home socket's record: one whose service ended is retired; the running
/// service the home's link names is joined, or with none, the link is pointed at a running one
/// not draining and that one is joined; every other running one drains. With none joined, each
/// draining one on the home's own socket or on the socket the link reaches is waited for until
/// `deadline`, since a launch would meet it there until it ends. Fails as a record's read, re-pin
/// or retire fails, as the link's read or move fails, and past `deadline`.
pub(super) async fn reconcile_kept_records(
    service: &CodexService,
    locked: &Arc<LockedServiceRecord>,
    deadline: Instant,
) -> Result<KeptRecordsOutcome, StartFailure> {
    let mut running = Vec::new();
    for (kept_locked, record) in read_kept_records(locked).await? {
        match repin(record.process.clone()).await? {
            Some(lasting) => running.push(RunningRecord {
                locked: kept_locked,
                record,
                lasting,
            }),
            None => retire_former_service(&kept_locked, record.process).await?,
        }
    }
    let link_target = read_socket_link(service.socket_path()).map_err(|error| {
        start_failed("The Codex folder's socket link could not be read.", error)
    })?;
    let holder = running.iter().position(|running| {
        !running.record.is_draining
            && running.record.physical_socket.is_some()
            && running.record.physical_socket == link_target
    });
    let joined = match holder {
        Some(holder) => Some(holder),
        None => restore_link_to_running(service, &running, locked.file(), deadline).await?,
    };
    let mut joined_service = None;
    let mut launch_blocking_drains = Vec::new();
    for (index, running) in running.into_iter().enumerate() {
        if Some(index) == joined {
            joined_service = Some((running.lasting, running.locked.file().clone()));
            continue;
        }
        let blocks_launch = running.locked.file() == locked.file()
            || (running.record.physical_socket.is_some()
                && running.record.physical_socket == link_target);
        let end = drain_in_background(&service.drains, &running.locked, running.lasting)
            .await
            .map_err(|error| {
                start_failed("A former Codex service could not be asked to drain.", error)
            })?;
        if blocks_launch {
            launch_blocking_drains.push(end);
        }
    }
    if let Some((lasting, record_file)) = joined_service {
        return Ok(KeptRecordsOutcome::Join {
            lasting,
            record_file,
        });
    }
    for end in launch_blocking_drains {
        wait_for_drain_end(end, deadline).await?;
    }
    Ok(KeptRecordsOutcome::NoFormerService)
}

/// A later start of the home's service reads only its own records, under the start's own hold
/// `locked`, the home socket's record: the one its last process was kept in is retired, and the
/// home socket's own is retired too, or waited for until `deadline` while it drains, since it
/// holds that socket until it ends. Fails as a record's read, re-pin or retire fails, and past
/// `deadline`.
pub(super) async fn settle_own_records(
    service: &CodexService,
    locked: &Arc<LockedServiceRecord>,
    deadline: Instant,
) -> Result<(), StartFailure> {
    let socket = service.socket_path();
    if let Some(last) = service.process_record_file()
        && last != *locked.file()
    {
        retire_kept_record(&Arc::new(locked.sibling(last)), socket).await?;
    }
    if let Some(record) = read_record(locked).await?
        && record.is_draining
        && let Some(lasting) = repin(record.process).await?
    {
        let end = drain_in_background(&service.drains, locked, lasting)
            .await
            .map_err(|error| {
                start_failed("A former Codex service could not be asked to drain.", error)
            })?;
        return wait_for_drain_end(end, deadline).await;
    }
    retire_kept_record(locked, socket).await
}

// With no running service holding the home's link, points it under Codex's start lock at a
// running one not draining whose socket is recorded, the home socket's own `own` first, never over
// a service answering on it; answers which of `running` it names, `None` where none can take it or
// another service answers on it.
async fn restore_link_to_running(
    service: &CodexService,
    running: &[RunningRecord],
    own: &LastingServiceRecordFile,
    deadline: Instant,
) -> Result<Option<usize>, StartFailure> {
    let Some((index, physical_socket)) = running
        .iter()
        .enumerate()
        .filter(|(_index, running)| !running.record.is_draining)
        .filter_map(|(index, running)| {
            let physical_socket = running.record.physical_socket.as_ref()?;
            Some((index, physical_socket, running.locked.file() != own))
        })
        .min_by_key(|(_index, _physical_socket, is_other)| *is_other)
        .map(|(index, physical_socket, _is_other)| (index, physical_socket))
    else {
        return Ok(None);
    };
    let remaining = deadline.saturating_duration_since(Instant::now());
    let start_lock = take_start_lock(&service.home().codex_home, remaining).await?;
    let is_pointed = restore_socket_link(service.socket_path(), physical_socket)
        .await
        .map_err(|error| {
            start_failed(
                "The Codex folder's socket link could not be pointed at its running service.",
                error,
            )
        })?;
    // A plain `codex` that waited on the lock reads the link once it is free.
    drop(start_lock);
    Ok(is_pointed.then_some(index))
}

// Waits until `deadline` for the end of a drain on a socket the launch would meet, which the
// service holds until it ends. Fails past the deadline, naming the running reply still finishing.
async fn wait_for_drain_end(
    end: oneshot::Receiver<()>,
    deadline: Instant,
) -> Result<(), StartFailure> {
    match tokio::time::timeout_at(deadline, end).await {
        // A drain that failed was reported and one called off ends with the daemon; either way
        // the launch then finds whether the socket is free.
        Ok(_ended_or_given_up) => Ok(()),
        Err(elapsed) => Err(StartFailure::from(CodexError::Transport {
            detail: "The Codex folder's socket is held by a former service still finishing its \
                     running replies."
                .to_owned(),
            cause: Some(Box::new(elapsed)),
        })),
    }
}
