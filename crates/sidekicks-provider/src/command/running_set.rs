//! The commands each session's agents run, provider-neutral: one row per command the provider
//! reports, in start order, paired with the wrapper that runs it where one does, so its output,
//! input wait and askpass prompt reach its row. Every change reaches the session's subscribers as
//! the whole set, a command's output is kept only as its live tail, and each command's ending is
//! appended once on the session's binding at the time it ends, so a fork move changes nothing.

use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::sync::{Arc, Mutex, MutexGuard};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use serde_json::json;
use sidekicks_contracts::command::{
    AgentCommandEndedPayload, CommandEnding, CommandId, ExitCode, RunningCommand,
};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::watch;
use tokio::time::Instant;

use crate::command::channel::PartyId;
use crate::command::waiting_checks::WaitingState;
use crate::driver::contract::ProviderDriver;
use crate::port::inbound_dispatch::InboundDispatch;
use crate::port::running_command_publisher::{
    CommandStart, ProviderCommandEnd, ReseedScope, RunningCommandParams, RunningCommandPublisher,
    WriteCommandInputParams, command_act_unsupported,
};
use crate::run::delivery::{DeliveryBinding, InboundDelivery, LateAppendableRow};

mod drawing;
mod feed;
mod refusals;

use drawing::drawn_row;
use feed::OutputRing;
pub(crate) use feed::RunningCommandFeed;
#[cfg(test)]
pub(crate) use feed::{next_sent_frame, next_sent_set_where};
use refusals::not_in_foreground;
pub(crate) use refusals::takes_no_input;

#[cfg(any(test, feature = "test-support"))]
mod test_support;
#[cfg(any(test, feature = "test-support"))]
pub use test_support::unbound_running_command_sets;
#[cfg(test)]
mod tests;

/// The binding a session runs on now, where it has one.
pub type SessionBindingLookup = Arc<dyn Fn(&SessionId) -> Option<RuntimeBindingId> + Send + Sync>;

/// Where a command's ending is appended: the session's event log, through the binding it runs on.
pub trait CommandEndingAppender: Send + Sync {
    /// Appends `ending` on `binding_id`, `summary` as its body; a failure is logged, since the
    /// provider's stream cannot take it back.
    fn append(
        &self,
        binding_id: RuntimeBindingId,
        ending: AgentCommandEndedPayload,
        summary: Option<String>,
    ) -> BoxFuture<'_, ()>;
}

impl<Dispatch: InboundDispatch + ?Sized> CommandEndingAppender for Dispatch {
    fn append(
        &self,
        binding_id: RuntimeBindingId,
        ending: AgentCommandEndedPayload,
        summary: Option<String>,
    ) -> BoxFuture<'_, ()> {
        let dispatched = self.dispatch(InboundDelivery::SessionRow {
            binding: DeliveryBinding {
                binding_id,
                operation: None,
            },
            row: LateAppendableRow::AgentCommandEnded(ending),
            content: summary,
        });
        async move {
            if let Err(error) = dispatched.await {
                tracing::warn!(
                    error = &*error as &(dyn Error + 'static),
                    "a command's ending was not appended"
                );
            }
        }
        .boxed()
    }
}

/// The wrapper a channel record comes from, and what it says of its command.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum WrapperCommand {
    /// A command whose shell line runs this text.
    Line(String),
    /// A command the provider's executor names by this process.
    Process(String),
}

/// What the person writes to a command: its text, and whether its input then ends.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandInput {
    /// The typed text.
    pub text: Option<String>,
    /// Whether the input ends after the text.
    pub is_end_of_input: bool,
}

/// Where an askpass prompt's answer goes, called once; one dropped unanswered, as a prompt closed
/// by its command's exit or never shown is, answers empty, so its git or ssh never waits on it.
pub(crate) struct PromptAnswer(Option<Box<dyn FnOnce(String) + Send>>);

impl PromptAnswer {
    /// The answer that `answer` takes.
    pub(crate) fn new(answer: impl FnOnce(String) + Send + 'static) -> Self {
        Self(Some(Box::new(answer)))
    }

