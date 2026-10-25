//! What a terminal service's start does with the records lasting services left on its Codex
//! folder, all read under the folder's one lock: a service still running is found again by its
//! record, and one gone has what it left ended and its record removed, so a fresh start leaves no
//! tree of a former one running. The service's first start joins the running service that holds
//! the home's link, or with none, points the link under Codex's start lock at a running one not
//! draining, the home's own first, and drains every other; a later start reads only its own. With
//! nothing joined, a drain on the home's own socket is launched beside where the home's path is a
//! link, and waited for where it is the socket itself.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use sidekicks_platforms::{CAN_LINK_A_SOCKET, ProcessRecord, read_socket_link};
use tokio::time::Instant;

use crate::provider::driver::codex::service::process::{
    LastingCodexService, codex_lasting_service_environment_entry, repin_lasting_codex_service,
};
use crate::provider::driver::codex::service::record::{
    LastingServiceRecord, LastingServiceRecordFile, LockedServiceRecord,
};
use crate::provider::driver::codex::service::socket_link::{
    clear_socket_link_of, is_listening, restore_socket_link,
};
use crate::provider::driver::codex::service::supervisor::CodexService;
use crate::provider::driver::codex::service::supervisor::drain::{
    LastingServiceDrainWatch, read_drain_end,
};
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
        /// The service, boxed as the larger arm by far.
        lasting: Box<LastingCodexService>,
        /// Its record's file.
        record_file: LastingServiceRecordFile,
        /// Where its record says its socket really is, which the join dials.
        physical_socket: PathBuf,
    },
    /// No former service is joined, and none holds the home's own socket: the start goes on to
    /// the folder's socket.
    LaunchOnHome,
    /// No former service is joined, and one draining holds the home's own socket until it ends:
    /// the start launches beside it on a socket of its own and moves the home's link there.
    LaunchBeside,
}

// A drain on a socket a launch on the home's own would meet: the home socket's own record's, or
// the one on the socket the home's link names.
struct LaunchBlockingDrain {
    is_home_record: bool,
    physical_socket: Option<PathBuf>,
    end: LastingServiceDrainWatch,
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
pub(in super::super) async fn on_record<Answer: Send + 'static>(
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

// The socket a running record must be recorded on to hold the home's link, whose target is
// `link_target`: that target, or where the system holds no link, `home_socket` itself, which is
// then the socket the one service on it binds.
fn find_holder_socket(
    link_target: Option<PathBuf>,
    home_socket: &Path,
    can_link_a_socket: bool,
) -> Option<PathBuf> {
    link_target.or_else(|| (!can_link_a_socket).then(|| home_socket.to_owned()))
}

// Which of `records` holds the home's link: the one not draining recorded on `holder_socket`.
fn find_link_holder<'record>(
    records: impl IntoIterator<Item = &'record LastingServiceRecord>,
    holder_socket: Option<&Path>,
) -> Option<usize> {
    let holder_socket = holder_socket?;
    records.into_iter().position(|record| {
        !record.is_draining && record.physical_socket.as_deref() == Some(holder_socket)
    })
}

/// The first start of the home's service settles every record its folder keeps, under the start's
/// own hold `locked`, the home socket's record: one whose service ended is retired; the running
/// service that holds the home's link is joined, or with none, the link is pointed at a running
/// one not draining and that one is joined; every other running one drains. With none joined, a
/// launch past the drains on the home's own socket or on the socket the link reaches is settled
/// by [`settle_launch_blocking_drains`]. Fails as a record's read, re-pin, retire or drain fails,
/// as the link's read or move fails, and past `deadline`.
pub(super) async fn reconcile_kept_records(
    service: &CodexService,
    locked: &Arc<LockedServiceRecord>,
    deadline: Instant,
) -> Result<KeptRecordsOutcome, StartFailure> {
    let mut running = Vec::new();
    let mut ended_services = Vec::new();
    for (kept_locked, record) in read_kept_records(locked).await? {
        if let Some(lasting) = repin(record.process.clone()).await? {
            running.push(RunningRecord {
                locked: kept_locked,
                record,
                lasting,
            });
        } else {
            ended_services.push(record.process.clone());
            retire_former_service(&kept_locked, record.process).await?;
        }
    }
    let link_target = read_socket_link(service.socket_path()).map_err(|error| {
        start_failed("The Codex folder's socket link could not be read.", error)
    })?;
    let holder_socket = find_holder_socket(
        link_target.clone(),
        service.socket_path(),
        CAN_LINK_A_SOCKET,
    );
    let holder = find_link_holder(
        running.iter().map(|running| &running.record),
        holder_socket.as_deref(),
    );
    let joined = match holder {
        Some(holder) => Some(holder),
        None => {
            restore_link_to_running(service, &running, &ended_services, locked.file(), deadline)
                .await?
        }
    };
    let is_link_unrecorded = link_target.is_some()
        && !running
            .iter()
            .any(|running| running.record.physical_socket == link_target);
    let mut joined_service = None;
    let mut launch_blocking_drains = Vec::new();
    for (index, running) in running.into_iter().enumerate() {
        if Some(index) == joined {
            joined_service = Some(running);
            continue;
        }
        let is_home_record = running.locked.file() == locked.file();
        let is_on_link = running.record.physical_socket.is_some()
            && running.record.physical_socket == holder_socket;
        let end =
            drain_running_record(service, running.locked, running.lasting, &running.record).await?;
        if is_home_record || is_on_link {
            launch_blocking_drains.push(LaunchBlockingDrain {
                is_home_record,
                physical_socket: running.record.physical_socket,
                end,
            });
        }
    }
    if let Some(joined) = joined_service {
        return Ok(KeptRecordsOutcome::Join {
            physical_socket: joined
                .record
                .physical_socket
                .expect("a joined record names its socket, as the holder and the restore require"),
            record_file: joined.locked.file().clone(),
            lasting: Box::new(joined.lasting),
        });
    }
    settle_launch_blocking_drains(
        service,
        launch_blocking_drains,
        is_link_unrecorded,
        deadline,
    )
    .await
}

