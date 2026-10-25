//! The running daemon: its start, in the order each service needs the ones before it, and its
//! stop, in the reverse order, carrying why it stops. A start that fails releases what it took,
//! in the stop's order, and names the step that failed.

pub(crate) mod start_options;
pub(crate) mod stop;
pub(crate) mod supervision;

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crash_handler::CrashHandler;
use sidekicks_contracts::daemon::lifecycle::{DAEMON_READY_LINE, DAEMON_STOP_DRAIN_BOUND_MS};
use sidekicks_contracts::jsonrpc::negotiation::CURRENT_PROTOCOL_VERSION;
use sidekicks_platforms::{
    DaemonRunFolder, Spawner, read_command_argument_limit, secret_store_offer,
};
use tokio::process::{Child, Command};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::bootstrap::secure_defaults::{
    SecureDefaults, SecureDefaultsConfig, SecureDefaultsError,
};
use crate::cleanup_failures::CleanupFailures;
use crate::credential_store::items::{SecretItems, SecretItemsStart};
use crate::credential_store::os::{KEYCHAIN_CALL_TIMEOUT, SystemCredentialStore};
use crate::daemon::crash::monitor::{
    CRASH_MONITOR_MODE, CrashMonitorError, attach_crash_handler, connect_crash_monitor,
    crash_monitor_socket_path,
};
use crate::daemon::data_folder::data_folder;
use crate::daemon::data_folder_lock::DataFolderLock;
use crate::daemon::login_shell_environment::capture_provider_base_environment;
use crate::daemon::panic_hook::send_panics_to_monitor;
use crate::daemon::process::start_options::{DaemonStartOptions, ProviderBaseEnvironment};
use crate::daemon::process::stop::{
    CrashMonitorEndFailure, DaemonStopFailure, close_data_folder, stop_work,
};
use crate::daemon::process::supervision::{ProcessStateTracker, ServingSocketHooks};
use crate::daemon::run_folder::{
    RunFolderError, bind_socket, mint_session_token, prepare_run_folder,
};
use crate::daemon::start_stopped_error::DaemonStartStoppedError;
use crate::git::process::find_git_executable;
use crate::helper_mode::child::start_helper_mode_child;
use crate::ipc::caller_process::contract::CallerProcessReader;
use crate::ipc::caller_process::descent::CallerCheck;
use crate::ipc::caller_process::provider_services::ProviderServiceProcesses;
use crate::ipc::local_gateway::{GatewayServices, LocalGateway};
use crate::ipc::protocol_negotiation::ProtocolNegotiator;
use crate::ipc::registry::{Dispatch, MethodRegistryBuilder, RegistrationError};
use crate::ipc::stream::subscriptions::Subscriptions;
use crate::policy::authorizer::{Authorizer, RulesLoadError};
use crate::policy::shell_commands::reading_bound::ShellLineReadingBound;
use crate::provider::driver::daemon_stop::DaemonStopIntent;
use crate::pty::orphan::guard::{OrphanGuard, OrphanGuardError, open_orphan_guard};
use crate::recovery::database_file::damage::DatabaseDamageWatch;
use crate::recovery::database_file::repair::DatabaseFileRepairFailure;
use crate::settle_all::{SettleFailures, settle_all};

/// The longest the stop's drain runs, the work ending and the data folder closing together.
pub(crate) const DAEMON_STOP_DRAIN_BOUND: Duration =
    Duration::from_millis(DAEMON_STOP_DRAIN_BOUND_MS);

/// Why the daemon could not start, naming the step that failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum DaemonStartError {
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
    /// The daemon's own program could not be found to start the crash monitor.
    #[error("the daemon's own program could not be found for its crash monitor")]
    CrashMonitorProgram(#[source] std::io::Error),
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
    /// A stop came before the daemon was ready.
    #[error(transparent)]
    Stopped(#[from] DaemonStartStoppedError),
    /// The database file is damaged and its repair could not heal it; it is left as it was.
    #[expect(dead_code, reason = "the database file's open raises it")]
    #[error(
        "The database file is damaged and could not be repaired: {failure}. Its files are copied \
         aside in {}.",
        aside_folder.display()
    )]
    SavedSessionsUnrepaired {
        /// The folder the damaged files are copied aside in.
        aside_folder: PathBuf,
        /// Why the repair failed.
        #[source]
        failure: DatabaseFileRepairFailure,
    },
    /// The database file holds another build's schema, which this build never migrates.
    #[expect(dead_code, reason = "the database file's open raises it")]
    #[error("the database at {} holds the schema of another build", path.display())]
    SavedSessionsFromAnotherVersion {
        /// The database file.
        path: PathBuf,
    },
}

