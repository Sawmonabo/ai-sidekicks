//! `sidekicks daemon start`: a daemon that answers the handshake, or answers that it is repairing
//! its database file, is already running. Otherwise this account's system service, which runs the
//! service while the person is logged out, refuses the start: only root can start it, which a run
//! under `sudo` does, waiting until launchd runs it, since root cannot reach the service. Else a
//! login agent registered for this account's home is started through the system's service
//! manager, and the service manager keeps it; with none, or with no one at the screen, its program
//! starts as a lasting child. Either registration the person turned off in Login Items, or a
//! `--daemon-path` it does not start, refuses the start. The command then waits for the handshake.
//! A lasting child that never answers is ended, and one that exits first is named with its exit and
//! why its start failed; an agent's service that never answers is left running; each exits 69.

use std::convert::Infallible;
use std::fs::OpenOptions;
use std::future::{Future, pending};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::ExitStatus;
use std::time::Duration;

use anyhow::Context as _;
use clap::Args;
use sidekicks_client::daemon_connection::handshake_wait::{
    HandshakeWaitEnd, is_not_ready_yet, wait_for_handshake,
};
use sidekicks_client::daemon_connection::{
    DaemonConnection, DaemonEndpoint, HANDSHAKE_DEADLINE, OpenedConnection,
};
use sidekicks_client::daemon_ending::{DaemonEndingTerms, end_unanswered_process};
use sidekicks_client::error::ClientError;
use sidekicks_contracts::daemon::recovery::DaemonRepairingDetails;
use sidekicks_contracts::daemon::service_status::DaemonCannotStart;
use sidekicks_platforms::{
    CtrlCListener, LastingChild, LastingCommand, NULL_DEVICE_PATH, PinnedProcess, ServiceOwner,
    ServiceRegistration, SystemServiceKickstart, SystemServiceOwner, SystemServiceState,
    leave_daemon_scope, read_child_exit, service_registration, spawn_lasting_child,
};
use tokio::time::{Instant, sleep};

use crate::command_context::CommandContext;
use crate::commands::daemon::install::system_service::{read_system_service_owner, write_line};
use crate::commands::daemon::registration::{read_owner, registration_failure};
use crate::commands::daemon::service_status::read_cannot_start;
use crate::connected_command::run_listening_for_ctrl_c;
use crate::daemon_program::{daemon_program, is_same_program};
use crate::exit_codes::{CommandFailure, ExitCode};
use crate::program::describe_repairing;

/// `daemon start`'s options.
#[derive(Debug, Args)]
pub(crate) struct StartArgs {
    /// The background service's program to start, in place of the one installed beside this
    /// program; refused where a login agent or system service that starts another program runs
    /// the service.
    #[arg(long, value_name = "PATH")]
    pub(crate) daemon_path: Option<PathBuf>,
    /// How long to wait for the started background service to answer, in milliseconds [default:
    /// 10000].
    #[arg(long, value_name = "MS")]
    timeout: Option<u64>,
}

impl StartArgs {
    /// How long the start waits for the started service.
    fn deadline(&self) -> Duration {
        self.timeout
            .map_or(HANDSHAKE_DEADLINE, Duration::from_millis)
    }
}

/// How a start ended without failing.
#[derive(Debug)]
pub(crate) enum DaemonStart {
    /// A daemon was already running, or another start's daemon answered first.
    AlreadyRunning,
    /// The started daemon answered the handshake.
    Started {
        /// Why the daemon could not leave this command's login scope, where it could not; it then
        /// ends with that scope.
        scope_refused: Option<io::Error>,
    },
}

/// The started daemon's exit, answered once it has exited and been reaped.
type DaemonExit = Pin<Box<dyn Future<Output = io::Result<ExitStatus>> + Send>>;

/// The line a command prints once it started the background service.
pub(crate) const STARTED_LINE: &str = "Started the background service.\n";

/// The line a start prints where the background service already runs.
const ALREADY_RUNNING_LINE: &str = "The background service is already running.\n";

