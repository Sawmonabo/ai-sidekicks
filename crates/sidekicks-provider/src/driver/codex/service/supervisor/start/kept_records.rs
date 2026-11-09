//! What a lasting service's start does with the records lasting services left on its Codex
//! folder, all read under the folder's one lock: a service still running is found again by its
//! record, and one gone has what it left ended and its record removed, so a fresh start leaves no
//! tree of a former one running. A terminal service's first start joins the running service that
//! holds the home's link, or with none, points the link under Codex's start lock at a running one
//! not draining, the home's own first, and drains every other; a later start reads only its own.
//! With nothing joined, a drain on the home's own socket is launched beside where the home's path
//! is a link, and waited for where it is the socket itself. An account home's start joins the one
//! service its record keeps running. A daemon stop that ends work in flight stops every service a
//! record still keeps that none of its live services holds. The erase of the daemon's data, with
//! no daemon running, ends every service a record names, a draining one too, and answers every
//! failure rather than logging it. Ending the turns a restart kept only reads where a kept service
//! listens.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures::future::join_all;
use sidekicks_platforms::{CAN_LINK_A_SOCKET, ProcessRecord, read_socket_link};
use tokio::time::Instant;

use crate::driver::codex::service::process::{
    LastingCodexService, codex_lasting_service_environment_entry, repin_lasting_codex_service,
};
use crate::driver::codex::service::record::{
    KeptLaunchTelemetry, LastingServiceRecord, LastingServiceRecordFile, LockedServiceRecord,
    one_recorded_file_per_folder,
};
use crate::driver::codex::service::socket_link::{
    clear_socket_link_of, is_listening, restore_socket_link,
};
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::service::supervisor::drain::{LastingServiceDrainWatch, read_drain_end};
use crate::driver::codex::service::supervisor::own_record::{
    live_record_files, retire_last_process_record, socket_record_file,
};
use crate::driver::codex::service::supervisor::runner::{SERVICE_STOP_GRACE, stop_grace_by};
use crate::driver::codex::service::supervisor::start::{
    StartFailure, start_failed, take_start_lock,
};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::daemon_stop::run_until;

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
pub(in super::super) async fn lock_record(
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

// What one kept record's end came to: each failure that left its service, or a process a gone one
// left, running though its record goes, and the record's own outcome.
struct KeptRecordEnd {
    unended: Vec<CodexError>,
    settled: Result<(), StartFailure>,
}

impl KeptRecordEnd {
    // An end that stopped nothing: the record's outcome alone.
    fn settled_only(settled: Result<(), StartFailure>) -> Self {
        Self {
            unended: Vec::new(),
            settled,
        }
    }

    // The record's outcome, with each service or process it could not end logged, as a start and
    // the daemon's stop do, since it runs on with no record to answer for it.
    fn reported(self) -> Result<(), StartFailure> {
        for error in &self.unended {
            tracing::warn!(
                error = error as &(dyn std::error::Error + 'static),
                "a former Codex service, or what it left running, could not be ended"
            );
        }
        self.settled
    }

    // Every failure the end met, for a caller that answers each.
    fn into_failures(self) -> impl Iterator<Item = CodexError> {
        self.unended
            .into_iter()
            .chain(self.settled.err().map(|failure| failure.error))
    }
}

/// Lets go of a former lasting service its record no longer pins: ends what it left running and
/// takes the home's link off its socket, then removes the record, so the fresh start that follows
/// leaves no tree of the former one running; what it left that cannot be ended, and a link that
/// cannot be taken off, is logged. Fails when the record cannot be removed.
pub(super) async fn retire_former_service(
    locked: &Arc<LockedServiceRecord>,
    record: LastingServiceRecord,
) -> Result<(), StartFailure> {
    end_former_service(locked, record).await.reported()
}

// Ends what the former service `record` names left running and takes the home's link off its
// socket, then removes its record held under `locked`.
async fn end_former_service(
    locked: &Arc<LockedServiceRecord>,
    record: LastingServiceRecord,
) -> KeptRecordEnd {
    const LEFT_RUNNING: &str = "What a former Codex service left running could not be ended.";
    let entry = codex_lasting_service_environment_entry();
    let process = record.process.clone();
    let ended = tokio::task::spawn_blocking(move || process.end_survivors(&entry))
        .await
        .map_err(io::Error::other)
        .and_then(|ended| ended);
    let mut unended: Vec<CodexError> = match ended {
        Ok(end) => end
            .unended
            .into_iter()
            .map(|process| start_failed(LEFT_RUNNING, process).error)
            .collect(),
        Err(error) => vec![start_failed(LEFT_RUNNING, error).error],
    };
    unended.extend(clear_home_link(&record).await);
    KeptRecordEnd {
        unended,
        settled: remove_record(locked).await,
    }
}

// Takes the home's link off the socket where `record`'s ended service really listened, while the
// link still names it, so a plain `codex` finds the home's socket free; answers why it could not.
async fn clear_home_link(record: &LastingServiceRecord) -> Option<CodexError> {
    let physical_socket = record.physical_socket.clone()?;
    let home_socket = record.home_socket.clone();
    tokio::task::spawn_blocking(move || clear_socket_link_of(&home_socket, &physical_socket))
        .await
        .map_err(io::Error::other)
        .and_then(|cleared| cleared)
        .err()
        .map(|error| {
            start_failed(
                "The Codex folder's socket link could not be taken off an ended service.",
                error,
            )
            .error
        })
}

/// Retires the record `locked` holds, when one is kept: the service it names is stopped where it
/// still runs, or what it left is ended where it is gone, and the record goes either way; one
/// draining is left to its drain, which removes it. A service that cannot be stopped is logged.
/// Fails as the read, the re-pin or the removal does.
pub(in super::super) async fn retire_kept_record(
    locked: &Arc<LockedServiceRecord>,
    control_socket: &Path,
) -> Result<(), StartFailure> {
    let Some(record) = read_record(locked).await? else {
        return Ok(());
    };
    end_recorded_service(locked, record, control_socket, SERVICE_STOP_GRACE, false)
        .await
        .reported()
}

// The one end of the service `record`, held under `locked`, names: stopped within `grace` over
// `control_socket` where it still runs, or what it left ended where it is gone, the home's link
// taken off its socket once it is, and the record removed either way;
// one draining is left to its drain, which removes its record, unless `ends_draining`.
async fn end_recorded_service(
    locked: &Arc<LockedServiceRecord>,
    record: LastingServiceRecord,
    control_socket: &Path,
    grace: Duration,
    ends_draining: bool,
) -> KeptRecordEnd {
    let lasting = match repin(record.process.clone()).await {
        Ok(Some(lasting)) => lasting,
        Ok(None) => return end_former_service(locked, record).await,
        Err(failure) => return KeptRecordEnd::settled_only(Err(failure)),
    };
    if record.is_draining && !ends_draining {
        return KeptRecordEnd::settled_only(Ok(()));
    }
    let unended = match lasting.stop(grace, control_socket).await {
        Ok(_) => clear_home_link(&record).await.into_iter().collect(),
        Err(error) => {
            vec![start_failed("A former Codex service could not be stopped.", error).error]
        }
    };
    KeptRecordEnd {
        unended,
        settled: remove_record(locked).await,
    }
}

// Removes the record `locked` holds. Fails as the removal does.
async fn remove_record(locked: &Arc<LockedServiceRecord>) -> Result<(), StartFailure> {
    on_record(locked, LockedServiceRecord::remove)
        .await
        .map_err(|error| start_failed("The Codex service's record could not be removed.", error))
}

/// The running service an account home's record `locked` keeps, to join, with where its record
/// says its socket really is and its export's token and tag, so a turn it was running when the
/// daemon restarted goes on in it and its exports are still taken;
/// with none running, the record is retired as [`retire_kept_record`] retires it, so a fresh
/// launch follows. Fails as the read, the re-pin or the retire does.
pub(super) async fn take_kept_service(
    locked: &Arc<LockedServiceRecord>,
    control_socket: &Path,
) -> Result<Option<(LastingCodexService, PathBuf, Option<KeptLaunchTelemetry>)>, StartFailure> {
    let Some(record) = read_record(locked).await? else {
        return Ok(None);
    };
    if !record.is_draining
        && let Some(physical_socket) = record.physical_socket.clone()
    {
        let Some(lasting) = repin(record.process.clone()).await? else {
            retire_former_service(locked, record).await?;
            return Ok(None);
        };
        return Ok(Some((lasting, physical_socket, record.telemetry)));
    }
    retire_kept_record(locked, control_socket).await?;
    Ok(None)
}

/// A service the record of a home keeps running: the daemon's own, or one a former daemon kept.
pub(crate) struct RunningKeptService {
    /// Its process's id.
    pub(crate) process_id: u32,
    /// Where its record says its socket really is.
    pub(crate) physical_socket: PathBuf,
}

/// The service the record of `service`'s home keeps, read from that record and touching nothing:
/// draining or not, while its process still runs; `None` where no record is kept, its process
/// ended, or it never answered on a socket. Fails as the record's name, lock or read, or the
/// process table's read, does.
pub(crate) async fn read_running_kept_service(
    service: &CodexService,
) -> Result<Option<RunningKeptService>, CodexError> {
    let read = async {
        let record_file = socket_record_file(service).map_err(|error| {
            start_failed("The Codex service's record could not be named.", error)
        })?;
        let locked = lock_record(record_file).await?;
        let Some(record) = read_record(&locked).await? else {
            return Ok(None);
        };
        let Some(physical_socket) = record.physical_socket else {
            return Ok(None);
        };
        let process_id = record.process.id();
        let running = repin(record.process).await?;
        Ok::<_, StartFailure>(running.map(|_running| RunningKeptService {
            process_id,
            physical_socket,
        }))
    };
    read.await.map_err(|failure| failure.error)
}

/// Which stop ends the lasting services the records under the data folder still keep.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum KeptServicesStop {
    /// The daemon's own stop, which ends by `deadline`: each service's grace is what is left of
    /// it, one draining is left to its drain, its record kept for the next start, a service that
    /// cannot be stopped is logged, its record removed, and a record whose stop the deadline cut
    /// is kept for the next start's retire.
    DaemonStop {
        /// When the daemon's stop runs out.
        deadline: Instant,
    },
    /// The erase of the daemon's data, which deletes every record: every service a record names
    /// is ended, a draining one too, and every failure is answered.
    Erase,
}

/// Stops every lasting service a record under `data_folder` still keeps: for the daemon's stop,
/// beside its own services' stops, and for the erase, with no daemon running. A record one of
/// `live_services` names, read once the folder's lock is held so a start that published since the
/// stop began is seen, is left to that service's supervisor. One a former daemon
/// kept is stopped and its record removed, what an ended one left is ended, and one draining is
/// left to its drain under [`KeptServicesStop::DaemonStop`] and stopped under
/// [`KeptServicesStop::Erase`]. All are stopped together, so the stop takes one grace whatever the
/// count. Under the daemon's stop the whole stop ends by its deadline, one failure answered for
/// what was still running there, and every record not yet removed stays for the next start's
/// retire. Answers every failure of the listing, a folder's lock or listing, and a record's read,
/// re-pin or removal, and under the erase every stop's and every end's too; empty when nothing
/// failed.
pub(crate) async fn stop_kept_services(
    data_folder: PathBuf,
    stop: KeptServicesStop,
    live_services: &[Arc<CodexService>],
) -> Vec<CodexError> {
    let deadline = match stop {
        KeptServicesStop::DaemonStop { deadline } => Some(deadline),
        KeptServicesStop::Erase => None,
    };
    run_until(
        deadline,
        stop_every_kept_service(data_folder, stop, live_services),
    )
    .await
    .unwrap_or_else(|cut| {
        vec![
            start_failed(
                "The Codex services kept in records were still stopping when the daemon's \
                     stop ran out.",
                io::Error::new(io::ErrorKind::TimedOut, cut),
            )
            .error,
        ]
    })
}

// Stops every lasting service a record under `data_folder` still keeps but the ones
// `live_services` name, all folders together, as `stop_kept_services` does, with no bound of its
// own.
async fn stop_every_kept_service(
    data_folder: PathBuf,
    stop: KeptServicesStop,
    live_services: &[Arc<CodexService>],
) -> Vec<CodexError> {
    let listed = tokio::task::spawn_blocking(move || one_recorded_file_per_folder(&data_folder))
        .await
        .map_err(io::Error::other)
        .and_then(|listed| listed);
    let files = match listed {
        Ok(files) => files,
        Err(error) => {
            return vec![
                start_failed("The Codex services' records could not be listed.", error).error,
            ];
        }
    };
    join_all(
        files
            .into_iter()
            .map(|file| stop_folder_kept_services(file, stop, live_services)),
    )
    .await
    .into_iter()
    .flatten()
    .collect()
}

// Stops every service the records of `file`'s Codex folder keep but the ones `live_services`
// name, all together under the one hold of the folder's lock, so no retire waits on another's
// hold; answers each record's failures, or the lock's or the listing's failure.
async fn stop_folder_kept_services(
    file: LastingServiceRecordFile,
    stop: KeptServicesStop,
    live_services: &[Arc<CodexService>],
) -> Vec<CodexError> {
    let held = async {
        let locked = lock_record(file).await?;
        let others = on_record(&locked, LockedServiceRecord::others)
            .await
            .map_err(|error| {
                start_failed("The Codex services' records could not be listed.", error)
            })?;
        Ok::<_, StartFailure>(
            std::iter::once(locked)
                .chain(others.into_iter().map(Arc::new))
                .collect::<Vec<_>>(),
        )
    }
    .await;
    let records = match held {
        Ok(records) => records,
        Err(failure) => return vec![failure.error],
    };
    // Read under the hold, which every start publishes under, so a launch or a join under way is
    // seen; a live service's record is left to its supervisor, so no second stopper signals it.
    let live_records = live_record_files(live_services);
    join_all(
        records
            .iter()
            .filter(|locked| !live_records.contains(locked.file()))
            .map(|locked| stop_kept_record(locked, stop)),
    )
    .await
    .into_iter()
    .flatten()
    .collect()
}

// Stops the service the record `locked` holds still keeps, through the one end a start's retire
// takes; answers its failures as `stop` answers them.
async fn stop_kept_record(
    locked: &Arc<LockedServiceRecord>,
    stop: KeptServicesStop,
) -> Vec<CodexError> {
    let record = match read_record(locked).await {
        Ok(Some(record)) => record,
        Ok(None) => return Vec::new(),
        Err(failure) => return vec![failure.error],
    };
    // A service that never answered names no socket, so where no signal stops a process its stop
    // goes straight to the forced end.
    let control_socket = record.physical_socket.clone().unwrap_or_default();
    let grace = match stop {
        KeptServicesStop::DaemonStop { deadline } => stop_grace_by(deadline),
        KeptServicesStop::Erase => SERVICE_STOP_GRACE,
    };
    let ended = end_recorded_service(
        locked,
        record,
        &control_socket,
        grace,
        matches!(stop, KeptServicesStop::Erase),
    )
    .await;
    match stop {
        KeptServicesStop::DaemonStop { .. } => ended
            .reported()
            .err()
            .map(|failure| failure.error)
            .into_iter()
            .collect(),
        KeptServicesStop::Erase => ended.into_failures().collect(),
    }
}

/// Reports a kept service the daemon's stop could not stop, which then runs on in its record.
pub(crate) fn report_kept_service_unstopped(error: &(dyn std::error::Error + 'static)) {
    tracing::warn!(
        error,
        "a Codex service a former daemon kept could not be stopped; it runs on in its record"
    );
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
            retire_former_service(&kept_locked, record).await?;
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
    retire_last_process_record(service, locked, socket).await?;
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
    use crate::driver::codex::service::record::LastingServiceRecord;

    const HOME: &str = "/home/app-server-control/app-server-control.sock";
    const OWN: &str = "/sockets/own";

    // A record of a running service recorded on `socket`, draining when `is_draining`.
    fn recorded(socket: &str, is_draining: bool) -> LastingServiceRecord {
        let process: ProcessRecord =
            serde_json::from_str(r#"{"id":1,"start":1,"boot":"b"}"#).expect("the record reads");
        LastingServiceRecord {
            process,
            home_socket: PathBuf::from(HOME),
            physical_socket: Some(PathBuf::from(socket)),
            is_draining,
            telemetry: None,
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