/// What the start read and loaded before it builds the services, each handed to the services that
/// take it.
#[expect(
    dead_code,
    reason = "the providers', the session services' and the repository services' builds take them"
)]
struct ServiceInputs {
    /// The providers' base environment.
    base_environment: Arc<[(String, String)]>,
    /// The one bound on shell-line reads, for the providers and the permission check.
    shell_lines: Arc<ShellLineReadingBound>,
    /// Git along the person's search path, when it is there.
    git_executable: Option<PathBuf>,
    /// The approval rules, parsed and checked.
    authorizer: Arc<Authorizer>,
    /// The daemon's secrets, for the status read, the erase and each keychain.
    secret_items: Arc<SecretItems>,
}

/// The crash monitor: the `minidump` child and the handler that asks it for a dump on a crash.
pub(crate) struct CrashMonitor {
    child: Child,
    handler: CrashHandler,
    socket_path: PathBuf,
}

impl CrashMonitor {
    /// Starts the monitor on `spawner` at its socket in `run_folder`, connects to it within its
    /// bound, attaches the crash handler and sends later panics to it. Fails naming the step.
    async fn start(
        spawner: &Spawner,
        run_folder: &DaemonRunFolder,
    ) -> Result<Self, DaemonStartError> {
        let socket_path = crash_monitor_socket_path(&run_folder.folder_path, std::process::id());
        let mut command =
            Command::new(std::env::current_exe().map_err(DaemonStartError::CrashMonitorProgram)?);
        command
            .arg(CRASH_MONITOR_MODE)
            .arg(&socket_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null());
        let child = start_helper_mode_child(spawner, command)
            .await
            .map_err(DaemonStartError::CrashMonitorStart)?;
        let connect_path = socket_path.clone();
        let client = Arc::new(
            tokio::task::spawn_blocking(move || connect_crash_monitor(&connect_path))
                .await
                .map_err(DaemonStartError::CrashMonitorConnectEnded)??,
        );
        let handler =
            attach_crash_handler(Arc::clone(&client)).map_err(DaemonStartError::CrashHandler)?;
        send_panics_to_monitor(client);
        Ok(Self {
            child,
            handler,
            socket_path,
        })
    }

    /// Detaches the crash handler, ends the monitor within `bound` and removes its socket from the
    /// run folder. Answers each step's failure.
    async fn end(mut self, bound: Duration) -> Vec<DaemonStopFailure> {
        drop(self.handler);
        let mut failures = Vec::new();
        match tokio::time::timeout(bound, self.child.kill()).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => failures.push(CrashMonitorEndFailure::Kill(error).into()),
            Err(_elapsed) => failures.push(CrashMonitorEndFailure::StillRunning(bound).into()),
        }
        match tokio::fs::remove_file(&self.socket_path).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(source) => failures.push(
                CrashMonitorEndFailure::Socket {
                    path: self.socket_path,
                    source,
                }
                .into(),
            ),
        }
        failures
    }
}

/// The running daemon: every service it started, held in the order its stop ends them.
pub(crate) struct DaemonProcess {
    /// The system's stop request.
    system_stop: CancellationToken,
    /// The first stop asked for over the socket, with why.
    stop_asked: watch::Sender<Option<DaemonStopIntent>>,
    /// Canceled at the stop, so the work under way ends.
    pub(crate) work_stop: CancellationToken,
    /// Where the daemon is in its own life.
    pub(crate) process_state: Arc<ProcessStateTracker>,
    /// The thread every child starts on, kept for the daemon's life: a child armed to end with
    /// the daemon ends once the thread that started it has.
    spawner: Spawner,
    /// What the services the start builds take.
    service_inputs: Option<ServiceInputs>,
    /// The serving socket, while it serves.
    pub(crate) gateway: Option<LocalGateway>,
    /// The record of every terminal child, closed once the terminals have drained.
    pub(crate) orphan_guard: Option<OrphanGuard>,
    /// The hold on the data folder, let go last.
    pub(crate) data_folder_lock: DataFolderLock,
    /// The crash monitor, ended once the data folder is closed.
    pub(crate) crash_monitor: Option<CrashMonitor>,
}