    fn answer(mut self, text: String) {
        if let Some(answer) = self.0.take() {
            answer(text);
        }
    }

    // Drops the answer unsent, for a prompt whose askpass has ended.
    fn dismiss(mut self) {
        self.0.take();
    }
}

impl Drop for PromptAnswer {
    fn drop(&mut self) {
        if let Some(answer) = self.0.take() {
            answer(String::new());
        }
    }
}

/// The running commands of every session, and what their subscribers read.
pub struct RunningCommandSets {
    sessions: Arc<Mutex<HashMap<SessionId, SessionCommands>>>,
    binding_of: SessionBindingLookup,
    endings: Arc<dyn CommandEndingAppender>,
}

struct SessionCommands {
    rows: Vec<CommandRow>,
    unpaired: Vec<UnpairedWrapper>,
    /// Counts each change to the set as drawn, so a feed sends the set once per change it saw.
    commands_version: u64,
    /// Raised on every change, the set's or a command's output, waking each feed.
    changed: watch::Sender<()>,
    /// The runs of the session's processes apart from its own, such as a staged review's, whose
    /// rows its own process's whole list and its end leave alone.
    apart_runs: HashSet<RunId>,
}

impl Default for SessionCommands {
    fn default() -> Self {
        Self {
            rows: Vec::new(),
            unpaired: Vec::new(),
            commands_version: 0,
            changed: watch::Sender::new(()),
            apart_runs: HashSet::new(),
        }
    }
}

struct CommandRow {
    start: CommandStart,
    started: Instant,
    state: RowState,
    wrapper: RowWrapper,
    facts: WrapperFacts,
    output: OutputRing,
    // The person's stop under way or answered, which a later stop answers as.
    stop_answer: Option<watch::Receiver<Option<StopAnswer>>>,
}

/// How the provider answered the person's stop: done, or refused with its code and words.
type StopAnswer = Result<(), (RefusalCode, String)>;

// The wrapper that runs a row's command: none yet, this one, or one that has ended, after which
// no other pairs with the row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RowWrapper {
    Waiting,
    Paired(PartyId),
    Ended,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RowState {
    Foreground,
    Background,
    // The person's stop was sent; the state it was sent from is kept for the row's drawing and for
    // a refused stop.
    Stopping { was_foreground: bool },
}

#[derive(Default)]
struct WrapperFacts {
    // Set once the wrapper reported its command exited.
    exit: Option<WrapperExit>,
    waiting: Option<WaitingState>,
    prompt: Option<OpenPrompt>,
}

// How the wrapper's command exited: its code, absent for a signal's end.
struct WrapperExit {
    code: Option<ExitCode>,
}

struct OpenPrompt {
    askpass: PartyId,
    text: NonEmptyText,
    is_masked: bool,
    answer: PromptAnswer,
}

struct UnpairedWrapper {
    party: PartyId,
    command: WrapperCommand,
    facts: WrapperFacts,
    // Raised once the wrapper pairs with its row.
    paired: watch::Sender<bool>,
}

// Why a row ends.
enum RowEnd {
    // The provider's own end of it.
    Provider(ProviderCommandEnd),
    // The provider's list of its commands no longer names it.
    Unlisted,
    // The provider's process exited.
    ProviderExited,
}

