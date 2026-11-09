//! One live Claude Code process: started on the daemon's spawner thread, written through one
//! ordered input queue, read by one output reader, and owned by one task that ends it as asked
//! and reads its exit once both its exit and its error output have ended. The exit closes the
//! control table and the input, then reaches the session's listener last, after every frame.

pub(crate) mod account;
mod stdin;
mod stdout;

use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt;
use futures::future::BoxFuture;
use process_wrap::tokio::ChildWrapper;
use secrecy::SecretString;
use serde::Serialize;
use serde_json::value::RawValue;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::run::control::ProcessExit;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::{
    ChildEnd, ChildExit, ProgramStart, Spawner, read_child_exit, secret_pipe,
};
use sidekicks_std::output_tail::{OutputTail, read_output_chunks};
use sidekicks_std::port_registration::PortRegistration;
use tokio::io::AsyncRead;
use tokio::sync::watch;
use tokio::time::{Instant, timeout, timeout_at};

use self::account::ClaudeProcessAccount;
use self::stdin::ClaudeInputWriter;
pub(crate) use self::stdout::{CLAUDE_OUTPUT_LINE_MAX_BYTES, ClaudeOutputReader};
use crate::child_ending::{ChildEnding, ChildEnds};
use crate::driver::child_records::{
    ChildRecord, ChildSecret, DaemonChildRecords, RecordedChild, spawn_recorded_child,
};
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::run::routes::ClaudeRunRoutes;
use crate::driver::claude::session::control_requests::{
    ClaudeAccountMoveMarker, ClaudeControlRequests,
};
use crate::driver::claude::session::errors::{ClaudeSessionError, ClaudeUnansweredCause};
use crate::driver::claude::session::transport::CLAUDE_REQUEST_DEADLINE;
use crate::driver::claude::session::transport::channel::ClaudeProcessChannel;
use crate::driver::claude::session::transport::control::{
    ClaudeControlRequest, ClaudeControlSubtype,
};
use crate::driver::claude::session::transport::declarations;
use crate::driver::claude::session::transport::inbound::{
    ClaudeControlAnswer, ClaudeInboundRequestEvent,
};
use crate::driver::claude::session::transport::user_message::{
    ClaudeUserFrame, ClaudeWriteAttempt,
};
use crate::driver::claude::spawn::arguments::CLAUDE_SETTINGS_FLAG;
use crate::driver::claude::spawn::command::compose_claude_command;
use crate::driver::claude::spawn::environment::CLAUDE_OAUTH_TOKEN_DESCRIPTOR_VARIABLE;
use crate::driver::claude::spawn::launch::ClaudeLaunchError;
use crate::driver::claude::spawn::settings::ClaudeSpawnSettings;
use crate::driver::claude::spawn::settings::private_file::ClaudeSpawnSettingsFile;
use crate::port::raw_provider_messages::RawProviderMessages;
use crate::pricing::receiver::TelemetryTarget;
use crate::pricing::receiver::bearers::TelemetryHolderId;
use crate::process_exit::compose_process_exit;
use crate::process_identity::ProviderProcessIdentity;
use crate::process_registry::ProviderProcessRegistry;

/// How long a process asked to stop has before it is killed.
const CLAUDE_STOP_KILL_GRACE: Duration = Duration::from_secs(5);

/// How long `initialize` waits for its answer outside the start-up hooks Claude Code runs.
const CLAUDE_INITIALIZE_DEADLINE: Duration = Duration::from_secs(60);

/// How long `initialize` waits for its answer in all, start-up hooks included.
const CLAUDE_INITIALIZE_TOTAL_DEADLINE: Duration = Duration::from_mins(10);

/// How a Claude Code process ended: its exit, or the failure that kept its exit from being read.
pub(crate) type ClaudeProcessEnd = Result<ProcessExit, Arc<io::Error>>;

