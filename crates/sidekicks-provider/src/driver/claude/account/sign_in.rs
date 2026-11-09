//! Claude Code's own interactive sign-in on one account's home: `claude auth login --claudeai` run
//! on that home's folders, its sign-in address and each wait for a pasted code read from its
//! output, the code the person pastes written to its input and nowhere else, and the status read
//! that names who signed in once it ended. Every variable that would sign the process in ahead of
//! the home's own sign-in is removed from both.

use std::io;
use std::path::Path;
use std::process::{ExitStatus, Stdio};
use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt as _;
use futures::channel::mpsc as prompt_channel;
use futures::future::BoxFuture;
use memchr::memmem;
use process_wrap::tokio::ChildWrapper;
use sidekicks_contracts::provider::account::record::{
    PROVIDER_SIGN_IN_FAILURE_REASON_MAX_LEN, ProviderAuthMode,
};
use sidekicks_contracts::provider::account::sign_in::{
    PROVIDER_SIGN_IN_CODE_MAX_LEN, ProviderSignInArm, ProviderSignInCancelStatus,
};
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_platforms::{ChildEnd, NO_BROWSER_OPENER, can_open_browser, wrap_child_command};
use tokio::io::{AsyncBufReadExt as _, AsyncReadExt as _, AsyncWriteExt as _, BufReader, Take};
use tokio::process::{ChildStderr, ChildStdin, ChildStdout};
use tokio::sync::{mpsc, oneshot};

use crate::account::credential_home::CredentialHome;
use crate::account::resolver::credential_home_folders;
use crate::child_ending::{ChildEnding, stop_child};
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::account::ClaudeAccountLegs;
use crate::driver::claude::account::credentials::{
    CUSTOM_SIGN_IN_HOST_VARIABLE, ClaudeCustomSignInBase, SIGN_IN_OVERRIDE_VARIABLES,
    read_custom_sign_in_base,
};
use crate::driver::claude::spawn::command::compose_claude_command;
use crate::driver::claude::spawn::environment::{
    ClaudeAccountFolders, ClaudeProcessHome, compose_claude_scratch_folder,
};
use crate::driver::claude::spawn::launch::control_only::{
    ClaudeSignInSources, probe_claude_sign_in,
};
use crate::driver::claude::spawn::one_shot_command::compose_claude_subcommand_arguments;
use crate::driver::contract::account::{
    ProviderSignInEnd, ProviderSignInHandle, ProviderSignInInput, ProviderSignInObservation,
    read_sign_in_address,
};
use crate::driver::contract::error::{DriverError, bound_provider_words};
use crate::spawned_version::ResolvedProviderExecutable;

/// The arguments after the Claude Code command that start its claude.ai sign-in.
const CLAUDE_SIGN_IN_ARGUMENTS: [&str; 3] = ["auth", "login", "--claudeai"];

/// The host Claude Code's claude.ai sign-in page is served from.
const CLAUDE_SIGN_IN_HOST: &str = "claude.com";

/// The text Claude Code writes before the sign-in address, which runs to the line's end.
const VISIT_MARKER: &[u8] = b"If the browser didn't open, visit: ";

/// The prompt Claude Code writes, with no line end, once it waits for a pasted code.
const CODE_PROMPT: &[u8] = b"Paste code here if prompted > ";

/// The start of the line Claude Code writes to its error output for a code it refused, after
/// which it waits for another without writing its prompt again.
const REFUSED_CODE_START: &[u8] = b"Invalid code";

/// How long the flow has to write its address before it is stopped.
const ADDRESS_WAIT: Duration = Duration::from_secs(30);

/// How long a sign-in may run before it is stopped as expired; Claude Code names no bound.
const SIGN_IN_BOUND: Duration = Duration::from_mins(15);

/// How long a flow asked to stop has before it is killed.
const STOP_GRACE: Duration = Duration::from_secs(5);

/// The variable naming the program Claude Code opens its sign-in page with.
const BROWSER_VARIABLE: &str = "BROWSER";

/// The most of one error output line held, far above the refusal line's length; a longer line is
/// read in pieces of this length.
const ERROR_LINE_CAP: u64 = 4 * 1024;

