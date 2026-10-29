//! The service on an account home the app manages: a lasting service kept in its home's record,
//! so a daemon restart leaves it running with every turn it runs and the next start joins that
//! same process again; with none kept running, a fresh one is launched on the home's socket.

use std::path::PathBuf;
use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use crate::driver::codex::service::home::CodexServiceKind;
use crate::driver::codex::service::process::LastingCodexService;
use crate::driver::codex::service::record::LastingServiceRecordFile;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::service::supervisor::start::kept_records::{
    lock_record, take_kept_service,
};
use crate::driver::codex::service::supervisor::start::{
    CodexServiceProcess, LaunchedLastingService, StartFailure, StartedService, compose_launch,
    connect, launch_lasting_service, name_lasting_log_file, read_service_version, start_failed,
};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::transport::socket::CodexSocketWait;
use crate::spawned_version::ResolvedProviderExecutable;

/// Starts the service on `service`'s account home under the start ticket `launch`, under the lock
/// of the home's records: the service its record keeps running is joined, and otherwise one is
/// launched and kept in the record; `cancel` stands the start down.
pub(super) async fn start_account_home_service(
    service: &Arc<CodexService>,
    launch: u64,
    cancel: &CancellationToken,
    executable: &ResolvedProviderExecutable,
) -> Result<StartedService, StartFailure> {
    let dependencies = service.dependencies();
    let socket = service.socket_path().to_owned();
    let record_file = LastingServiceRecordFile::of_socket(
        &dependencies.data_folder,
        &service.home().codex_home,
        &socket,
    )
    .map_err(|error| start_failed("The Codex service's record could not be named.", error))?;
    let locked = lock_record(record_file).await?;
    let log_file = name_lasting_log_file(service)?;
    if let Some((lasting, physical_socket)) = take_kept_service(&locked, &socket).await? {
        return join_kept_service(
            service,
            launch,
            cancel,
            executable,
            lasting,
            locked.file().clone(),
            physical_socket,
        )
        .await;
    }
    let process_launch = compose_launch(
        service,
        executable,
        dependencies.additional_config_overrides.clone(),
        &socket,
    )
    .await?;
    let LaunchedLastingService {
        process,
        connection,
        reply,
        physical_socket,
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
    match read_service_version(&reply, executable) {
        Ok(version) => Ok(StartedService {
            kind: CodexServiceKind::Account,
            process: Some(process),
            connection,
            version,
            physical_socket,
            is_restart_owed: false,
        }),
        Err(error) => Err(StartFailure {
            error,
            process: Some(Box::new(process)),
        }),
    }
}

// The service a former daemon kept on the home, joined on `physical_socket`, where its record says
// its socket really is. A join it fails, in its dial and answer or its version, hands it back with
// the failure, so the start's teardown stops it and removes its record.
async fn join_kept_service(
    service: &Arc<CodexService>,
    launch: u64,
    cancel: &CancellationToken,
    executable: &ResolvedProviderExecutable,
    lasting: LastingCodexService,
    record_file: LastingServiceRecordFile,
    physical_socket: PathBuf,
) -> Result<StartedService, StartFailure> {
    let joined = async {
        let (connection, reply) = connect(
            service,
            &physical_socket,
            launch,
            CodexSocketWait::Never,
            None,
            cancel,
        )
        .await?;
        let version = read_service_version(&reply, executable)?;
        Ok::<_, CodexError>((connection, version))
    }
    .await;
    let process = CodexServiceProcess::Lasting {
        service: lasting,
        record_file,
    };
    match joined {
        Ok((connection, version)) => Ok(StartedService {
            kind: CodexServiceKind::Account,
            process: Some(process),
            connection,
            version,
            physical_socket,
            is_restart_owed: false,
        }),
        Err(error) => Err(StartFailure {
            error,
            process: Some(Box::new(process)),
        }),
    }
}