/// What one Claude Code process runs and for whom.
pub(crate) struct ClaudeProcessLaunch {
    /// The resolved program and the arguments put before the command line.
    pub(crate) start: ProgramStart,
    /// The command line after the program, before `--settings` and its file.
    pub(crate) arguments: Vec<String>,
    /// The settings document, which the process reads from a file of its own.
    pub(crate) settings: ClaudeSpawnSettings,
    /// The whole environment; nothing is inherited from the daemon.
    pub(crate) environment: Vec<(String, String)>,
    /// The folder the process starts in.
    pub(crate) working_folder: PathBuf,
    /// The provider session the process runs, named in its diagnostics.
    pub(crate) provider_session_id: String,
    /// The account whose home it runs on, named in its diagnostics as it is now, a session's
    /// shared with its stream; empty for a short read that names no account.
    pub(crate) account: ClaudeProcessAccount,
    /// The pasted token the process signs in with, handed on the pipe its environment names and
    /// never as a variable; the launcher reads the one sealed for a pasted token's account where
    /// this is `None`.
    pub(crate) token: Option<SecretString>,
    /// Where the process exports its telemetry, under a token of its own minted at its start;
    /// `None` before the target is registered, and every exporter is off.
    pub(crate) telemetry_target: Option<Arc<TelemetryTarget>>,
}

/// One stream frame the process wrote, with the facts it is routed by.
#[derive(Clone, Debug)]
pub(crate) struct ClaudeStreamFrame {
    /// The frame's text, as read.
    pub(crate) text: String,
    /// What routes it.
    pub(crate) observation: declarations::ClaudeInboundFrameObservation,
}

/// Takes what one process writes, on its reader and in the order read; every call returns at
/// once, never waiting on the session's task, so control answers keep settling.
pub(crate) trait ClaudeProcessListener: Send + Sync {
    /// Takes one stream frame.
    fn take_frame(&self, frame: ClaudeStreamFrame);

    /// Takes one request the process waits on, or its withdrawal of one.
    fn take_request(&self, event: ClaudeInboundRequestEvent);

    /// Takes the process's end, after every frame and request it wrote.
    fn take_exit(&self, end: ClaudeProcessEnd);

    /// Whether the lead `result` in `frame` ends the session's turn; an abort `result` for a
    /// `now` message ends nothing, since Claude Code runs that message as the next cycle.
    fn is_turn_ending(&self, frame: &ClaudeStreamFrame) -> bool;
}

/// The session turn the reader releases when it reads a lead `result` that ends it.
pub(crate) struct ClaudeTurnHolds {
    /// The routes holding the turn.
    pub(crate) routes: Arc<ClaudeRunRoutes>,
    /// The session whose turn it is.
    pub(crate) session_id: SessionId,
}

/// One live Claude Code process.
pub(crate) struct ClaudeCodeProcess {
    identity: ProviderProcessIdentity,
    input: ClaudeInputWriter,
    requests: ClaudeControlRequests,
    ends: Arc<ChildEnds>,
    end: watch::Receiver<Option<ClaudeProcessEnd>>,
    startup_hooks: watch::Receiver<usize>,
}

