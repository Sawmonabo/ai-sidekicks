//! A session's process brought up: the command line composed from its legs, the process started
//! with its reader running, then `initialize` with the daemon's hooks and in-process tool
//! servers, the summarized thinking display and the settings readback, any failure ending the
//! process and failing the spawn, since nothing runs on a half-set process.

use std::sync::Arc;

use serde_json::Value;
use serde_json::value::RawValue;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_platforms::PathRules;
use sidekicks_policy::ask_rule::ProviderAskRule;

use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::hooks::registration::compose_claude_initialize_request;
use crate::driver::claude::session::answered_commands::{
    ClaudeAttachedAdvisor, read_claude_attached_advisor,
};
use crate::driver::claude::session::errors::ClaudeSessionError;
use crate::driver::claude::session::permission_level::claude_permission_mode_for;
use crate::driver::claude::session::process::{
    ClaudeCodeProcess, ClaudeProcessLaunch, ClaudeProcessListener, ClaudeTurnHolds,
};
use crate::driver::claude::session::transport::channel::ClaudeProcessChannel;
use crate::driver::claude::session::transport::control::{
    ClaudeControlRequest, ClaudePermissionMode, ClaudeSettingsReply, ClaudeThinkingDisplay,
};
use crate::driver::claude::session::transport::declarations::ClaudeInitializeDeclaration;
use crate::driver::claude::session::transport::spawn_legs::ClaudeSpawnBoundLegs;
use crate::driver::claude::session::ultracode::{ClaudeUltracodeReading, read_claude_ultracode};
use crate::driver::claude::spawn::arguments::{
    ClaudeArgumentsRequest, ClaudeConversationStart, compose_claude_arguments,
};
use crate::driver::claude::spawn::launch::{
    ClaudeLaunchError, ClaudeProcessLauncher, initialize_reply,
};
use crate::driver::claude::spawn::settings::ClaudeSessionAdvisor;
use crate::driver::claude::spawn::settings::{
    ClaudePermissionsRequest, compose_claude_spawn_settings,
};
use crate::driver::session_control::SubagentPolicy;
use crate::port::in_process_tool_servers::InProcessToolServers;
use crate::spawned_version::ResolvedProviderExecutable;
use crate::tool_server_name::DAEMON_TOOL_SERVER_NAME;

/// The administrator's MCP file, whose presence makes Claude Code exit at startup when it is told
/// to load only the servers it is given.
const CLAUDE_MANAGED_MCP_FILE: &str = "managed-mcp.json";

/// What every process of one session is spawned from.
pub(crate) struct ClaudeSessionSpawn<'a> {
    /// The legs the process starts with.
    pub(crate) legs: &'a ClaudeSpawnBoundLegs,
    /// The account the process runs on; `None` on the person's own home.
    pub(crate) provider_account_id: Option<ProviderAccountId>,
    /// The session's own standing rules, carried in its `--settings`.
    pub(crate) session_rules: &'a [ProviderAskRule],
    /// The session's step bound, `None` where it sets none.
    pub(crate) step_bound: Option<u32>,
    /// The daemon's in-process tool servers, once registered.
    pub(crate) in_process_servers: Option<&'a Arc<dyn InProcessToolServers>>,
    /// How the place the process runs in spells paths.
    pub(crate) path_rules: PathRules,
}

/// What one session process is brought up from.
pub(crate) struct ClaudeBringUpRequest<'a> {
    /// What the session's processes are spawned from.
    pub(crate) spawn: ClaudeSessionSpawn<'a>,
    /// The conversation the process runs, named in its diagnostics.
    pub(crate) provider_session_id: String,
    /// How the conversation starts.
    pub(crate) conversation: ClaudeConversationStart,
    /// Takes what the process writes.
    pub(crate) listener: Arc<dyn ClaudeProcessListener>,
    /// The session turn its reader releases at a turn-ending lead `result`; `None` for a process
    /// that holds no session turn.
    pub(crate) turn_holds: Option<ClaudeTurnHolds>,
    /// The mode it starts in in place of its level's own, as `--permission-mode` names it; `None`
    /// starts in the level's.
    pub(crate) permission_mode: Option<ClaudePermissionMode>,
}

/// What a `get_settings` reply says the process runs with.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ClaudeSettingsReadback {
    /// The effective `cleanupPeriodDays`, where the reply carries a number.
    pub(crate) cleanup_period_days: Option<f64>,
    /// The advisor Claude Code says it attaches.
    pub(crate) attached_advisor: ClaudeAttachedAdvisor,
    /// The effective `advisorModel`, `Unpicked` where the reply carries no effective settings.
    pub(crate) resolved_advisor: ClaudeSessionAdvisor,
    /// Ultracode's state, where the build reports it.
    pub(crate) ultracode: Option<ClaudeUltracodeReading>,
}

/// A process brought up, with what it declared.
pub(crate) struct ClaudeBroughtUp {
    /// The process.
    pub(crate) process: Arc<ClaudeCodeProcess>,
    /// What its `initialize` reply declared.
    pub(crate) initialize: ClaudeInitializeDeclaration,
    /// What its settings read back.
    pub(crate) settings_readback: ClaudeSettingsReadback,
}

