//! Where a driver reports the shell commands its agent runs, to the session's running set: each
//! start, move to the background, end and reseed the provider sends, and a command's output as it
//! prints; and what the set hands the driver's command acts. Output is never stored: the command's
//! whole output lands as its tool call's result.

use serde_json::json;
use sidekicks_contracts::command::{CommandId, ExitCode};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::NonEmptyText;

use crate::ipc::domain_error::DomainError;
use crate::provider::driver::contract::PROVIDER_CAPABILITY_UNSUPPORTED_MESSAGE;

/// A command the provider reports running, from its start or from a list that names it.
#[derive(Clone)]
pub(crate) struct CommandStart {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The provider's own id for the command.
    pub(crate) command_id: CommandId,
    /// The run that started it.
    pub(crate) run_id: RunId,
    /// The command as the agent ran it.
    pub(crate) name: NonEmptyText,
    /// When it started.
    pub(crate) started_at: WireInstant,
    /// The text the provider's shell line runs for it, which its wrapper names at its start, where
    /// the provider runs it through a shell prefix.
    pub(crate) line: Option<String>,
    /// The process the provider's executor names it by, where the provider runs it through one.
    pub(crate) process_id: Option<String>,
    /// Whether it runs in the background from its start.
    pub(crate) is_backgrounded: bool,
    /// Whether the provider can move it to the background while the agent waits on it.
    pub(crate) can_move_to_background: bool,
    /// Whether it takes typed input for its whole run.
    pub(crate) accepts_input: bool,
}

/// How the provider reports a command ended: its exit code where it gave one, whether the
/// provider stopped it itself, and its summary of that stop.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProviderCommandEnd {
    /// The process's exit code.
    pub(crate) exit_code: Option<ExitCode>,
    /// Whether the provider stopped the command itself, as a time limit does, which fails it
    /// whatever its code.
    pub(crate) is_stopped_by_provider: bool,
    /// The provider's summary of a command it stopped itself, stored as the ending's body.
    pub(crate) summary: Option<String>,
}

/// Which commands a provider's list of its running commands covers: a command it covers and does
/// not list has ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "each driver names what its list of running commands covers"
    )
)]
pub(crate) enum ReseedScope {
    /// Only the commands running in the background.
    BackgroundCommands,
    /// Every command.
    EveryCommand,
}

/// The running-commands intake, registered through a `PortRegistration`. It never blocks or fails
/// back into the provider's stream; a fact about a command the set holds no row for is dropped,
/// except where it adds the row.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "each driver reports its commands' starts, moves, ends and lists here"
    )
)]
pub(crate) trait RunningCommandPublisher: Send + Sync {
    /// Publishes `data`, a piece of `command_id`'s output in `session_id` as it printed, as the
    /// stream's output frame.
    fn publish_output(&self, session_id: SessionId, command_id: CommandId, data: String);

    /// Adds the command `start` names; a command the set already holds is left as it is.
    fn command_started(&self, start: CommandStart);

    /// Moves the command `start` names to the background, adding it there when its start was
    /// missed.
    fn command_moved_to_background(&self, start: CommandStart);

    /// Ends `command_id` as the provider reported it, appending its ending once.
    fn command_ended(&self, session_id: SessionId, command_id: CommandId, end: ProviderCommandEnd);

    /// Takes the provider's whole list of `session_id`'s running commands over `scope`: a listed
    /// command the set lacks is added in the background, and one held in scope but not listed ends.
    fn commands_listed(&self, session_id: SessionId, scope: ReseedScope, listed: Vec<CommandStart>);

    /// Ends every command of `session_id`: its provider's process exited.
    fn provider_exited(&self, session_id: SessionId);
}

/// The running command one of the person's acts addresses: its session, the binding the session
/// runs on now and the provider's own id for the command.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RunningCommandParams {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The binding.
    pub(crate) binding_id: RuntimeBindingId,
    /// The provider's own id for the command.
    pub(crate) command_id: CommandId,
}

/// Params of the person's write to a running command: the command, the typed text and whether the
/// command's input then ends.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WriteCommandInputParams {
    /// The command.
    pub(crate) command: RunningCommandParams,
    /// The typed text.
    pub(crate) text: Option<String>,
    /// Whether the input ends after the text.
    pub(crate) is_end_of_input: bool,
}

/// The refusal of an act on `command_id` the provider cannot carry out
/// (`provider.capability.unsupported`).
pub(crate) fn command_act_unsupported(command_id: &CommandId) -> DomainError {
    DomainError::new(
        PROVIDER_CAPABILITY_UNSUPPORTED_MESSAGE,
        RefusalCode::ProviderCapabilityUnsupported,
    )
    .with_detail(json!({ "commandId": command_id }))
}