impl ClaudeCodeProcess {
    /// Starts the process on `spawner`'s thread, recorded in `child_records` until its reap and
    /// its spawn counted in `registry`, with its reader handing what it writes to `listener` and
    /// releasing `turn_holds`' turn at a turn-ending lead `result` and handing each line it reads
    /// to `raw_messages`. The launch's settings, with the telemetry switches and the process's own
    /// telemetry token minted for its spawn sequence, are written to a private file in
    /// `settings_folder` first, named last on the command line and removed, its token refused with
    /// it, at the reap or as the start fails; the launch's token is handed on a pipe the process
    /// alone inherits. Fails with `TelemetryBearer` as the telemetry token cannot be minted, with
    /// `SettingsFile` as the file cannot be written, and with `Spawn` carrying the record's error,
    /// the spawn's, the spawner's when its thread has ended, or `Unsupported` for a token on a
    /// system with no such pipe.
    pub(crate) async fn start(
        spawner: &Spawner,
        child_records: &Arc<dyn DaemonChildRecords>,
        registry: &ProviderProcessRegistry,
        launch: ClaudeProcessLaunch,
        settings_folder: &Path,
        listener: Arc<dyn ClaudeProcessListener>,
        turn_holds: Option<ClaudeTurnHolds>,
        raw_messages: Arc<PortRegistration<Arc<dyn RawProviderMessages>>>,
    ) -> Result<Self, ClaudeLaunchError> {
        // Drawn before the settings file, so the token names the process the registry maps.
        let spawn_sequence = registry.mint_spawn_sequence();
        let mut settings = launch.settings;
        let telemetry = launch
            .telemetry_target
            .map(|target| {
                target
                    .bearers()
                    .mint(
                        DESCRIPTOR.provider_id(),
                        TelemetryHolderId::new(spawn_sequence),
                    )
                    .map(|bearer| (target, bearer))
            })
            .transpose()
            .map_err(ClaudeLaunchError::TelemetryBearer)?;
        settings.set_telemetry_switches(
            telemetry
                .as_ref()
                .map(|(target, bearer)| (target.as_ref(), bearer)),
        );
        let settings_file = ClaudeSpawnSettingsFile::write(
            settings_folder,
            &settings,
            telemetry.map(|(_target, bearer)| bearer),
        )
        .await
        .map_err(ClaudeLaunchError::SettingsFile)?;
        let mut arguments = launch.arguments;
        arguments.push(CLAUDE_SETTINGS_FLAG.to_owned());
        arguments.push(settings_file.path().to_string_lossy().into_owned());
        let mut command = compose_claude_command(
            &launch.start,
            &arguments,
            &launch.environment,
            &launch.working_folder,
        );
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let secret = launch
            .token
            .map(|token| {
                let pipe = secret_pipe().ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::Unsupported,
                        "this system has no pipe to hand Claude Code its token on",
                    )
                })?;
                Ok::<_, io::Error>(ChildSecret {
                    pipe,
                    variable: CLAUDE_OAUTH_TOKEN_DESCRIPTOR_VARIABLE,
                    secret: token,
                })
            })
            .transpose()
            .map_err(ClaudeLaunchError::Spawn)?;
        let RecordedChild { mut child, record } =
            spawn_recorded_child(spawner, child_records, command, secret)
                .await
                .map_err(ClaudeLaunchError::Spawn)?;
        let identity = ProviderProcessIdentity {
            process_id: child.id().ok_or_else(|| {
                ClaudeLaunchError::Spawn(io::Error::other(
                    "the Claude Code process started with no id",
                ))
            })?,
            spawn_sequence,
        };
        let standard_input = child
            .stdin()
            .take()
            .expect("the process's standard input is piped");
        let standard_output = child
            .stdout()
            .take()
            .expect("the process's standard output is piped");
        let standard_error = child
            .stderr()
            .take()
            .expect("the process's standard error is piped");
        let input = ClaudeInputWriter::start(standard_input);
        let withdrawing_input = input.clone();
        let requests = ClaudeControlRequests::new(Arc::new(move |request_id: &str| {
            withdrawing_input.enqueue_line(compose_withdrawal_line(request_id));
        }));
        let (ends_sender, ends) = ChildEnds::new();
        let ends_sender = Arc::new(ends_sender);
        let (startup_hooks_sender, startup_hooks) = watch::channel(0);
        let reader = ClaudeOutputReader::new(
            requests.clone(),
            Arc::clone(&listener),
            turn_holds,
            startup_hooks_sender,
            Arc::downgrade(&ends_sender),
            launch.provider_session_id,
            launch.account,
        );
        let reading = tokio::spawn(reader.read(standard_output, raw_messages));
        let (end_sender, end) = watch::channel(None);
        tokio::spawn(own_child(
            child,
            record,
            settings_file,
            ends,
            standard_error,
            ProcessExitSettlement {
                reading,
                requests: requests.clone(),
                input: input.clone(),
                end: end_sender,
                listener,
            },
        ));
        Ok(Self {
            identity,
            input,
            requests,
            ends: ends_sender,
            end,
            startup_hooks,
        })
    }

    /// Sends `initialize` and settles on its answer, waiting at most 60 s outside the
    /// `SessionStart` and `Setup` hooks Claude Code runs as it starts and 10 minutes in all; at
    /// either deadline the request is withdrawn. Fails as `send_control_request` does.
    pub(crate) async fn send_initialize(
        &self,
        request: ClaudeControlRequest,
    ) -> Result<ClaudeControlAnswer, ClaudeSessionError> {
        let answer =
            self.send_control_request_within(request, CLAUDE_INITIALIZE_TOTAL_DEADLINE, None);
        tokio::select! {
            answered = answer => answered,
            () = wait_out_startup_deadline(self.startup_hooks.clone()) => {
                Err(ClaudeSessionError::Unanswered {
                    subtype: ClaudeControlSubtype::Initialize,
                    cause: ClaudeUnansweredCause::Deadline,
                })
            }
        }
    }

    /// Stops the process as a deliberate stop: closes its input, so an idle Claude Code tears
    /// itself down and finishes writing its conversation, and waits `exit_wait` for it to exit;
    /// then asks it to stop, which aborts a running turn. With no `kill_at` it settles once the
    /// process exited, killed once the grace passes; with one, every wait ends by `kill_at`, where
    /// the kill is asked and the end is not awaited.
    pub(crate) async fn stop(&self, exit_wait: Duration, kill_at: Option<Instant>) {
        if self.is_closed() {
            return;
        }
        self.input.close();
        let Some(kill_at) = kill_at else {
            if timeout(exit_wait, self.exited()).await.is_err() {
                self.ends.ask(ChildEnd::Stop);
                self.wait_for_exit().await;
            }
            return;
        };
        let input_close_end = (Instant::now() + exit_wait).min(kill_at);
        if timeout_at(input_close_end, self.wait_for_exit())
            .await
            .is_ok()
        {
            return;
        }
        // The owner reaps a killed process and retires its record without this wait.
        self.ends.stop_until(self.wait_for_exit(), kill_at).await;
    }

    /// How the process ended, once it has: its exit, read after its error output ended, or the
    /// failure that kept the exit from being read.
    pub(crate) async fn exited(&self) -> ClaudeProcessEnd {
        let mut end = self.end.clone();
        match end.wait_for(Option::is_some).await {
            Ok(ended) => ended
                .clone()
                .expect("the wait answers only once the end is set"),
            Err(_owner_ended) => Err(Arc::new(io::Error::other(
                "the Claude Code process's owner ended before reading its exit",
            ))),
        }
    }

    // Waits until the end is published, or its owner is gone; whoever reads the end awaits
    // `exited` itself.
    async fn wait_for_exit(&self) {
        let mut end = self.end.clone();
        let _is_owner_gone = end.wait_for(Option::is_some).await.is_err();
    }

    /// The operating system's id for the process and its place in the daemon's spawn count.
    pub(crate) fn identity(&self) -> ProviderProcessIdentity {
        self.identity
    }

    /// Whether the process has exited.
    pub(crate) fn is_closed(&self) -> bool {
        self.end.borrow().is_some()
    }

    /// Sends one control request, carrying `account_move` where given, and settles on its answer
    /// within `deadline`, failing as `send_control_request` does.
    async fn send_control_request_within(
        &self,
        request: ClaudeControlRequest,
        deadline: Duration,
        account_move: Option<ClaudeAccountMoveMarker>,
    ) -> Result<ClaudeControlAnswer, ClaudeSessionError> {
        let pending = match account_move {
            None => self.requests.open(request.subtype())?,
            Some(account_move) => self
                .requests
                .open_account_move(request.subtype(), account_move)?,
        };
        let line = compose_line(&ControlRequestLine {
            frame_type: "control_request",
            request_id: &pending.request_id(),
            request: &request,
        });
        let written = self.input.write_line(line, deadline).await;
        pending.answer_within(written, deadline).await
    }
}