impl RunningCommandSets {
    /// Running sets that append each ending through `endings` on the binding `binding_of` answers
    /// for its session when the command ends.
    pub fn new(binding_of: SessionBindingLookup, endings: Arc<dyn CommandEndingAppender>) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            binding_of,
            endings,
        }
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<SessionId, SessionCommands>> {
        lock(&self.sessions)
    }

    /// Follows `session_id`'s running commands: the feed sends the whole set at once, then after
    /// every change, and each command's output from the start of its live tail.
    pub fn subscribe(&self, session_id: SessionId) -> RunningCommandFeed {
        let changed = self
            .lock()
            .entry(session_id)
            .or_default()
            .changed
            .subscribe();
        RunningCommandFeed::new(Arc::clone(&self.sessions), session_id, changed)
    }

    /// Whether a command of `session_id` still runs: one the provider reported, or one whose
    /// wrapper started before the provider named it.
    pub fn has_running_commands(&self, session_id: SessionId) -> bool {
        self.lock()
            .get(&session_id)
            .is_some_and(|commands| !commands.rows.is_empty() || !commands.unpaired.is_empty())
    }

    /// The person's stop, carried out by the session's `driver`: answered once the provider
    /// acknowledged it, at once for a command that is not running, and for a command whose stop
    /// was already sent as that stop is answered. Fails with the provider's refusal, the row then
    /// drawn as it was.
    pub async fn stop(
        &self,
        driver: &dyn ProviderDriver,
        session_id: SessionId,
        command_id: &CommandId,
    ) -> Result<(), HandlerError> {
        let sent = {
            let mut sessions = self.lock();
            let Some(commands) = sessions.get_mut(&session_id) else {
                return Ok(());
            };
            let Some(row) = commands.row_mut(command_id) else {
                return Ok(());
            };
            match row.state {
                RowState::Stopping { .. } => Err(row
                    .stop_answer
                    .clone()
                    .expect("a stopping row holds its stop's answer")),
                RowState::Foreground | RowState::Background => {
                    let was_foreground = row.state == RowState::Foreground;
                    let (answer, answered) = watch::channel(None);
                    row.state = RowState::Stopping { was_foreground };
                    row.stop_answer = Some(answered);
                    commands.publish_commands();
                    Ok((was_foreground, answer))
                }
            }
        };
        let (was_foreground, answer) = match sent {
            Ok(sent) => sent,
            Err(answered) => return Self::answered_stop(answered, command_id).await,
        };
        let stopped = match self.command_params(session_id, command_id) {
            Ok(params) => driver
                .stop_command(params)
                .await
                .map_err(HandlerError::from),
            Err(refusal) => Err(refusal.into()),
        };
        let Err(error) = stopped else {
            answer.send_replace(Some(Ok(())));
            return Ok(());
        };
        answer.send_replace(Some(Err(match &error {
            HandlerError::Refused(refusal) => (refusal.code, refusal.message.clone()),
            HandlerError::Internal(_) | HandlerError::Canceled => (
                RefusalCode::ProviderUnavailable,
                "The provider did not take the stop.".to_owned(),
            ),
        })));
        self.update_row(session_id, command_id, |row| {
            if matches!(row.state, RowState::Stopping { .. }) {
                row.state = if was_foreground {
                    RowState::Foreground
                } else {
                    RowState::Background
                };
                row.stop_answer = None;
            }
        });
        Err(error)
    }

    // A later stop of a command whose stop was sent: answered as that stop is, once it is.
    async fn answered_stop(
        mut answered: watch::Receiver<Option<StopAnswer>>,
        command_id: &CommandId,
    ) -> Result<(), HandlerError> {
        let answer = answered
            .wait_for(Option::is_some)
            .await
            .ok()
            .and_then(|answer| answer.clone());
        match answer {
            Some(Ok(())) => Ok(()),
            Some(Err((code, message))) => Err(DomainError::new(message, code)
                .with_detail(json!({ "commandId": command_id }))
                .into()),
            // The first stop's caller went away before the provider answered.
            None => Err(DomainError::new(
                "The provider did not answer the stop.",
                RefusalCode::ProviderUnavailable,
            )
            .with_detail(json!({ "commandId": command_id }))
            .into()),
        }
    }

    /// The person's move to the background, carried out by the session's `driver`, for a command
    /// the agent waits on. Refused with `agent.command.notInForeground` for any other, with
    /// `provider.capability.unsupported` where the provider cannot move it, and with the
    /// provider's refusal.
    pub async fn move_to_background(
        &self,
        driver: &dyn ProviderDriver,
        session_id: SessionId,
        command_id: &CommandId,
    ) -> Result<(), HandlerError> {
        {
            let sessions = self.lock();
            let row = sessions
                .get(&session_id)
                .and_then(|commands| commands.row(command_id))
                .filter(|row| row.state == RowState::Foreground)
                .ok_or_else(|| not_in_foreground(command_id))?;
            if !row.start.can_move_to_background {
                return Err(command_act_unsupported(command_id).into());
            }
        }
        let params = self.command_params(session_id, command_id)?;
        if !driver.move_command_to_background(params).await? {
            return Err(not_in_foreground(command_id).into());
        }
        self.update_row(session_id, command_id, |row| {
            if row.state == RowState::Foreground {
                row.state = RowState::Background;
            }
        });
        Ok(())
    }

    /// The person's input: an open askpass prompt takes it as its answer, the end of input alone
    /// answering it empty; otherwise the session's `driver` writes it to a command that takes
    /// input. Refused with `agent.command.takesNoInput` for any other command, and with the
    /// provider's refusal.
    pub async fn write(
        &self,
        driver: &dyn ProviderDriver,
        session_id: SessionId,
        command_id: &CommandId,
        input: CommandInput,
    ) -> Result<(), HandlerError> {
        {
            let mut sessions = self.lock();
            let Some(commands) = sessions.get_mut(&session_id) else {
                return Err(takes_no_input(command_id).into());
            };
            let Some(row) = commands.row_mut(command_id) else {
                return Err(takes_no_input(command_id).into());
            };
            if let Some(prompt) = row.facts.prompt.take() {
                prompt.answer.answer(input.text.unwrap_or_default());
                commands.publish_commands();
                return Ok(());
            }
            if !row.start.accepts_input {
                return Err(takes_no_input(command_id).into());
            }
        }
        let command = self.command_params(session_id, command_id)?;
        driver
            .write_command_input(WriteCommandInputParams {
                command,
                text: input.text,
                is_end_of_input: input.is_end_of_input,
            })
            .await?;
        Ok(())
    }

    // What an act on `command_id` hands the driver: the session's binding now. Refused
    // `provider.unavailable` for a session bound to no provider now.
    fn command_params(
        &self,
        session_id: SessionId,
        command_id: &CommandId,
    ) -> Result<RunningCommandParams, DomainError> {
        let binding_id = (self.binding_of)(&session_id).ok_or_else(|| {
            DomainError::new(
                "The session runs on no provider now.",
                RefusalCode::ProviderUnavailable,
            )
            .with_detail(json!({ "commandId": command_id }))
        })?;
        Ok(RunningCommandParams {
            session_id,
            binding_id,
            command_id: command_id.clone(),
        })
    }

    /// Pairs the wrapper `party` with its command's row: a line with the oldest unpaired row whose
    /// line runs the same text, a process with the row the provider names by it; a wrapper whose
    /// row is not known yet waits for it. Answers the signal raised once it pairs, which its output
    /// waits on.
    pub(crate) fn wrapper_started(
        &self,
        session_id: SessionId,
        party: PartyId,
        command: WrapperCommand,
    ) -> watch::Receiver<bool> {
        let mut sessions = self.lock();
        let commands = sessions.entry(session_id).or_default();
        let found = commands
            .rows
            .iter_mut()
            .find(|row| row.wrapper == RowWrapper::Waiting && row_runs(row, &command));
        let (paired, is_paired) = watch::channel(found.is_some());
        match found {
            Some(row) => row.wrapper = RowWrapper::Paired(party),
            None => commands.unpaired.push(UnpairedWrapper {
                party,
                command,
                facts: WrapperFacts::default(),
                paired,
            }),
        }
        is_paired
    }

    /// Output the wrapper `party` read from its command, kept in its row's live tail; dropped for a
    /// wrapper not paired.
    pub(crate) fn wrapper_output(&self, session_id: SessionId, party: PartyId, data: &str) {
        let mut sessions = self.lock();
        let Some(commands) = sessions.get_mut(&session_id) else {
            return;
        };
        if let Some(index) = commands
            .rows
            .iter()
            .position(|row| row.wrapper == RowWrapper::Paired(party))
        {
            commands.publish_output(index, data);
        }
    }

    /// The wrapper `party`'s command exited with `exit_code`, which its row's ending takes when
    /// the provider gives none.
    pub(crate) fn wrapper_exited(
        &self,
        session_id: SessionId,
        party: PartyId,
        exit_code: Option<ExitCode>,
    ) {
        self.update_wrapper(session_id, party, |facts| {
            facts.exit = Some(WrapperExit { code: exit_code });
            facts.prompt.take().is_some()
        });
    }

    /// What the wrapper `party`'s command's input wait now reads.
    pub(crate) fn waiting_read(&self, session_id: SessionId, party: PartyId, state: WaitingState) {
        self.update_wrapper(session_id, party, |facts| {
            let changed = facts.waiting != Some(state);
            facts.waiting = Some(state);
            changed
        });
    }

    /// Opens the askpass `askpass`'s prompt on the wrapper `party`'s command, in its own words,
    /// masked when its kind is; `answer` takes the person's answer, and answers empty for a wrapper
    /// the set holds nothing of.
    pub(crate) fn prompt_opened(
        &self,
        session_id: SessionId,
        party: PartyId,
        askpass: PartyId,
        text: NonEmptyText,
        is_masked: bool,
        answer: PromptAnswer,
    ) {
        self.update_wrapper(session_id, party, |facts| {
            facts.prompt = Some(OpenPrompt {
                askpass,
                text,
                is_masked,
                answer,
            });
            true
        });
    }

    /// Closes the prompt the askpass `askpass` opened on the wrapper `party`'s command, unanswered,
    /// once that askpass ended.
    pub(crate) fn prompt_ended(&self, session_id: SessionId, party: PartyId, askpass: PartyId) {
        self.update_wrapper(session_id, party, |facts| {
            let is_its_prompt = facts
                .prompt
                .as_ref()
                .is_some_and(|prompt| prompt.askpass == askpass);
            if is_its_prompt && let Some(prompt) = facts.prompt.take() {
                prompt.answer.dismiss();
            }
            is_its_prompt
        });
    }

    /// How many wrappers in `session_id` wait for their row.
    #[cfg(test)]
    pub(crate) fn unpaired_count(&self, session_id: SessionId) -> usize {
        self.lock()
            .get(&session_id)
            .map_or(0, |commands| commands.unpaired.len())
    }

    /// The wrapper that runs `command_id` in `session_id`; `None` before one pairs with its row
    /// and once it ended.
    pub(crate) fn paired_wrapper(
        &self,
        session_id: SessionId,
        command_id: &CommandId,
    ) -> Option<PartyId> {
        match self.lock().get(&session_id)?.row(command_id)?.wrapper {
            RowWrapper::Paired(party) => Some(party),
            RowWrapper::Waiting | RowWrapper::Ended => None,
        }
    }

    /// Forgets the wrapper `party`, whose command ended or whose process did, so a later process
    /// that reuses its id reaches no row of its.
    /// Marks `run_id` as a process of `session_id` apart from its own, whose rows the session's
    /// own whole list and process end leave alone until `apart_run_ended`.
    pub(crate) fn apart_run_started(&self, session_id: SessionId, run_id: RunId) {
        self.lock()
            .entry(session_id)
            .or_default()
            .apart_runs
            .insert(run_id);
    }

    /// Clears the mark `apart_run_started` set, once the apart process ended its rows.
    pub(crate) fn apart_run_ended(&self, session_id: SessionId, run_id: RunId) {
        if let Some(commands) = self.lock().get_mut(&session_id) {
            commands.apart_runs.remove(&run_id);
        }
    }

    pub(crate) fn wrapper_ended(&self, session_id: SessionId, party: PartyId) {
        let mut sessions = self.lock();
        if let Some(commands) = sessions.get_mut(&session_id) {
            commands.unpaired.retain(|unpaired| unpaired.party != party);
            for row in &mut commands.rows {
                if row.wrapper == RowWrapper::Paired(party) {
                    row.wrapper = RowWrapper::Ended;
                }
            }
        }
    }

    // Applies `change` to a wrapper's facts, on its row or while it waits for one; a change that
    // answers true sends the set.
    fn update_wrapper(
        &self,
        session_id: SessionId,
        party: PartyId,
        change: impl FnOnce(&mut WrapperFacts) -> bool,
    ) {
        let mut sessions = self.lock();
        let Some(commands) = sessions.get_mut(&session_id) else {
            return;
        };
        if let Some(row) = commands
            .rows
            .iter_mut()
            .find(|row| row.wrapper == RowWrapper::Paired(party))
        {
            if change(&mut row.facts) {
                commands.publish_commands();
            }
        } else if let Some(unpaired) = commands.unpaired_mut(party) {
            change(&mut unpaired.facts);
        }
    }

    fn update_row(
        &self,
        session_id: SessionId,
        command_id: &CommandId,
        change: impl FnOnce(&mut CommandRow),
    ) {
        let mut sessions = self.lock();
        if let Some(commands) = sessions.get_mut(&session_id)
            && let Some(row) = commands.row_mut(command_id)
        {
            change(row);
            commands.publish_commands();
        }
    }

    // Adds a row for `start` in `state`, paired with a wrapper already waiting for it, whose
    // output then starts.
    fn add_row(commands: &mut SessionCommands, start: CommandStart, state: RowState) {
        let mut row = CommandRow {
            start,
            started: Instant::now(),
            state,
            wrapper: RowWrapper::Waiting,
            facts: WrapperFacts::default(),
            output: OutputRing::default(),
            stop_answer: None,
        };
        if let Some(index) = commands
            .unpaired
            .iter()
            .position(|unpaired| row_runs(&row, &unpaired.command))
        {
            let unpaired = commands.unpaired.remove(index);
            row.wrapper = RowWrapper::Paired(unpaired.party);
            row.facts = unpaired.facts;
            unpaired.paired.send_replace(true);
        }
        commands.rows.push(row);
        commands.publish_commands();
    }

    // Removes the row at `index` and appends its ending: the person's stop ends it by the person;
    // a row the provider stopped itself, or no longer lists, fails; else its exit code decides,
    // the wrapper's where the provider gave none, a summary riding only on a failed ending.
    fn end_row(&self, commands: &mut SessionCommands, index: usize, end: RowEnd) {
        let row = commands.rows.remove(index);
        let wrapper_code = row.facts.exit.and_then(|exit| exit.code);
        let (exit_code, is_failed, summary) = match end {
            RowEnd::Provider(end) => (
                end.exit_code.or(wrapper_code),
                end.is_stopped_by_provider,
                end.summary,
            ),
            RowEnd::Unlisted => (None, true, None),
            RowEnd::ProviderExited => (wrapper_code, false, None),
        };
        let ending = match row.state {
            RowState::Stopping { .. } => CommandEnding::EndedByPerson,
            RowState::Foreground | RowState::Background
                if !is_failed && exit_code.is_some_and(|code| code.get() == 0) =>
            {
                CommandEnding::Finished
            }
            RowState::Foreground | RowState::Background => CommandEnding::Failed,
        };
        let session_id = row.start.session_id;
        commands.publish_commands();
        let duration_ms = u64::try_from(row.started.elapsed().as_millis()).unwrap_or(u64::MAX);
        let payload = AgentCommandEndedPayload {
            session_id,
            run_id: row.start.run_id,
            command_id: row.start.command_id,
            ending,
            exit_code,
            duration_ms: SafeInt::new(duration_ms).expect("a command runs far less than 2^53 ms"),
            source_epoch: None,
            source_position: None,
            content_length: None,
            content_truncated: None,
            content_encoding: None,
        };
        let summary = summary.filter(|_| ending == CommandEnding::Failed);
        let Some(binding_id) = (self.binding_of)(&session_id) else {
            tracing::warn!("a command ended in a session bound to no provider");
            return;
        };
        let endings = Arc::clone(&self.endings);
        tokio::spawn(async move { endings.append(binding_id, payload, summary).await });
    }
}

