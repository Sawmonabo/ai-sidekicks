//! What a start takes from the machine it runs on, each given so a test can start the daemon on a
//! temporary home; every other part of the start is the real one.

use std::path::PathBuf;
use std::sync::Arc;

use sidekicks_contracts::process_identity::ProcessIdentity;
use sidekicks_contracts::release_manifest::ReleaseVersion;
use sidekicks_ipc::caller_process::contract::CallerProcessReader;
use sidekicks_platforms::DaemonRunFolder;
use sidekicks_store::data_folder::lock::DataFolderLock;
use tokio_util::sync::CancellationToken;

use crate::daemon::service_log::ServiceLogFiles;

/// What the daemon's start runs with.
pub(crate) struct DaemonStartOptions {
    /// The person's home, which holds the data folder.
    pub(crate) home_folder: PathBuf,
    /// The hold on the data folder, taken before the start; it goes in the stop's last step.
    pub(crate) data_folder_lock: DataFolderLock,
    /// The run folder the socket, the session token and the crash monitor's socket go in.
    pub(crate) run_folder: DaemonRunFolder,
    /// The daemon's own program, which the crash monitor runs in its mode.
    pub(crate) daemon_program: PathBuf,
    /// The daemon's own process as the system knows it.
    pub(crate) process_identity: ProcessIdentity,
    /// The service's own release version.
    pub(crate) version: ReleaseVersion,
    /// Reads a connecting process's parents, responsible process and signature.
    pub(crate) caller_process_reader: Arc<dyn CallerProcessReader>,
    /// The system's stop request: canceled, it cuts the start short or starts the stop.
    pub(crate) stop: CancellationToken,
    /// Where the providers' base environment comes from.
    pub(crate) base_environment: ProviderBaseEnvironment,
    /// The service log's files, which the diagnostic-log expiry leaves the live one of alone.
    pub(crate) service_log_files: ServiceLogFiles,
}

/// Where the providers' base environment comes from: the real login-shell capture, or, in a test
/// on a temporary home, the environment given (the capture would read the person's own dotfiles).
pub(crate) enum ProviderBaseEnvironment {
    /// The login shell's environment, captured once at the start.
    Capture,
    /// These name-value pairs, as they are.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "a test starts the daemon on a temporary home with it"
        )
    )]
    Given(Arc<[(String, String)]>),
}