impl ClaudeProcessChannel for ClaudeCodeProcess {
    fn send_control_request(
        &self,
        request: ClaudeControlRequest,
    ) -> BoxFuture<'_, Result<ClaudeControlAnswer, ClaudeSessionError>> {
        self.send_control_request_within(request, CLAUDE_REQUEST_DEADLINE, None)
            .boxed()
    }

    fn send_account_move(
        &self,
        request: ClaudeControlRequest,
        account_move: ClaudeAccountMoveMarker,
    ) -> BoxFuture<'_, Result<ClaudeControlAnswer, ClaudeSessionError>> {
        self.send_control_request_within(request, CLAUDE_REQUEST_DEADLINE, Some(account_move))
            .boxed()
    }

    fn answer_inbound_request(
        &self,
        request_id: String,
        answer: Box<RawValue>,
    ) -> BoxFuture<'_, ClaudeWriteAttempt> {
        let line = compose_line(&ControlResponseLine {
            frame_type: "control_response",
            response: ControlSuccess {
                subtype: "success",
                request_id: &request_id,
                response: &answer,
            },
        });
        self.input.write_line(line, CLAUDE_REQUEST_DEADLINE).boxed()
    }

    fn write_user_frame(&self, frame: ClaudeUserFrame) -> BoxFuture<'_, ClaudeWriteAttempt> {
        let line = compose_line(&frame);
        self.input.write_line(line, CLAUDE_REQUEST_DEADLINE).boxed()
    }

    fn terminate(&self) -> BoxFuture<'_, ()> {
        async move {
            self.ends.ask(ChildEnd::Stop);
            self.wait_for_exit().await;
        }
        .boxed()
    }

    fn close(&self) -> BoxFuture<'_, ()> {
        self.stop(CLAUDE_REQUEST_DEADLINE, None).boxed()
    }
}

