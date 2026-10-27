//! One live Claude Code process: started on the daemon's spawner thread, written through one
//! ordered input queue, read by one output reader, and owned by one task that ends it as asked
//! and reads its exit once both its exit and its error output have ended. The exit closes the
//! control table and the input, then reaches the session's listener last, after every frame.

mod stdin;
mod stdout;

use std::error::Error;
use std::io;
use std::path::PathBuf;
use std::process::{ExitStatus, Stdio};
use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt;
use futures::future::BoxFuture;
use process_wrap::tokio::ChildWrapper;
use serde::Serialize;
use serde_json::value::RawValue;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::run::control::ProcessExit;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::{
    ChildEnd, ChildExit, ProgramStart, Spawner, ask_child_to_stop, read_child_exit,
    wrap_child_command,
};
use sidekicks_std::process_exit::{OutputTail, read_output_chunks};
use stdin::ClaudeInputWriter;
pub(crate) use stdout::CLAUDE_OUTPUT_LINE_MAX_BYTES;
use stdout::ClaudeOutputReader;
use tokio::io::AsyncRead;
use tokio::process::Command;
use tokio::sync::watch;
use tokio::time::Instant;

use crate::driver::claude::run::routes::ClaudeRunRoutes;
use crate::driver::claude::session::control_requests::ClaudeControlRequests;
use crate::driver::claude::session::errors::{ClaudeSessionError, ClaudeUnansweredCause};
use crate::driver::claude::session::transport::CLAUDE_REQUEST_DEADLINE;
use crate::driver::claude::session::transport::channel::ClaudeProcessChannel;
use crate::driver::claude::session::transport::control::{
    ClaudeControlRequest, ClaudeControlSubtype,
};
use crate::driver::claude::session::transport::declarations;
use crate::driver::claude::session::transport::inbound::{
    ClaudeControlAnswer, ClaudeControlFrameReader, ClaudeInboundRequestEvent,
};
use crate::driver::claude::session::transport::user_message::{
    ClaudeUserFrame, ClaudeWriteAttempt,
};
use crate::driver::diagnostics::OnceReportedDiagnostics;
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
    /// The command line after the program.
    pub(crate) arguments: Vec<String>,
    /// The whole environment; nothing is inherited from the daemon.
    pub(crate) environment: Vec<(String, String)>,
    /// The folder the process starts in.
    pub(crate) working_folder: PathBuf,
    /// The provider session the process runs, named in its diagnostics.
    pub(crate) provider_session_id: String,
    /// The account whose home it runs on; `None` on the person's own home.
    pub(crate) provider_account_id: Option<ProviderAccountId>,
}

/// One stream frame the process wrote, with the facts it is routed by.
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

/// The ends asked of one child; a kill is never replaced by a stop. Dropped, it kills the child.
pub(crate) struct ClaudeChildEnds(watch::Sender<Option<ChildEnd>>);

impl ClaudeChildEnds {
    /// Asks the child to end as `end`.
    pub(crate) fn ask(&self, end: ChildEnd) {
        self.0.send_if_modified(|asked| {
            let is_changed = *asked != Some(ChildEnd::Kill) && *asked != Some(end);
            if is_changed {
                *asked = Some(end);
            }
            is_changed
        });
    }
}

/// One live Claude Code process.
pub(crate) struct ClaudeCodeProcess {
    identity: ProviderProcessIdentity,
    input: ClaudeInputWriter,
    requests: ClaudeControlRequests,
    ends: Arc<ClaudeChildEnds>,
    end: watch::Receiver<Option<ClaudeProcessEnd>>,
    startup_hooks: watch::Receiver<usize>,
}

