//! What a conversation's channel records do to its session's running set: a wrapper's start pairs
//! it with its row and with the provider's noted tool call of its line, which its capture window
//! names, and is acknowledged at once, then answered `go` once that window is open, or at once
//! where it gets none, the file its command's standard output writes to is tailed as that row's
//! output once it pairs, its terminal's readings feed the row's waiting checks, its exit settles
//! the row's exit code and closes its window, and an askpass's prompt opens on the row of the
//! wrapper above it, answered empty at once where no wrapper is. A wrapper started under another,
//! or relaying a command, is answered `go` and pairs with no noted call; one under another pairs
//! with nothing. A wrapper is let go at its exit, or at its process's end where it died before
//! saying so or is nested; an askpass at its process's end, which closes its prompt where no one
//! answered it.

use std::collections::HashMap;
use std::io::{self, ErrorKind};
use std::path::PathBuf;
use std::sync::Arc;

use sidekicks_contracts::command::ExitCode;
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeSignedInt;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_platforms::{FileAppendWatch, FolderArrivalWatch, InputTerminal};
use sidekicks_std::port_registration::PortRegistration;
use sidekicks_std::utf8_stream::Utf8StreamDecoder;
use sidekicks_workspace::askpass_prompt::is_masked_prompt;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

use crate::command::channel::{
    CommandChannel, DaemonRequest, PartyId, PartyRecord, ReceivedRecord,
};
use crate::command::running_set::{PromptAnswer, RunningCommandSets, WrapperCommand};
use crate::command::waiting_checks::{InputWaitReader, WaitingChecks};
use crate::port::command_capture::{
    CommandCapture, CommandWindowEnd, CommandWindowOpenError, CommandWindowStart,
};

#[cfg(test)]
mod tests;

/// What the daemon holds of one wrapper while its command runs.
struct FollowedWrapper {
    /// Set once the command exited, which ends the output's tail after its last bytes.
    exited: watch::Sender<bool>,
    tail: Option<JoinHandle<()>>,
    checks: Option<WaitingChecks>,
    last_output_tail: String,
    /// Waits for the wrapper's process to end, which lets the wrapper go where it said nothing.
    process_end: Option<JoinHandle<()>>,
    /// Which following of its id this is, so the end of a process whose id it reused is told
    /// apart.
    following: u64,
    /// The calls on its command's capture window, which the window's own task makes in order;
    /// `None` where it has no window or the window was closed. Dropped unclosed, the window
    /// closes untold.
    window: Option<mpsc::UnboundedSender<WindowCall>>,
    /// Whether the wrapper said its command began.
    has_begun: bool,
}

/// A call on a command's capture window, in the order its wrapper's records came.
enum WindowCall {
    /// The command began, covered or not.
    Began { is_covered: bool },
    /// The command ended as this says; the window's last call.
    Close(CommandWindowEnd),
}

/// What the daemon holds of one askpass while its prompt is open: the wrapper whose row shows it,
/// where one does, and the wait for its process to end, which closes the prompt and forgets it.
struct FollowedAskpass {
    wrapper: Option<PartyId>,
    process_end: Option<JoinHandle<()>>,
    following: u64,
}

/// A followed party whose process ended: its id and which following of that id it was.
type EndedParty = (PartyId, u64);

/// The provider's tool calls noted before the wrapper that runs each one starts, which a line's
/// start pairs with.
pub(crate) trait NotedWrapperCalls: Send + Sync {
    /// Removes the session `session_id`'s oldest noted call whose line is `line` and answers its
    /// tool call; `None` where no note of the line is left.
    fn pair_started_wrapper(&self, session_id: SessionId, line: &str) -> Option<ToolCallId>;
}

/// How a channel's lines are captured: the capture each line's command opens a window on, once
/// registered, and the provider's noted calls each line's start pairs with, `None` where the
/// provider notes none.
#[derive(Clone)]
pub(crate) struct LineCapture {
    /// The capture each line's command opens a window on.
    pub(crate) capture: Arc<PortRegistration<Arc<dyn CommandCapture>>>,
    /// The calls each line's start pairs with.
    pub(crate) noted_calls: Option<Arc<dyn NotedWrapperCalls>>,
}