#[derive(Serialize)]
struct ControlRequestLine<'line> {
    #[serde(rename = "type")]
    frame_type: &'static str,
    request_id: &'line str,
    request: &'line ClaudeControlRequest,
}

#[derive(Serialize)]
struct ControlResponseLine<'line> {
    #[serde(rename = "type")]
    frame_type: &'static str,
    response: ControlSuccess<'line>,
}

#[derive(Serialize)]
struct ControlSuccess<'line> {
    subtype: &'static str,
    request_id: &'line str,
    response: &'line RawValue,
}

#[derive(Serialize)]
struct WithdrawalLine<'line> {
    #[serde(rename = "type")]
    frame_type: &'static str,
    request_id: &'line str,
}

fn compose_withdrawal_line(request_id: &str) -> Vec<u8> {
    compose_line(&WithdrawalLine {
        frame_type: "control_cancel_request",
        request_id,
    })
}

// One input line: the frame's JSON and its newline.
fn compose_line(frame: &impl Serialize) -> Vec<u8> {
    let mut line = serde_json::to_vec(frame)
        .expect("an input frame holds only strings, numbers and JSON, which always serialize");
    line.push(b'\n');
    line
}

// Ends once `initialize` has waited its deadline outside the start-up hooks: the clock runs only
// while no `SessionStart` or `Setup` hook is running. Once the reader has ended, the hooks it
// counted last stand.
async fn wait_out_startup_deadline(mut running_hooks: watch::Receiver<usize>) {
    let mut left = CLAUDE_INITIALIZE_DEADLINE;
    loop {
        if running_hooks
            .wait_for(|running| *running == 0)
            .await
            .is_err()
        {
            if *running_hooks.borrow() == 0 {
                tokio::time::sleep(left).await;
            } else {
                std::future::pending::<()>().await;
            }
            return;
        }
        let started = Instant::now();
        // The borrow the wait answers with is let go before any later wait.
        let has_hook_started = tokio::select! {
            () = tokio::time::sleep(left) => return,
            hook_started = running_hooks.wait_for(|running| *running > 0) => hook_started.is_ok(),
        };
        left = left.saturating_sub(started.elapsed());
        if !has_hook_started {
            tokio::time::sleep(left).await;
            return;
        }
    }
}