// What a failed start's release is called in its error.
const START_OPERATION: &str = "the daemon's start";

impl DaemonProcess {
    /// Starts the daemon with `options` and answers it once it is ready. A failed step releases
    /// what the start took, in the stop's order, and fails with the step's error beside every
    /// failure of that release; a stop asked for before the daemon is ready fails it with
    /// [`DaemonStartError::Stopped`].
    pub(crate) async fn start(
        options: DaemonStartOptions,
    ) -> Result<Self, CleanupFailures<DaemonStartError, DaemonStopFailure>> {
        let DaemonStartOptions {
            home_folder,
            data_folder_lock,
            run_folder,
            process_identity: _,
            version: _,
            caller_process_reader,
            stop,
            base_environment,
        } = options;
        let spawner = match Spawner::new(tokio::runtime::Handle::current()) {
            Ok(spawner) => spawner,
            Err(error) => {
                return Err(CleanupFailures::new(
                    DaemonStartError::Spawner(error),
                    Vec::new(),
                    START_OPERATION,
                ));
            }
        };
        let mut process = Self {
            work_stop: stop.child_token(),
            system_stop: stop,
            stop_asked: watch::Sender::new(None),
            process_state: ProcessStateTracker::new(),
            spawner,
            service_inputs: None,
            gateway: None,
            orphan_guard: None,
            data_folder_lock,
            crash_monitor: None,
        };
        let started = process
            .run_start(
                &home_folder,
                &run_folder,
                caller_process_reader,
                base_environment,
            )
            .await;
        match started {
            Ok(()) => Ok(process),
            Err(error) => Err(process.release(error).await),
        }
    }

    // The start's steps, each part kept in the process as it is taken, so a failure releases it.
    async fn run_start(
        &mut self,
        home_folder: &std::path::Path,
        run_folder: &DaemonRunFolder,
        caller_process_reader: Arc<dyn CallerProcessReader>,
        base_environment: ProviderBaseEnvironment,
    ) -> Result<(), DaemonStartError> {
        let data_folder = data_folder(home_folder);
        prepare_run_folder(run_folder).await?;
        let session_token = mint_session_token().map_err(DaemonStartError::SessionToken)?;
        self.crash_monitor = Some(CrashMonitor::start(&self.spawner, run_folder).await?);
        let shell_lines = Arc::new(ShellLineReadingBound::new(
            read_command_argument_limit().map_err(DaemonStartError::CommandArgumentLimit)?,
        ));
        let capture = async {
            match base_environment {
                ProviderBaseEnvironment::Capture => {
                    capture_provider_base_environment(&self.spawner, home_folder, &self.work_stop)
                        .await
                        .map(Arc::from)
                }
                ProviderBaseEnvironment::Given(pairs) => Ok(pairs),
            }
        };
        let (base_environment, orphan_guard) =
            tokio::join!(capture, open_orphan_guard(&data_folder));
        self.orphan_guard = Some(orphan_guard.map_err(DaemonStartError::OrphanGuard)?);
        let base_environment = base_environment.map_err(DaemonStartError::BaseEnvironment)?;
        if self.work_stop.is_cancelled() {
            return Err(DaemonStartStoppedError {
                step: "capturing the providers' base environment",
            }
            .into());
        }
        let git_executable = find_git_executable(&base_environment);
        let authorizer = Arc::new(Authorizer::load_built_in()?);
        let secret_items = SecretItems::new(SecretItemsStart {
            data_folder,
            // The service starts only as the per-user agent or the app's child.
            runs_while_logged_out: false,
            access: Arc::new(SystemCredentialStore {
                offer: secret_store_offer(),
            }),
            call_timeout: KEYCHAIN_CALL_TIMEOUT,
        })
        .map_err(DaemonStartError::SecretItems)?;
        self.service_inputs = Some(ServiceInputs {
            base_environment,
            shell_lines,
            git_executable,
            authorizer,
            secret_items,
        });
        self.gateway = Some(
            self.bind_serving_socket(run_folder, caller_process_reader, session_token)
                .await?,
        );
        self.process_state.mark_ready();
        tracing::info!(
            process_id = std::process::id(),
            protocol = CURRENT_PROTOCOL_VERSION,
            "{DAEMON_READY_LINE}"
        );
        Ok(())
    }

