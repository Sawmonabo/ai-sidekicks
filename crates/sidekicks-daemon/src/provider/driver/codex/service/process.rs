//! The Codex services the daemon starts: one on an account home it manages, which ends with the
//! daemon, and the lasting service on the person's own Codex folder, which outlives it, writes to
//! one log per folder and is found again from its record; their stops, the lasting service's
//! drain and Codex's own shutdown request.

use std::error::Error;
use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::Arc;
use std::time::Duration;

use futures::future::{BoxFuture, Shared};
use futures::{FutureExt as _, SinkExt, StreamExt};
use process_wrap::tokio::ChildWrapper;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::run::control::ProcessExit;
use sidekicks_platforms::{
    CAN_SIGNAL_A_STOP, ChildEnd, LastingChild, LastingCommand, PinnedProcess, ProcessRecord,
    Spawner, ask_child_to_stop, connect_unix_domain_socket, lasting_child_asked_end,
    leave_daemon_scope, read_child_exit, spawn_lasting_child, wrap_child_command,
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite};
use tokio::process::{ChildStderr, ChildStdout, Command};
use tokio::sync::{oneshot, watch};
use tokio_tungstenite::tungstenite::{self, Message};

use crate::process_exit::{OutputTail, compose_process_exit};
use crate::provider::service_log::{open_provider_service_log, read_provider_service_log_tail};

/// The variable that opens a lasting service's shutdown socket; Codex reads it only on Windows.
const CODEX_DAEMON_SHUTDOWN_SOCKET_ENVIRONMENT_NAME: &str = "CODEX_DAEMON_SHUTDOWN_SOCKET";

/// The value that variable takes.
const CODEX_DAEMON_SHUTDOWN_SOCKET_ENVIRONMENT_VALUE: &str = "1";

/// The `NAME=value` entry every lasting service and what it starts carries, which marks what a
/// former daemon's service left running for `ProcessRecord::end_survivors`.
pub(crate) fn codex_lasting_service_environment_entry() -> String {
    format!(
        "{CODEX_DAEMON_SHUTDOWN_SOCKET_ENVIRONMENT_NAME}={CODEX_DAEMON_SHUTDOWN_SOCKET_ENVIRONMENT_VALUE}"
    )
}

/// The address Codex answers a shutdown request at, over its control socket.
const CODEX_SHUTDOWN_ADDRESS: &str = "ws://localhost/daemon/shutdown";

/// How long the shutdown request waits for the control socket's answer, as Codex's own does.
const CODEX_CONTROL_SOCKET_RESPONSE_TIMEOUT: Duration = Duration::from_secs(2);

/// What one Codex process runs: a service start or a short command.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexProcessLaunch {
    /// The native Codex program, absolute, never the npm launcher, which would leave its native
    /// child unpinned: `resolve_codex_native_program` gives it.
    pub(crate) program: PathBuf,
    /// The arguments after the program.
    pub(crate) arguments: Vec<String>,
    /// The whole environment, the launcher's variables set over it by
    /// `CodexNativeProgram::set_launcher_environment`; nothing is inherited from the daemon.
    pub(crate) environment: Vec<(String, String)>,
    /// The folder the process starts in.
    pub(crate) working_folder: PathBuf,
}

impl CodexProcessLaunch {
    /// The command that runs the launch, on its own environment alone.
    pub(super) fn into_command(self) -> Command {
        let mut command = Command::new(self.program);
        command
            .args(self.arguments)
            .env_clear()
            .envs(self.environment)
            .current_dir(self.working_folder);
        command
    }
}

/// How a Codex service the daemon started ended, answered once it has: its code or signal and the
/// tail of what it printed. Every clone answers the same exit, so the supervisor's exit watch and
/// a stop's wait both read it. Fails when the wait or a read failed.
pub(crate) type CodexServiceExit = Shared<BoxFuture<'static, Result<ProcessExit, Arc<io::Error>>>>;

