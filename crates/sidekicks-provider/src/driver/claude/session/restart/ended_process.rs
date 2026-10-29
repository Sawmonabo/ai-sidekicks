//! What a Claude Code process leaves when it ends: the conversation it wrote, the exit it crosses
//! the wire with, and the resume that brings its session back, the status sink of the relaunch's
//! own leg handed in once the session directory answered it.

use std::error::Error;

use serde_json::Map;
use sidekicks_contracts::command::ExitCode;
use sidekicks_contracts::run::control::{ProcessExit, ProcessExitWithCode};
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_std::error_description::describe_error;
use sidekicks_std::mutex_lock::lock;

use crate::driver::claude::session::process::ClaudeProcessEnd;
use crate::driver::claude::session::state::LiveClaudeSession;
use crate::driver::claude::session::ultracode::relaunch_claude_options;
use crate::driver::contract::bound_failure_detail;
use crate::driver::error_causes::UNSPECIFIED_PROVIDER_FAILURE_DETAIL;
use crate::driver::session_control::ResumeSessionParams;
use crate::runtime_binding::store::mint_runtime_binding_id;

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

/// The resume that brings `live` back on the legs and level it ran at, the person's later moves
/// included, under the account it was admitted on, asking for the callback tools and Settings rows
/// its process was asked for, which the session's own advisor and style still override, under a
/// binding minted for it. It carries no status sink: the ended process's leg ends with it, and the
/// relaunch hands in the one the session directory answers for the new binding. `None` when the
/// model it moved to has no name a resume carries.
pub(super) fn compose_claude_relaunch(live: &LiveClaudeSession) -> Option<ResumeSessionParams> {
    let settings = lock(&live.settings).clone();
    let legs = &live.spawn_bound_legs;
    Some(ResumeSessionParams {
        session_id: live.session_id,
        binding_id: mint_runtime_binding_id(),
        agent_id: live.agent_id,
        resume_handle: live.provider_session_id.clone(),
        // The model it runs on now, which a session-long switch by Claude Code may have moved.
        model: FreeFormText::new(settings.running_model).ok()?,
        // Claude Code's model id names its window, so the driver keeps no figure of its own.
        larger_window: None,
        runtime_metadata: Map::new(),
        mode: settings.session_mode,
        execution_posture: settings.execution_posture,
        output_speed: settings
            .applied_output_speed
            .and_then(|level| FreeFormText::new(level).ok()),
        options: relaunch_claude_options(settings.ultracode_requested),
        row_values: live.requested_spawn.row_values.clone(),
        callback_tools: live.requested_spawn.callback_tools.clone(),
        subagent_policy: legs.subagent_policy.clone(),
        tool_servers: Some(legs.tool_servers.clone()),
        output_schema: legs.output_schema.clone(),
        provider_account_id: live.admitted_provider_account_id.clone(),
        on_mcp_server_status: None,
        // This daemon's idle sleep still holds the session's jobs across the relaunch.
        kept_schedules: Vec::new(),
    })
}
