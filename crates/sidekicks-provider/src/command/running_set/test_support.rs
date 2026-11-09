//! A running set no session's binding or ending log is behind, one whose every session runs on the
//! test binding, and a running command or an unpaired wrapper added straight to a session's set,
//! for this crate's and other crates' tests.

use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::command::{AgentCommandEndedPayload, CommandId};
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::NonEmptyText;

use super::{CommandEndingAppender, RowState, RunningCommandSets, WrapperCommand};
use crate::command::channel::PartyId;
use crate::port::running_command_publisher::CommandStart;

/// The binding a test command starts on, which its ending is appended on.
pub const TEST_COMMAND_BINDING: &str = "test-command-binding";

/// A running set whose sessions run on no binding, their commands' endings appended nowhere.
pub fn unbound_running_command_sets() -> Arc<RunningCommandSets> {
    Arc::new(RunningCommandSets::new(
        Arc::new(|_session: &SessionId| None),
        Arc::new(DroppedEndings),
    ))
}

/// A running set whose every session runs on [`TEST_COMMAND_BINDING`], so a stop reaches its
/// driver, its commands' endings appended nowhere.
pub fn test_bound_running_command_sets() -> Arc<RunningCommandSets> {
    Arc::new(RunningCommandSets::new(
        Arc::new(|_session: &SessionId| Some(test_command_binding())),
        Arc::new(DroppedEndings),
    ))
}

// The binding every test command runs on.
fn test_command_binding() -> RuntimeBindingId {
    RuntimeBindingId::new(TEST_COMMAND_BINDING.to_owned()).expect("a binding id")
}

/// A test command's start: which command, of which run and tool call, and when.
pub struct TestCommandStart {
    /// The command.
    pub command_id: CommandId,
    /// The run that started it.
    pub run_id: RunId,
    /// The tool call that started it, where one did.
    pub tool_call_id: Option<ToolCallId>,
    /// When it started.
    pub started_at: WireInstant,
}

// Endings no test reads.
struct DroppedEndings;

impl CommandEndingAppender for DroppedEndings {
    fn append(
        &self,
        _binding_id: RuntimeBindingId,
        _ending: AgentCommandEndedPayload,
        _summary: Option<String>,
    ) -> BoxFuture<'_, ()> {
        async {}.boxed()
    }
}

impl RunningCommandSets {
    /// Admits the wrapper `party` to `session_id`'s own process, now, with no row its line pairs
    /// with, so it waits unpaired as a wrapper the provider has not named yet does.
    pub fn admit_test_wrapper(&self, session_id: SessionId, party: PartyId) {
        let _paired = self.wrapper_started(
            session_id,
            party,
            None,
            WrapperCommand::Line("test wrapper's command".to_owned()),
        );
    }

    /// Adds a background command of `run_id` on [`TEST_COMMAND_BINDING`] to `session_id`'s set, as
    /// a provider's report of one does.
    pub fn start_test_command(&self, session_id: SessionId, run_id: RunId) {
        self.start_test_command_of(
            session_id,
            TestCommandStart {
                command_id: CommandId::new("test-command".to_owned()).expect("a command id"),
                run_id,
                tool_call_id: None,
                started_at: WireInstant::now(),
            },
        );
    }

    /// Adds the background command `command` on [`TEST_COMMAND_BINDING`] to `session_id`'s set,
    /// as a provider's report of one does.
    pub fn start_test_command_of(&self, session_id: SessionId, command: TestCommandStart) {
        let start = CommandStart {
            session_id,
            command_id: command.command_id,
            run_id: command.run_id,
            tool_call_id: command.tool_call_id,
            binding_id: test_command_binding(),
            name: NonEmptyText::new("sleep 600".to_owned()).expect("a command name"),
            started_at: command.started_at,
            line: None,
            process_id: None,
            is_backgrounded: true,
            can_move_to_background: false,
            accepts_input: false,
        };
        let mut sessions = self.lock();
        Self::add_row(
            sessions.entry(session_id).or_default(),
            start,
            RowState::Background,
        );
    }
}