// The exit the task waiting on the process answers, shared by every reader.
fn share_service_exit(answer: oneshot::Receiver<io::Result<ProcessExit>>) -> CodexServiceExit {
    async move {
        answer
            .await
            .map_err(io::Error::other)
            .and_then(|exit| exit)
            .map_err(Arc::new)
    }
    .boxed()
    .shared()
}

/// One Codex service on an account home the daemon manages: a child that ends with the daemon,
/// killed when this handle drops, with the tail of what it printed kept for its exit.
pub(crate) struct ManagedCodexService {
    process_id: Option<u32>,
    // The end asked last; a kill is never replaced by a stop.
    ends: watch::Sender<Option<ChildEnd>>,
    exit: CodexServiceExit,
}

impl ManagedCodexService {
    /// The process's id, or `None` when the system gave it none.
    pub(crate) fn process_id(&self) -> Option<u32> {
        self.process_id
    }

    /// Asks the service to stop; its exit answers once it has.
    pub(crate) fn stop(&self) {
        self.ask_to_end(ChildEnd::Stop);
    }

    /// Ends the service at once, for one that did not stop when asked.
    pub(crate) fn kill(&self) {
        self.ask_to_end(ChildEnd::Kill);
    }

    /// How the service ended, answered once it has exited and both its outputs have ended.
    pub(crate) fn exited(&self) -> CodexServiceExit {
        self.exit.clone()
    }

    fn ask_to_end(&self, end: ChildEnd) {
        self.ends.send_if_modified(|asked| {
            let is_changed = *asked != Some(ChildEnd::Kill) && *asked != Some(end);
            if is_changed {
                *asked = Some(end);
            }
            is_changed
        });
    }
}

/// Starts a Codex service on an account home the daemon manages, on `spawner`'s thread, armed to
/// end with the daemon, its standard input closed and both outputs kept in one tail. Fails with
/// the spawn's error, or the spawner's when its thread has ended.
pub(crate) async fn start_managed_codex_service(
    spawner: &Spawner,
    launch: CodexProcessLaunch,
) -> io::Result<ManagedCodexService> {
    let mut command = launch.into_command();
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let daemon_pid = std::process::id();
    let child = spawner
        .run(move || wrap_child_command(command, daemon_pid).spawn())
        .await
        .and_then(|spawned| spawned)?;
    let process_id = child.id();
    let (ends, ends_received) = watch::channel(None);
    let (exit, exit_received) = oneshot::channel();
    tokio::spawn(own_managed_child(child, ends_received, exit));
    Ok(ManagedCodexService {
        process_id,
        ends,
        exit: share_service_exit(exit_received),
    })
}