impl RunningCommandPublisher for RunningCommandSets {
    fn publish_output(&self, session_id: SessionId, command_id: CommandId, data: String) {
        let mut sessions = self.lock();
        if let Some(commands) = sessions.get_mut(&session_id)
            && let Some(index) = commands.index(&command_id)
        {
            commands.publish_output(index, &data);
        }
    }

    fn command_started(&self, start: CommandStart) {
        let mut sessions = self.lock();
        let commands = sessions.entry(start.session_id).or_default();
        if commands.row(&start.command_id).is_some() {
            return;
        }
        let state = if start.is_backgrounded {
            RowState::Background
        } else {
            RowState::Foreground
        };
        Self::add_row(commands, start, state);
    }

    fn command_moved_to_background(&self, start: CommandStart) {
        let mut sessions = self.lock();
        let commands = sessions.entry(start.session_id).or_default();
        match commands.row_mut(&start.command_id) {
            Some(row) => {
                if row.state == RowState::Foreground {
                    row.state = RowState::Background;
                    commands.publish_commands();
                }
            }
            None => Self::add_row(commands, start, RowState::Background),
        }
    }

    fn command_ended(&self, session_id: SessionId, command_id: CommandId, end: ProviderCommandEnd) {
        let mut sessions = self.lock();
        let Some(commands) = sessions.get_mut(&session_id) else {
            return;
        };
        if let Some(index) = commands.index(&command_id) {
            self.end_row(commands, index, RowEnd::Provider(end));
        }
    }

