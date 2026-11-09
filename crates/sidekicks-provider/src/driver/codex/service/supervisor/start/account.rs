//! The service on an account home the app manages, or on the switching home: a lasting service
//! kept in its record, so a daemon restart leaves it running with every turn it runs and the next
//! start joins that same process again. A build move starts a second service beside the first on
//! a socket of its own and marks the first's record replaced, so a daemon restarted before the
//! first is retired joins the second and drains the first, launching no third. With none to join,
//! a fresh one is launched on the home's socket, or beside it while a draining service still holds
//! that socket.

use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use crate::driver::codex::service::home::CodexServiceKind;
use crate::driver::codex::service::record::LockedServiceRecord;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::service::supervisor::own_record::{
    retire_last_process_record, socket_record_file,
};
use crate::driver::codex::service::supervisor::start::kept_records::{
    KeptRecordsOutcome, find_joinable, join_one_drain_others, lock_record, read_kept_records,
    read_record, sort_kept_records,
};
use crate::driver::codex::service::supervisor::start::lasting_launch::{
    LaunchedLastingService, launch_lasting_service, name_lasting_log_file,
};
use crate::driver::codex::service::supervisor::start::{
    StartFailure, StartedService, compose_launch, join_former_service, name_beside,
    read_service_version, start_failed,
};
use crate::spawned_version::ResolvedProviderExecutable;

/// Starts the service on `service`'s account home under the start ticket `launch`, under the lock
/// of the home's records: the running service the records keep for it is joined, and otherwise one
/// is launched and kept in its record; `cancel` stands the start down.
pub(super) async fn start_account_home_service(
    service: &Arc<CodexService>,
    launch: u64,
    cancel: &CancellationToken,
    executable: &ResolvedProviderExecutable,
) -> Result<StartedService, StartFailure> {
    let record_file = socket_record_file(service)
        .map_err(|error| start_failed("The Codex service's record could not be named.", error))?;
    let locked = lock_record(record_file).await?;
    let log_file = name_lasting_log_file(service)?;
    let (socket, locked) = match settle_account_records(service, &locked).await? {
        KeptRecordsOutcome::Join {
            lasting,
            telemetry,
            record_file,
            physical_socket,
        } => {
            return join_former_service(
                service,
                CodexServiceKind::Account,
                launch,
                cancel,
                executable,
                *lasting,
                telemetry,
                record_file,
                physical_socket,
            )
            .await;
        }
        KeptRecordsOutcome::LaunchOnHome => (service.socket_path().to_owned(), locked),
        KeptRecordsOutcome::LaunchBeside => name_beside(service, &locked)?,
    };
    let process_launch = compose_launch(
        service,
        executable,
        service.launch_config_overrides(),
        &socket,
    )
    .await?;
    let LaunchedLastingService {
        process,
        connection,
        reply,
        physical_socket,
        earlier_record_file,
    } = launch_lasting_service(
        service,
        launch,
        cancel,
        process_launch,
        &log_file,
        &locked,
        &socket,
    )
    .await?;
    let earlier_record_file = Some(Box::new(earlier_record_file));
    match read_service_version(&reply, executable) {
        Ok(version) => Ok(StartedService {
            kind: CodexServiceKind::Account,
            process: Some(process),
            connection,
            version,
            physical_socket,
            is_restart_owed: false,
            earlier_record_file,
        }),
        Err(error) => Err(StartFailure {
            error,
            process: Some(Box::new(process)),
            earlier_record_file,
        }),
    }
}

// Settles the records the start reads under its hold `locked` of its own socket's record. The
// first start of the home's own service reads every record of the home, so a daemon restarted in
// the middle of a build move finds the second service; a later start, and every start of a second
// service on a socket of its own, reads only its own record and the one its last process was kept
// in, so it never joins the other service the daemon itself runs on the home. A record whose
// service ended is retired; the running service a start may join is joined, the own record's
// first, and every other running one drains. With none joined, a running service on the own
// socket keeps holding it while it drains, so the launch goes beside it. Fails as a record's read,
// re-pin, retire or drain fails.
async fn settle_account_records(
    service: &CodexService,
    locked: &Arc<LockedServiceRecord>,
) -> Result<KeptRecordsOutcome, StartFailure> {
    let kept = if service.socket.is_home_socket() && service.physical_socket().is_none() {
        read_kept_records(locked).await?
    } else {
        retire_last_process_record(service, locked, service.socket_path()).await?;
        read_record(locked)
            .await?
            .map(|record| (Arc::clone(locked), record))
            .into_iter()
            .collect()
    };
    let (running, _ended_services) = sort_kept_records(kept).await?;
    let joined = find_joinable(&running, locked.file());
    let (join, drained) = join_one_drain_others(service, running, joined).await?;
    let holds_own_socket = drained
        .iter()
        .any(|drained| drained.record_file == *locked.file());
    Ok(match join {
        Some(join) => join,
        None if holds_own_socket => KeptRecordsOutcome::LaunchBeside,
        None => KeptRecordsOutcome::LaunchOnHome,
    })
}
