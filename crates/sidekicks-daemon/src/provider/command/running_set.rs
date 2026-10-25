//! The commands each session's agents run, provider-neutral: one row per command the provider
//! reports, in start order, paired with the wrapper that runs it where one does, so its output,
//! input wait and askpass prompt reach its row. Every change sends the whole set to the session's
//! subscribers, output goes to them as it prints and is never stored, and each command's ending is
//! appended once on the session's binding at the time it ends, so a fork move changes nothing.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use serde_json::json;
use sidekicks_contracts::command::{
    AgentCommandEndedPayload, AgentCommandSubscribeFrame, CommandEnding, CommandId, CommandPrompt,
    ExitCode, RunningCommand,
};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::list::UniqueList;
use sidekicks_contracts::wire::text::NonEmptyText;
use tokio::sync::Notify;
use tokio::time::Instant;

use crate::ipc::domain_error::DomainError;
use crate::ipc::registry::HandlerError;
use crate::ipc::stream::feed::{Feed, SendGate};
use crate::provider::command::channel::PartyId;
use crate::provider::command::waiting_checks::WaitingState;
use crate::provider::driver::contract::ProviderDriver;
use crate::provider::port::running_command_publisher::{
    CommandStart, ProviderCommandEnd, ReseedScope, RunningCommandParams, RunningCommandPublisher,
    WriteCommandInputParams, command_act_unsupported,
};
use crate::session::run::inbound::rows::LateAppendableRow;
use crate::session::run::inbound::{DeliveryBinding, InboundDelivery, RunInboundDispatch};

#[cfg(test)]
mod tests;

/// The most output bytes a subscriber's feed holds while its reader is slow; past it the oldest
/// pieces are dropped, since the whole output lands as the tool call's result.
const FEED_OUTPUT_BYTES: usize = 256 * 1024;

/// The most output bytes a wrapper holds before its command's row is known.
const UNPAIRED_OUTPUT_BYTES: usize = 64 * 1024;

/// The binding a session runs on now, where it has one.
pub(crate) type SessionBindingLookup =
    Arc<dyn Fn(&SessionId) -> Option<RuntimeBindingId> + Send + Sync>;

/// Where a command's ending is appended: the session's event log, through the binding it runs on.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the running set appends each command's ending through it"
    )
)]
pub(crate) trait CommandEndingAppender: Send + Sync {
    /// Appends `ending` on `binding_id`, `summary` as its body; a failure is logged, since the
    /// provider's stream cannot take it back.
    fn append(
        &self,
        binding_id: RuntimeBindingId,
        ending: AgentCommandEndedPayload,
        summary: Option<String>,
    ) -> BoxFuture<'_, ()>;
}

impl CommandEndingAppender for RunInboundDispatch {
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
                    error = &error as &(dyn std::error::Error + 'static),
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
    /// A command the agent ran as this shell line.
    Line(String),
    /// A command the provider's executor names by this process.
    Process(String),
}

/// What the person writes to a command: its text, and whether its input then ends.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CommandInput {
    /// The typed text.
    pub(crate) text: Option<String>,
    /// Whether the input ends after the text.
    pub(crate) is_end_of_input: bool,
}

/// Where an askpass prompt's answer goes; called once, with the empty answer for `End input`.
pub(crate) type PromptAnswer = Box<dyn FnOnce(String) + Send>;

/// The running commands of every session, and their subscribers.
pub(crate) struct RunningCommandSets {
    sessions: Mutex<HashMap<SessionId, SessionCommands>>,
    binding_of: SessionBindingLookup,
    endings: Arc<dyn CommandEndingAppender>,
}

#[derive(Default)]
struct SessionCommands {
    rows: Vec<CommandRow>,
    unpaired: Vec<UnpairedWrapper>,
    subscribers: Vec<Arc<FeedPlace>>,
}

struct CommandRow {
    start: CommandStart,
    started: Instant,
    state: RowState,
    wrapper: Option<PartyId>,
    facts: WrapperFacts,
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
    text: NonEmptyText,
    is_masked: bool,
    answer: PromptAnswer,
}

struct UnpairedWrapper {
    party: PartyId,
    command: WrapperCommand,
    facts: WrapperFacts,
    output: String,
}