    fn commands_listed(
        &self,
        session_id: SessionId,
        scope: ReseedScope,
        listed: Vec<CommandStart>,
    ) {
        let mut sessions = self.lock();
        let commands = sessions.entry(session_id).or_default();
        let mut index = 0;
        while let Some(row) = commands.rows.get(index) {
            let is_covered = !commands.apart_runs.contains(&row.start.run_id)
                && match scope {
                    ReseedScope::EveryCommand => true,
                    ReseedScope::BackgroundCommands => matches!(
                        row.state,
                        RowState::Background
                            | RowState::Stopping {
                                was_foreground: false
                            }
                    ),
                };
            let is_listed = listed
                .iter()
                .any(|start| start.command_id == row.start.command_id);
            if is_covered && !is_listed {
                self.end_row(commands, index, RowEnd::Unlisted);
            } else {
                index += 1;
            }
        }
        for start in listed {
            if commands.row(&start.command_id).is_none() {
                Self::add_row(commands, start, RowState::Background);
            }
        }
    }

    fn provider_exited(&self, session_id: SessionId) {
        let mut sessions = self.lock();
        let Some(commands) = sessions.get_mut(&session_id) else {
            return;
        };
        let mut index = 0;
        while let Some(row) = commands.rows.get(index) {
            if commands.apart_runs.contains(&row.start.run_id) {
                index += 1;
            } else {
                self.end_row(commands, index, RowEnd::ProviderExited);
            }
        }
    }
}