/// How long a start under `sudo` waits between reads of whether launchd runs the system service.
const SYSTEM_SERVICE_READ_INTERVAL: Duration = Duration::from_millis(100);

/// Starts the background service unless it is running, and answers 0 once it answers: the repair's
/// line on stderr while it repairs its database file, then on stdout `started_line` where this
/// command started it, with the cause after it where the service could not leave this login's
/// scope and so stops at log out, else the line saying it was already running. Fails as
/// [`start_daemon`] does, or as a write does.
pub(crate) fn start_and_report<Output: Write, ErrorOutput: Write>(
    args: &StartArgs,
    started_line: &'static str,
    context: &mut CommandContext<Output, ErrorOutput>,
) -> anyhow::Result<ExitCode> {
    let deadline = args.deadline();
    let mut repair_line = RepairLine::new(&mut context.stderr);
    let started = start_daemon(args.daemon_path.as_deref(), deadline, |details| {
        repair_line.show(details);
    });
    repair_line.finish()?;
    let line = match started? {
        DaemonStart::AlreadyRunning => ALREADY_RUNNING_LINE.to_owned(),
        DaemonStart::Started {
            scope_refused: None,
        } => started_line.to_owned(),
        DaemonStart::Started {
            scope_refused: Some(refusal),
        } => format!(
            "{} It stops when you log out: {}.\n",
            started_line.trim_end(),
            refusal.to_string().trim_end_matches('.')
        ),
    };
    context.stdout.write_all(line.as_bytes())?;
    context.stdout.flush()?;
    Ok(ExitCode::Success)
}

/// The repair's line on stderr, written once however often a waited-for daemon answers that it is
/// repairing its database file; a failed write is kept for [`RepairLine::finish`].
pub(crate) struct RepairLine<'a, ErrorOutput: Write> {
    stderr: &'a mut ErrorOutput,
    is_shown: bool,
    written: io::Result<()>,
}

impl<'a, ErrorOutput: Write> RepairLine<'a, ErrorOutput> {
    /// A repair line not yet written to `stderr`.
    pub(crate) fn new(stderr: &'a mut ErrorOutput) -> Self {
        Self {
            stderr,
            is_shown: false,
            written: Ok(()),
        }
    }

    /// Writes the line for `details` unless it was written already.
    pub(crate) fn show(&mut self, details: DaemonRepairingDetails) {
        if !self.is_shown {
            self.is_shown = true;
            self.written = writeln!(self.stderr, "{}", describe_repairing(details));
        }
    }

    /// Ends the line's use; fails with its write's error where the write failed.
    pub(crate) fn finish(self) -> io::Result<()> {
        self.written
    }
}

/// Starts this machine's background service unless one answers, on a runtime of its own, and
/// answers once a daemon answers the handshake: `daemon start` calls it, and so does an account
/// command that needs the service running. A login agent registered for this account's home is
/// started through the service manager; otherwise the program is `daemon_path`, else the one
/// installed beside this program, started as a lasting child. The wait for the handshake lasts
/// `deadline`, moved on by each answer that the daemon is repairing its database file, whose
/// details go to `on_repairing`. Fails with [`CommandFailure::SystemServiceStartNeedsRoot`] where
/// this account's system service runs the service, [`CommandFailure::TurnedOffInLoginItems`] or
/// [`CommandFailure::AppServiceTurnedOff`] for a registration the person turned off, with nothing
/// started; [`CommandFailure::RegisteredNotAnswering`] when an agent's service does not answer in
/// time, which is left running; [`CommandFailure::StartTimedOut`] when a lasting child does not,
/// which is then ended; [`CommandFailure::DaemonExited`] when it exits first and no other daemon
/// answers; `ClientError::Canceled` after a Ctrl-C; and as the registration's reads and start,
/// the program's resolution, its start or a handshake that fails other than as a starting
/// daemon's does.
pub(crate) fn start_daemon(
    daemon_path: Option<&Path>,
    deadline: Duration,
    mut on_repairing: impl FnMut(DaemonRepairingDetails),
) -> anyhow::Result<DaemonStart> {
    run_listening_for_ctrl_c(async |ctrl_c| {
        tokio::select! {
            started = start_and_wait(daemon_path, deadline, &mut on_repairing) => started,
            _ = ctrl_c.recv() => Err(ClientError::Canceled.into()),
        }
    })
}

