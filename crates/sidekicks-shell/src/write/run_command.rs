//! An agent's command in one of its session's shells. The run takes the shell only while it sits
//! idle at a marked prompt; the command's capture window opens before the command is written, the
//! write held until the capture is written, and a failed capture lets the command run with no
//! window. The shell's next end mark closes the window with the command's exit code, or else its
//! next prompt mark or its exit does, and the shell goes back to whoever held it before. One task
//! runs every step, so a caller that stops waiting leaves no hold and no window behind.

use std::error::Error;
use std::future::Future;
use std::sync::Arc;

use sidekicks_contracts::command::CommandId;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::terminal::TerminalId;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_provider::port::command_capture::{
    CommandCapture, CommandWindowEnd, CommandWindowId, CommandWindowOpenError, CommandWindowStart,
};
use sidekicks_std::port_registration::PortRegistration;
use tokio::runtime::Handle;
use tokio::sync::{oneshot, watch};

use crate::control_lease::{ShellControlLease, ShellLeaseRun};
use crate::output::stream::ShellOutputEnd;
use crate::record::{ShellMarkState, ShellMarksSeen};
use crate::write::ShellInput;

/// An agent's command to run in one of its session's shells.
pub struct ShellRunRequest {
    /// The session.
    pub session_id: SessionId,
    /// The shell.
    pub terminal_id: TerminalId,
    /// The run whose agent runs the command.
    pub run_id: RunId,
    /// The command the run holds the shell for.
    pub command_id: CommandId,
    /// The command line: one line, with no line break.
    pub command: String,
    /// The provider's tool call that runs the command, `None` where there is none.
    pub tool_call_id: Option<ToolCallId>,
}

/// How a run's command in a shell started.
pub enum ShellRunStart {
    /// The run holds the shell, and the command is on its way in.
    Started(ShellRunCommand),
    /// The shell has marked no prompt, so neither whether it sits idle nor the command's end can be
    /// read; nothing was taken or written.
    ReportsNoMarks,
    /// Something was typed at the shell's prompt since it was drawn, or a command runs in it;
    /// nothing was taken or written.
    NotIdle,
}

/// A run's command on its way into its shell. Dropping it stops nothing: the command still runs,
/// and its window still closes and the shell still goes back at its end.
pub struct ShellRunCommand {
    written: oneshot::Receiver<Result<(), HandlerError>>,
    end: watch::Receiver<Option<ShellCommandEnd>>,
}

impl ShellRunCommand {
    /// The command's end as the shell shows it, `None` until it ends; one whose write failed never
    /// ends.
    pub fn end(&self) -> watch::Receiver<Option<ShellCommandEnd>> {
        self.end.clone()
    }

    /// Answers once the shell's input took the command, after its capture window opened or failed
    /// to. Fails as the run's write did: `terminal.control.notHeld` once the run's hold ended,
    /// `terminal.notFound` once the shell closed, and as a fault when the system refused it.
    pub async fn written(self) -> Result<(), HandlerError> {
        self.written
            .await
            .unwrap_or_else(|_ended| Err(task_ended("the shell's command task ended unwritten")))
    }
}

/// How a run's command in a shell ended, as the shell marked it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShellCommandEnd {
    /// The shell marked the command's end: the tool answers its exit code, absent where the mark
    /// carried none.
    Exited {
        /// The command's exit code.
        exit_code: Option<i64>,
    },
    /// The shell marked an end or its prompt with no command started, so the command never ran:
    /// the tool answers that it did not run.
    NotStarted,
    /// The shell marked its next prompt with no end mark: the tool answers that the command ended
    /// with no exit code.
    PromptWithoutEnd,
    /// The shell's program exited, or the shell closed, before the command's end mark: the tool
    /// answers that the shell ended.
    ShellEnded,
}

/// The parts of one shell a run's command goes through.
pub(crate) struct CommandShell {
    /// Who holds the shell.
    pub(crate) lease: Arc<ShellControlLease>,
    /// Its input, which the command is written to.
    pub(crate) input: Arc<ShellInput>,
    /// Its marks, which tell whether it sits idle and where the command ends.
    pub(crate) marks: Arc<ShellMarkState>,
    /// How it stands, which leaves `Running` once its program exits or it closes.
    pub(crate) progress: watch::Receiver<ShellOutputEnd>,
}