// Owns a managed service's child: ends it as asked, a dropped handle as a kill, and answers its
// exit once it has exited and both its outputs have ended.
async fn own_managed_child(
    mut child: Box<dyn ChildWrapper>,
    mut ends: watch::Receiver<Option<ChildEnd>>,
    exit: oneshot::Sender<io::Result<ProcessExit>>,
) {
    let standard_output = child
        .stdout()
        .take()
        .expect("the service's standard output is piped");
    let standard_error = child
        .stderr()
        .take()
        .expect("the service's standard error is piped");
    let waiting = async {
        let mut asked_end = None;
        let mut is_handle_held = true;
        loop {
            tokio::select! {
                biased;
                status = child.wait() => break status.map(|status| (status, asked_end)),
                changed = ends.changed(), if is_handle_held => {
                    let end = if changed.is_ok() {
                        let Some(end) = *ends.borrow_and_update() else {
                            continue;
                        };
                        end
                    } else {
                        is_handle_held = false;
                        ChildEnd::Kill
                    };
                    // A stop asked after a kill changes nothing.
                    if matches!(asked_end, Some(ChildEnd::Kill)) {
                        continue;
                    }
                    let asked = match end {
                        ChildEnd::Stop => ask_child_to_stop(&mut *child),
                        ChildEnd::Kill => child.start_kill(),
                    };
                    if let Err(error) = asked {
                        tracing::warn!(
                            error = &error as &(dyn Error + 'static),
                            "the Codex service could not be asked to end"
                        );
                    }
                    asked_end = Some(end);
                }
            }
        }
    };
    let (waited, read) = tokio::join!(waiting, read_output_tail(standard_output, standard_error));
    let composed = match (waited, read) {
        (Ok((status, asked_end)), Ok(tail)) => Ok(compose_process_exit(
            read_child_exit(&status, asked_end),
            tail,
        )),
        (Err(error), _) | (_, Err(error)) => Err(error),
    };
    if exit.send(composed).is_err() {
        tracing::debug!("the Codex service's handle dropped before its exit");
    }
}

// Reads both outputs to their ends into one tail, chunk by chunk as each arrives.
async fn read_output_tail(
    mut standard_output: ChildStdout,
    mut standard_error: ChildStderr,
) -> io::Result<OutputTail<PROVIDER_FAILURE_DETAIL_MAX_LEN>> {
    let mut tail = OutputTail::new();
    let mut output_chunk = vec![0; 8192];
    let mut error_chunk = vec![0; 8192];
    let mut is_output_open = true;
    let mut is_error_open = true;
    while is_output_open || is_error_open {
        tokio::select! {
            read = standard_output.read(&mut output_chunk), if is_output_open => match read? {
                0 => is_output_open = false,
                length => tail.push(&output_chunk[..length]),
            },
            read = standard_error.read(&mut error_chunk), if is_error_open => match read? {
                0 => is_error_open = false,
                length => tail.push(&error_chunk[..length]),
            },
        }
    }
    Ok(tail)
}

/// The lasting Codex service on the person's own Codex folder: a process that outlives the
/// daemon, held by its pinned identity so a later daemon finds the same one again.
pub(crate) struct LastingCodexService {
    process: PinnedProcess,
    record: ProcessRecord,
    // Only for a service this daemon started, which is still its child.
    exit: Option<CodexServiceExit>,
}

impl LastingCodexService {
    /// What a later daemon re-pins this service from, which the daemon keeps in the service's
    /// record file.
    pub(crate) fn record(&self) -> &ProcessRecord {
        &self.record
    }

    /// How a service this daemon started ended: its code or signal and the tail of its log's
    /// current start, or `None` for one a former daemon started, whose end reads as its
    /// connection's end and its log's tail. The exit arrives once the process ends, which can be
    /// while a `stop` is still under way, since one exit wakes both.
    pub(crate) fn exited(&self) -> Option<CodexServiceExit> {
        self.exit.clone()
    }

    /// Whether the process has ended, read from the system through its pin; for a service a former
    /// daemon started, whose exit no wait answers. Fails with the system's error.
    pub(crate) fn has_ended(&self) -> io::Result<bool> {
        Ok(self.process.record()?.is_none())
    }

    /// Stops the service and answers how it ended: on macOS and Linux `SIGTERM`, then `SIGKILL`
    /// once `grace` passes; on Windows first Codex's own shutdown request over the service's
    /// control socket at `control_socket`, so a running reply finishes, then the forced end after
    /// `grace`. A failed shutdown request is logged and the stop goes on. Fails when the process
    /// could not be ended or its blocking stop failed to run.
    pub(crate) async fn stop(
        &self,
        grace: Duration,
        control_socket: &Path,
    ) -> io::Result<ChildEnd> {
        if !CAN_SIGNAL_A_STOP && let Err(error) = self.request_shutdown(control_socket).await {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                process_id = self.process.id(),
                "the Codex service's shutdown request failed; it is ended after the grace"
            );
        }
        let process = self.process.clone();
        tokio::task::spawn_blocking(move || process.stop(grace))
            .await
            .map_err(io::Error::other)?
    }

    /// Asks the service to drain, Codex's own graceful end, after which it refuses new turns,
    /// finishes its running replies, disconnects every client and exits by itself, with no kill
    /// after it: on macOS and Linux a hang-up through its pin, on Windows Codex's own shutdown
    /// request over its control socket at `control_socket`, a second of which would force a
    /// running reply, so a service is asked once. Answers whether the ask was delivered, `false`
    /// for a service already ended. Fails with the signal's error or the request's.
    pub(crate) async fn ask_to_drain(&self, control_socket: &Path) -> io::Result<bool> {
        if CAN_SIGNAL_A_STOP {
            return self.process.hang_up();
        }
        match self.request_shutdown(control_socket).await {
            Ok(()) => Ok(true),
            Err(_unreached) if self.has_ended()? => Ok(false),
            Err(error) => Err(io::Error::other(error)),
        }
    }

    // Sends Codex's own shutdown request to the service over its control socket.
    async fn request_shutdown(
        &self,
        control_socket: &Path,
    ) -> Result<(), CodexShutdownRequestError> {
        let connection = connect_unix_domain_socket(control_socket)
            .await
            .map_err(CodexShutdownRequestError::Connect)?;
        request_codex_service_shutdown(connection, self.process.id()).await
    }

    /// Waits with no bound and no thread for the service's end, for one asked to drain. Dropping
    /// the wait calls it off. Fails with the system's error.
    pub(crate) async fn wait_for_end(&self) -> io::Result<()> {
        self.process.wait_for_end().await
    }
}