/// Follows `channel`'s records, which `watch` made before the provider started reports, into
/// `session_id`'s rows in `set` of the process the channel serves, the one that runs `apart_run`
/// alone or, for `None`, the session's own, the waiting checks reading through `waits` and each
/// line paired and captured through `line_capture`, until the watch fails, with its error.
pub(crate) async fn follow_channel_records(
    session_id: SessionId,
    apart_run: Option<RunId>,
    channel: Arc<CommandChannel>,
    mut watch: FolderArrivalWatch,
    set: Arc<RunningCommandSets>,
    waits: Arc<dyn InputWaitReader>,
    line_capture: LineCapture,
) -> io::Result<()> {
    set.channel_followed(session_id, apart_run, &channel);
    // Bounded by the parties followed: each sends its end once, and its watch is stopped when an
    // `Exited` lets it go first.
    let (process_ended, mut ended_parties) = mpsc::unbounded_channel();
    let mut follower = RecordFollower {
        session_id,
        apart_run,
        channel,
        set,
        waits,
        line_capture,
        wrappers: HashMap::new(),
        askpasses: HashMap::new(),
        process_ended,
        followings: 0,
    };
    loop {
        tokio::select! {
            arrivals = watch.next_arrivals() => {
                for received in follower.channel.take_records(arrivals?).await {
                    follower.take_record(received).await;
                }
            }
            Some((party, following)) = ended_parties.recv() => {
                follower.process_ended(&mut watch, party, following).await?;
            }
        }
    }
}

/// One channel's follower: what its records reach, and the wrappers it holds.
struct RecordFollower {
    session_id: SessionId,
    /// The run the channel's process runs alone; `None` for the session's own process.
    apart_run: Option<RunId>,
    channel: Arc<CommandChannel>,
    set: Arc<RunningCommandSets>,
    waits: Arc<dyn InputWaitReader>,
    /// How each line is paired and captured.
    line_capture: LineCapture,
    wrappers: HashMap<PartyId, FollowedWrapper>,
    askpasses: HashMap<PartyId, FollowedAskpass>,
    /// Takes each followed party whose process ended, at most one entry per party followed.
    process_ended: mpsc::UnboundedSender<EndedParty>,
    /// How many parties were followed so far, which numbers each following.
    followings: u64,
}