/// A later start of the home's service reads only its own records, under the start's own hold
/// `locked`, the home socket's record: the one its last process was kept in is retired, and the
/// home socket's own is retired too, or while it drains, settled by
/// [`settle_launch_blocking_drains`], since it holds that socket until it ends. Fails as a record's
/// read, re-pin, retire or drain fails, and past `deadline`.
pub(super) async fn settle_own_records(
    service: &CodexService,
    locked: &Arc<LockedServiceRecord>,
    deadline: Instant,
) -> Result<KeptRecordsOutcome, StartFailure> {
    let socket = service.socket_path();
    if let Some(last) = service.process_record_file()
        && last != *locked.file()
    {
        retire_kept_record(&Arc::new(locked.sibling(last)), socket).await?;
    }
    if let Some(record) = read_record(locked).await?
        && record.is_draining
        && let Some(lasting) = repin(record.process.clone()).await?
    {
        let end = drain_running_record(service, Arc::clone(locked), lasting, &record).await?;
        let link_target = read_socket_link(socket).map_err(|error| {
            start_failed("The Codex folder's socket link could not be read.", error)
        })?;
        let is_link_unrecorded = link_target.is_some() && link_target != record.physical_socket;
        let drain = LaunchBlockingDrain {
            is_home_record: true,
            physical_socket: record.physical_socket,
            end,
        };
        return settle_launch_blocking_drains(service, vec![drain], is_link_unrecorded, deadline)
            .await;
    }
    retire_kept_record(locked, socket).await?;
    Ok(KeptRecordsOutcome::LaunchOnHome)
}

// Drains the running service `lasting`, whose record `record` is kept under `locked`, through the
// driver's drains, over its recorded socket where it takes no signal. Fails as the drain does.
async fn drain_running_record(
    service: &CodexService,
    locked: Arc<LockedServiceRecord>,
    lasting: LastingCodexService,
    record: &LastingServiceRecord,
) -> Result<LastingServiceDrainWatch, StartFailure> {
    let control_socket = record
        .physical_socket
        .clone()
        .unwrap_or_else(|| service.socket_path().to_owned());
    service
        .dependencies()
        .drains
        .drain(&locked, lasting, &control_socket)
        .await
        .map_err(|error| start_failed("A former Codex service could not be asked to drain.", error))
}