impl ClaudeCodeProcess {
    /// Starts the process on `spawner`'s thread, its spawn counted in `registry`, with its reader
    /// handing what it writes to `listener` and releasing `turn_holds`' turn at a turn-ending lead
    /// `result`. Fails with the spawn's error, or the spawner's when its thread has ended.
    pub(crate) async fn start(
        spawner: &Spawner,
        registry: &ProviderProcessRegistry,
        launch: ClaudeProcessLaunch,
        listener: Arc<dyn ClaudeProcessListener>,
        turn_holds: Option<ClaudeTurnHolds>,
    ) -> io::Result<Self> {
        let mut command = Command::new(launch.start.program);
        command
            .args(launch.start.leading_arguments)
            .args(launch.arguments)
            .env_clear()
            .envs(launch.environment)
            .current_dir(launch.working_folder)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let daemon_pid = std::process::id();
        let mut child = spawner
            .run(move || wrap_child_command(command, daemon_pid).spawn())
            .await
            .and_then(|spawned| spawned)?;
        let identity = ProviderProcessIdentity {
            process_id: child
                .id()
                .ok_or_else(|| io::Error::other("the Claude Code process started with no id"))?,
            spawn_sequence: registry.mint_spawn_sequence(),
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
        let (ends_sender, ends) = watch::channel(None);
        let ends_sender = Arc::new(ClaudeChildEnds(ends_sender));
        let (startup_hooks_sender, startup_hooks) = watch::channel(0);
        let reader = ClaudeOutputReader {
            requests: requests.clone(),
            control_frames: ClaudeControlFrameReader::new(
                launch.provider_account_id.clone(),
                launch.provider_session_id.clone(),
            ),
            listener: Arc::clone(&listener),
            turn_holds,
            startup_hooks: startup_hooks_sender,
            ends: Arc::downgrade(&ends_sender),
            unmapped_lines: OnceReportedDiagnostics::default(),
            provider_session_id: launch.provider_session_id,
            provider_account_id: launch.provider_account_id,
        };
        let reading = tokio::spawn(reader.read(standard_output));
        let (end_sender, end) = watch::channel(None);
        tokio::spawn(own_child(
            child,
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
        let answer = self.send_control_request_within(request, CLAUDE_INITIALIZE_TOTAL_DEADLINE);
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

    /// Stops the process as a deliberate stop: closes its input, so Claude Code finishes writing
    /// its conversation, waits `exit_wait` for it to exit, then asks it to stop, and kills it
    /// once the grace passes; settles once it exited.
    pub(crate) async fn stop(&self, exit_wait: Duration) {
        if self.is_closed() {
            return;
        }
        self.input.close();
        if tokio::time::timeout(exit_wait, self.exited())
            .await
            .is_err()
        {
            self.ends.ask(ChildEnd::Stop);
            self.wait_for_exit().await;
        }
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

    /// Sends one control request and settles on its answer within `deadline`, failing as
    /// `send_control_request` does.
    async fn send_control_request_within(
        &self,
        request: ClaudeControlRequest,
        deadline: Duration,
    ) -> Result<ClaudeControlAnswer, ClaudeSessionError> {
        let pending = self.requests.open(request.subtype())?;
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
        self.send_control_request_within(request, CLAUDE_REQUEST_DEADLINE)
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
        self.stop(CLAUDE_REQUEST_DEADLINE).boxed()
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
// handle as a kill; reads its exit once both its exit and its error output have ended; then, once
// the reader has handed on every frame, closes the control table and the input, publishes the end
// and hands it to the listener last.
async fn own_child(
    mut child: Box<dyn ChildWrapper>,
    mut ends: watch::Receiver<Option<ChildEnd>>,
    standard_error: impl AsyncRead + Unpin,
    settlement: ProcessExitSettlement,
) {
    let waiting = async {
        let mut asked_end = None;
        let mut is_handle_held = true;
        let kill_grace = tokio::time::sleep(CLAUDE_STOP_KILL_GRACE);
        tokio::pin!(kill_grace);
        let mut is_kill_armed = false;
        loop {
            let end = tokio::select! {
                biased;
                status = child.wait() => break status.map(|status| (status, asked_end)),
                () = &mut kill_grace, if is_kill_armed => {
                    is_kill_armed = false;
                    ChildEnd::Kill
                }
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
            // A stop asked after a kill or a stop changes nothing.
            if asked_end == Some(ChildEnd::Kill) || asked_end == Some(end) {
                continue;
            }
            let asked = match end {
                ChildEnd::Stop => ask_child_to_stop(&mut *child),
                ChildEnd::Kill => child.start_kill(),
            };
            if let Err(error) = asked {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "the Claude Code process could not be asked to end"
                );
            }
            if end == ChildEnd::Stop {
                kill_grace
                    .as_mut()
                    .reset(Instant::now() + CLAUDE_STOP_KILL_GRACE);
                is_kill_armed = true;
            }
            asked_end = Some(end);
        }
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
mod tests {
    use std::sync::{Arc, Weak};
    use std::time::Duration;

    use tokio::io::AsyncWriteExt;
    use tokio::sync::watch;

    use super::{
        ClaudeOutputReader, ClaudeProcessEnd, ClaudeProcessListener, ClaudeStreamFrame,
        wait_out_startup_deadline,
    };
    use crate::driver::claude::session::control_requests::ClaudeControlRequests;
    use crate::driver::claude::session::transport::inbound::{
        ClaudeControlFrameReader, ClaudeInboundRequestEvent,
    };
    use crate::driver::diagnostics::OnceReportedDiagnostics;

    struct NoSession;

    impl ClaudeProcessListener for NoSession {
        fn take_frame(&self, _frame: ClaudeStreamFrame) {}

        fn take_request(&self, _event: ClaudeInboundRequestEvent) {}

        fn take_exit(&self, _end: ClaudeProcessEnd) {}

        fn is_turn_ending(&self, _frame: &ClaudeStreamFrame) -> bool {
            true
        }
    }

    async fn settle_tasks() {
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
    }

    // Killed by counting the time a `SessionStart` hook runs against `initialize`'s deadline, and
    // by a reader that does not count the hook from its frames.
    #[tokio::test(start_paused = true)]
    async fn initialize_waits_its_deadline_only_outside_the_startup_hooks() {
        let (startup_hooks, running_hooks) = watch::channel(0);
        let (mut provider, output) = tokio::io::duplex(4096);
        let reader = ClaudeOutputReader {
            requests: ClaudeControlRequests::new(Arc::new(|_request_id: &str| {})),
            control_frames: ClaudeControlFrameReader::new(None, "conversation".to_owned()),
            listener: Arc::new(NoSession),
            turn_holds: None,
            startup_hooks,
            ends: Weak::new(),
            unmapped_lines: OnceReportedDiagnostics::default(),
            provider_session_id: "conversation".to_owned(),
            provider_account_id: None,
        };
        let reading = tokio::spawn(reader.read(output));
        let deadline = tokio::spawn(wait_out_startup_deadline(running_hooks.clone()));
        settle_tasks().await;

        provider
            .write_all(
                b"{\"type\":\"system\",\"subtype\":\"hook_started\",\"hook_id\":\"h1\",\
                  \"hook_name\":\"SessionStart:startup\",\"hook_event\":\"SessionStart\"}\n",
            )
            .await
            .expect("the pipe takes the line");
        settle_tasks().await;
        assert_eq!(*running_hooks.borrow(), 1);
        tokio::time::advance(Duration::from_secs(50)).await;
        settle_tasks().await;
        assert!(!deadline.is_finished(), "the hook's time is not counted");

        provider
            .write_all(
                b"{\"type\":\"system\",\"subtype\":\"hook_response\",\"hook_id\":\"h1\",\
                  \"hook_event\":\"SessionStart\"}\n",
            )
            .await
            .expect("the pipe takes the line");
        settle_tasks().await;
        assert_eq!(*running_hooks.borrow(), 0);
        tokio::time::advance(Duration::from_secs(50)).await;
        settle_tasks().await;
        assert!(
            !deadline.is_finished(),
            "50 s outside the hook is within the deadline"
        );

        tokio::time::advance(Duration::from_secs(11)).await;
        settle_tasks().await;
        assert!(
            deadline.is_finished(),
            "61 s outside the hook passes the deadline"
        );
        drop(provider);
        reading.await.expect("the reader ends with its output");
    }
}
