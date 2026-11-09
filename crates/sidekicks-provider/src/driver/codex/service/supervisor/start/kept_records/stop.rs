//! The stop of the lasting services the records under the daemon's data folder still keep. A
//! daemon stop that ends work in flight stops every service a record keeps that none of its live
//! services holds. The erase of the daemon's data, with no daemon running, ends every service a
//! record names, a draining one too, and answers every failure rather than logging it.

use std::io;
use std::path::PathBuf;
use std::sync::Arc;

use futures::future::join_all;
use tokio::time::Instant;

use super::{end_recorded_service, lock_record, on_record, read_record};
use crate::driver::codex::service::record::{
    LastingServiceRecordFile, LockedServiceRecord, one_recorded_file_per_folder,
};
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::service::supervisor::own_record::live_record_files;
use crate::driver::codex::service::supervisor::runner::{SERVICE_STOP_GRACE, stop_grace_by};
use crate::driver::codex::service::supervisor::start::{StartFailure, start_failed};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::daemon_stop::run_until;

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