/// A lasting service that could not be started or pinned, with what its log holds.
#[derive(Debug, thiserror::Error)]
#[error("the started Codex service could not be recorded; its log reads: {output_tail}")]
struct UnrecordedServiceError {
    #[source]
    cause: io::Error,
    output_tail: String,
}

/// Starts the lasting Codex service on the person's own Codex folder on `spawner`'s thread: its
/// log begun again at `log_file`, the former start's tail kept beside it, taking the service's
/// error output; a session or job of its own apart from the daemon's, pinned, then moved out of
/// the daemon's scope where the system has one. The caller keeps its record in the folder's record
/// file. Fails when the log cannot be opened, or the start cannot be spawned or pinned (on Windows
/// a refused breakaway from the daemon's job among them), with the log's tail beside the cause.
pub(crate) async fn start_lasting_codex_service(
    spawner: &Spawner,
    mut launch: CodexProcessLaunch,
    log_file: &Path,
) -> io::Result<LastingCodexService> {
    let error_output = open_provider_service_log(log_file).await?;
    launch.environment.push((
        CODEX_DAEMON_SHUTDOWN_SOCKET_ENVIRONMENT_NAME.to_owned(),
        CODEX_DAEMON_SHUTDOWN_SOCKET_ENVIRONMENT_VALUE.to_owned(),
    ));
    let command = LastingCommand {
        program: launch.program,
        arguments: launch.arguments,
        environment: launch.environment,
        working_folder: launch.working_folder,
        error_output,
    };
    let started = spawner
        .run(move || spawn_lasting_child(command))
        .await
        .and_then(|spawned| spawned);
    let LastingChild {
        process,
        record,
        exit,
    } = match started {
        Ok(started) => started,
        Err(cause) => {
            let output_tail = match read_provider_service_log_tail(log_file).await {
                Ok(output_tail) => output_tail.into_text(),
                Err(error) => {
                    tracing::warn!(
                        error = &error as &(dyn Error + 'static),
                        log_file = %log_file.display(),
                        "the unrecorded Codex service's log could not be read"
                    );
                    "(the log could not be read)".to_owned()
                }
            };
            return Err(io::Error::other(UnrecordedServiceError {
                cause,
                output_tail,
            }));
        }
    };
    if let Err(error) = leave_daemon_scope(process.id()).await {
        tracing::warn!(
            error = &error as &(dyn Error + 'static),
            process_id = process.id(),
            "the Codex service could not leave the daemon's scope"
        );
    }
    let (exit_sender, exit_received) = oneshot::channel();
    tokio::spawn(wait_for_lasting_child(
        exit,
        log_file.to_owned(),
        exit_sender,
    ));
    Ok(LastingCodexService {
        process,
        record,
        exit: Some(share_service_exit(exit_received)),
    })
}

/// Finds again the lasting service a former daemon started, from the record it kept: `None` when
/// that process has ended or another now holds its id. Fails when the system's process read
/// fails.
pub(crate) fn repin_lasting_codex_service(
    record: ProcessRecord,
) -> io::Result<Option<LastingCodexService>> {
    Ok(record.pin()?.map(|process| LastingCodexService {
        process,
        record,
        exit: None,
    }))
}

// Waits for the exit of a lasting service this daemon started and answers it, with its log's
// tail; a kill by this daemon reads from the exit itself.
async fn wait_for_lasting_child(
    exit: impl Future<Output = io::Result<ExitStatus>>,
    log_file: PathBuf,
    exit_sender: oneshot::Sender<io::Result<ProcessExit>>,
) {
    let composed = async {
        let status = exit.await?;
        let tail = read_provider_service_log_tail(&log_file).await?;
        Ok::<_, io::Error>(compose_process_exit(
            read_child_exit(&status, lasting_child_asked_end(&status)),
            tail,
        ))
    }
    .await;
    if exit_sender.send(composed).is_err() {
        tracing::debug!("the lasting Codex service's handle dropped before its exit");
    }
}

/// Why Codex's shutdown request over a lasting service's control socket failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum CodexShutdownRequestError {
    /// The control socket could not be reached.
    #[error("the Codex service's control socket could not be reached")]
    Connect(#[source] io::Error),
    /// The control socket did not answer in time.
    #[error("the Codex service's shutdown socket did not answer in time")]
    TimedOut(#[source] tokio::time::error::Elapsed),
    /// The socket refused the handshake.
    #[error("the Codex service's shutdown socket refused the handshake")]
    Handshake(#[source] Box<tungstenite::Error>),
    /// The request could not be sent.
    #[error("the shutdown request could not be sent")]
    Send(#[source] Box<tungstenite::Error>),
    /// The socket closed before answering.
    #[error("the shutdown socket closed without an acknowledgment")]
    Closed,
    /// The answer could not be read.
    #[error("the shutdown socket's answer could not be read")]
    Read(#[source] Box<tungstenite::Error>),
    /// The answer was not the process's own id.
    #[error("the shutdown acknowledgment did not name process {process_id}")]
    NotAcknowledged {
        /// The process the request named.
        process_id: u32,
    },
    /// The socket could not be closed after the acknowledgment.
    #[error("the shutdown socket could not be closed")]
    Close(#[source] Box<tungstenite::Error>),
}

/// Sends Codex's shutdown request for `process_id` over `stream`, a connection to the service's
/// control socket, and waits for Codex to echo the id back, all within two seconds. Fails with
/// [`CodexShutdownRequestError`] naming the step that failed.
pub(crate) async fn request_codex_service_shutdown<Stream>(
    stream: Stream,
    process_id: u32,
) -> Result<(), CodexShutdownRequestError>
where
    Stream: AsyncRead + AsyncWrite + Unpin,
{
    tokio::time::timeout(CODEX_CONTROL_SOCKET_RESPONSE_TIMEOUT, async {
        let (mut websocket, _response) =
            tokio_tungstenite::client_async(CODEX_SHUTDOWN_ADDRESS, stream)
                .await
                .map_err(Box::new)
                .map_err(CodexShutdownRequestError::Handshake)?;
        let expected = process_id.to_string();
        websocket
            .send(Message::Text(expected.clone().into()))
            .await
            .map_err(Box::new)
            .map_err(CodexShutdownRequestError::Send)?;
        let reply = websocket
            .next()
            .await
            .ok_or(CodexShutdownRequestError::Closed)?
            .map_err(Box::new)
            .map_err(CodexShutdownRequestError::Read)?;
        let is_acknowledged = if let Message::Text(acknowledgment) = &reply {
            acknowledgment.as_str() == expected
        } else {
            false
        };
        if !is_acknowledged {
            return Err(CodexShutdownRequestError::NotAcknowledged { process_id });
        }
        websocket
            .close(None)
            .await
            .map_err(Box::new)
            .map_err(CodexShutdownRequestError::Close)
    })
    .await
    .map_err(CodexShutdownRequestError::TimedOut)?
}
