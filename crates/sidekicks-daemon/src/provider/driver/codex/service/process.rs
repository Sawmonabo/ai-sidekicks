//! The Codex processes the daemon starts: a service on an account home it manages, which ends
//! with the daemon; the lasting service on the person's own Codex folder, which outlives it and
//! writes to one log per home; and a short command run to its end for what it prints.

use std::error::Error;
use std::future::Future;
use std::io::{self, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use process_wrap::tokio::ChildWrapper;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::run::control::ProcessExit;
use sidekicks_platforms::{
    CAN_SIGNAL_A_STOP, ChildEnd, PinnedProcess, ProcessRecord, Spawner, ask_child_to_stop,
    exit_signal_name, leave_daemon_scope, pin_child_process, prepare_lasting_child_command,
    wrap_child_command,
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt, AsyncWrite};
use tokio::process::{Child, ChildStderr, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::tungstenite::{self, Message};

use crate::process_exit::{OutputTail, compose_process_exit, wire_exit_code};

/// How much of the log a former start wrote is kept beside the new one.
const PREVIOUS_LOG_TAIL_BYTES: u64 = 256 * 1024;

/// The variable that opens a lasting service's shutdown socket; Codex reads it only on Windows.
const CODEX_DAEMON_SHUTDOWN_SOCKET_ENVIRONMENT_NAME: &str = "CODEX_DAEMON_SHUTDOWN_SOCKET";

/// The address Codex answers a shutdown request at, over its control socket.
const CODEX_SHUTDOWN_ADDRESS: &str = "ws://localhost/daemon/shutdown";

/// How long the shutdown request waits for the control socket's answer, as Codex's own does.
const CODEX_CONTROL_SOCKET_RESPONSE_TIMEOUT: Duration = Duration::from_secs(2);

/// The most a short command may print; the catalog dump, the largest, measured near 660 KB.
const CODEX_COMMAND_MAX_OUTPUT_BYTES: usize = 16 * 1024 * 1024;

/// What one Codex process runs: a service start or a short command.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexProcessLaunch {
    /// The resolved Codex program, absolute.
    pub(crate) program: PathBuf,
    /// The arguments after the program.
    pub(crate) arguments: Vec<String>,
    /// The whole environment; nothing is inherited from the daemon.
    pub(crate) environment: Vec<(String, String)>,
    /// The folder the process starts in.
    pub(crate) working_folder: PathBuf,
}

impl CodexProcessLaunch {
    // The command that runs the launch, on its own environment alone.
    fn into_command(self) -> Command {
        let mut command = Command::new(self.program);
        command
            .args(self.arguments)
            .env_clear()
            .envs(self.environment)
            .current_dir(self.working_folder);
        command
    }
}

/// A service's exit, read once from the task that waits on it.
struct ServiceExit(Option<oneshot::Receiver<io::Result<ProcessExit>>>);

impl ServiceExit {
    async fn read(&mut self) -> io::Result<ProcessExit> {
        let Some(answer) = self.0.as_mut() else {
            return Err(io::Error::other(
                "the Codex service's exit was already read",
            ));
        };
        let answered = answer.await;
        self.0 = None;
        answered.map_err(io::Error::other).and_then(|exit| exit)
    }
}

/// One Codex service on an account home the daemon manages: a child that ends with the daemon,
/// killed when this handle drops, with the tail of what it printed kept for its exit.
pub(crate) struct ManagedCodexService {
    process_id: Option<u32>,
    ends: mpsc::UnboundedSender<ChildEnd>,
    exit: ServiceExit,
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

    /// How the service ended: its code or signal and the tail of what it printed, answered once
    /// it has exited and both its outputs have ended. Fails when the wait or a read failed, or
    /// when the exit was already read.
    pub(crate) async fn exited(&mut self) -> io::Result<ProcessExit> {
        self.exit.read().await
    }

    fn ask_to_end(&self, end: ChildEnd) {
        if self.ends.send(end).is_err() {
            tracing::debug!("the Codex service had already exited when asked to end");
        }
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
    let (ends, ends_received) = mpsc::unbounded_channel();
    let (exit, exit_received) = oneshot::channel();
    tokio::spawn(own_managed_child(child, ends_received, exit));
    Ok(ManagedCodexService {
        process_id,
        ends,
        exit: ServiceExit(Some(exit_received)),
    })
}

// Owns a managed service's child: ends it as asked, a dropped handle as a kill, and answers its
// exit once it has exited and both its outputs have ended.
async fn own_managed_child(
    mut child: Box<dyn ChildWrapper>,
    mut ends: mpsc::UnboundedReceiver<ChildEnd>,
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
                end = ends.recv(), if is_handle_held => {
                    let end = end.unwrap_or_else(|| {
                        is_handle_held = false;
                        ChildEnd::Kill
                    });
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
            status.code(),
            exit_signal_name(&status, asked_end),
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

/// Where a lasting service's stop stands, for the exit its waiting task composes.
#[derive(Clone, Copy)]
enum AskedEnd {
    NotAsked,
    Asking,
    Asked(ChildEnd),
}

/// The lasting Codex service on the person's own Codex folder: a process that outlives the
/// daemon, held by its pinned identity so a later daemon finds the same one again.
pub(crate) struct LastingCodexService {
    process: PinnedProcess,
    record: ProcessRecord,
    asked_end: Arc<watch::Sender<AskedEnd>>,
    // Only for a service this daemon started, which is still its child.
    exit: Option<ServiceExit>,
}

impl LastingCodexService {
    /// What a later daemon re-pins this service from: its id and start time.
    pub(crate) fn record(&self) -> ProcessRecord {
        self.record
    }

    /// How a service this daemon started ended: its code or signal and the tail of its log's
    /// current start, or `None` for one a former daemon started, whose end reads as its
    /// connection's end and its log's tail. Fails when the wait or the log's read failed, or when
    /// the exit was already read.
    pub(crate) async fn exited(&mut self) -> Option<io::Result<ProcessExit>> {
        Some(self.exit.as_mut()?.read().await)
    }

    /// Stops the service and answers how it ended: on macOS and Linux `SIGTERM`, then `SIGKILL`
    /// once `grace` passes; on Windows first Codex's own shutdown request over the service's
    /// control socket, which `control_connection` opens, so a running reply finishes, then the
    /// forced end after `grace`. A failed shutdown request is logged and the stop goes on. Fails
    /// when the process could not be ended or its blocking stop failed to run.
    pub(crate) async fn stop<Connection>(
        &self,
        grace: Duration,
        control_connection: impl Future<Output = io::Result<Connection>>,
    ) -> io::Result<ChildEnd>
    where
        Connection: AsyncRead + AsyncWrite + Unpin,
    {
        if !CAN_SIGNAL_A_STOP {
            let requested = match control_connection.await {
                Ok(connection) => {
                    request_codex_service_shutdown(connection, self.process.id()).await
                }
                Err(error) => Err(CodexShutdownRequestError::Connect(error)),
            };
            if let Err(error) = requested {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    process_id = self.process.id(),
                    "the Codex service's shutdown request failed; it is ended after the grace"
                );
            }
        }
        let process = self.process.clone();
        let asked_end = Arc::clone(&self.asked_end);
        // The verdict is set inside the blocking stop, so a dropped caller still records it. Only
        // the forced end is the daemon's: a service that stopped within the grace ended itself,
        // so its exit keeps its own code or signal.
        tokio::task::spawn_blocking(move || {
            asked_end.send_replace(AskedEnd::Asking);
            let ended = process.stop(grace);
            asked_end.send_replace(match &ended {
                Ok(ChildEnd::Kill) => AskedEnd::Asked(ChildEnd::Kill),
                Ok(ChildEnd::Stop) | Err(_) => AskedEnd::NotAsked,
            });
            ended
        })
        .await
        .map_err(io::Error::other)?
    }
}

/// A lasting service that ended or could not be pinned as it started, with what its log holds.
#[derive(Debug, thiserror::Error)]
#[error("the started Codex service could not be recorded; its log reads: {output_tail}")]
struct UnrecordedServiceError {
    #[source]
    cause: io::Error,
    output_tail: String,
}

/// Starts the lasting Codex service on the person's own Codex folder on `spawner`'s thread: the
/// former start's log tail kept beside `log_file`, which is then truncated and takes the
/// service's error output, its own session apart from the daemon, pinned, then moved out of the
/// daemon's scope where the system has one. Fails when the log cannot be opened, the start cannot
/// be prepared or spawned (on Windows a refused breakaway from the daemon's job), or the started
/// process cannot be pinned, which ends it.
pub(crate) async fn start_lasting_codex_service(
    spawner: &Spawner,
    mut launch: CodexProcessLaunch,
    log_file: &Path,
) -> io::Result<LastingCodexService> {
    if let Err(error) = keep_previous_log_tail(log_file).await {
        tracing::warn!(
            error = &error as &(dyn Error + 'static),
            log_file = %log_file.display(),
            "the Codex service's previous log tail could not be kept"
        );
    }
    let log = tokio::fs::File::create(log_file).await?.into_std().await;
    launch.environment.push((
        CODEX_DAEMON_SHUTDOWN_SOCKET_ENVIRONMENT_NAME.to_owned(),
        "1".to_owned(),
    ));
    let mut command = launch.into_command();
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(log));
    prepare_lasting_child_command(&mut command)?;
    let mut child = spawner
        .run(move || command.spawn())
        .await
        .and_then(|spawned| spawned)?;
    let pinned = child
        .id()
        .ok_or_else(|| io::Error::other("the started Codex service has no process id"))
        .and_then(pin_child_process)
        .and_then(|process| {
            let record = process
                .record()?
                .ok_or_else(|| io::Error::other("the Codex service ended as it started"))?;
            Ok((process, record))
        });
    let (process, record) = match pinned {
        Ok(pinned) => pinned,
        Err(cause) => {
            end_unrecorded_child(&mut child).await;
            let output_tail = match read_codex_service_log_tail(log_file).await {
                Ok(output_tail) => output_tail,
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
    let (asked_end, asked_end_received) = watch::channel(AskedEnd::NotAsked);
    let (exit, exit_received) = oneshot::channel();
    tokio::spawn(wait_for_lasting_child(
        child,
        asked_end_received,
        log_file.to_owned(),
        exit,
    ));
    Ok(LastingCodexService {
        process,
        record,
        asked_end: Arc::new(asked_end),
        exit: Some(ServiceExit(Some(exit_received))),
    })
}

/// Finds again the lasting service a former daemon started, from the record it stored: `None`
/// when that process has ended or another now holds its id. Fails when the system's process read
/// fails.
pub(crate) fn repin_lasting_codex_service(
    record: ProcessRecord,
) -> io::Result<Option<LastingCodexService>> {
    Ok(record.pin()?.map(|process| LastingCodexService {
        process,
        record,
        asked_end: Arc::new(watch::channel(AskedEnd::NotAsked).0),
        exit: None,
    }))
}

// Kills and reaps a lasting service that could not be pinned, so nothing unrecorded outlives the
// start.
async fn end_unrecorded_child(child: &mut Child) {
    if let Err(error) = child.start_kill() {
        tracing::warn!(
            error = &error as &(dyn Error + 'static),
            "the unrecorded Codex service could not be killed"
        );
    }
    if let Err(error) = child.wait().await {
        tracing::warn!(
            error = &error as &(dyn Error + 'static),
            "the unrecorded Codex service could not be waited for"
        );
    }
}

// Reaps a lasting service this daemon started and answers its exit, with its log's tail.
async fn wait_for_lasting_child(
    mut child: Child,
    mut asked_end: watch::Receiver<AskedEnd>,
    log_file: PathBuf,
    exit: oneshot::Sender<io::Result<ProcessExit>>,
) {
    let composed = async {
        let status = child.wait().await?;
        // A stop under way names the end it asked for once it returns; a dropped handle asked none.
        let asked = match asked_end
            .wait_for(|asked| !matches!(asked, AskedEnd::Asking))
            .await
            .map(|asked| *asked)
        {
            Ok(AskedEnd::Asked(end)) => Some(end),
            Ok(AskedEnd::NotAsked | AskedEnd::Asking) | Err(_) => None,
        };
        let tail = read_log_output_tail(&log_file).await?;
        Ok::<_, io::Error>(compose_process_exit(
            status.code(),
            exit_signal_name(&status, asked),
            tail,
        ))
    }
    .await;
    if exit.send(composed).is_err() {
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

/// The log of the lasting service on `codex_home`, in the daemon's `logs_folder`: one per home,
/// named by the first 16 hex digits of the home path's `blake3` hash, so nothing is written into
/// the home itself.
pub(crate) fn codex_service_log_file(logs_folder: &Path, codex_home: &Path) -> PathBuf {
    let key = blake3::hash(codex_home.as_os_str().as_encoded_bytes()).to_hex();
    logs_folder.join(format!("codex-service-{}.log", &key.as_str()[..16]))
}

// The former start's tail beside the log: `codex-service-<key>.previous.log`.
fn previous_log_file(log_file: &Path) -> PathBuf {
    log_file.with_extension("previous.log")
}

// Keeps the last stretch of the former start's log beside it, written to a temporary file and
// renamed into place; a missing or empty log leaves the last kept tail as it was.
async fn keep_previous_log_tail(log_file: &Path) -> io::Result<()> {
    match tokio::fs::symlink_metadata(log_file).await {
        Ok(metadata) if metadata.is_file() && metadata.len() > 0 => {}
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    }
    let bytes = read_last_bytes(log_file, PREVIOUS_LOG_TAIL_BYTES).await?;
    let previous = previous_log_file(log_file);
    let temporary = previous.with_extension("log.tmp");
    let kept = async {
        tokio::fs::write(&temporary, &bytes).await?;
        tokio::fs::rename(&temporary, &previous).await
    }
    .await;
    if kept.is_err()
        && let Err(error) = tokio::fs::remove_file(&temporary).await
        && error.kind() != io::ErrorKind::NotFound
    {
        tracing::warn!(
            error = &error as &(dyn Error + 'static),
            temporary_file = %temporary.display(),
            "the previous log tail's temporary file could not be removed"
        );
    }
    kept
}

// The last `count` bytes of `file`, or all of it when it is shorter.
async fn read_last_bytes(file: &Path, count: u64) -> io::Result<Vec<u8>> {
    let mut opened = tokio::fs::File::open(file).await?;
    let length = opened.metadata().await?.len();
    opened
        .seek(SeekFrom::Start(length.saturating_sub(count)))
        .await?;
    let mut bytes = Vec::new();
    opened.take(count).read_to_end(&mut bytes).await?;
    Ok(bytes)
}

/// The tail of what the lasting service wrote to `log_file` since its current start, as a
/// failure reports it, for a service this daemon did not start. Fails when the log cannot be
/// read.
pub(crate) async fn read_codex_service_log_tail(log_file: &Path) -> io::Result<String> {
    Ok(read_log_output_tail(log_file).await?.into_text())
}

async fn read_log_output_tail(
    log_file: &Path,
) -> io::Result<OutputTail<PROVIDER_FAILURE_DETAIL_MAX_LEN>> {
    // At most four bytes a code point, and three more for a sequence the start cuts into, so the
    // bytes read hold the whole tail however the log is written.
    let count = u64::try_from(4 * PROVIDER_FAILURE_DETAIL_MAX_LEN + 3)
        .expect("the tail's byte count fits 64 bits");
    let mut tail = OutputTail::new();
    tail.push(&read_last_bytes(log_file, count).await?);
    Ok(tail)
}

/// Why a short Codex command gave no output.
#[derive(Debug, thiserror::Error)]
pub(crate) enum CodexCommandError {
    /// The command could not start.
    #[error("the Codex command could not start")]
    Start(#[source] io::Error),
    /// Its output could not be read.
    #[error("the Codex command's output could not be read")]
    Read(#[source] io::Error),
    /// The wait for its exit failed.
    #[error("the Codex command's exit could not be waited for")]
    Wait(#[source] io::Error),
    /// It printed more than the cap.
    #[error("the Codex command printed more than {limit} bytes")]
    OutputTooLarge {
        /// The cap, in bytes.
        limit: usize,
    },
    /// Its deadline passed before it ended.
    #[error("the Codex command did not end within {deadline:?}")]
    DeadlinePassed {
        /// The deadline it was given.
        deadline: Duration,
        /// The timer's end.
        #[source]
        elapsed: tokio::time::error::Elapsed,
    },
    /// It could not be ended once past its deadline or its cap.
    #[error("the Codex command could not be ended")]
    End(#[source] io::Error),
    /// It exited with a failure code.
    #[error("the Codex command exited with code {exit_code}")]
    Failed {
        /// The exit code, a Windows code read as its unsigned 32-bit value.
        exit_code: i64,
    },
    /// A signal ended it.
    #[error("the Codex command was ended by {signal}")]
    Signaled {
        /// The signal's name.
        signal: String,
    },
    /// What it printed is not UTF-8 text.
    #[error("the Codex command's output is not UTF-8 text")]
    NotText(#[source] std::string::FromUtf8Error),
}

/// Runs a short Codex command to its end on `spawner`'s thread, armed to end with the daemon, and
/// answers its standard output; its input is closed and its error output discarded. Fails with
/// [`CodexCommandError`] when it cannot start, prints past 16 MiB, outlives `deadline` (both of
/// which kill it), exits with a failure code or a signal, or prints anything but UTF-8 text.
pub(crate) async fn run_codex_command(
    spawner: &Spawner,
    launch: CodexProcessLaunch,
    deadline: Duration,
) -> Result<String, CodexCommandError> {
    let mut command = launch.into_command();
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let daemon_pid = std::process::id();
    let mut child = spawner
        .run(move || wrap_child_command(command, daemon_pid).spawn())
        .await
        .and_then(|spawned| spawned)
        .map_err(CodexCommandError::Start)?;
    let standard_output = child
        .stdout()
        .take()
        .expect("the command's standard output is piped");
    let ran =
        tokio::time::timeout(deadline, read_to_end_and_wait(&mut *child, standard_output)).await;
    let (output, status) = match ran {
        Ok(ended) => ended?,
        Err(elapsed) => {
            end_command(&mut *child).await?;
            return Err(CodexCommandError::DeadlinePassed { deadline, elapsed });
        }
    };
    if !status.success() {
        return Err(match exit_signal_name(&status, None) {
            Some(signal) => CodexCommandError::Signaled { signal },
            None => CodexCommandError::Failed {
                exit_code: wire_exit_code(status.code()),
            },
        });
    }
    String::from_utf8(output).map_err(CodexCommandError::NotText)
}

// Reads the command's output to its end, killing it past the cap, then waits for its exit.
async fn read_to_end_and_wait(
    child: &mut dyn ChildWrapper,
    standard_output: ChildStdout,
) -> Result<(Vec<u8>, std::process::ExitStatus), CodexCommandError> {
    let limit = u64::try_from(CODEX_COMMAND_MAX_OUTPUT_BYTES).expect("the output cap fits 64 bits");
    let mut output = Vec::new();
    standard_output
        .take(limit + 1)
        .read_to_end(&mut output)
        .await
        .map_err(CodexCommandError::Read)?;
    if output.len() > CODEX_COMMAND_MAX_OUTPUT_BYTES {
        end_command(child).await?;
        return Err(CodexCommandError::OutputTooLarge {
            limit: CODEX_COMMAND_MAX_OUTPUT_BYTES,
        });
    }
    let status = child.wait().await.map_err(CodexCommandError::Wait)?;
    Ok((output, status))
}

// Kills a command past its deadline or its cap and reaps it.
async fn end_command(child: &mut dyn ChildWrapper) -> Result<(), CodexCommandError> {
    child.start_kill().map_err(CodexCommandError::End)?;
    child.wait().await.map_err(CodexCommandError::End)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fmt::Write as _;

    use super::{PREVIOUS_LOG_TAIL_BYTES, keep_previous_log_tail, previous_log_file};

    // Fails when the keep copies the whole log, or its first 256 KiB instead of its last.
    #[tokio::test]
    async fn the_previous_log_keeps_exactly_the_last_256_kib_and_leaves_the_log_alone() {
        let folder = tempfile::tempdir().expect("a scratch folder is made");
        let log_file = folder.path().join("codex-service-0123456789abcdef.log");
        let mut log = String::new();
        let mut line = 0_u32;
        while log.len() < 300 * 1024 {
            writeln!(log, "line {line:06}").expect("a line is written into a string");
            line += 1;
        }
        log.truncate(300 * 1024);
        std::fs::write(&log_file, &log).expect("the log is written");

        keep_previous_log_tail(&log_file)
            .await
            .expect("the previous tail is kept");

        let kept = std::fs::read(previous_log_file(&log_file)).expect("the previous tail is read");
        let kept_len = usize::try_from(PREVIOUS_LOG_TAIL_BYTES).expect("256 KiB fits a usize");
        assert_eq!(kept.len(), kept_len);
        assert_eq!(kept.as_slice(), &log.as_bytes()[log.len() - kept_len..]);
        assert_eq!(
            std::fs::read(&log_file).expect("the log is read"),
            log.as_bytes()
        );
    }
}