impl RecordFollower {
    // Applies one record to the set.
    async fn take_record(&mut self, received: ReceivedRecord) {
        let session_id = self.session_id;
        let party = received.party;
        match received.record {
            PartyRecord::Starting {
                command,
                stdout_path,
                process,
            } => {
                send_request(&self.channel, party, &DaemonRequest::Acknowledged {}).await;
                // Only an agent's own line pairs and is captured: a relayed command is captured by
                // its relay, and a wrapper under another runs part of that one's command.
                let is_line = !received.is_nested && process.is_none();
                // Paired whether or not a capture is registered, so no paired note outlives its
                // start; the line names no tool call, so the window names the call it paired with.
                let tool_call_id = match &self.line_capture.noted_calls {
                    Some(noted_calls) if is_line => {
                        noted_calls.pair_started_wrapper(session_id, &command)
                    }
                    _ => None,
                };
                let capture = self.line_capture.capture.port().filter(|_| is_line);
                let window = if let Some(capture) = capture {
                    Some(open_window(
                        Arc::clone(capture),
                        CommandWindowStart {
                            session_id,
                            apart_run: self.apart_run,
                            command: command.clone(),
                            tool_call_id,
                        },
                        party,
                        Arc::clone(&self.channel),
                    ))
                } else {
                    send_request(&self.channel, party, &DaemonRequest::Go {}).await;
                    None
                };
                // A wrapper under another pairs with no row and shows no output, and is followed
                // only until its process ends.
                let paired = (!received.is_nested).then(|| {
                    let command =
                        process.map_or(WrapperCommand::Line(command), WrapperCommand::Process);
                    self.set
                        .wrapper_started(session_id, party, self.apart_run, command)
                });
                let (exited, ended) = watch::channel(false);
                let tail = paired.zip(stdout_path).map(|(paired, path)| {
                    let set = Arc::clone(&self.set);
                    tokio::spawn(tail_output(path, set, session_id, party, paired, ended))
                });
                let (following, process_end) = self.watch_process_end(party);
                self.wrappers.insert(
                    party,
                    FollowedWrapper {
                        exited,
                        tail,
                        checks: None,
                        last_output_tail: String::new(),
                        process_end,
                        following,
                        window,
                        has_begun: false,
                    },
                );
            }
            PartyRecord::Began { is_covered } => {
                if let Some(wrapper) = self.wrappers.get_mut(&party) {
                    wrapper.has_begun = true;
                    if let Some(window) = &wrapper.window {
                        // The window's task stops reading only once its open failed, when the
                        // command has no window to tell.
                        window
                            .send(WindowCall::Began { is_covered })
                            .unwrap_or_default();
                    }
                }
            }
            PartyRecord::Terminal {
                device,
                master,
                output_tail,
            } => {
                let Some(wrapper) = self.wrappers.get_mut(&party) else {
                    return;
                };
                let checks = wrapper.checks.get_or_insert_with(|| {
                    let set = Arc::clone(&self.set);
                    WaitingChecks::start(Arc::clone(&self.waits), move |state| {
                        set.waiting_read(session_id, party, state);
                    })
                });
                if output_tail != wrapper.last_output_tail {
                    checks.output_printed();
                    wrapper.last_output_tail.clone_from(&output_tail);
                }
                checks.terminal_read(InputTerminal { device, master }, output_tail);
            }
            PartyRecord::Exited { exit_code, signal } => {
                let row_exit_code: Option<ExitCode> =
                    exit_code.and_then(|code| SafeSignedInt::new(i64::from(code)));
                self.set.wrapper_exited(session_id, party, row_exit_code);
                // A wrapper ended before it began, killed while it waited for its `go`, ran
                // nothing, and its release closes its window unrun.
                if self
                    .wrappers
                    .get(&party)
                    .is_some_and(|wrapper| wrapper.has_begun)
                {
                    self.close_window(party, CommandWindowEnd::Exited { exit_code, signal });
                }
                self.release(party).await;
            }
            PartyRecord::Warning { message } => {
                tracing::warn!(
                    party,
                    message,
                    "a command's party could not do what it meant to"
                );
            }
            PartyRecord::Stopped {} => {
                tracing::debug!(
                    party,
                    "a command wrapper stopped its command at the daemon's stop"
                );
                if self
                    .wrappers
                    .get(&party)
                    .is_some_and(|wrapper| !wrapper.has_begun)
                {
                    self.close_window(party, CommandWindowEnd::Unrun);
                }
            }
            PartyRecord::Asking {} => {
                let prompt = received.first_argument.and_then(NonEmptyText::new);
                let channel = Arc::clone(&self.channel);
                // The askpass is forgotten once its process ends, after it read its answer.
                let answer = PromptAnswer::new(move |text| {
                    tokio::spawn(async move {
                        send_request(&channel, party, &DaemonRequest::Answer { text }).await;
                    });
                });
                // A prompt with no wrapper to show it on is answered empty as `answer` drops.
                if let Some((wrapper, prompt)) = received.wrapper.zip(prompt) {
                    let is_masked = is_masked_prompt(prompt.as_str());
                    self.set
                        .prompt_opened(session_id, wrapper, party, prompt, is_masked, answer);
                }
                let (following, process_end) = self.watch_process_end(party);
                let followed = FollowedAskpass {
                    wrapper: received.wrapper,
                    process_end,
                    following,
                };
                if let Some(earlier) = self.askpasses.insert(party, followed)
                    && let Some(process_end) = earlier.process_end
                {
                    process_end.abort();
                }
            }
        }
    }

