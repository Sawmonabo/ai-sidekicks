//! What a Claude Code process leaves when it ends: the conversation it wrote and the exit it
//! crosses the wire with.

use std::error::Error;

use sidekicks_contracts::command::ExitCode;
use sidekicks_contracts::run::control::{ProcessExit, ProcessExitWithCode};
use sidekicks_std::error_description::describe_error;

use crate::driver::claude::session::process::ClaudeProcessEnd;
use crate::driver::claude::session::state::LiveClaudeSession;
use crate::driver::contract::error::bound_failure_detail;
use crate::driver::error_causes::UNSPECIFIED_PROVIDER_FAILURE_DETAIL;

/// The conversation an ended process wrote, where its file is found again.
#[derive(Clone, Debug)]
pub(crate) struct ClaudeEndedConversation {
    /// Claude Code's id of the conversation.
    pub(crate) provider_session_id: String,
    /// The environment the process ran in, which names its Claude Code home.
    pub(crate) spawn_environment: Vec<(String, String)>,
}

/// Where the file of the conversation `live`'s process wrote is found again.
pub(super) fn ended_conversation_of(live: &LiveClaudeSession) -> ClaudeEndedConversation {
    ClaudeEndedConversation {
        provider_session_id: live.provider_session_id.clone(),
        spawn_environment: live.spawn_bound_legs.spawn_environment.clone(),
    }
}

/// The exit a process's end crosses the wire with: a wait that failed reads as code 0, its error
/// the output tail, since the process is gone either way.
pub(crate) fn claude_process_exit_of(end: &ClaudeProcessEnd) -> ProcessExit {
    match end {
        Ok(exit) => exit.clone(),
        Err(error) => ProcessExit::Code(ProcessExitWithCode {
            exit_code: ExitCode::new(0).expect("zero is a safe integer"),
            signal: None,
            silent_seconds: None,
            output_tail: bound_failure_detail(
                &describe_error(&**error as &(dyn Error + 'static)),
                UNSPECIFIED_PROVIDER_FAILURE_DETAIL.clone(),
            ),
        }),
    }
}