    // Registers the handshake and the subscriptions' cancel, freezes the registry and binds the
    // serving socket with `session_token`.
    async fn bind_serving_socket(
        &self,
        run_folder: &DaemonRunFolder,
        caller_process_reader: Arc<dyn CallerProcessReader>,
        session_token: String,
    ) -> Result<LocalGateway, DaemonStartError> {
        let caller_check = CallerCheck::new(
            Arc::clone(&caller_process_reader),
            Arc::new(Default::default),
            Arc::new(ProviderServiceProcesses::default()),
        );
        let negotiator =
            ProtocolNegotiator::new(session_token.clone(), caller_check.admission_check());
        let subscriptions = Subscriptions::new(Arc::new(DatabaseDamageWatch::new()));
        let mut builder = MethodRegistryBuilder::new();
        negotiator.register_handshake(&mut builder)?;
        subscriptions.register_cancel(&mut builder)?;
        let registry = Arc::new(builder.freeze());
        let services = GatewayServices {
            device_id: None,
            dispatch: Arc::new(negotiator.gate(
                Arc::clone(&registry) as Arc<dyn Dispatch>,
                Arc::clone(&registry),
            )),
            registry,
            negotiator: Arc::clone(&negotiator),
            subscriptions: Arc::clone(&subscriptions),
            hooks: Arc::new(ServingSocketHooks {
                negotiator,
                subscriptions,
                process_state: Arc::clone(&self.process_state),
            }),
        };
        let secure_defaults = SecureDefaults::load(SecureDefaultsConfig {
            local_ipc_path: run_folder.socket_path.clone(),
        })?;
        Ok(bind_socket(
            || LocalGateway::start(services, caller_process_reader, &secure_defaults),
            run_folder,
            session_token,
        )
        .await?)
    }

    // Releases what a failed start took, in the stop's order, keeping each failure beside `error`.
    async fn release(
        mut self,
        error: DaemonStartError,
    ) -> CleanupFailures<DaemonStartError, DaemonStopFailure> {
        let release_started = Instant::now();
        let mut failures =
            stop_work(&mut self, DaemonStopIntent::Stop, DAEMON_STOP_DRAIN_BOUND).await;
        failures.extend(
            close_data_folder(
                self,
                DAEMON_STOP_DRAIN_BOUND.saturating_sub(release_started.elapsed()),
            )
            .await,
        );
        CleanupFailures::new(error, failures, START_OPERATION)
    }

    /// The stop asked for over the socket: the lifecycle methods' stop asks with
    /// [`DaemonStopIntent::Stop`], their restart with [`DaemonStopIntent::Restart`]; the first ask
    /// wins.
    #[expect(dead_code, reason = "the lifecycle methods' stop and restart call it")]
    pub(crate) fn accept_stop(&self) -> Arc<dyn Fn(DaemonStopIntent) + Send + Sync> {
        let stop_asked = self.stop_asked.clone();
        Arc::new(move |intent| {
            stop_asked.send_if_modified(|asked| {
                let is_first = asked.is_none();
                if is_first {
                    *asked = Some(intent);
                }
                is_first
            });
        })
    }

    /// Waits for the first stop asked for: the system's stop request, which stops, or a stop or
    /// restart over the socket.
    pub(crate) async fn wait_for_stop(&self) -> DaemonStopIntent {
        let mut stop_asked = self.stop_asked.subscribe();
        tokio::select! {
            () = self.system_stop.cancelled() => DaemonStopIntent::Stop,
            asked = stop_asked.wait_for(Option::is_some) => match asked.as_deref() {
                Ok(Some(intent)) => *intent,
                // The process holds the sender, so the wait ends only with an ask.
                Ok(None) | Err(_) => DaemonStopIntent::Stop,
            },
        }
    }

    /// Stops the daemon for `intent`: its work within the drain bound, then its data folder in
    /// what is left of it. Fails with every step's failure, each step having run.
    pub(crate) async fn stop(
        mut self,
        intent: DaemonStopIntent,
    ) -> Result<(), SettleFailures<DaemonStopFailure>> {
        let stop_started = Instant::now();
        let mut failures = stop_work(&mut self, intent, DAEMON_STOP_DRAIN_BOUND).await;
        failures.extend(
            close_data_folder(
                self,
                DAEMON_STOP_DRAIN_BOUND.saturating_sub(stop_started.elapsed()),
            )
            .await,
        );
        settle_all(
            failures
                .into_iter()
                .map(Err)
                .collect::<Vec<Result<(), _>>>(),
            "the daemon's stop",
        )
        .map(drop)
    }
}