    // Closes the wrapper `party`'s capture window, where it has one still open, as `end` says.
    fn close_window(&mut self, party: PartyId, end: CommandWindowEnd) {
        if let Some(window) = self
            .wrappers
            .get_mut(&party)
            .and_then(|wrapper| wrapper.window.take())
        {
            // The window's task stops reading only once its open failed, when there is no window
            // to close.
            window.send(WindowCall::Close(end)).unwrap_or_default();
        }
    }

    // Lets `party` go once the process of its following numbered `following` ended, after the
    // records it wrote before its end, which are in the folder by now. Fails when `watch` cannot
    // read the folder.
    async fn process_ended(
        &mut self,
        watch: &mut FolderArrivalWatch,
        party: PartyId,
        following: u64,
    ) -> io::Result<()> {
        for received in self.channel.take_records(watch.arrivals_now().await?).await {
            self.take_record(received).await;
        }
        // A party its `Exited` let go is no longer followed, and its id may be another's.
        if self
            .wrappers
            .get(&party)
            .is_some_and(|wrapper| wrapper.following == following)
        {
            self.release(party).await;
        } else if self
            .askpasses
            .get(&party)
            .is_some_and(|askpass| askpass.following == following)
        {
            self.askpass_ended(party).await;
        }
        Ok(())
    }

    // Numbers a new following of `party` and sends its id with that number to the follower once
    // its process, pinned at its admission, ends.
    fn watch_process_end(&mut self, party: PartyId) -> (u64, Option<JoinHandle<()>>) {
        self.followings += 1;
        let following = self.followings;
        let Some(process) = self.channel.party_process(party) else {
            return (following, None);
        };
        let process_ended = self.process_ended.clone();
        let process_end = tokio::spawn(async move {
            match process.wait_for_end().await {
                Ok(()) => process_ended.send((party, following)).unwrap_or_default(),
                Err(error) => tracing::warn!(
                    party,
                    error = &error as &(dyn std::error::Error + 'static),
                    "a command party's process end could not be watched"
                ),
            }
        });
        (following, Some(process_end))
    }

    // Lets the askpass `party` go once its process ended: its prompt, which no one can answer any
    // more, closed, and its place on the channel forgotten.
    async fn askpass_ended(&mut self, party: PartyId) {
        if let Some(askpass) = self.askpasses.remove(&party)
            && let Some(wrapper) = askpass.wrapper
        {
            self.set.prompt_ended(self.session_id, wrapper, party);
        }
        self.channel.forget_party(party).await;
    }

    // Lets the wrapper `party` go: a window it still holds closed unrun where its command never
    // began, its output read to the end, its checks stopped, its row's pairing and its place on
    // the channel forgotten.
    async fn release(&mut self, party: PartyId) {
        if self
            .wrappers
            .get(&party)
            .is_some_and(|wrapper| !wrapper.has_begun)
        {
            self.close_window(party, CommandWindowEnd::Unrun);
        }
        if let Some(wrapper) = self.wrappers.remove(&party) {
            if let Some(process_end) = wrapper.process_end {
                process_end.abort();
            }
            wrapper.exited.send_replace(true);
            if let Some(tail) = wrapper.tail
                && let Err(error) = tail.await
            {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "a command's output tail ended abnormally"
                );
            }
        }
        self.set.wrapper_ended(self.session_id, party);
        self.channel.forget_party(party).await;
    }
}