/// Brings one session process up on `executable`, the build resolved at this spawn, so a relaunch
/// runs whatever the command names now, in the request's mode where given and else its level's
/// own. Fails with the settings' composition error, the start's error, or a request's failure or
/// refusal, the process then terminated.
pub(crate) async fn bring_up_claude_process(
    launcher: &ClaudeProcessLauncher,
    executable: &ResolvedProviderExecutable,
    request: ClaudeBringUpRequest<'_>,
) -> Result<ClaudeBroughtUp, ClaudeLaunchError> {
    let spawn = request.spawn;
    let legs = spawn.legs;
    let settings = compose_claude_spawn_settings(
        &ClaudePermissionsRequest {
            credential_deny_paths: &legs.credential_deny_paths,
            memory_folders: &legs.memory_folders,
            session_rules: spawn.session_rules,
            path_rules: spawn.path_rules,
            background_work: &legs.background_work,
        },
        legs.execution_posture.as_ref(),
        &legs.advisor,
        legs.output_style.as_deref(),
    )?;
    let has_managed_mcp_file = has_readable_managed_mcp_file().await;
    let arguments = compose_claude_arguments(&ClaudeArgumentsRequest {
        model: &legs.model,
        permission_mode: request.permission_mode.unwrap_or_else(|| {
            claude_permission_mode_for(
                legs.execution_posture
                    .as_ref()
                    .map(ExecutionPosture::permission_level),
            )
        }),
        settings: &settings,
        output_schema: legs.output_schema.as_ref(),
        is_helper_tool_withheld: matches!(legs.subagent_policy, Some(SubagentPolicy::Disabled {})),
        step_bound: spawn.step_bound,
        has_managed_mcp_file,
        conversation: request.conversation,
    });
    // Under an administrator's MCP file only the daemon's own server is fronted, and Claude Code
    // loads the organization's servers itself.
    let in_process_servers = spawn.in_process_servers.map_or_else(Vec::new, |servers| {
        if has_managed_mcp_file {
            vec![DAEMON_TOOL_SERVER_NAME.to_owned()]
        } else {
            servers.server_names(&legs.session_id)
        }
    });
    let process = launcher
        .start(
            ClaudeProcessLaunch {
                start: executable.start.clone(),
                arguments,
                environment: executable.environment.clone(),
                working_folder: legs.working_directory.clone(),
                provider_session_id: request.provider_session_id,
                provider_account_id: spawn.provider_account_id,
            },
            request.listener,
            request.turn_holds,
        )
        .await?;
    match configure(&process, legs.subagent_policy.as_ref(), in_process_servers).await {
        Ok((initialize_response, settings_readback)) => Ok(ClaudeBroughtUp {
            initialize: initialize_reply::read_claude_initialize_declaration(
                initialize_response.as_deref(),
            ),
            settings_readback,
            process,
        }),
        Err(error) => {
            process.terminate().await;
            Err(error.into())
        }
    }
}

// `initialize`, the thinking display and the settings readback, in order.
async fn configure(
    process: &ClaudeCodeProcess,
    subagent_policy: Option<&SubagentPolicy>,
    in_process_servers: Vec<String>,
) -> Result<(Option<Box<RawValue>>, ClaudeSettingsReadback), ClaudeSessionError> {
    let initialize = process
        .send_initialize(compose_claude_initialize_request(
            subagent_policy,
            in_process_servers,
        ))
        .await?;
    process
        .send_control_request(ClaudeControlRequest::SetMaxThinkingTokens {
            thinking_display: ClaudeThinkingDisplay::Summarized,
        })
        .await?;
    let settings = process
        .send_control_request(ClaudeControlRequest::GetSettings {})
        .await?;
    Ok((
        initialize.response,
        read_settings_readback(settings.response.as_deref()),
    ))
}

fn read_settings_readback(reply: Option<&RawValue>) -> ClaudeSettingsReadback {
    let reply = ClaudeSettingsReply::read(reply);
    let effective = reply.effective.as_ref();
    let cleanup_period_days =
        effective.and_then(|effective| effective.get("cleanupPeriodDays").and_then(Value::as_f64));
    // An `effective` naming no `advisorModel` resolves to no advisor.
    let resolved_advisor = effective.map_or(ClaudeSessionAdvisor::Unpicked, |effective| {
        ClaudeSessionAdvisor::of(effective.get("advisorModel").and_then(Value::as_str))
    });
    ClaudeSettingsReadback {
        cleanup_period_days,
        resolved_advisor,
        attached_advisor: read_claude_attached_advisor(&reply),
        ultracode: read_claude_ultracode(&reply),
    }
}

// Whether Claude Code can read an administrator's MCP file in its managed folder. Only its
// presence is checked, never its contents: a parse that disagreed with Claude Code's own would
// fail toward the startup exit.
async fn has_readable_managed_mcp_file() -> bool {
    let Some(folder) = DESCRIPTOR.managed_settings_folder() else {
        return false;
    };
    tokio::fs::File::open(folder.join(CLAUDE_MANAGED_MCP_FILE))
        .await
        .is_ok()
}
