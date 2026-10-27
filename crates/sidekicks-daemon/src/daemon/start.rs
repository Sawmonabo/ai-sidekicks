//! The service's start, on the program's service path: its own responsible process first, before
//! any thread exists; then the system's library search, the stable working folder, the hold on the
//! data folder, the service log and the panic hook that ends the service on any panic, the memory
//! settings, the hold on every process it will start and the runtime with its two workers; then the
//! daemon starts on it and runs until the first stop asked for, and the runtime ends within what is
//! left of the stop's drain bound, so the process exits before its caller's signal.

use std::error::Error;
use std::io;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Instant;

use sidekicks_ipc::caller_process::system_reader::ProcessTableReader;
use sidekicks_platforms::{
    CodeSignatureError, StopRequest, contain_daemon_descendants, create_missing_private_folders,
    daemon_run_folder, install_tree_sitter_allocator, process_identity, restrict_library_search,
    stable_working_folder, turn_off_transparent_huge_pages,
};
use sidekicks_std::cleanup_failures::CleanupFailures;
use sidekicks_std::error_description::describe_error;
use sidekicks_std::standard_error::write_error_line;
use sidekicks_store::data_folder::data_folder;
use sidekicks_store::data_folder_lock::{DataFolderLock, DataFolderLockError};
use sidekicks_store::events::session::insert::monotonic_ns_now;
use tokio_util::sync::CancellationToken;

use crate::daemon::already_running_error::DaemonAlreadyRunningError;
use crate::daemon::own_root::become_own_root;
use crate::daemon::panic_hook::install_panic_hook;
use crate::daemon::process::start_options::{DaemonStartOptions, ProviderBaseEnvironment};
use crate::daemon::process::stop::DaemonStopFailure;
use crate::daemon::process::{DAEMON_STOP_DRAIN_BOUND, DaemonProcess, DaemonStartError};
use crate::daemon::release_version::this_build_release_version;
use crate::daemon::service_log::{ServiceLogFiles, open_service_log};
use crate::daemon::service_status::record_start_failure;

// The runtime's worker threads.
const RUNTIME_WORKER_THREADS: usize = 2;

