//! A running set no session's binding or ending log is behind, and a running command added
//! straight to a session's set, for this crate's and other crates' tests.

use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::command::{AgentCommandEndedPayload, CommandId};
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::NonEmptyText;

use super::{CommandEndingAppender, RowState, RunningCommandSets};
use crate::port::running_command_publisher::CommandStart;

/// A running set whose sessions run on no binding, their commands' endings appended nowhere.
pub fn unbound_running_command_sets() -> Arc<RunningCommandSets> {
    Arc::new(RunningCommandSets::new(
        Arc::new(|_session: &SessionId| None),
        Arc::new(DroppedEndings),
    ))
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
    /// Adds a background command of `run_id` to `session_id`'s set, as a provider's report of one
    /// does.
    pub fn start_test_command(&self, session_id: SessionId, run_id: RunId) {
        let start = CommandStart {
            session_id,
            command_id: CommandId::new("test-command".to_owned()).expect("a command id"),
            run_id,
            name: NonEmptyText::new("sleep 600".to_owned()).expect("a command name"),
            started_at: WireInstant::now(),
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