/// How a start reaches the service.
enum StartRoute {
    /// The login agent was started through the service manager, which keeps its process.
    Agent,
    /// The program starts as this command's lasting child.
    LastingChild,
}

/// Starts the login agent registered for this account's home where there is one and someone is
/// at the screen, and answers how the start goes on. Blocks on the service manager. Fails with
/// [`CommandFailure::SystemServiceStartNeedsRoot`] where this account's system service runs the
/// service, which this run without root's rights cannot start, as
/// [`has_system_service_to_start`] fails, with [`CommandFailure::AgentRunsOtherProgram`] where
/// `daemon_path` names a program the agent does not start,
/// [`CommandFailure::TurnedOffInLoginItems`] for the command line's own agent turned off,
/// [`CommandFailure::AppServiceTurnedOff`] for the app's, and as [`registration_failure`] turns a
/// failed read or start.
fn start_registered_agent(daemon_path: Option<&Path>) -> anyhow::Result<StartRoute> {
    let Some(registration) = service_registration() else {
        return refuse_app_turned_off().map(|()| StartRoute::LastingChild);
    };
    // A login agent or lasting child beside the system service would run a second service.
    if has_system_service_to_start(registration)? {
        return Err(CommandFailure::SystemServiceStartNeedsRoot.into());
    }
    match read_owner(&registration)? {
        ServiceOwner::None => refuse_app_turned_off().map(|()| StartRoute::LastingChild),
        ServiceOwner::CommandLine => {
            // launchd starts a list turned off in Login Items when asked, so the switch is read
            // first.
            let is_turned_off = registration.is_turned_off().map_err(|failure| {
                registration_failure(
                    failure,
                    "could not read whether the background service is turned off in Login Items",
                )
            })?;
            if is_turned_off {
                return Err(CommandFailure::TurnedOffInLoginItems.into());
            }
            let has_screen_session = registration.has_screen_session().map_err(|failure| {
                registration_failure(failure, "could not read whether anyone is at the screen")
            })?;
            if !has_screen_session {
                return refuse_app_turned_off().map(|()| StartRoute::LastingChild);
            }
            if let Some(daemon_path) = daemon_path {
                let agent_program = registration.agent_program().map_err(|failure| {
                    registration_failure(failure, "could not read the login agent's program")
                })?;
                if !names_registered_program(agent_program.as_deref(), daemon_path)? {
                    return Err(CommandFailure::AgentRunsOtherProgram.into());
                }
            }
            registration.kickstart().map_err(|failure| {
                registration_failure(failure, "could not start the background service")
            })?;
            Ok(StartRoute::Agent)
        }
        ServiceOwner::App => {
            if daemon_path.is_some() {
                return Err(CommandFailure::AgentRunsOtherProgram.into());
            }
            // The app's switch in Login Items reads from its status file, read here first.
            refuse_app_turned_off()?;
            registration.kickstart().map_err(|failure| {
                registration_failure(failure, "could not start the background service")
            })?;
            Ok(StartRoute::Agent)
        }
    }
}

/// Whether this account's system service, which runs the background service while the person is
/// logged out, is installed through `registration`, so a start is its own. Blocks on the system's
/// answer. Fails with [`CommandFailure::TurnedOffInLoginItems`] where the person turned it off in
/// Login Items, which launchd does not honor when asked to start it, and as
/// [`registration_failure`] turns a failed read.
pub(crate) fn has_system_service_to_start(
    registration: ServiceRegistration,
) -> anyhow::Result<bool> {
    match read_system_service_owner(&registration, None)? {
        SystemServiceOwner::ThisAccount | SystemServiceOwner::ThisAccountOtherProgram => {}
        SystemServiceOwner::NotInstalled | SystemServiceOwner::OtherAccount => return Ok(false),
    }
    let is_turned_off = registration
        .is_system_service_turned_off()
        .map_err(|failure| {
            registration_failure(
                failure,
                "could not read whether the background service is turned off in Login Items",
            )
        })?;
    if is_turned_off {
        return Err(CommandFailure::TurnedOffInLoginItems.into());
    }
    Ok(true)
}

