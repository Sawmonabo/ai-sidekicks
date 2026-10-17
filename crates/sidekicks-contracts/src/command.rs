//! The shell commands an agent started: one live list, and the acts stop, background, write and end
//! input. The provider decides how a command runs. Every list frame carries the whole running set,
//! because a subscriber composing deltas could hold a command the provider has already dropped.
//! Output arrives on the same subscription as it prints and is never stored; the stored
//! `agent.command.ended` event settles a row after a reload.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::event::envelope::{
    SourceEpoch, SourcePosition, check_epoch_stamp, epoch_stamp_dependent_required,
};
use crate::jsonrpc::streaming::SubscribeAckResponse;
use crate::method::methods;
use crate::method_descriptor::NullPayload;
use crate::run::id::RunId;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::instant::WireInstant;
use crate::wire::integer::{SafeInt, SafeSignedInt};
use crate::wire::list::{ListKey, UniqueList};
use crate::wire::text::{NonEmptyText, branded_text};
use crate::wire::{False, True};

ts_constants! {
    /// The longest command id the daemon accepts.
    pub const COMMAND_ID_MAX_LEN: usize = 256;
}

branded_text! {
    /// The daemon's id for one running command, opaque to every client.
    pub struct CommandId(1..=COMMAND_ID_MAX_LEN);
}

/// A git or ssh prompt open on a command, in the prompt's own words.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandPrompt {
    /// The prompt's words.
    pub text: NonEmptyText,
}

/// One running command in a session, as every device draws its row.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "the wire carries each switch as its own boolean member"
)]
pub struct RunningCommand {
    /// The command.
    pub command_id: CommandId,
    /// The run that started it.
    pub run_id: RunId,
    /// The command as the agent ran it.
    pub name: NonEmptyText,
    /// When it started.
    #[garde(dive)]
    pub started_at: WireInstant,
    /// True only while the provider holds the agent's turn on this command.
    pub waiting_in_foreground: bool,
    /// True while the session's provider offers to move this waited-on command to the background,
    /// its output held until the command ends; only then does the row carry `Move to background`.
    pub can_move_to_background: bool,
    /// True when the command can take typed input for its whole run, so its row has an input line.
    pub accepts_input: bool,
    /// True while the daemon reads from the system that the command is blocked reading its input.
    pub waiting_for_input: bool,
    /// True while the command's terminal has echo off, as at a password prompt, so the input line
    /// masks what is typed; read from the terminal's settings, a Windows console's input mode, or
    /// an open prompt's kind, whether or not the command is waiting.
    pub echo_off: bool,
    /// A git or ssh prompt open on the command; absent otherwise.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "CommandPrompt")]
    pub prompt: Option<CommandPrompt>,
}

/// `agent.command.subscribe`: the session whose running commands the subscription follows.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AgentCommandSubscribeRequest {
    /// The session.
    pub session_id: SessionId,
}

/// One frame of the running-commands subscription: the whole set in start order (an empty set
/// takes the list away), or a piece of one command's output as it printed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AgentCommandSubscribeFrame {
    /// The whole running set; a command appears at most once.
    Commands {
        /// The session.
        #[garde(skip)]
        session_id: SessionId,
        /// The commands, in start order.
        #[garde(dive)]
        commands: UniqueList<RunningCommand, 0, { usize::MAX }>,
    },
    /// A piece of one command's output.
    Output {
        /// The session.
        #[garde(skip)]
        session_id: SessionId,
        /// The command.
        #[garde(skip)]
        command_id: CommandId,
        /// The output as it printed.
        #[garde(skip)]
        data: String,
    },
}

/// `agent.command.stop`: stops one running command. The agent receives one short message naming it,
/// never a bare failure; `Stop all commands` sends this once per running command.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AgentCommandStopRequest {
    /// The session.
    pub session_id: SessionId,
    /// The command.
    pub command_id: CommandId,
}

/// The command was stopped.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AgentCommandStopResponse {
    /// The command.
    pub command_id: CommandId,
    /// Always true.
    pub stopped: True,
}

/// `agent.command.background`: moves a command the agent is waiting on to the background, so the
/// agent's turn continues and the command's output streams into its row. Sent only for a command
/// whose entry reads `canMoveToBackground`; where no entry does, the control does not exist.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AgentCommandBackgroundRequest {
    /// The session.
    pub session_id: SessionId,
    /// The command.
    pub command_id: CommandId,
}

/// The command no longer holds the agent's turn.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AgentCommandBackgroundResponse {
    /// The command.
    pub command_id: CommandId,
    /// Always false.
    pub waiting_in_foreground: False,
}