// With nothing joined, settles the drains a launch on the home's own socket would meet. Where the
// home's path is a link, nothing is waited for: a drain on the home's own socket is launched
// beside, unless a listener no record names answers through the link, `is_link_unrecorded`, which
// the folder's socket path joins; and the link is taken off a drain on a socket of its own under
// Codex's start lock, so the home's socket is free at once. Where the path is the socket itself,
// each drain is waited for until `deadline`. Fails as the start lock, the link's move or the
// socket's probe fails, and past `deadline`.
async fn settle_launch_blocking_drains(
    service: &CodexService,
    drains: Vec<LaunchBlockingDrain>,
    is_link_unrecorded: bool,
    deadline: Instant,
) -> Result<KeptRecordsOutcome, StartFailure> {
    if drains.is_empty() {
        return Ok(KeptRecordsOutcome::LaunchOnHome);
    }
    if !CAN_LINK_A_SOCKET {
        for drain in drains {
            wait_for_drain_end(drain.end, deadline).await?;
        }
        return Ok(KeptRecordsOutcome::LaunchOnHome);
    }
    if drains.iter().any(|drain| drain.is_home_record) {
        let is_unrecorded_listening = is_link_unrecorded
            && is_listening(service.socket_path()).await.map_err(|error| {
                start_failed("The Codex folder's socket could not be reached.", error)
            })?;
        return Ok(if is_unrecorded_listening {
            KeptRecordsOutcome::LaunchOnHome
        } else {
            KeptRecordsOutcome::LaunchBeside
        });
    }
    let remaining = deadline.saturating_duration_since(Instant::now());
    let start_lock = take_start_lock(&service.home().codex_home, remaining).await?;
    let home_socket = service.socket_path().to_owned();
    let draining_sockets: Vec<PathBuf> = drains
        .into_iter()
        .filter_map(|drain| drain.physical_socket)
        .collect();
    tokio::task::spawn_blocking(move || {
        for draining_socket in draining_sockets {
            clear_socket_link_of(&home_socket, &draining_socket)?;
        }
        Ok::<_, io::Error>(())
    })
    .await
    .map_err(io::Error::other)
    .and_then(|cleared| cleared)
    .map_err(|error| {
        start_failed(
            "The Codex folder's socket link could not be taken off a draining service.",
            error,
        )
    })?;
    // A plain `codex` that waited on the lock finds the home's socket free.
    drop(start_lock);
    Ok(KeptRecordsOutcome::LaunchOnHome)
}

// With no running service holding the home's link, points it under Codex's start lock at a
// running one not draining whose socket is recorded, the home socket's own `own` first, never over
// a service answering on it unless it is one of `ended_services`, the processes the records showed
// ended; answers which of `running` it names, `None` where none can take it or another service
// answers on it.
async fn restore_link_to_running(
    service: &CodexService,
    running: &[RunningRecord],
    ended_services: &[ProcessRecord],
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
    let is_pointed = restore_socket_link(service.socket_path(), physical_socket, ended_services)
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

// Waits until `deadline` for the end of a drain on the socket the launch would meet, which the
// service holds until it ends. Fails past the deadline, naming the running reply still finishing.
async fn wait_for_drain_end(
    end: LastingServiceDrainWatch,
    deadline: Instant,
) -> Result<(), StartFailure> {
    match tokio::time::timeout_at(deadline, read_drain_end(end)).await {
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

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use rstest::rstest;
    use sidekicks_platforms::ProcessRecord;

    use super::{find_holder_socket, find_link_holder};
    use crate::provider::driver::codex::service::record::LastingServiceRecord;

    const HOME: &str = "/home/app-server-control/app-server-control.sock";
    const OWN: &str = "/sockets/own";

    // A record of a running service recorded on `socket`, draining when `is_draining`.
    fn recorded(socket: &str, is_draining: bool) -> LastingServiceRecord {
        let process: ProcessRecord =
            serde_json::from_str(r#"{"id":1,"start":1,"boot":"b"}"#).expect("the record reads");
        LastingServiceRecord {
            process,
            physical_socket: Some(PathBuf::from(socket)),
            is_draining,
        }
    }

    // Fails when the holder is read from the link alone, which on a system with no link, where
    // the home's path is the socket itself, never finds the running service on it, so a daemon's
    // restart drains it instead of joining it; or when a draining record holds the link.
    #[rstest]
    #[case::the_link_names_the_service(Some(OWN), true, &[(HOME, false), (OWN, false)], Some(1))]
    #[case::no_link_where_links_are_made(None, true, &[(HOME, false)], None)]
    #[case::no_link_where_the_path_is_the_socket(None, false, &[(HOME, false)], Some(0))]
    #[case::the_service_on_the_path_drains(None, false, &[(HOME, true)], None)]
    #[case::the_service_the_link_names_drains(Some(OWN), true, &[(HOME, false), (OWN, true)], None)]
    fn the_link_holder_is_the_running_service_the_link_or_the_path_reaches(
        #[case] link_target: Option<&str>,
        #[case] can_link_a_socket: bool,
        #[case] records: &[(&str, bool)],
        #[case] holder: Option<usize>,
    ) {
        let records: Vec<LastingServiceRecord> = records
            .iter()
            .map(|(socket, is_draining)| recorded(socket, *is_draining))
            .collect();

        let holder_socket = find_holder_socket(
            link_target.map(PathBuf::from),
            Path::new(HOME),
            can_link_a_socket,
        );

        assert_eq!(find_link_holder(&records, holder_socket.as_deref()), holder);
    }
}