impl RunningCommandSets {
    /// Running sets that append each ending through `endings` on the binding `binding_of` answers
    /// for its session when the command ends.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the daemon's start builds the one running set")
    )]
    pub(crate) fn new(
        binding_of: SessionBindingLookup,
        endings: Arc<dyn CommandEndingAppender>,
    ) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            binding_of,
            endings,
        }
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<SessionId, SessionCommands>> {
        self.sessions.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Follows `session_id`'s running commands: the feed sends the whole set at once, then on
    /// every change, and each command's output as it prints.
    pub(crate) fn subscribe(&self, session_id: SessionId) -> RunningCommandFeed {
        let place = Arc::new(FeedPlace::default());
        let mut sessions = self.lock();
        let commands = sessions.entry(session_id).or_default();
        place.push_commands(session_id, commands);
        commands.subscribers.push(Arc::clone(&place));
        RunningCommandFeed { place }
    }

    /// The person's stop, carried out by the session's `driver`: answered once the provider
    /// acknowledged it, or at once for a command that is not running or whose stop was already
    /// sent. Fails with the provider's refusal, the row then drawn as it was.
    pub(crate) async fn stop(
        &self,
        driver: &dyn ProviderDriver,
        session_id: SessionId,
        command_id: &CommandId,
    ) -> Result<(), HandlerError> {
        let was_foreground = {
            let mut sessions = self.lock();
            let Some(commands) = sessions.get_mut(&session_id) else {
                return Ok(());
            };
            let Some(row) = commands.row_mut(command_id) else {
                return Ok(());
            };
            let was_foreground = match row.state {
                RowState::Stopping { .. } => return Ok(()),
                RowState::Foreground => true,
                RowState::Background => false,
            };
            row.state = RowState::Stopping { was_foreground };
            commands.publish_commands(session_id);
            was_foreground
        };
        let stopped = match self.command_params(session_id, command_id) {
            Ok(params) => driver
                .stop_command(params)
                .await
                .map_err(HandlerError::from),
            Err(refusal) => Err(refusal.into()),
        };
        if let Err(error) = stopped {
            self.update_row(session_id, command_id, |row| {
                if matches!(row.state, RowState::Stopping { .. }) {
                    row.state = if was_foreground {
                        RowState::Foreground
                    } else {
                        RowState::Background
                    };
                }
            });
            return Err(error);
        }
        Ok(())
    }

    /// The person's move to the background, carried out by the session's `driver`, for a command
    /// the agent waits on. Refused with `agent.command.notInForeground` for any other, with
    /// `provider.capability.unsupported` where the provider cannot move it, and with the
    /// provider's refusal.
    pub(crate) async fn move_to_background(
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
    pub(crate) async fn write(
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
                (prompt.answer)(input.text.unwrap_or_default());
                commands.publish_commands(session_id);
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
    /// command reads the same, a process with the row the provider names by it; a wrapper whose row
    /// is not known yet waits for it.
    pub(crate) fn wrapper_started(
        &self,
        session_id: SessionId,
        party: PartyId,
        command: WrapperCommand,
    ) {
        let mut sessions = self.lock();
        let commands = sessions.entry(session_id).or_default();
        let found = commands
            .rows
            .iter_mut()
            .find(|row| row.wrapper.is_none() && row_runs(row, &command));
        match found {
            Some(row) => row.wrapper = Some(party),
            None => commands.unpaired.push(UnpairedWrapper {
                party,
                command,
                facts: WrapperFacts::default(),
                output: String::new(),
            }),
        }
    }

    /// Output the wrapper `party` read from its command, sent as its row's output frame.
    pub(crate) fn wrapper_output(&self, session_id: SessionId, party: PartyId, data: &str) {
        let mut sessions = self.lock();
        let Some(commands) = sessions.get_mut(&session_id) else {
            return;
        };
        if let Some(row) = commands.rows.iter().find(|row| row.wrapper == Some(party)) {
            let command_id = row.start.command_id.clone();
            commands.publish_output(session_id, &command_id, data);
        } else if let Some(unpaired) = commands.unpaired_mut(party) {
            push_capped(&mut unpaired.output, data, UNPAIRED_OUTPUT_BYTES);
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
            facts.prompt = None;
            false
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

    /// Opens an askpass prompt on the wrapper `party`'s command, in its own words, masked when its
    /// kind is; `answer` takes the person's answer.
    pub(crate) fn prompt_opened(
        &self,
        session_id: SessionId,
        party: PartyId,
        text: NonEmptyText,
        is_masked: bool,
        answer: PromptAnswer,
    ) {
        self.update_wrapper(session_id, party, |facts| {
            facts.prompt = Some(OpenPrompt {
                text,
                is_masked,
                answer,
            });
            true
        });
    }

    /// Forgets the wrapper `party`, whose channel ended.
    pub(crate) fn wrapper_ended(&self, session_id: SessionId, party: PartyId) {
        let mut sessions = self.lock();
        if let Some(commands) = sessions.get_mut(&session_id) {
            commands.unpaired.retain(|unpaired| unpaired.party != party);
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
            .find(|row| row.wrapper == Some(party))
        {
            if change(&mut row.facts) {
                commands.publish_commands(session_id);
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
            commands.publish_commands(session_id);
        }
    }

    // Adds a row for `start` in `state`, paired with a wrapper already waiting for it.
    fn add_row(commands: &mut SessionCommands, start: CommandStart, state: RowState) {
        let mut row = CommandRow {
            start,
            started: Instant::now(),
            state,
            wrapper: None,
            facts: WrapperFacts::default(),
        };
        let waiting = commands
            .unpaired
            .iter()
            .position(|unpaired| row_runs(&row, &unpaired.command));
        let held_output = waiting.map(|index| {
            let unpaired = commands.unpaired.remove(index);
            row.wrapper = Some(unpaired.party);
            row.facts = unpaired.facts;
            unpaired.output
        });
        let session_id = row.start.session_id;
        let command_id = row.start.command_id.clone();
        commands.rows.push(row);
        commands.publish_commands(session_id);
        if let Some(output) = held_output.filter(|output| !output.is_empty()) {
            commands.publish_output(session_id, &command_id, &output);
        }
    }

    // Removes the row at `index` and appends its ending: the person's stop ends it by the person,
    // else its exit code decides, a summary riding only on a failed ending.
    fn end_row(
        &self,
        commands: &mut SessionCommands,
        index: usize,
        exit_code: Option<ExitCode>,
        summary: Option<String>,
    ) {
        let row = commands.rows.remove(index);
        let exit_code = exit_code.or(row.facts.exit.and_then(|exit| exit.code));
        let ending = match row.state {
            RowState::Stopping { .. } => CommandEnding::EndedByPerson,
            RowState::Foreground | RowState::Background
                if exit_code.is_some_and(|code| code.get() == 0) =>
            {
                CommandEnding::Finished
            }
            RowState::Foreground | RowState::Background => CommandEnding::Failed,
        };
        let session_id = row.start.session_id;
        commands.publish_commands(session_id);
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
            && commands.row(&command_id).is_some()
        {
            commands.publish_output(session_id, &command_id, &data);
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
        let session_id = start.session_id;
        let commands = sessions.entry(session_id).or_default();
        match commands.row_mut(&start.command_id) {
            Some(row) => {
                if row.state == RowState::Foreground {
                    row.state = RowState::Background;
                    commands.publish_commands(session_id);
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
            self.end_row(commands, index, end.exit_code, end.summary);
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
            let is_covered = match scope {
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
                self.end_row(commands, index, None, None);
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
        while !commands.rows.is_empty() {
            self.end_row(commands, 0, None, None);
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

    // Sends the whole set to every subscriber, dropping those whose feed is gone.
    fn publish_commands(&mut self, session_id: SessionId) {
        self.subscribers
            .retain(|place| Arc::strong_count(place) > 1);
        let subscribers = std::mem::take(&mut self.subscribers);
        for place in &subscribers {
            place.push_commands(session_id, self);
        }
        self.subscribers = subscribers;
    }

    fn publish_output(&mut self, session_id: SessionId, command_id: &CommandId, data: &str) {
        self.subscribers
            .retain(|place| Arc::strong_count(place) > 1);
        for place in &self.subscribers {
            place.push_output(session_id, command_id, data);
        }
    }

    fn running_commands(&self) -> Vec<RunningCommand> {
        self.rows.iter().map(drawn_row).collect()
    }
}

// The row every device draws for `row`.
fn drawn_row(row: &CommandRow) -> RunningCommand {
    let is_foreground = match row.state {
        RowState::Foreground => true,
        RowState::Background => false,
        RowState::Stopping { was_foreground } => was_foreground,
    };
    let waiting = row.facts.waiting.unwrap_or(WaitingState {
        is_waiting: false,
        is_echo_off: false,
    });
    let prompt = row.facts.prompt.as_ref();
    RunningCommand {
        command_id: row.start.command_id.clone(),
        run_id: row.start.run_id,
        name: row.start.name.clone(),
        started_at: row.start.started_at.clone(),
        waiting_in_foreground: is_foreground,
        can_move_to_background: row.state == RowState::Foreground
            && row.start.can_move_to_background,
        accepts_input: row.start.accepts_input,
        waiting_for_input: waiting.is_waiting || prompt.is_some(),
        echo_off: waiting.is_echo_off || prompt.is_some_and(|prompt| prompt.is_masked),
        prompt: prompt.map(|prompt| CommandPrompt {
            text: prompt.text.clone(),
        }),
    }
}

// Whether `row` is the command a wrapper reports running.
fn row_runs(row: &CommandRow, command: &WrapperCommand) -> bool {
    match command {
        WrapperCommand::Line(line) => row.start.name.as_str() == line,
        WrapperCommand::Process(process) => row.start.process_id.as_deref() == Some(process),
    }
}

// Appends `data` to `held`, dropping its oldest characters past `cap` bytes.
fn push_capped(held: &mut String, data: &str, cap: usize) {
    held.push_str(data);
    if held.len() > cap {
        let mut cut = held.len() - cap;
        while !held.is_char_boundary(cut) {
            cut += 1;
        }
        held.drain(..cut);
    }
}

fn not_in_foreground(command_id: &CommandId) -> DomainError {
    DomainError::new(
        "The agent is not waiting on this command.",
        RefusalCode::AgentCommandNotInForeground,
    )
    .with_detail(json!({ "commandId": command_id }))
}

fn takes_no_input(command_id: &CommandId) -> DomainError {
    DomainError::new(
        "This command takes no input and has no prompt open.",
        RefusalCode::AgentCommandTakesNoInput,
    )
    .with_detail(json!({ "commandId": command_id }))
}

/// What waits for one subscriber: its frames in order, the whole set kept only at its newest and
/// a command's output joined while the reader is slow, with at most `FEED_OUTPUT_BYTES` of output.
#[derive(Default)]
struct FeedPlace {
    waiting: Mutex<VecDeque<AgentCommandSubscribeFrame>>,
    sent: Notify,
}

impl FeedPlace {
    fn lock(&self) -> MutexGuard<'_, VecDeque<AgentCommandSubscribeFrame>> {
        self.waiting.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn push_commands(&self, session_id: SessionId, commands: &SessionCommands) {
        let set = UniqueList::new(commands.running_commands())
            .expect("a session's rows name each command once");
        {
            let mut waiting = self.lock();
            waiting.retain(|frame| !matches!(frame, AgentCommandSubscribeFrame::Commands { .. }));
            waiting.push_back(AgentCommandSubscribeFrame::Commands {
                session_id,
                commands: set,
            });
        }
        self.sent.notify_one();
    }

    fn push_output(&self, session_id: SessionId, command_id: &CommandId, data: &str) {
        {
            let mut waiting = self.lock();
            match waiting.back_mut() {
                Some(AgentCommandSubscribeFrame::Output {
                    command_id: last,
                    data: held,
                    ..
                }) if last == command_id => held.push_str(data),
                Some(_) | None => waiting.push_back(AgentCommandSubscribeFrame::Output {
                    session_id,
                    command_id: command_id.clone(),
                    data: data.to_owned(),
                }),
            }
            drop_oldest_output(&mut waiting);
        }
        self.sent.notify_one();
    }
}

// Drops the oldest output frames until the output waiting fits `FEED_OUTPUT_BYTES`.
fn drop_oldest_output(waiting: &mut VecDeque<AgentCommandSubscribeFrame>) {
    let output_bytes = |waiting: &VecDeque<AgentCommandSubscribeFrame>| {
        waiting
            .iter()
            .map(|frame| match frame {
                AgentCommandSubscribeFrame::Output { data, .. } => data.len(),
                AgentCommandSubscribeFrame::Commands { .. } => 0,
            })
            .sum::<usize>()
    };
    let mut dropped = false;
    while output_bytes(waiting) > FEED_OUTPUT_BYTES {
        let Some(oldest) = waiting
            .iter()
            .position(|frame| matches!(frame, AgentCommandSubscribeFrame::Output { .. }))
        else {
            break;
        };
        waiting.remove(oldest);
        dropped = true;
    }
    if dropped {
        tracing::debug!("a slow reader's command output was dropped past its cap");
    }
}

/// One subscriber's running-commands feed; dropping it ends the subscription's place in the set.
pub(crate) struct RunningCommandFeed {
    place: Arc<FeedPlace>,
}

impl Feed for RunningCommandFeed {
    type Emission = AgentCommandSubscribeFrame;

    fn next<'a>(
        &'a mut self,
        gate: &'a dyn SendGate,
    ) -> BoxFuture<'a, Result<Option<AgentCommandSubscribeFrame>, HandlerError>> {
        async move {
            loop {
                if gate.ready().await.is_err() {
                    return Ok(None);
                }
                if let Some(frame) = self.place.lock().pop_front() {
                    return Ok(Some(frame));
                }
                // A push between the check and this wait leaves a permit, so none is missed.
                self.place.sent.notified().await;
            }
        }
        .boxed()
    }
}