/// How long the error stream is still read once the flow has exited, for the reason it gives.
const ERROR_DRAIN_WAIT: Duration = Duration::from_secs(1);

/// A failed flow's reason, the last line with text Claude Code wrote to its error stream.
type ErrorReason = FreeFormText<PROVIDER_SIGN_IN_FAILURE_REASON_MAX_LEN>;

/// The most output held while the address line is still unread, far above its length.
const ADDRESS_OUTPUT_CAP: usize = 64 * 1024;

/// The bytes one read of the flow's output takes.
const OUTPUT_CHUNK: usize = 4096;

/// The code prompts held for the broker, which reads each at once; a fuller queue already says
/// the flow waits.
const PROMPT_CAPACITY: usize = 4;

/// The inputs held for the flow, a code or a cancel, each answered before the next.
const INPUT_CAPACITY: usize = 4;

/// Why Claude Code's sign-in could not start or take its input.
#[derive(Debug, thiserror::Error)]
enum ClaudeSignInError {
    /// The home's scratch folder, where the command runs, could not be made.
    #[error("the folder Claude Code's sign-in runs in could not be made")]
    WorkingFolder(#[source] io::Error),
    /// The command could not start.
    #[error("Claude Code's sign-in could not start")]
    Start(#[source] io::Error),
    /// Its output could not be read.
    #[error("Claude Code's sign-in output could not be read")]
    Output(#[source] io::Error),
    /// It ended, or outlived the wait, before writing its sign-in address.
    #[error("Claude Code's sign-in wrote no sign-in address in time")]
    NoAddress,
    /// It wrote an address that is not on Claude Code's own sign-in host.
    #[error("Claude Code's sign-in wrote an address on a host it does not sign in at")]
    AddressRefused,
    /// The flow has ended and takes no more input.
    #[error("Claude Code's sign-in has ended")]
    Ended,
    /// The code could not be written to the flow's input.
    #[error("the code could not be written to Claude Code's sign-in")]
    CodeUnwritten(#[source] io::Error),
    /// The flow could be neither stopped nor killed, so it still runs.
    #[error("Claude Code's sign-in could not be ended")]
    Unended(#[source] io::Error),
}

impl From<ClaudeSignInError> for DriverError {
    fn from(error: ClaudeSignInError) -> Self {
        Self::Internal(Box::new(error))
    }
}

// What a sign-in on the person's environment removes, and the hosts its address may name.
struct SignInScope {
    removed: Vec<&'static str>,
    hosts: Vec<String>,
}

impl SignInScope {
    // The variables that would sign in ahead of the home, and a custom sign-in host Claude Code
    // refuses; an accepted one stays, and its host is a sign-in host beside Claude Code's own.
    fn read(environment: &[(String, String)]) -> Self {
        let mut removed = SIGN_IN_OVERRIDE_VARIABLES.to_vec();
        let mut hosts = vec![CLAUDE_SIGN_IN_HOST.to_owned()];
        match read_custom_sign_in_base(environment) {
            ClaudeCustomSignInBase::Unset => {}
            ClaudeCustomSignInBase::Approved(base) => hosts.extend(
                url::Url::parse(base)
                    .ok()
                    .and_then(|base| base.host_str().map(str::to_owned)),
            ),
            ClaudeCustomSignInBase::Refused => removed.push(CUSTOM_SIGN_IN_HOST_VARIABLE),
        }
        Self { removed, hosts }
    }
}

// The folders of the account whose home is `home`.
fn claude_home_folders(home: &CredentialHome) -> ClaudeAccountFolders {
    ClaudeAccountFolders::from(&credential_home_folders(&DESCRIPTOR.provider_id(), home))
}

/// Starts `claude auth login --claudeai` on `home`'s folders and answers once it wrote its sign-in
/// address; on the device-code arm its browser opener is a program that opens nothing, so the
/// person reaches the address and pastes the code back from any device. On the browser arm the
/// person's own opener stays only where a browser opened from the daemon reaches the person (no
/// SSH login, and a display or a graphical session); elsewhere the opener opens nothing too and
/// the handle says the provider opened no browser, so the client opens the address. Fails with the
/// resolve's error as the environment cannot be composed, and with `DriverError::Internal` where
/// the command cannot start or writes no address on Claude Code's own host within the wait, the
/// command then stopped.
pub(super) async fn start_claude_sign_in(
    legs: &ClaudeAccountLegs,
    home: CredentialHome,
    arm: ProviderSignInArm,
) -> Result<ProviderSignInHandle, DriverError> {
    let folders = claude_home_folders(&home);
    let scope = SignInScope::read(&legs.sources.0.base_environment);
    let executable = legs
        .sources
        .resolve_build_on(
            ClaudeProcessHome::Account { folders: &folders },
            &scope.removed,
        )
        .await?;
    let working_folder = compose_claude_scratch_folder(
        &legs.sources.0.data_folder.to_string_lossy(),
        Path::new(&folders.config_folder),
    );
    Ok(start_flow(legs, &executable, &working_folder, arm, &scope.hosts).await?)
}

/// Reads who signed in on `home` after a sign-in there, through a process that keeps nothing run
/// on the home with the same variables removed, as Claude Code's own `auth status` reads it. Fails
/// with the driver's error where the process cannot answer or its reply cannot be read.
pub(super) async fn observe_claude_sign_in(
    legs: &ClaudeAccountLegs,
    home: CredentialHome,
) -> Result<ProviderSignInObservation, DriverError> {
    let folders = claude_home_folders(&home);
    let scope = SignInScope::read(&legs.sources.0.base_environment);
    let executable = legs
        .sources
        .resolve_build_on(
            ClaudeProcessHome::Account { folders: &folders },
            &scope.removed,
        )
        .await?;
    // No account: the probe runs no turn, and a new account is not admitted yet.
    let sources = probe_claude_sign_in(&legs.launcher, &executable, None, None).await?;
    Ok(ProviderSignInObservation::read_now(
        read_claude_sign_in_mode(&sources),
        sources.has_email(),
    ))
}

// The kind of sign-in the sources name, as `claude auth status` reads them: a claude.ai
// subscription or token is a subscription, a helper's token or key comes from elsewhere, any other
// token is a pasted one, any other named key an API key; `None` is signed out.
fn read_claude_sign_in_mode(sources: &ClaudeSignInSources) -> Option<ProviderAuthMode> {
    if sources.has_subscription() {
        return Some(ProviderAuthMode::OauthSubscription);
    }
    match sources.token_source() {
        Some("claude.ai") => Some(ProviderAuthMode::OauthSubscription),
        Some("apiKeyHelper") => Some(ProviderAuthMode::External),
        Some(_) => Some(ProviderAuthMode::OauthToken),
        None => match sources.api_key_source() {
            Some("apiKeyHelper") => Some(ProviderAuthMode::External),
            Some(_) => Some(ProviderAuthMode::ApiKey),
            None => None,
        },
    }
}

// Starts the flow on the spawner's thread, reads its address and hands the rest of the flow to a
// task of its own; a flow that writes no usable address is stopped.
async fn start_flow(
    legs: &ClaudeAccountLegs,
    executable: &ResolvedProviderExecutable,
    working_folder: &Path,
    arm: ProviderSignInArm,
    hosts: &[String],
) -> Result<ProviderSignInHandle, ClaudeSignInError> {
    tokio::fs::create_dir_all(working_folder)
        .await
        .map_err(ClaudeSignInError::WorkingFolder)?;
    let mut command = compose_claude_command(
        &executable.start,
        &compose_claude_subcommand_arguments(&CLAUDE_SIGN_IN_ARGUMENTS),
        &executable.environment,
        working_folder,
    );
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let base_environment = Arc::clone(&legs.sources.0.base_environment);
    let daemon_pid = std::process::id();
    // The browser check reads files and makes a system call, so it runs on the spawner's thread,
    // just before the start.
    let (spawned, is_browser_opened_by_provider) = legs
        .sources
        .0
        .spawner
        .run(move || {
            let is_browser_opened_by_provider =
                arm == ProviderSignInArm::Browser && can_open_browser(&base_environment);
            if !is_browser_opened_by_provider {
                command.env(BROWSER_VARIABLE, NO_BROWSER_OPENER);
            }
            (
                wrap_child_command(command, daemon_pid).spawn(),
                is_browser_opened_by_provider,
            )
        })
        .await
        .map_err(ClaudeSignInError::Start)?;
    let mut child = spawned.map_err(ClaudeSignInError::Start)?;
    let input = child.stdin().take().expect("the sign-in's input is piped");
    let mut output = child
        .stdout()
        .take()
        .expect("the sign-in's output is piped");
    let errors = child
        .stderr()
        .take()
        .expect("the sign-in's error output is piped");
    let mut scan = OutputScan::default();
    let read = tokio::time::timeout(ADDRESS_WAIT, read_address_line(&mut output, &mut scan)).await;
    let address = match read {
        Ok(Ok(Some(line))) => {
            read_sign_in_address(&strip_terminal_controls(&line), &hosts_of(hosts))
                .ok_or(ClaudeSignInError::AddressRefused)
        }
        Ok(Ok(None)) | Err(_) => Err(ClaudeSignInError::NoAddress),
        Ok(Err(error)) => Err(ClaudeSignInError::Output(error)),
    };
    let verification_uri = match address {
        Ok(address) => address,
        Err(error) => {
            stop_child(&mut *child, STOP_GRACE).await;
            return Err(error);
        }
    };
    let (prompts, code_prompts) = prompt_channel::channel(PROMPT_CAPACITY);
    let (inputs, received) = mpsc::channel(INPUT_CAPACITY);
    let (end, completion) = oneshot::channel();
    let flow = Flow {
        child,
        input,
        output,
        errors: BufReader::new(errors).take(ERROR_LINE_CAP),
        ending: ChildEnding::new(STOP_GRACE),
        scan,
        prompts,
        inputs: received,
        end,
    };
    tokio::spawn(flow.run());
    Ok(ProviderSignInHandle {
        verification_uri,
        user_code: None,
        expires_at: None,
        is_browser_opened_by_provider,
        code_prompts: Box::pin(code_prompts),
        input: Box::new(ClaudeSignInInput { inputs }),
        completion: async move {
            completion
                .await
                .unwrap_or(ProviderSignInEnd::Failed { reason: None })
        }
        .boxed(),
    })
}

fn hosts_of(hosts: &[String]) -> Vec<&str> {
    hosts.iter().map(String::as_str).collect()
}

// Reads the flow's output until the address line ended, answering its text without the marker,
// or `None` where the output ended or outgrew its cap first.
async fn read_address_line(
    output: &mut ChildStdout,
    scan: &mut OutputScan,
) -> io::Result<Option<Vec<u8>>> {
    let mut chunk = [0_u8; OUTPUT_CHUNK];
    loop {
        if let Some(line) = scan.take_address_line() {
            return Ok(Some(line));
        }
        if scan.pending.len() > ADDRESS_OUTPUT_CAP {
            return Ok(None);
        }
        let read = output.read(&mut chunk).await?;
        if read == 0 {
            return Ok(None);
        }
        scan.pending.extend_from_slice(&chunk[..read]);
    }
}

/// The flow's output as read so far, scanned as bytes, never as lines, since the code prompt ends
/// no line.
#[derive(Default)]
struct OutputScan {
    pending: Vec<u8>,
}

impl OutputScan {
    // The address line's text once it has ended, the output up to its end taken; else what could
    // still start the marker is kept.
    fn take_address_line(&mut self) -> Option<Vec<u8>> {
        let Some(start) = memmem::find(&self.pending, VISIT_MARKER) else {
            self.keep_tail(VISIT_MARKER.len());
            return None;
        };
        let text_start = start + VISIT_MARKER.len();
        let end = text_start
            + self.pending[text_start..]
                .iter()
                .position(|byte| *byte == b'\n')?;
        let line = self.pending[text_start..end].to_vec();
        self.pending.drain(..=end);
        Some(line)
    }

    // How many code prompts the output read so far holds, each taken.
    fn take_prompts(&mut self) -> usize {
        let mut count = 0;
        while let Some(start) = memmem::find(&self.pending, CODE_PROMPT) {
            self.pending.drain(..start + CODE_PROMPT.len());
            count += 1;
        }
        self.keep_tail(CODE_PROMPT.len());
        count
    }

    // Keeps only the bytes that could still start a `marker_len`-byte marker.
    fn keep_tail(&mut self, marker_len: usize) {
        let keep = marker_len.saturating_sub(1);
        let excess = self.pending.len().saturating_sub(keep);
        self.pending.drain(..excess);
    }
}

// The text of `line` as a terminal shows it: its printed characters, every control sequence and
// operating-system command (the link wrapper among them) left out, then trimmed.
fn strip_terminal_controls(line: &[u8]) -> String {
    let mut shown = ShownText(String::with_capacity(line.len()));
    vte::Parser::new().advance(&mut shown, line);
    shown.0.trim().to_owned()
}

/// The characters a terminal prints, gathered as the parser hands them over.
struct ShownText(String);

impl vte::Perform for ShownText {
    fn print(&mut self, character: char) {
        self.0.push(character);
    }
}

// One input to a running flow, each answered on its own channel.
enum FlowInput {
    Code(
        FreeFormText<PROVIDER_SIGN_IN_CODE_MAX_LEN>,
        oneshot::Sender<io::Result<()>>,
    ),
    Cancel(CancelAnswer),
}

// Where a cancel's answer goes.
type CancelAnswer = oneshot::Sender<io::Result<ProviderSignInCancelStatus>>;

// What one turn of the flow's wait saw.
enum FlowEvent {
    Exited(io::Result<ExitStatus>),
    Output(io::Result<usize>),
    ErrorLine(io::Result<usize>),
    Input(Option<FlowInput>),
    Bound,
    Abandoned,
    KillDue,
}

// A started flow, run to its end on its own task.
struct Flow {
    child: Box<dyn ChildWrapper>,
    input: ChildStdin,
    output: ChildStdout,
    errors: Take<BufReader<ChildStderr>>,
    ending: ChildEnding,
    scan: OutputScan,
    prompts: prompt_channel::Sender<()>,
    inputs: mpsc::Receiver<FlowInput>,
    end: oneshot::Sender<ProviderSignInEnd>,
}

impl Flow {
    // Reports each wait for a code, writes each code, and stops the flow on a cancel, at its bound
    // or once its handle is dropped, then answers how it ended. A cancel always ends the flow: one
    // whose stop could not be asked is answered once the kill past the grace ended it, and with
    // an error only where that kill failed too, the flow left running.
    async fn run(mut self) {
        self.report_prompts();
        let bound = tokio::time::sleep(SIGN_IN_BOUND);
        tokio::pin!(bound);
        let mut chunk = [0_u8; OUTPUT_CHUNK];
        let mut error_line = Vec::new();
        // The last line Claude Code wrote to its error stream with any text, the reason a failed
        // flow gives; the broker scrubs it before it leaves.
        let mut last_error: Option<ErrorReason> = None;
        let (mut is_output_open, mut is_errors_open, mut is_input_open) = (true, true, true);
        let mut asked_end: Option<ProviderSignInEnd> = None;
        // Cancels answered by how the flow ends, not at once.
        let mut unanswered_cancels: Vec<CancelAnswer> = Vec::new();
        // Why the kill failed, once nothing can end the flow.
        let mut unended: Option<io::ErrorKind> = None;
        let status = loop {
            let event = tokio::select! {
                status = self.child.wait() => FlowEvent::Exited(status),
                read = self.output.read(&mut chunk), if is_output_open => FlowEvent::Output(read),
                read = self.errors.read_until(b'\n', &mut error_line), if is_errors_open => {
                    FlowEvent::ErrorLine(read)
                }
                input = self.inputs.recv(), if is_input_open => FlowEvent::Input(input),
                () = &mut bound, if asked_end.is_none() => FlowEvent::Bound,
                () = self.end.closed(), if asked_end.is_none() => FlowEvent::Abandoned,
                () = self.ending.kill_due() => FlowEvent::KillDue,
            };
            // The end a stop asks for.
            let stop = match event {
                FlowEvent::Exited(status) => break status,
                FlowEvent::Output(Ok(read)) if read > 0 => {
                    self.scan.pending.extend_from_slice(&chunk[..read]);
                    self.report_prompts();
                    None
                }
                FlowEvent::Output(_) => {
                    is_output_open = false;
                    None
                }
                FlowEvent::ErrorLine(Ok(read)) if read > 0 => {
                    // Never logged, since it may echo what the person pasted; only the last line
                    // with text is kept, as a failed flow's reason.
                    if error_line.starts_with(REFUSED_CODE_START) {
                        self.report_prompt();
                    }
                    keep_error_line(&error_line, &mut last_error);
                    error_line.clear();
                    self.errors.set_limit(ERROR_LINE_CAP);
                    None
                }
                FlowEvent::ErrorLine(_) => {
                    is_errors_open = false;
                    None
                }
                FlowEvent::Input(Some(FlowInput::Code(code, answer))) => {
                    let written = write_code(&mut self.input, &code).await;
                    drop(code);
                    if answer.send(written).is_err() {
                        tracing::debug!("a sign-in code's writer stopped waiting for its answer");
                    }
                    None
                }
                FlowEvent::Input(Some(FlowInput::Cancel(answer))) => {
                    if let Some(kind) = unended {
                        answer_cancel(answer, Err(kind.into()));
                        None
                    } else if asked_end.is_none() && unanswered_cancels.is_empty() {
                        match self.ending.ask(&mut *self.child, ChildEnd::Stop) {
                            Ok(()) => {
                                answer_cancel(answer, Ok(ProviderSignInCancelStatus::Canceled));
                                Some(ProviderSignInEnd::Canceled)
                            }
                            // The kill the failed stop armed ends the flow past its grace.
                            Err(error) => {
                                tracing::debug!(
                                    error = &error as &(dyn std::error::Error + 'static),
                                    "a canceled Claude Code sign-in could not be asked to stop"
                                );
                                unanswered_cancels.push(answer);
                                None
                            }
                        }
                    } else {
                        // The flow is already ending; its end answers the cancel.
                        unanswered_cancels.push(answer);
                        None
                    }
                }
                FlowEvent::Input(None) => {
                    is_input_open = false;
                    None
                }
                FlowEvent::Bound => Some(ProviderSignInEnd::Expired),
                // No one waits for the end: the flow is stopped as a cancel stops it.
                FlowEvent::Abandoned => Some(ProviderSignInEnd::Canceled),
                FlowEvent::KillDue => match self.ending.ask(&mut *self.child, ChildEnd::Kill) {
                    Ok(()) => {
                        (!unanswered_cancels.is_empty()).then_some(ProviderSignInEnd::Canceled)
                    }
                    // Nothing ends the flow now, so each cancel waiting fails and the attempt
                    // stays as it was.
                    Err(error) => {
                        tracing::debug!(
                            error = &error as &(dyn std::error::Error + 'static),
                            "Claude Code's sign-in could not be killed past its stop's grace"
                        );
                        unended = Some(error.kind());
                        for answer in unanswered_cancels.drain(..) {
                            answer_cancel(answer, Err(error.kind().into()));
                        }
                        None
                    }
                },
            };
            if let Some(end) = stop
                && asked_end.is_none()
            {
                // A cancel asked the stop already, which this asks no second time.
                if let Err(error) = self.ending.ask(&mut *self.child, ChildEnd::Stop) {
                    tracing::debug!(
                        error = &error as &(dyn std::error::Error + 'static),
                        "Claude Code's sign-in could not be asked to stop"
                    );
                }
                asked_end = Some(end);
            }
        };
        if is_errors_open {
            self.drain_errors(error_line, &mut last_error).await;
        }
        let end = asked_end.unwrap_or(match status {
            Ok(status) if status.success() => ProviderSignInEnd::Finished,
            // A flow a cancel was asked of ended unfinished: it is canceled.
            Ok(_) | Err(_) if !unanswered_cancels.is_empty() => ProviderSignInEnd::Canceled,
            Ok(_) | Err(_) => ProviderSignInEnd::Failed { reason: last_error },
        });
        let canceled = if end == ProviderSignInEnd::Canceled {
            ProviderSignInCancelStatus::Canceled
        } else {
            ProviderSignInCancelStatus::NotFound
        };
        for answer in unanswered_cancels {
            answer_cancel(answer, Ok(canceled));
        }
        if self.end.send(end).is_err() {
            tracing::debug!("a Claude Code sign-in ended after its handle was dropped");
        }
    }

    // Reads what the error stream still holds once the flow has exited, from `line`'s unfinished
    // text on, for up to `ERROR_DRAIN_WAIT`, keeping its last line with text in `last_error`.
    async fn drain_errors(&mut self, mut line: Vec<u8>, last_error: &mut Option<ErrorReason>) {
        let drained = tokio::time::timeout(ERROR_DRAIN_WAIT, async {
            loop {
                match self.errors.read_until(b'\n', &mut line).await {
                    Ok(read) if read > 0 => {
                        keep_error_line(&line, last_error);
                        line.clear();
                        self.errors.set_limit(ERROR_LINE_CAP);
                    }
                    Ok(_) | Err(_) => break,
                }
            }
        })
        .await;
        if drained.is_err() {
            tracing::debug!("Claude Code's sign-in error output was still open after it exited");
        }
        keep_error_line(&line, last_error);
    }

    fn report_prompts(&mut self) {
        for _ in 0..self.scan.take_prompts() {
            self.report_prompt();
        }
    }

    fn report_prompt(&mut self) {
        if self.prompts.try_send(()).is_err() {
            tracing::debug!("a Claude Code sign-in waited for a code while a wait was unread");
        }
    }
}

// Keeps `line` in `last_error` where it holds text once its terminal controls are left out.
fn keep_error_line(line: &[u8], last_error: &mut Option<ErrorReason>) {
    if let Some(reason) = bound_provider_words(&strip_terminal_controls(line)) {
        *last_error = Some(reason);
    }
}

// Hands a cancel `status`; one that stopped waiting is let go.
fn answer_cancel(answer: CancelAnswer, status: io::Result<ProviderSignInCancelStatus>) {
    if answer.send(status).is_err() {
        tracing::debug!("a sign-in's cancel stopped waiting for its answer");
    }
}

// Writes `code` and a line end to the flow's input.
async fn write_code(
    input: &mut ChildStdin,
    code: &FreeFormText<PROVIDER_SIGN_IN_CODE_MAX_LEN>,
) -> io::Result<()> {
    input.write_all(code.as_str().as_bytes()).await?;
    input.write_all(b"\n").await?;
    input.flush().await
}

// The input of one running flow, handed to its task.
struct ClaudeSignInInput {
    inputs: mpsc::Sender<FlowInput>,
}

impl ClaudeSignInInput {
    // Hands `input` to the flow and answers what it answered.
    async fn send<Answer>(
        &self,
        input: impl FnOnce(oneshot::Sender<io::Result<Answer>>) -> FlowInput,
    ) -> Result<io::Result<Answer>, ClaudeSignInError> {
        let (answer, answered) = oneshot::channel();
        self.inputs
            .send(input(answer))
            .await
            .map_err(|_unsent| ClaudeSignInError::Ended)?;
        answered
            .await
            .map_err(|_unanswered| ClaudeSignInError::Ended)
    }
}

impl ProviderSignInInput for ClaudeSignInInput {
    fn write_code(
        &self,
        code: FreeFormText<PROVIDER_SIGN_IN_CODE_MAX_LEN>,
    ) -> BoxFuture<'_, Result<(), DriverError>> {
        async move {
            self.send(|answer| FlowInput::Code(code, answer))
                .await?
                .map_err(ClaudeSignInError::CodeUnwritten)?;
            Ok(())
        }
        .boxed()
    }

    fn cancel(&self) -> BoxFuture<'_, Result<ProviderSignInCancelStatus, DriverError>> {
        async move {
            Ok(self
                .send(FlowInput::Cancel)
                .await?
                .map_err(ClaudeSignInError::Unended)?)
        }
        .boxed()
    }
}

#[cfg(test)]
mod tests;
