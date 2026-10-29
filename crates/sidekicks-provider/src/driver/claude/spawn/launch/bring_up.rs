//! A session's process brought up: the command line composed from its legs, the process started
//! with its reader running, then `initialize` with the daemon's hooks and in-process tool
//! servers, the summarized thinking display and the settings readback, any failure ending the
//! process and failing the spawn, since nothing runs on a half-set process.

use std::path::Path;
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
    /// The account the process runs on.
    pub(crate) provider_account_id: ProviderAccountId,
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
    /// The socket the process listens on for other sessions' messages; `None` for a process
    /// no inbox passes messages to.
    pub(crate) messaging_socket: Option<&'a Path>,
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
        legs.command_channel.as_deref(),
    )?;
    let has_managed_mcp_file = has_readable_managed_mcp_file().await;
    // A fork's predecessor keeps running on the session's channel until the fork is adopted, which
    // binds the channel then, so a fork that fails leaves it on the predecessor's process.
    let binds_command_channel =
        !matches!(request.conversation, ClaudeConversationStart::Fork { .. });
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
        messaging_socket: request.messaging_socket,
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
                provider_account_id: Some(spawn.provider_account_id),
            },
            request.listener,
            request.turn_holds,
        )
        .await?;
    if binds_command_channel && let Some(channel) = &legs.command_channel {
        channel.follow(process.identity().process_id);
    }
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

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use sidekicks_ipc::caller_process::system_reader::ProcessTableReader;
    use sidekicks_platforms::{
        PathRules, ProgramStart, Spawner, StandInAnswer, StandInProgram, write_stand_in_program,
    };
    use sidekicks_std::port_registration::PortRegistration;
    use tokio::runtime::Handle;

    use super::{
        ClaudeBringUpRequest, ClaudeSessionSpawn, ClaudeSpawnBoundLegs, bring_up_claude_process,
    };
    use crate::background_work::BackgroundWorkForms;
    use crate::command::running_set::unbound_running_command_sets;
    use crate::command::waiting_checks::SystemInputWaitReader;
    use crate::driver::PROVIDERS;
    use crate::driver::claude::delivery::commands::{ClaudeCommandChannels, ClaudeCommandPrograms};
    use crate::driver::claude::session::process::{
        ClaudeProcessEnd, ClaudeProcessListener, ClaudeStreamFrame,
    };
    use crate::driver::claude::session::transport::inbound::ClaudeInboundRequestEvent;
    use crate::driver::claude::spawn::arguments::ClaudeConversationStart;
    use crate::driver::claude::spawn::launch::ClaudeProcessLauncher;
    use crate::driver::claude::spawn::settings::ClaudeSessionAdvisor;
    use crate::driver::test_registry::new_session_id;
    use crate::process_registry::ProviderProcessRegistry;
    use crate::runtime_binding::test_store::test_provider_account_id;
    use crate::spawned_version::ResolvedProviderExecutable;

    struct NoSession;

    impl ClaudeProcessListener for NoSession {
        fn take_frame(&self, _frame: ClaudeStreamFrame) {}

        fn take_request(&self, _event: ClaudeInboundRequestEvent) {}

        fn take_exit(&self, _end: ClaudeProcessEnd) {}

        fn is_turn_ending(&self, _frame: &ClaudeStreamFrame) -> bool {
            true
        }
    }

    // A fork whose process fails before its adoption leaves the session's command channel on its
    // predecessor's process, whose commands still run. Killed by a fork's bring-up that follows
    // the channel itself.
    #[tokio::test]
    async fn a_fork_that_fails_before_adoption_leaves_the_channel_on_its_predecessor() {
        let folder = tempfile::tempdir().expect("a test folder");
        let spawner = Spawner::new(Handle::current()).expect("a spawner");
        let command_output = Arc::new(PortRegistration::new("running commands"));
        command_output
            .register(unbound_running_command_sets())
            .expect("the running commands register once");
        let channels = ClaudeCommandChannels::new(
            folder.path(),
            ClaudeCommandPrograms {
                wrapper_program: folder.path().join("wrapper"),
                askpass_program: folder.path().join("askpass"),
            },
            Arc::new(ProcessTableReader::for_this_program().expect("the reader builds")),
            Arc::new(SystemInputWaitReader {
                spawner: spawner.clone(),
            }),
            command_output,
        );
        let session_id = new_session_id();
        let Some(opened) = channels.open(session_id).await.expect("the channel opens") else {
            // A system that runs no command wrapper opens no channel to keep.
            return;
        };
        let channel = Arc::clone(opened.channel());
        let predecessor = std::process::id();
        channel.follow(predecessor);
        let program = write_stand_in_program(
            folder.path(),
            "claude",
            &StandInProgram {
                answers_by_first_argument: Vec::new(),
                otherwise: StandInAnswer {
                    standard_output: String::new(),
                    exit_code: 0,
                    argument_record: None,
                },
            },
        )
        .expect("the stand-in is written");
        let executable = ResolvedProviderExecutable {
            requested_command: "claude".to_owned(),
            resolved_executable_path: program.clone(),
            start: ProgramStart {
                program,
                leading_arguments: Vec::new(),
            },
            environment: Vec::new(),
        };
        let legs = ClaudeSpawnBoundLegs {
            session_id,
            model: "opus".to_owned(),
            execution_posture: None,
            working_directory: folder.path().to_owned(),
            callback_tools: None,
            subagent_policy: None,
            tool_servers: Vec::new(),
            output_schema: None,
            on_callback_tool_call: None,
            on_mcp_server_status: None,
            credential_deny_paths: Vec::new(),
            memory_folders: Vec::new(),
            background_work: Arc::new(BackgroundWorkForms::of_providers(PROVIDERS)),
            spawn_environment: Vec::new(),
            advisor: ClaudeSessionAdvisor::Unpicked,
            output_style: None,
            command_channel: Some(Arc::clone(&channel)),
        };
        let launcher = ClaudeProcessLauncher::new(
            spawner,
            Arc::new(ProviderProcessRegistry::default()),
            folder.path(),
        );

        let brought_up = bring_up_claude_process(
            &launcher,
            &executable,
            ClaudeBringUpRequest {
                spawn: ClaudeSessionSpawn {
                    legs: &legs,
                    provider_account_id: test_provider_account_id(),
                    session_rules: &[],
                    step_bound: None,
                    in_process_servers: None,
                    path_rules: PathRules::NATIVE,
                },
                provider_session_id: "fork".to_owned(),
                conversation: ClaudeConversationStart::Fork {
                    resume_handle: "predecessor".to_owned(),
                    forked_provider_session_id: "fork".to_owned(),
                    resume_at_message_uuid: "message".to_owned(),
                    dropped_turn_prompt_uuid: "prompt".to_owned(),
                },
                listener: Arc::new(NoSession),
                turn_holds: None,
                permission_mode: None,
                messaging_socket: None,
            },
        )
        .await;

        assert!(brought_up.is_err(), "a process that answers nothing fails");
        assert_eq!(channel.bound_process_id(), Some(predecessor));
        channels
            .close(session_id)
            .await
            .expect("the channel closes");
    }
}