/// Starts `request`'s command in `shell` on a task of `runtime`, which runs every step to the
/// command's end, opening its window on `capture` where one is registered. Answers how it started;
/// fails with the take's broadcast failure, nothing held.
pub(crate) fn start_run_command(
    shell: CommandShell,
    capture: Arc<PortRegistration<Arc<dyn CommandCapture>>>,
    runtime: &Handle,
    request: ShellRunRequest,
) -> impl Future<Output = Result<ShellRunStart, HandlerError>> + Send + 'static {
    let (start, started) = oneshot::channel();
    runtime.spawn(run_command(shell, capture, request, start));
    async move {
        started
            .await
            .unwrap_or_else(|_ended| Err(task_ended("the shell's command task ended unstarted")))
    }
}

// Takes the shell, answers `start`, opens the window, writes the command and waits for its end,
// then closes the window and hands the shell back. A caller gone by the start is handed the shell
// back with nothing written.
async fn run_command(
    shell: CommandShell,
    capture: Arc<PortRegistration<Arc<dyn CommandCapture>>>,
    request: ShellRunRequest,
    start: oneshot::Sender<Result<ShellRunStart, HandlerError>>,
) {
    let CommandShell {
        lease,
        input,
        marks,
        mut progress,
    } = shell;
    if !marks.is_reporting() {
        return answer_start(start, Ok(ShellRunStart::ReportsNoMarks));
    }
    let run = ShellLeaseRun {
        run_id: request.run_id,
        command_id: request.command_id.clone(),
    };
    match lease
        .take_for_run(&run, || !marks.has_input_since_prompt())
        .await
    {
        Ok(true) => {}
        Ok(false) => return answer_start(start, Ok(ShellRunStart::NotIdle)),
        Err(failure) => return answer_start(start, Err(failure.into())),
    }
    let (written, written_answer) = oneshot::channel();
    let (end, ended) = watch::channel(None);
    let command = ShellRunCommand {
        written: written_answer,
        end: ended,
    };
    if start.send(Ok(ShellRunStart::Started(command))).is_err() {
        return hand_back(&lease, &run, &request).await;
    }
    let window = open_window(&capture, &request).await;
    let mut seen = marks.subscribe();
    let at_write = *seen.borrow_and_update();
    let write = match input.admit_run_write(request.run_id, format!("{}\r", request.command)) {
        Ok(admitted) => admitted.answered().await.map(|_answered| ()),
        Err(refusal) => Err(refusal.into()),
    };
    if let Err(error) = write {
        if let Some((capture, window)) = window {
            capture.close_window(window, CommandWindowEnd::Unrun).await;
        }
        hand_back(&lease, &run, &request).await;
        return answer_written(written, Err(error));
    }
    answer_written(written, Ok(()));
    if let Some((capture, window)) = &window {
        capture.command_began(window, true).await;
    }
    let is_marked = tokio::select! {
        biased;
        marked = seen.wait_for(|now| {
            now.command_ends > at_write.command_ends || now.prompts > at_write.prompts
        }) => marked.is_ok(),
        _ended = progress.wait_for(|stands| *stands != ShellOutputEnd::Running) => false,
    };
    let (command_end, window_end) = read_end(*seen.borrow(), at_write, is_marked);
    if let Some((capture, window)) = window {
        capture.close_window(window, window_end).await;
    }
    hand_back(&lease, &run, &request).await;
    end.send_replace(Some(command_end));
}

// The command's end from the marks `now` against those `at_write`: an end or a prompt with no
// start is a command that never ran, an end mark its exit, a prompt alone an end untold; without
// either mark, `is_marked` false, the shell ended.
fn read_end(
    now: ShellMarksSeen,
    at_write: ShellMarksSeen,
    is_marked: bool,
) -> (ShellCommandEnd, CommandWindowEnd) {
    let is_started = now.command_starts > at_write.command_starts;
    if !is_marked {
        let window_end = if is_started {
            CommandWindowEnd::Untold
        } else {
            CommandWindowEnd::Unrun
        };
        return (ShellCommandEnd::ShellEnded, window_end);
    }
    if !is_started {
        return (ShellCommandEnd::NotStarted, CommandWindowEnd::Unrun);
    }
    if now.command_ends > at_write.command_ends {
        let exit_code = now.last_exit_code;
        return (
            ShellCommandEnd::Exited { exit_code },
            CommandWindowEnd::Exited {
                exit_code: exit_code.and_then(|code| i32::try_from(code).ok()),
                signal: None,
            },
        );
    }
    (ShellCommandEnd::PromptWithoutEnd, CommandWindowEnd::Untold)
}