/// Starts this account's system service with root's rights through `registration`, and answers 0
/// with the started line on stdout once launchd runs it, or with the already-running line where it
/// ran before. Root cannot pass the service's own-account check, so launchd's word that it runs
/// stands in for the handshake. Fails as [`refuse_other_system_program`],
/// [`kickstart_system_service`] and [`wait_for_system_service`] do, or as a write does.
pub(crate) fn start_system_service<Output: Write, ErrorOutput: Write>(
    args: &StartArgs,
    registration: ServiceRegistration,
    context: &mut CommandContext<Output, ErrorOutput>,
) -> anyhow::Result<ExitCode> {
    refuse_other_system_program(args.daemon_path.as_deref(), registration)?;
    if read_system_service_state(registration)? == SystemServiceState::Running {
        return write_line(context, ALREADY_RUNNING_LINE);
    }
    kickstart_system_service(registration, SystemServiceKickstart::Start)?;
    run_listening_for_ctrl_c(async |ctrl_c| {
        wait_for_system_service(registration, args, ctrl_c).await
    })?;
    write_line(context, STARTED_LINE)
}

/// Waits until launchd runs this account's system service, as [`wait_until_running`] waits, for
/// `args`' wait or until the person's Ctrl-C on `ctrl_c`. Fails as that wait does.
pub(crate) async fn wait_for_system_service(
    registration: ServiceRegistration,
    args: &StartArgs,
    ctrl_c: &mut CtrlCListener,
) -> anyhow::Result<()> {
    wait_until_running(
        move || read_system_service_state(registration),
        args.deadline(),
        ctrl_c.recv(),
    )
    .await
}

/// Reads the state with `read_state` every [`SYSTEM_SERVICE_READ_INTERVAL`] until it is running,
/// `waited` passes or `ctrl_c` arrives, each read on a blocking thread so a Ctrl-C ends the wait
/// without waiting on the read. Fails with [`CommandFailure::SystemServiceNotRunning`] where the
/// wait ends first, `ClientError::Canceled` on Ctrl-C, and as a read fails.
async fn wait_until_running(
    read_state: impl Fn() -> anyhow::Result<SystemServiceState> + Copy + Send + 'static,
    waited: Duration,
    ctrl_c: impl Future,
) -> anyhow::Result<()> {
    let deadline = Instant::now() + waited;
    let running = async {
        loop {
            let state = tokio::task::spawn_blocking(read_state)
                .await
                .context("the background service's state read stopped before it answered")??;
            if state == SystemServiceState::Running {
                return Ok(());
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(CommandFailure::SystemServiceNotRunning { waited }.into());
            }
            sleep(SYSTEM_SERVICE_READ_INTERVAL.min(deadline - now)).await;
        }
    };
    tokio::select! {
        waited = running => waited,
        _ = ctrl_c => Err(ClientError::Canceled.into()),
    }
}

/// Whether launchd runs this account's system service. Fails as [`registration_failure`] turns a
/// failed read.
fn read_system_service_state(
    registration: ServiceRegistration,
) -> anyhow::Result<SystemServiceState> {
    registration.read_system_service_state().map_err(|failure| {
        registration_failure(
            failure,
            "could not read whether the background service runs",
        )
    })
}

/// Fails with [`CommandFailure::SystemServiceRunsOtherProgram`] where `daemon_path` names a
/// program this account's system service does not start, and as the program's resolution or the
/// system service's read fails.
pub(crate) fn refuse_other_system_program(
    daemon_path: Option<&Path>,
    registration: ServiceRegistration,
) -> anyhow::Result<()> {
    let Some(daemon_path) = daemon_path else {
        return Ok(());
    };
    let service_program = registration.system_service_program().map_err(|failure| {
        registration_failure(failure, "could not read the system service's program")
    })?;
    if !names_registered_program(service_program.as_deref(), daemon_path)? {
        return Err(CommandFailure::SystemServiceRunsOtherProgram.into());
    }
    Ok(())
}

