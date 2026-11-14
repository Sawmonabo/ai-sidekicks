//! What a start takes from the machine it runs on, each given so a test can start the daemon on a
//! temporary home; every other part of the start is the real one.

use std::path::PathBuf;
use std::sync::Arc;

use sidekicks_contracts::process_identity::ProcessIdentity;
use sidekicks_contracts::release_manifest::ReleaseVersion;
use sidekicks_ipc::caller_process::contract::CallerProcessReader;
use sidekicks_platforms::DaemonRunFolder;
use sidekicks_provider::driver::ProviderRegistration;
use sidekicks_store::credential_store::os::CredentialStoreAccess;
use sidekicks_store::data_folder::lock::DataFolderLock;
use tokio_util::sync::CancellationToken;

use crate::daemon::service_log::ServiceLogFiles;

/// The program's argument that starts the service apart from the account it runs as: providers
/// start from the service's own environment, never the login shell's, and the secrets stay in the
/// plain items file in the data folder, never the account's keychain. A test of the program on a
/// temporary home starts it so; an argument, unlike the environment, is never inherited.
pub const ISOLATED_SERVICE_MODE: &str = "isolated-service";

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
    /// The store the secret items and this machine's keys are kept in: the system's, or for a start
    /// on a temporary home an in-memory one or the plain items file, so no test writes the person's
    /// keychain.
    pub(crate) credential_store: Arc<dyn CredentialStoreAccess>,
    /// Whether this is the Mac's system service, which runs while the person is logged out and
    /// keeps the secrets in files.
    pub(crate) runs_while_logged_out: bool,
    /// The service log's files, which the diagnostic-log expiry leaves the live one of alone.
    pub(crate) service_log_files: ServiceLogFiles,
    /// The providers whose drivers the start builds, in their order: the one table of providers,
    /// or in a test a table whose drivers run over services the test scripts.
    pub(crate) provider_registrations: &'static [ProviderRegistration],
}

/// Where the providers' base environment comes from: the real login-shell capture, or, for a start
/// on a temporary home, the environment given (the capture would run the account's login shell).
pub(crate) enum ProviderBaseEnvironment {
    /// The login shell's environment, captured once at the start.
    Capture,
    /// These name-value pairs, as they are.
    Given(Arc<[(String, String)]>),
}