/// Why the service could not start or stop cleanly.
#[derive(Debug, thiserror::Error)]
enum ServiceStartError {
    /// The system's library search could not be limited to the system's own folder.
    #[error("the library search could not be limited to the system's folder")]
    LibrarySearch(#[source] io::Error),
    /// The stable working folder could not be entered.
    #[error("the working folder {} could not be entered", folder.display())]
    WorkingFolder {
        /// The folder.
        folder: PathBuf,
        /// The system's refusal.
        #[source]
        source: io::Error,
    },
    /// No home folder is known, so the data folder has no place.
    #[error("this account has no home folder")]
    NoHome,
    /// The data folder could not be made.
    #[error("the data folder {} could not be made", folder.display())]
    DataFolder {
        /// The folder.
        folder: PathBuf,
        /// The system's failure.
        #[source]
        source: io::Error,
    },
    /// Another daemon holds the data folder.
    #[error(transparent)]
    AlreadyRunning(DaemonAlreadyRunningError),
    /// The data folder's lock could not be taken or its holder's record written.
    #[error(transparent)]
    Lock(DataFolderLockError),
    /// The service log could not be installed.
    #[error("the service log could not be installed")]
    Log(#[source] tracing_subscriber::util::TryInitError),
    /// The hold on every process the service starts could not be set.
    #[error("the hold on the processes the service starts could not be set")]
    Containment(#[source] io::Error),
    /// The runtime or its stop request could not be made.
    #[error("the service's runtime could not start")]
    Runtime(#[source] io::Error),
    /// The run folder could not be resolved.
    #[error("the run folder could not be resolved")]
    RunFolder(#[source] io::Error),
    /// The service's own process could not be read.
    #[error("the service's own process could not be read")]
    ProcessIdentity(#[source] io::Error),
    /// The service's own program could not be found, which its crash monitor runs.
    #[error("the service's own program could not be found")]
    Program(#[source] io::Error),
    /// The desktop client's signature requirement could not be built.
    #[error("the desktop client's signature requirement could not be built")]
    CallerReader(#[source] CodeSignatureError),
    /// The daemon's start failed.
    #[error(transparent)]
    Start(#[from] CleanupFailures<DaemonStartError, DaemonStopFailure>),
}

/// Runs the service: makes it its own responsible process, prepares the process, then runs the
/// daemon until its stop. Exits 0 once stopped, 1 with why in the service log, or on standard
/// error before the log is installed, when the start or a step of the stop fails.
pub(crate) fn run_service() -> ExitCode {
    if let Err(code) = become_own_root() {
        return code;
    }
    match start_and_run() {
        Ok(exit_code) => exit_code,
        Err(error) => {
            report_start_failure(&error);
            ExitCode::FAILURE
        }
    }
}

// Prepares the process and runs the daemon until its stop. Fails with what went wrong before the
// service log was installed; from then on a failure is logged and answers the failed exit.
fn start_and_run() -> Result<ExitCode, ServiceStartError> {
    restrict_library_search().map_err(ServiceStartError::LibrarySearch)?;
    let folder = stable_working_folder();
    std::env::set_current_dir(&folder)
        .map_err(|source| ServiceStartError::WorkingFolder { folder, source })?;
    let home_folder = std::env::home_dir().ok_or(ServiceStartError::NoHome)?;
    let data_folder = data_folder(&home_folder);
    create_missing_private_folders(&data_folder).map_err(|source| {
        ServiceStartError::DataFolder {
            folder: data_folder.clone(),
            source,
        }
    })?;
    // Before the log opens, so a second start writes nothing to the first one's log.
    let data_folder_lock = DataFolderLock::take(&data_folder).map_err(|error| match error {
        DataFolderLockError::Held(held) => ServiceStartError::AlreadyRunning(held.into()),
        failure @ (DataFolderLockError::Lock { .. }
        | DataFolderLockError::RecordProcessId { .. }) => ServiceStartError::Lock(failure),
    })?;
    let log = open_service_log(&data_folder, io::stderr())
        .install()
        .map_err(ServiceStartError::Log)?;
    install_panic_hook(&data_folder, log.file_writer());
    let exit_code =
        run_daemon(home_folder, data_folder_lock, log.files()).unwrap_or_else(|error| {
            report_start_failure(&error);
            ExitCode::FAILURE
        });
    drop(log);
    Ok(exit_code)
}

// Prepares the memory and the process hold, then runs the daemon on its runtime until its stop,
// writes the service log's last lines, and ends the runtime within what is left of the stop's
// drain bound. Fails with what went wrong before the daemon's start; from then on a failure is
// logged and answers the failed exit.
fn run_daemon(
    home_folder: PathBuf,
    data_folder_lock: DataFolderLock,
    service_log_files: ServiceLogFiles,
) -> Result<ExitCode, ServiceStartError> {
    if let Err(error) = turn_off_transparent_huge_pages() {
        tracing::warn!(
            error = &error as &(dyn Error + 'static),
            "transparent huge pages could not be turned off for the service"
        );
    }
    install_tree_sitter_allocator();
    // Read once here, so the monotonic clock's zero is the start.
    monotonic_ns_now();
    contain_daemon_descendants().map_err(ServiceStartError::Containment)?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(RUNTIME_WORKER_THREADS)
        .enable_all()
        .build()
        .map_err(ServiceStartError::Runtime)?;
    let run_folder = daemon_run_folder().map_err(ServiceStartError::RunFolder)?;
    let process_identity = process_identity(std::process::id())
        .map_err(ServiceStartError::ProcessIdentity)?
        .ok_or_else(|| {
            ServiceStartError::ProcessIdentity(io::Error::new(
                io::ErrorKind::NotFound,
                "the service's own process reads as ended",
            ))
        })?;
    let daemon_program = std::env::current_exe().map_err(ServiceStartError::Program)?;
    let caller_process_reader =
        Arc::new(ProcessTableReader::for_this_program().map_err(ServiceStartError::CallerReader)?);
    let (exit_code, drain_started) = runtime.block_on(async {
        let mut stop_request = match StopRequest::listen() {
            Ok(stop_request) => stop_request,
            Err(error) => return Err(ServiceStartError::Runtime(error)),
        };
        let stop = CancellationToken::new();
        // Held until the stop has run, which on Windows lets the session end only then.
        let signals = tokio::spawn({
            let stop = stop.clone();
            async move {
                stop_request.requested().await;
                stop.cancel();
                stop_request
            }
        });
        let started = DaemonProcess::start(DaemonStartOptions {
            home_folder,
            data_folder_lock,
            run_folder: run_folder.clone(),
            daemon_program,
            process_identity,
            version: this_build_release_version(),
            caller_process_reader,
            stop,
            base_environment: ProviderBaseEnvironment::Capture,
            service_log_files,
        })
        .await;
        let ran = match started {
            Ok(mut process) => {
                let intent = process.wait_for_stop().await;
                let drain_started = Instant::now();
                match process.stop(intent).await {
                    Ok(()) => {
                        tracing::info!("the background service stopped");
                        (ExitCode::SUCCESS, drain_started)
                    }
                    Err(failure) => {
                        tracing::error!(
                            error = &failure as &(dyn Error + 'static),
                            "the background service's stop failed"
                        );
                        (ExitCode::FAILURE, drain_started)
                    }
                }
            }
            Err(failure) => {
                record_start_failure(&run_folder, failure.failures.original());
                report_start_failure(&ServiceStartError::Start(failure.failures));
                (ExitCode::FAILURE, failure.release_started)
            }
        };
        signals.abort();
        drop(signals.await);
        Ok(ran)
    })?;
    runtime.shutdown_timeout(DAEMON_STOP_DRAIN_BOUND.saturating_sub(drain_started.elapsed()));
    Ok(exit_code)
}

// Says why the start failed: in the service log once it is installed, which also writes standard
// error, and otherwise on standard error alone.
fn report_start_failure(error: &ServiceStartError) {
    // A held data folder is the other daemon's; its log is not this start's to write.
    if let ServiceStartError::AlreadyRunning(held) = error {
        write_error_line(&held.to_string());
        return;
    }
    if tracing::dispatcher::has_been_set() {
        tracing::error!(
            error = error as &(dyn Error + 'static),
            "the background service could not start"
        );
        return;
    }
    let report = format!(
        "the background service could not start: {}",
        describe_error(error)
    );
    write_error_line(&report);
}