/// Whether `daemon_path` names `registered_program`, the one a registration starts, compared as
/// files; no registered program is never named. Fails as their resolution fails.
fn names_registered_program(
    registered_program: Option<&Path>,
    daemon_path: &Path,
) -> anyhow::Result<bool> {
    let named = daemon_program(Some(daemon_path))?;
    match registered_program {
        Some(registered_program) => is_same_program(registered_program, &named),
        None => Ok(false),
    }
}

/// Starts this account's system service through `registration` as `kickstart` asks, which needs
/// root's rights. Fails as [`registration_failure`] turns a refused start.
pub(crate) fn kickstart_system_service(
    registration: ServiceRegistration,
    kickstart: SystemServiceKickstart,
) -> anyhow::Result<()> {
    registration
        .kickstart_system_service(kickstart)
        .map_err(|failure| registration_failure(failure, "could not start the background service"))
}

/// Fails with [`CommandFailure::AppServiceTurnedOff`] where the status file reads that the app's
/// login agent is turned off in Login Items, and as the status file's read does.
fn refuse_app_turned_off() -> anyhow::Result<()> {
    if matches!(
        // The start this check serves replaces the file, so a torn one needs no warning.
        read_cannot_start(&mut io::sink())?,
        Some(DaemonCannotStart::TurnedOffInLoginItems {})
    ) {
        return Err(CommandFailure::AppServiceTurnedOff.into());
    }
    Ok(())
}

/// [`start_daemon`]'s body on its runtime.
async fn start_and_wait(
    daemon_path: Option<&Path>,
    deadline: Duration,
    mut on_repairing: impl FnMut(DaemonRepairingDetails),
) -> anyhow::Result<DaemonStart> {
    let endpoint = DaemonEndpoint::this_machine()
        .context("could not find where the background service listens")?;
    if is_daemon_answering(&endpoint, &mut on_repairing).await? {
        return Ok(DaemonStart::AlreadyRunning);
    }
    let registered_path = daemon_path.map(Path::to_owned);
    let route =
        tokio::task::spawn_blocking(move || start_registered_agent(registered_path.as_deref()))
            .await
            .context("the background service's start stopped before it answered")??;
    if let StartRoute::Agent = route {
        // The service manager owns the started process, so nothing here ends the wait early.
        let waited = wait_for_handshake(
            endpoint,
            deadline,
            &mut on_repairing,
            pending::<Infallible>(),
        )
        .await;
        return match waited {
            Ok(HandshakeWaitEnd::Connected(connection)) => {
                connection.close().await;
                Ok(DaemonStart::Started {
                    scope_refused: None,
                })
            }
            Ok(HandshakeWaitEnd::Ended(never)) => match never {},
            Err(failure) if is_not_ready_yet(&failure) => {
                Err(CommandFailure::RegisteredNotAnswering {
                    waited: deadline,
                    last_failure: failure,
                }
                .into())
            }
            Err(failure) => Err(failure.into()),
        };
    }
    let LastingChild {
        process, mut exit, ..
    } = spawn_daemon(daemon_path).await?;
    let scope_refused = leave_daemon_scope(process.id()).await.err();
    let waited =
        wait_for_handshake(endpoint.clone(), deadline, &mut on_repairing, exit.as_mut()).await;
    match waited {
        Ok(HandshakeWaitEnd::Connected(connection)) => {
            connection.close().await;
            Ok(DaemonStart::Started { scope_refused })
        }
        Ok(HandshakeWaitEnd::Ended(exited)) => {
            let status =
                exited.context("could not read how the background service's process ended")?;
            // Another start's daemon may have taken the data folder this one exited on.
            if is_daemon_answering(&endpoint, &mut on_repairing).await? {
                return Ok(DaemonStart::AlreadyRunning);
            }
            let exit = read_child_exit(&status, None);
            // The start this read serves replaces the file, so a torn one needs no warning.
            Err(match read_cannot_start(&mut io::sink()) {
                Ok(cannot_start) => CommandFailure::DaemonExited { exit, cannot_start }.into(),
                Err(unread) => anyhow::Error::from(CommandFailure::DaemonExited {
                    exit,
                    cannot_start: None,
                })
                .context(format!("{unread:#}")),
            })
        }
        Err(failure) => {
            // A daemon this command started and cannot vouch for would hold the socket against
            // every later start.
            end_unanswered_daemon(process, exit).await?;
            Err(if is_not_ready_yet(&failure) {
                CommandFailure::StartTimedOut {
                    waited: deadline,
                    last_failure: failure,
                }
                .into()
            } else {
                failure.into()
            })
        }
    }
}

