//! Why the daemon's start failed: the step's error, and with it every failure of the release that
//! undid what the start took.

use std::path::PathBuf;
use std::time::Instant;

use sidekicks_ipc::registry::RegistrationError;
use sidekicks_platforms::SocketPathRefused;
use sidekicks_policy::authorizer::RulesLoadError;
use sidekicks_queue::error::QueueError;
use sidekicks_session::attention::service::AttentionServiceError;
use sidekicks_session::idle_sleep::IdleSleepError;
use sidekicks_shell::orphan::guard::OrphanGuardError;
use sidekicks_std::cleanup_failures::CleanupFailures;
use sidekicks_std::scheduler::ScheduleError;
use sidekicks_store::machine::local::LocalMachineError;
use tokio::task::JoinError;

use crate::bootstrap::SecureDefaultsError;
use crate::daemon::artifact_methods::ArtifactMethodsError;
use crate::daemon::configuration::ConfigurationError;
use crate::daemon::crash::monitor::CrashMonitorError;
use crate::daemon::process::database::DatabaseFileOpenError;
use crate::daemon::process::jobs::JobScheduleError;
use crate::daemon::process::method_inputs::MethodInputsError;
use crate::daemon::process::repo_services::{RepoAttachmentStartError, RepoServiceStartError};
use crate::daemon::process::stop::DaemonStopFailure;
use crate::daemon::run_folder::RunFolderError;
use crate::daemon::start_stopped_error::DaemonStartStoppedError;

/// Why the daemon could not start, naming the step that failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum DaemonStartError {
    /// A socket's path in the run folder is no socket address, past the system's bound among the
    /// reasons; nothing was made or started.
    #[error("the socket path {} cannot be bound", path.display())]
    SocketPathRefused {
        /// The socket's path.
        path: PathBuf,
        /// Why, with the system's bound when the path is past it.
        #[source]
        source: SocketPathRefused,
    },
    /// The thread every child starts on could not start.
    #[error("the start's spawner could not start")]
    Spawner(#[source] std::io::Error),
    /// The run folder could not be prepared or the socket bound, another daemon running there
    /// among the reasons.
    #[error(transparent)]
    RunFolder(#[from] RunFolderError),
    /// The session token could not be minted.
    #[error("the session token could not be minted")]
    SessionToken(#[source] getrandom::Error),
    /// The crash monitor could not start.
    #[error("the crash monitor could not start")]
    CrashMonitorStart(#[source] std::io::Error),
    /// The crash monitor could not be reached.
    #[error(transparent)]
    CrashMonitorConnect(#[from] CrashMonitorError),
    /// The connect to the crash monitor ended before it finished.
    #[error("the connect to the crash monitor ended before it finished")]
    CrashMonitorConnectEnded(#[source] tokio::task::JoinError),
    /// The system refused the crash handler.
    #[error("the crash handler could not be attached")]
    CrashHandler(#[source] crash_handler::Error),
    /// The system's bound on a program's arguments could not be read.
    #[error("the system's bound on a program's arguments could not be read")]
    CommandArgumentLimit(#[source] std::io::Error),
    /// The account could not be read for the providers' base environment.
    #[error("the account could not be read for the providers' base environment")]
    BaseEnvironment(#[source] std::io::Error),
    /// The orphan guard could not be opened.
    #[error("the terminals' orphan guard could not be opened")]
    OrphanGuard(#[source] OrphanGuardError),
    /// The approval rules do not parse or check.
    #[error(transparent)]
    Rules(#[from] RulesLoadError),
    /// The secret items could not be built.
    #[error("the secret items could not be built")]
    SecretItems(#[source] getrandom::Error),
    /// A method was registered twice.
    #[error(transparent)]
    Registration(#[from] RegistrationError),
    /// The socket's path cannot name a local socket.
    #[error(transparent)]
    SocketPath(#[from] SecureDefaultsError),
    /// An earlier start's status file stayed, so a client would still read that start's failure.
    #[error("the service status file of an earlier start could not be removed")]
    ServiceStatus(#[source] std::io::Error),
    /// A stop came before the daemon was ready.
    #[error(transparent)]
    Stopped(#[from] DaemonStartStoppedError),
    /// The database file could not be opened, damaged past repair or from another build among
    /// the reasons.
    #[error(transparent)]
    DatabaseFile(#[from] DatabaseFileOpenError),
    /// This machine's row could not be read or minted.
    #[error(transparent)]
    LocalMachine(#[from] LocalMachineError),
    /// The wall clock the scheduler's timed jobs run on could not be armed.
    #[error("the scheduler's wall clock could not be armed")]
    WallClock(#[source] std::io::Error),
    /// The daemon's configuration could not be read.
    #[error(transparent)]
    Configuration(#[from] ConfigurationError),
    /// The artifact store could not be built.
    #[error(transparent)]
    ArtifactMethods(#[from] ArtifactMethodsError),
    /// A background job could not be scheduled.
    #[error(transparent)]
    Jobs(#[from] JobScheduleError),
    /// The artifact store's reaper could not be scheduled.
    #[error("the artifact store's reaper could not be scheduled")]
    ArtifactReaper(#[source] ScheduleError),
    /// The providers' registration ended abnormally.
    #[error("the providers' registration ended abnormally")]
    ProvidersRegistration(#[source] JoinError),
    /// The daemon's worktrees folder could not be made or resolved.
    #[error("the worktrees folder could not be made")]
    WorktreesFolder(#[source] std::io::Error),
    /// The repository services could not be built: another daemon binds the askpass program's
    /// socket in the run folder.
    #[error(transparent)]
    RepoServices(#[from] RepoServiceStartError),
    /// The idle sleep could not read or store the sessions it wakes, so the session services'
    /// follows did not begin.
    #[error(transparent)]
    SessionAttachments(#[from] IdleSleepError),
    /// The repository services' background work could not begin.
    #[error(transparent)]
    RepoAttachments(#[from] RepoAttachmentStartError),
    /// The services the method tables take could not be built.
    #[error(transparent)]
    MethodInputs(#[from] MethodInputsError),
    /// The attention entries a stop left could not be swept, so their decisions did not start.
    #[error(transparent)]
    Attention(#[from] AttentionServiceError),
    /// The run queues could not be read to deliver what a stop left waiting.
    #[error("the run queues could not be recovered")]
    QueueRecovery(#[source] Box<QueueError>),
}

/// A start that failed: its error beside every failure of its release, and when the release
/// began, from which what is left of the drain bound is counted.
#[derive(Debug)]
pub(crate) struct DaemonStartFailure {
    /// The step's error and the release's failures.
    pub(crate) failures: Box<CleanupFailures<DaemonStartError, DaemonStopFailure>>,
    /// When the release began.
    pub(crate) release_started: Instant,
}