// Opens the command's window on the registered capture, none where nothing is registered; a
// refused or failed open leaves the command uncovered, as the wrapper leg logs it.
async fn open_window(
    capture: &PortRegistration<Arc<dyn CommandCapture>>,
    request: &ShellRunRequest,
) -> Option<(Arc<dyn CommandCapture>, CommandWindowId)> {
    let capture = Arc::clone(capture.port()?);
    let opened = capture
        .open_window(CommandWindowStart {
            session_id: request.session_id,
            apart_run: None,
            command: request.command.clone(),
            tool_call_id: request.tool_call_id.clone(),
        })
        .await;
    match opened {
        Ok(window) => Some((capture, window)),
        Err(CommandWindowOpenError::Refused(refusal)) => {
            tracing::debug!(
                session_id = %request.session_id,
                terminal = request.terminal_id.as_str(),
                command_id = request.command_id.as_str(),
                error = &refusal as &(dyn Error + 'static),
                "a shell command runs with no capture window to cover"
            );
            None
        }
        Err(error @ CommandWindowOpenError::CaptureFailed(_)) => {
            tracing::warn!(
                session_id = %request.session_id,
                terminal = request.terminal_id.as_str(),
                command_id = request.command_id.as_str(),
                error = &error as &(dyn Error + 'static),
                "a shell command runs with no capture window"
            );
            None
        }
    }
}

// Ends the run's hold for its command; a failed hand-back leaves nobody holding the shell, and no
// caller waits on it.
async fn hand_back(lease: &ShellControlLease, run: &ShellLeaseRun, request: &ShellRunRequest) {
    if let Err(error) = lease.release_command(run).await {
        tracing::warn!(
            session_id = %request.session_id,
            terminal = request.terminal_id.as_str(),
            command_id = request.command_id.as_str(),
            error = &error as &(dyn Error + 'static),
            "a shell's hand-back at its command's end failed"
        );
    }
}

fn answer_start(
    start: oneshot::Sender<Result<ShellRunStart, HandlerError>>,
    answer: Result<ShellRunStart, HandlerError>,
) {
    if start.send(answer).is_err() {
        tracing::debug!("a shell command's caller stopped waiting for its start");
    }
}

fn answer_written(
    written: oneshot::Sender<Result<(), HandlerError>>,
    answer: Result<(), HandlerError>,
) {
    if written.send(answer).is_err() {
        tracing::debug!("a shell command's caller stopped waiting for its write");
    }
}

// The fault a caller reads when the command's task ended before answering, as the runtime's stop
// ends it.
fn task_ended(what: &'static str) -> HandlerError {
    DomainError::new(what, RefusalCode::SystemInternalError).into()
}

#[cfg(test)]
mod tests {
    use std::fmt::Write as _;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use bytes::Bytes;
    use futures::FutureExt as _;
    use rstest::rstest;
    use sidekicks_contracts::command::ExitCode;
    use sidekicks_contracts::jsonrpc::streaming::SubscriptionId;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::terminal::TerminalId;
    use sidekicks_contracts::trust_statement::DeviceId;
    use sidekicks_ipc::registry::{HandlerError, TransportId};
    use sidekicks_provider::port::command_capture::{
        CaptureCall, CommandCapture, CommandWindowEnd, held_capture, next_call, no_call,
        unregistered_capture,
    };
    use sidekicks_std::port_registration::PortRegistration;
    use sidekicks_terminal::{OutputFilter as _, TerminalWriteError};
    use tokio::runtime::Handle;
    use tokio::sync::watch;

    use super::{
        CommandShell, ShellCommandEnd, ShellRunCommand, ShellRunRequest, ShellRunStart,
        start_run_command,
    };
    use crate::control_lease::tests::{LeaseUnderTest, run};
    use crate::control_lease::{ShellConnection, ShellLeaseCaller};
    use crate::list::ShellListFollowers;
    use crate::output::stream::ShellOutputEnd;
    use crate::record::{ShellMarkFilter, ShellMarkState};
    use crate::write::{ShellInput, ShellInputHooks, ShellWriteInput};

    const NONCE: &str = "0f3c9a7e5b";
    const COMMAND: &str = "npm test";
    const RELEASED: &str = "autoReleasedCommandEnded";

    /// A shell with no terminal: its lease, its marks fed through its mark filter, its input whose
    /// writes are recorded and answered, and how it stands.
    struct ShellUnderTest {
        lease: LeaseUnderTest,
        marks: Arc<ShellMarkState>,
        filter: ShellMarkFilter,
        input: Arc<ShellInput>,
        writes: Arc<Mutex<Vec<String>>>,
        progress: watch::Sender<ShellOutputEnd>,
    }

    impl ShellUnderTest {
        /// A shell that has marked no prompt, its writes failed where `fails_writes`.
        fn unmarked(fails_writes: bool) -> Self {
            let lease = LeaseUnderTest::open();
            let marks = Arc::new(ShellMarkState::default());
            let writes = Arc::new(Mutex::new(Vec::new()));
            let recorded = Arc::clone(&writes);
            let noted = Arc::clone(&marks);
            let input = ShellInput::new(
                TerminalId::new("terminal-1".to_owned()).expect("a terminal id"),
                Arc::clone(&lease.lease),
                ShellInputHooks {
                    queue_write: Box::new(move |bytes: Bytes| {
                        noted.note_input();
                        recorded
                            .lock()
                            .expect("no test panics holding it")
                            .push(String::from_utf8(bytes.to_vec()).expect("typed text"));
                        async move {
                            if fails_writes {
                                Err(TerminalWriteError::Failed(Arc::new(std::io::Error::other(
                                    "the test failed it",
                                ))))
                            } else {
                                Ok(())
                            }
                        }
                        .boxed()
                    }),
                    queue_answer: Box::new(|_answer| {}),
                    is_bracketed_paste_requested: Box::new(|| false),
                },
                Handle::current(),
            );
            // No one follows this shell's list, so its read is never awaited to an end.
            let list = ShellListFollowers::new(Arc::new(|| std::future::pending().boxed()));
            Self {
                filter: marks.mark_filter(NONCE, list),
                lease,
                marks,
                input,
                writes,
                progress: watch::Sender::new(ShellOutputEnd::Running),
            }
        }

        /// A shell sitting at its first marked prompt.
        fn at_prompt(fails_writes: bool) -> Self {
            let mut shell = Self::unmarked(fails_writes);
            shell.read(&["A"]);
            shell
        }

        /// Reads one chunk of output holding each of `marks`, such as `"D;0"`, with the nonce.
        fn read(&mut self, marks: &[&str]) {
            let mut output = String::new();
            for mark in marks {
                write!(output, "\x1b]133;{mark};nonce={NONCE}\x07").expect("a string takes it");
            }
            let mut kept = Vec::new();
            self.filter.filter(output.as_bytes(), &mut kept);
        }

        /// Starts the command in the shell, its window on `capture`. The test keeps `capture`, as
        /// the daemon keeps its registration, so the capture's calls stay open once the command
        /// ends.
        async fn start(
            &self,
            capture: &Arc<PortRegistration<Arc<dyn CommandCapture>>>,
        ) -> Result<ShellRunStart, HandlerError> {
            start_run_command(
                self.parts(),
                Arc::clone(capture),
                &Handle::current(),
                request(),
            )
            .await
        }

        /// The command started in the shell, its window on `capture`, which the test keeps.
        async fn started(
            &self,
            capture: &Arc<PortRegistration<Arc<dyn CommandCapture>>>,
        ) -> ShellRunCommand {
            match self.start(capture).await.expect("the start answers") {
                ShellRunStart::Started(command) => command,
                ShellRunStart::ReportsNoMarks | ShellRunStart::NotIdle => {
                    panic!("the run takes the shell")
                }
            }
        }

        fn parts(&self) -> CommandShell {
            CommandShell {
                lease: Arc::clone(&self.lease.lease),
                input: Arc::clone(&self.input),
                marks: Arc::clone(&self.marks),
                progress: self.progress.subscribe(),
            }
        }

        fn writes(&self) -> Vec<String> {
            self.writes
                .lock()
                .expect("no test panics holding it")
                .clone()
        }

        /// The reason of each change of holder once `count` were sent, failing after 5 s.
        async fn reasons_once(&self, count: usize) -> Vec<String> {
            tokio::time::timeout(Duration::from_secs(5), self.lease.sent(count))
                .await
                .expect("the changes are sent");
            self.lease
                .changes()
                .into_iter()
                .map(|(reason, ..)| reason)
                .collect()
        }
    }

    fn request() -> ShellRunRequest {
        let run = run("0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c9d0f", "command-1");
        ShellRunRequest {
            session_id: SessionId::new("0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c9d0e").expect("a session"),
            terminal_id: TerminalId::new("terminal-1".to_owned()).expect("a terminal id"),
            run_id: run.run_id,
            command_id: run.command_id,
            command: COMMAND.to_owned(),
            tool_call_id: None,
        }
    }

    /// The command's end, failing after 5 s.
    async fn end_of(mut end: watch::Receiver<Option<ShellCommandEnd>>) -> ShellCommandEnd {
        tokio::time::timeout(Duration::from_secs(5), end.wait_for(Option::is_some))
            .await
            .expect("the command ends in time")
            .expect("the command's task answers its end")
            .expect("an end was sent")
    }

    #[tokio::test]
    async fn the_command_is_written_only_once_its_window_opens() {
        let mut shell = ShellUnderTest::at_prompt(false);
        let (opens, held_opens) = watch::channel(None);
        let (capture, mut called) = held_capture(held_opens);

        let command = shell.started(&capture).await;
        assert_eq!(next_call(&mut called).await, CaptureCall::Open(1));
        let mut written = std::pin::pin!(command.written());
        let early = tokio::time::timeout(Duration::from_millis(200), &mut written).await;
        assert!(early.is_err(), "the write answered before the open");
        assert_eq!(shell.writes(), [] as [String; 0], "written before the open");

        opens.send_replace(Some(true));
        written.await.expect("the command is written");
        assert_eq!(shell.writes(), [format!("{COMMAND}\r")]);
        assert_eq!(next_call(&mut called).await, CaptureCall::Began(1, true));

        shell.read(&["C"]);
        shell.read(&["D;0"]);
        shell.read(&["A"]);
        assert_eq!(
            next_call(&mut called).await,
            CaptureCall::Close(
                1,
                CommandWindowEnd::Exited {
                    exit_code: Some(0),
                    signal: None
                }
            )
        );
        assert_eq!(shell.reasons_once(2).await, ["taken", RELEASED]);
    }

    #[tokio::test]
    async fn the_end_mark_closes_the_window_with_its_exit_code_and_releases_the_shell() {
        let mut shell = ShellUnderTest::at_prompt(false);
        let (_opens, open) = watch::channel(Some(true));
        let (capture, mut called) = held_capture(open);
        let command = shell.started(&capture).await;
        let end = command.end();
        command.written().await.expect("the command is written");

        shell.read(&["C"]);
        shell.read(&["D;3", "A"]);

        assert_eq!(
            end_of(end).await,
            ShellCommandEnd::Exited { exit_code: Some(3) }
        );
        assert_eq!(next_call(&mut called).await, CaptureCall::Open(1));
        assert_eq!(next_call(&mut called).await, CaptureCall::Began(1, true));
        assert_eq!(
            next_call(&mut called).await,
            CaptureCall::Close(
                1,
                CommandWindowEnd::Exited {
                    exit_code: Some(3),
                    signal: None
                }
            )
        );
        no_call(&mut called, "the window closed twice").await;
        assert_eq!(
            shell.lease.changes().last().map(|change| change.0.as_str()),
            Some(RELEASED)
        );
    }

    #[rstest]
    #[case::a_prompt_with_no_end_mark(
        &["C", "A"],
        false,
        CommandWindowEnd::Untold,
        ShellCommandEnd::PromptWithoutEnd
    )]
    #[case::an_end_with_no_command_started(
        &["D", "A"],
        false,
        CommandWindowEnd::Unrun,
        ShellCommandEnd::NotStarted
    )]
    #[case::the_shell_exiting(
        &["C"],
        true,
        CommandWindowEnd::Untold,
        ShellCommandEnd::ShellEnded
    )]
    #[tokio::test]
    async fn a_command_with_no_end_mark_closes_as_its_shell_shows(
        #[case] marks: &[&str],
        #[case] does_shell_exit: bool,
        #[case] window_end: CommandWindowEnd,
        #[case] command_end: ShellCommandEnd,
    ) {
        let mut shell = ShellUnderTest::at_prompt(false);
        let (_opens, open) = watch::channel(Some(true));
        let (capture, mut called) = held_capture(open);
        let command = shell.started(&capture).await;
        let end = command.end();
        command.written().await.expect("the command is written");

        for mark in marks {
            shell.read(&[mark]);
        }
        if does_shell_exit {
            shell.progress.send_replace(ShellOutputEnd::Exited {
                exit_code: ExitCode::new(0).expect("an exit code"),
                cursor: 0,
            });
        }

        assert_eq!(end_of(end).await, command_end);
        assert_eq!(next_call(&mut called).await, CaptureCall::Open(1));
        assert_eq!(next_call(&mut called).await, CaptureCall::Began(1, true));
        assert_eq!(
            next_call(&mut called).await,
            CaptureCall::Close(1, window_end)
        );
        assert_eq!(
            shell.lease.changes().last().map(|change| change.0.as_str()),
            Some(RELEASED)
        );
    }

    #[rstest]
    #[case::opens_failed(true)]
    #[case::no_capture(false)]
    #[tokio::test]
    async fn a_failed_or_missing_capture_writes_the_command_uncovered(#[case] is_registered: bool) {
        let mut shell = ShellUnderTest::at_prompt(false);
        let (_opens, failed) = watch::channel(Some(false));
        let (capture, called) = if is_registered {
            let (capture, called) = held_capture(failed);
            (capture, Some(called))
        } else {
            (unregistered_capture(), None)
        };
        let command = shell.started(&capture).await;
        let end = command.end();
        command.written().await.expect("the command is written");
        assert_eq!(shell.writes(), [format!("{COMMAND}\r")]);

        shell.read(&["C"]);
        shell.read(&["D;0"]);
        assert_eq!(
            end_of(end).await,
            ShellCommandEnd::Exited { exit_code: Some(0) }
        );
        assert_eq!(
            shell.lease.changes().last().map(|change| change.0.as_str()),
            Some(RELEASED)
        );
        shell.read(&["A"]);

        if let Some(mut called) = called {
            assert_eq!(next_call(&mut called).await, CaptureCall::Open(1));
            no_call(&mut called, "an uncovered command's window was told of it").await;
        }
    }

    #[tokio::test]
    async fn a_shell_with_input_since_its_prompt_is_not_taken() {
        let (_opens, open) = watch::channel(Some(true));
        let (capture, mut called) = held_capture(open);
        let unmarked = ShellUnderTest::unmarked(false);
        assert!(matches!(
            unmarked.start(&capture).await,
            Ok(ShellRunStart::ReportsNoMarks)
        ));

        let shell = ShellUnderTest::at_prompt(false);
        let device = ShellLeaseCaller {
            connection: ShellConnection {
                device_id: DeviceId::new("device-laptop".to_owned()).expect("a device id"),
                transport_id: TransportId(1),
            },
            output_subscription_id: SubscriptionId::new("0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c0001")
                .expect("a subscription id"),
        };
        shell
            .input
            .admit_write(device, ShellWriteInput::Keys("ls".to_owned()))
            .expect("the device's write is admitted")
            .answered()
            .await
            .expect("the device's write is taken");

        assert!(matches!(
            shell.start(&capture).await,
            Ok(ShellRunStart::NotIdle)
        ));
        assert_eq!(shell.writes(), ["ls"]);
        no_call(&mut called, "a window opened for a shell not taken").await;
    }

    #[tokio::test]
    async fn a_call_dropped_before_its_start_leaves_no_hold_and_no_window() {
        let shell = ShellUnderTest::at_prompt(false);
        let (_opens, open) = watch::channel(Some(true));
        let (capture, mut called) = held_capture(open);
        let land = shell.lease.hold_next_broadcast();

        let starting = start_run_command(
            shell.parts(),
            Arc::clone(&capture),
            &Handle::current(),
            request(),
        );
        tokio::time::timeout(Duration::from_secs(5), shell.lease.sent(1))
            .await
            .expect("the take is broadcast");
        drop(starting);
        land.send(true).expect("the take waits on its broadcast");

        assert_eq!(shell.reasons_once(2).await, ["taken", RELEASED]);
        assert_eq!(shell.writes(), [] as [String; 0]);
        no_call(&mut called, "a window opened for a dropped call").await;
        // Kept past the check, as the daemon keeps its registration.
        drop(capture);
    }

    #[tokio::test]
    async fn a_failed_write_closes_its_window_unrun_and_releases() {
        let shell = ShellUnderTest::at_prompt(true);
        let (_opens, open) = watch::channel(Some(true));
        let (capture, mut called) = held_capture(open);
        let command = shell.started(&capture).await;

        assert!(
            command.written().await.is_err(),
            "the failed write answered"
        );
        assert_eq!(next_call(&mut called).await, CaptureCall::Open(1));
        assert_eq!(
            next_call(&mut called).await,
            CaptureCall::Close(1, CommandWindowEnd::Unrun)
        );
        assert_eq!(shell.reasons_once(2).await, ["taken", RELEASED]);
        no_call(&mut called, "a failed write's window was told it began").await;
    }
}