// What the owner settles once the process exited.
struct ProcessExitSettlement {
    reading: tokio::task::JoinHandle<()>,
    requests: ClaudeControlRequests,
    input: ClaudeInputWriter,
    end: watch::Sender<Option<ClaudeProcessEnd>>,
    listener: Arc<dyn ClaudeProcessListener>,
}

// Owns the child: ends it as asked, a stop followed by a kill once the grace passes and a dropped
// handle as a kill; removes its settings file and retires its record once its wait returned; reads
// its exit once both its exit and its error output have ended; then, once the reader has handed on
// every frame, closes the control table and the input, publishes the end and hands it to the
// listener last.
async fn own_child(
    mut child: Box<dyn ChildWrapper>,
    record: ChildRecord,
    settings_file: ClaudeSpawnSettingsFile,
    mut ends: watch::Receiver<Option<ChildEnd>>,
    standard_error: impl AsyncRead + Unpin,
    settlement: ProcessExitSettlement,
) {
    let waiting = async {
        let mut ending = ChildEnding::new(CLAUDE_STOP_KILL_GRACE);
        let mut is_handle_held = true;
        let status = loop {
            let end = tokio::select! {
                biased;
                status = child.wait() => break status,
                () = ending.kill_due() => ChildEnd::Kill,
                changed = ends.changed(), if is_handle_held => {
                    if changed.is_ok() {
                        let Some(end) = *ends.borrow_and_update() else {
                            continue;
                        };
                        end
                    } else {
                        is_handle_held = false;
                        ChildEnd::Kill
                    }
                }
            };
            if let Err(error) = ending.ask(&mut *child, end) {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "the Claude Code process could not be asked to end"
                );
            }
        };
        drop(settings_file);
        let waited = status.map(|status| (status, ending.asked()));
        // A wait that failed leaves the record for the next start's sweep.
        if waited.is_ok() {
            record.retire().await;
        }
        waited
    };
    let (waited, tail) = tokio::join!(waiting, read_error_tail(standard_error));
    let exit = waited
        .map(|(status, asked_end)| read_exit(status, asked_end, tail))
        .map_err(Arc::new);
    settlement.settle(exit).await;
}

impl ProcessExitSettlement {
    async fn settle(self, read: Result<(ProcessExit, ChildExit), Arc<io::Error>>) {
        if let Err(error) = self.reading.await {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "the Claude Code process's output reader ended without finishing"
            );
        }
        let detail = match &read {
            Ok((_, child_exit)) => describe_exit(child_exit),
            Err(_) => "Its exit could not be read.".to_owned(),
        };
        self.requests.close_on_exit(detail);
        self.input.close();
        let end = read.map(|(exit, _)| exit);
        self.end.send_replace(Some(end.clone()));
        self.listener.take_exit(end);
    }
}

fn read_exit(
    status: ExitStatus,
    asked_end: Option<ChildEnd>,
    tail: OutputTail<PROVIDER_FAILURE_DETAIL_MAX_LEN>,
) -> (ProcessExit, ChildExit) {
    let child_exit = read_child_exit(&status, asked_end);
    (compose_process_exit(child_exit.clone(), tail), child_exit)
}

// The exit in the words a request the process can no longer answer fails with.
fn describe_exit(child_exit: &ChildExit) -> String {
    match &child_exit.signal_name {
        Some(signal) => format!("It was ended by {signal}."),
        None => format!("It exited with code {}.", child_exit.exit_code),
    }
}

// Reads the error output to its end into one tail, chunk by chunk as each arrives. A read that
// fails ends the tail where it stands, so the exit is still read.
async fn read_error_tail(
    standard_error: impl AsyncRead + Unpin,
) -> OutputTail<PROVIDER_FAILURE_DETAIL_MAX_LEN> {
    let mut tail = OutputTail::new();
    read_output_chunks(
        standard_error,
        "the Claude Code process's error output",
        |chunk| tail.push(chunk),
    )
    .await;
    tail
}

#[cfg(test)]
mod tests;