/// `agent.command.write`: typed input, `End input`, or both, for a command that takes input or has
/// a prompt open, whether or not it is waiting. `text` goes to the command or answers its prompt,
/// and `endOfInput` then ends its input as end of file does on a terminal, or answers an open
/// prompt with nothing. A write carries text, the end of input, or both.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[garde(custom(|request: &Self, (): &()| {
    if request.text.is_some() || request.end_of_input == Some(true) {
        Ok(())
    } else {
        Err(garde::Error::new("a write carries text, the end of input, or both"))
    }
}))]
#[schemars(transform = add_write_carries_something_rule)]
pub struct AgentCommandWriteRequest {
    /// The session.
    pub session_id: SessionId,
    /// The command.
    pub command_id: CommandId,
    /// The typed text.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "NonEmptyText")]
    pub text: Option<NonEmptyText>,
    /// Whether the input ends after the text.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "bool")]
    pub end_of_input: Option<bool>,
}

/// States in the schema that a write carries text, the end of input, or both.
fn add_write_carries_something_rule(schema: &mut schemars::Schema) {
    schema.insert(
        "anyOf".into(),
        serde_json::json!([
            { "type": "object", "properties": { "text": {} }, "required": ["text"] },
            {
                "type": "object",
                "properties": { "endOfInput": { "const": true } },
                "required": ["endOfInput"],
            },
        ]),
    );
}

/// How a command ended: it finished, it failed, or the person stopped it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum CommandEnding {
    /// It finished.
    Finished,
    /// It failed.
    Failed,
    /// The person stopped it.
    EndedByPerson,
}

/// The `agent.command.ended` payload: one command's ending. `exitCode` is the process's own when it
/// has one; `durationMs` is how long it ran, so the row reads its duration after a reload. It takes
/// the epoch stamp.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[schemars(extend("dependentRequired" = epoch_stamp_dependent_required()))]
pub struct AgentCommandEndedPayload {
    /// The session.
    pub session_id: SessionId,
    /// The run.
    pub run_id: RunId,
    /// The command.
    pub command_id: CommandId,
    /// How it ended.
    pub ending: CommandEnding,
    /// The process's exit code.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ExitCode")]
    pub exit_code: Option<ExitCode>,
    /// How long it ran, in milliseconds.
    pub duration_ms: SafeInt<0>,
    /// The superseded execution epoch the row was delivered for; comes with `sourcePosition`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SourceEpoch")]
    #[garde(custom(|epoch: &Option<SourceEpoch>, (): &()| {
        check_epoch_stamp(*epoch, self.source_position, true)
    }))]
    pub source_epoch: Option<SourceEpoch>,
    /// The turn position the row occupies within its epoch; comes with `sourceEpoch`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SourcePosition")]
    pub source_position: Option<SourcePosition>,
}

/// A process's exit code, any whole number a JavaScript number holds exactly.
pub type ExitCode = SafeSignedInt;

methods! {
    /// The `agent.command.*` methods.
    pub const COMMAND_METHOD_DESCRIPTORS = [
        /// Follows the session's running commands and their output.
        AgentCommandSubscribe = subscription "agent.command.subscribe" {
            mutating: false,
            params: AgentCommandSubscribeRequest,
            result: SubscribeAckResponse,
            emission: AgentCommandSubscribeFrame,
            refusals: [SessionNotFound],
        },
        /// Stops one running command.
        AgentCommandStop = mutation "agent.command.stop" {
            mutating: true,
            params: AgentCommandStopRequest,
            result: AgentCommandStopResponse,
            refusals: [SessionNotFound],
        },
        /// Moves a command the agent waits on to the background.
        AgentCommandBackground = mutation "agent.command.background" {
            mutating: true,
            params: AgentCommandBackgroundRequest,
            result: AgentCommandBackgroundResponse,
            refusals: [SessionNotFound, ProviderCapabilityUnsupported, AgentCommandNotInForeground],
        },
        /// Writes input to a command, ends its input, or both.
        AgentCommandWrite = mutation "agent.command.write" {
            mutating: true,
            params: AgentCommandWriteRequest,
            result: NullPayload,
            refusals: [SessionNotFound, AgentCommandTakesNoInput],
        },
    ];
}

/// The TypeScript module of an agent's running commands.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "command",
    doc: "The shell commands an agent started: one live list, and the acts stop, background, \
          write and end input.",
    definitions: &[
        Definition::read::<CommandId>().checked(),
        Definition::read::<CommandPrompt>(),
        Definition::read::<RunningCommand>(),
        Definition::read::<AgentCommandSubscribeRequest>(),
        Definition::read::<AgentCommandSubscribeFrame>().checked(),
        Definition::read::<AgentCommandStopRequest>(),
        Definition::read::<AgentCommandStopResponse>(),
        Definition::read::<AgentCommandBackgroundRequest>(),
        Definition::read::<AgentCommandBackgroundResponse>(),
        Definition::read::<AgentCommandWriteRequest>().checked(),
        Definition::read::<CommandEnding>(),
        Definition::read::<AgentCommandEndedPayload>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[&COMMAND_METHOD_DESCRIPTORS],
};

impl ListKey for RunningCommand {
    type Key = CommandId;

    fn list_key(&self) -> CommandId {
        self.command_id.clone()
    }

    fn validate_item(&self, parent: &mut dyn FnMut() -> garde::Path, report: &mut garde::Report) {
        garde::Validate::validate_into(self, &(), parent, report);
    }
}
