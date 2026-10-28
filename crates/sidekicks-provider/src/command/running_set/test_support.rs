//! A running command added straight to a session's set, for other crates' tests.

use sidekicks_contracts::command::CommandId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::NonEmptyText;

use super::{RowState, RunningCommandSets};
use crate::port::running_command_publisher::CommandStart;

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