impl SessionCommands {
    fn index(&self, command_id: &CommandId) -> Option<usize> {
        self.rows
            .iter()
            .position(|row| &row.start.command_id == command_id)
    }

    fn row(&self, command_id: &CommandId) -> Option<&CommandRow> {
        self.index(command_id).map(|index| &self.rows[index])
    }

    fn row_mut(&mut self, command_id: &CommandId) -> Option<&mut CommandRow> {
        self.index(command_id).map(|index| &mut self.rows[index])
    }

    fn unpaired_mut(&mut self, party: PartyId) -> Option<&mut UnpairedWrapper> {
        self.unpaired
            .iter_mut()
            .find(|unpaired| unpaired.party == party)
    }

    // Marks the set changed, so every feed sends it.
    fn publish_commands(&mut self) {
        self.commands_version += 1;
        self.changed.send_replace(());
    }

    // Keeps `data` in the live tail of the row at `index` and wakes every feed.
    fn publish_output(&mut self, index: usize, data: &str) {
        self.rows[index].output.push(data);
        self.changed.send_replace(());
    }

    fn running_commands(&self) -> Vec<RunningCommand> {
        self.rows.iter().map(drawn_row).collect()
    }
}

// Whether `row` is the command a wrapper reports running.
fn row_runs(row: &CommandRow, command: &WrapperCommand) -> bool {
    match command {
        WrapperCommand::Line(line) => row.start.line.as_deref() == Some(line),
        WrapperCommand::Process(process) => row.start.process_id.as_deref() == Some(process),
    }
}
