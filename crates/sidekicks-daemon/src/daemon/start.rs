//! The service's start, on the program's service path: its own responsible process first, before
//! any thread exists; then the system's library search, the stable working folder, the service
//! log and the panic hook that ends the service on any panic, the memory settings, the hold on
//! every process it will start, the runtime with its two workers and the one spawner every child
//! starts on; then it runs until the stop request.

use std::error::Error;
use std::io;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use sidekicks_platforms::{
    StopRequest, contain_daemon_descendants, install_tree_sitter_allocator,
    restrict_library_search, stable_working_folder, turn_off_transparent_huge_pages,
};

use crate::daemon::data_folder::data_folder;
use crate::daemon::own_root::become_own_root;
use crate::daemon::panic_hook::install_panic_hook;
use crate::daemon::service_log::open_service_log;
use crate::error_description::describe_error;
use crate::events::session::insert::monotonic_ns_now;
use crate::standard_error::write_error_line;

// The runtime's worker threads.
const RUNTIME_WORKER_THREADS: usize = 2;

// How long the runtime's shutdown waits for its blocking tasks before it leaves them.
const RUNTIME_SHUTDOWN_BOUND: Duration = Duration::from_secs(5);

/// Why the service could not start.
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
    /// The service log could not be installed.
    #[error("the service log could not be installed")]
    Log(#[source] tracing_subscriber::util::TryInitError),
    /// The hold on every process the service starts could not be set.
    #[error("the hold on the processes the service starts could not be set")]
    Containment(#[source] io::Error),
    /// The runtime, its spawner or its stop request could not be made.
    #[error("the service's runtime could not start")]
    Runtime(#[source] io::Error),
}

/// Runs the service: makes it its own responsible process, prepares the process, then runs the
/// runtime until the stop request. Exits 0 once stopped, 1 with why in the service log, or on
/// standard error before the log is installed, when the start fails.
pub(crate) fn run_service() -> ExitCode {
    if let Err(code) = become_own_root() {
        return code;
    }
    match start_and_run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            report_start_failure(&error);
            ExitCode::FAILURE
        }
    }
}

// Prepares the process and runs until the stop request.
fn start_and_run() -> Result<(), ServiceStartError> {
    restrict_library_search().map_err(ServiceStartError::LibrarySearch)?;
    let folder = stable_working_folder();
    std::env::set_current_dir(&folder)
        .map_err(|source| ServiceStartError::WorkingFolder { folder, source })?;
    let data_folder = data_folder(&std::env::home_dir().ok_or(ServiceStartError::NoHome)?);
    let log = open_service_log(&data_folder, io::stderr())
        .install()
        .map_err(ServiceStartError::Log)?;
    install_panic_hook(&data_folder, log.file_writer());
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
    let ran = runtime.block_on(async {
        let mut stop = StopRequest::listen()?;
        tracing::info!("The background service started");
        stop.requested().await;
        tracing::info!("The background service stops");
        Ok(())
    });
    runtime.shutdown_timeout(RUNTIME_SHUTDOWN_BOUND);
    ran.map_err(ServiceStartError::Runtime)?;
    drop(log);
    Ok(())
}

// Says why the start failed: in the service log once it is installed, which also writes standard
// error, and otherwise on standard error alone.
fn report_start_failure(error: &ServiceStartError) {
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