/// Whether a daemon answers one handshake at `endpoint`, a daemon repairing its database file
/// among them, whose details go to `on_repairing`. Fails as the handshake does other than as a
/// starting daemon's does.
pub(crate) async fn is_daemon_answering(
    endpoint: &DaemonEndpoint,
    on_repairing: &mut impl FnMut(DaemonRepairingDetails),
) -> Result<bool, ClientError> {
    match DaemonConnection::connect_or_repairing(endpoint.clone()).await {
        Ok(OpenedConnection::Open(connection)) => {
            connection.close().await;
            Ok(true)
        }
        Ok(OpenedConnection::Repairing(repairing)) => {
            on_repairing(repairing.details());
            Ok(true)
        }
        Err(failure) if is_not_ready_yet(&failure) => Ok(false),
        Err(failure) => Err(failure),
    }
}

/// Starts the daemon's program as a lasting child in this command's folder and environment, its
/// error output discarded, on a blocking thread. Fails as the program's resolution, the current
/// folder's read or the start does.
async fn spawn_daemon(daemon_path: Option<&Path>) -> anyhow::Result<LastingChild> {
    let program = daemon_program(daemon_path)?;
    // Opened for writing too, since the child writes its error output to it.
    let error_output = OpenOptions::new()
        .read(true)
        .write(true)
        .open(NULL_DEVICE_PATH)
        .context("could not open the null device for the background service's error output")?;
    let command = LastingCommand {
        program: program.clone(),
        arguments: Vec::new(),
        environment: std::env::vars_os().collect(),
        working_folder: std::env::current_dir().context("could not read the current folder")?,
        error_output,
    };
    tokio::task::spawn_blocking(move || spawn_lasting_child(command))
        .await
        .context("the background service's start stopped before it answered")?
        .with_context(|| {
            format!(
                "could not start the background service's program {}",
                program.display()
            )
        })
}

/// Ends the started daemon `process` as one that never answered, then reaps it through `exit`.
/// Fails as the ending or the reap does.
async fn end_unanswered_daemon(process: PinnedProcess, exit: DaemonExit) -> anyhow::Result<()> {
    end_unanswered_process(&DaemonEndingTerms::default(), process)
        .await
        .context("could not stop the background service that did not answer")?;
    exit.await
        .context("could not read how the background service's process ended")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use sidekicks_client::error::ClientError;
    use sidekicks_platforms::SystemServiceState;
    use tokio::time::sleep;

    use super::wait_until_running;

    // Fails when a Ctrl-C during the wait for launchd is not listened for: the wait would then run
    // to its end and answer that the service did not start, instead of ending as canceled.
    #[tokio::test]
    async fn a_ctrl_c_before_the_service_runs_ends_the_wait_as_canceled() {
        let waited = wait_until_running(
            || Ok(SystemServiceState::NotRunning),
            Duration::from_secs(10),
            sleep(Duration::from_millis(50)),
        )
        .await;
        let failure = waited.expect_err("the Ctrl-C ends the wait");
        assert!(
            matches!(failure.downcast_ref(), Some(ClientError::Canceled)),
            "{failure:?}"
        );
    }
}