// Opens `start`'s capture window on a task of its own, which answers `party`, the wrapper, `go`
// once the open settled, opened or not, then makes the window's calls in the order they are sent,
// and closes it untold where they end unclosed. Bounded by the wrapper's records: one `Began` and
// one close. The open has no bound of its own: one that never settles holds the wrapper at its
// wait for `go` until the daemon stops or the wrapper is killed, and this task until the daemon
// stops.
fn open_window(
    capture: Arc<dyn CommandCapture>,
    start: CommandWindowStart,
    party: PartyId,
    channel: Arc<CommandChannel>,
) -> mpsc::UnboundedSender<WindowCall> {
    let (calls, mut waiting_calls) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        let opened = capture.open_window(start).await;
        send_request(&channel, party, &DaemonRequest::Go {}).await;
        let window = match opened {
            Ok(window) => window,
            Err(CommandWindowOpenError::Refused(refusal)) => {
                tracing::debug!(
                    party,
                    error = &refusal as &(dyn std::error::Error + 'static),
                    "a command runs with no capture window to cover"
                );
                return;
            }
            Err(error @ CommandWindowOpenError::CaptureFailed(_)) => {
                tracing::warn!(
                    party,
                    error = &error as &(dyn std::error::Error + 'static),
                    "a command runs with no capture window"
                );
                return;
            }
        };
        while let Some(call) = waiting_calls.recv().await {
            match call {
                WindowCall::Began { is_covered } => {
                    capture.command_began(&window, is_covered).await;
                }
                WindowCall::Close(end) => return capture.close_window(window, end).await,
            }
        }
        capture.close_window(window, CommandWindowEnd::Untold).await;
    });
    calls
}

// Sends `request` to `party`, logging a failure: a wrapper never sent its `go` runs uncovered once
// its own wait ends, which after an acknowledgment is when its requests can no longer be read.
async fn send_request(channel: &CommandChannel, party: PartyId, request: &DaemonRequest) {
    if let Err(error) = channel.send_request(party, request).await {
        tracing::warn!(
            error = &error as &(dyn std::error::Error + 'static),
            "a command channel's request could not be written"
        );
    }
}

// Tails the file at `path` as the wrapper `party`'s output, from its first byte once the wrapper
// pairs with its row, until its command exited and its last bytes are read; the file held open
// from the start is what holds the output before the pairing. A file shorter than what was read,
// after the end, is the end of the output; a wrapper that ends unpaired has no output to show.
async fn tail_output(
    path: PathBuf,
    set: Arc<RunningCommandSets>,
    session_id: SessionId,
    party: PartyId,
    mut paired: watch::Receiver<bool>,
    mut ended: watch::Receiver<bool>,
) {
    let mut decoder = Utf8StreamDecoder::default();
    let publish = |bytes: &[u8], decoder: &mut Utf8StreamDecoder| {
        decoder.push(bytes, |text| {
            set.wrapper_output(session_id, party, text);
        });
    };
    let mut file = match FileAppendWatch::watch(&path).await {
        Ok(file) => file,
        Err(error) => {
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                "a command's output file could not be watched"
            );
            return;
        }
    };
    tokio::select! {
        biased;
        is_paired = paired.wait_for(|is_paired| *is_paired) => if is_paired.is_err() {
            return;
        },
        _ = ended.wait_for(|has_exited| *has_exited) => return,
    }
    loop {
        tokio::select! {
            biased;
            has_exited = async { ended.wait_for(|has_exited| *has_exited).await.is_ok() } => {
                if has_exited {
                    drain(&mut file, &mut decoder, &publish).await;
                }
                break;
            }
            appended = file.next_appended() => match appended {
                Ok(bytes) => publish(&bytes, &mut decoder),
                Err(error) => {
                    tracing::warn!(
                        error = &error as &(dyn std::error::Error + 'static),
                        "a command's output file could not be read"
                    );
                    break;
                }
            },
        }
    }
    decoder.finish(|text| set.wrapper_output(session_id, party, text));
}

// Reads the bytes left in `file` once its writer ended.
async fn drain(
    file: &mut FileAppendWatch,
    decoder: &mut Utf8StreamDecoder,
    publish: &impl Fn(&[u8], &mut Utf8StreamDecoder),
) {
    loop {
        match file.drain().await {
            Ok(bytes) if bytes.is_empty() => return,
            Ok(bytes) => publish(&bytes, decoder),
            Err(error) if error.kind() == ErrorKind::InvalidData => return,
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "a command's last output could not be read"
                );
                return;
            }
        }
    }
}
