//! What a Claude Code process is started under: the legs every spawn path builds the one way, the
//! binding a later run is checked against, and the check itself.

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Map, Value};
use sidekicks_contracts::machine::settings::EnvironmentRow;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::provider::driver::tools::SessionCallbackTool;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_platforms::PathRules;
use sidekicks_store::events::canonicalizer::CanonicalizationRefusal;

use crate::background_work::BackgroundWorkForms;
use crate::callback_tools::host::{
    CallbackToolAdmission, CallbackToolHost, CallbackToolSpawnRequest,
};
use crate::callback_tools::spawn_binding::{
    CallbackToolSpawnBinding, bind_callback_tools_for_spawn,
};
use crate::command::askpass::GIT_TERMINAL_PROMPT_OFF;
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::delivery::commands::ClaudeCommandChannel;
use crate::driver::claude::session::errors::{ClaudeSessionError, ClaudeSessionUnavailableReason};
use crate::driver::claude::session::establishment::ClaudeSpawnSources;
use crate::driver::claude::session::posture::{digest_output_schema, find_posture_divergence};
use crate::driver::claude::session::settings_file::ClaudeSettingsFileError;
use crate::driver::claude::session::state::{ClaudeSpawnBinding, LiveClaudeSession};
use crate::driver::claude::session::transport::spawn_legs::ClaudeSpawnBoundLegs;
use crate::driver::claude::spawn::account_home::write_claude_home_retention;
use crate::driver::claude::spawn::environment::{
    ClaudeAccountFolders, ClaudeProcessEnvironmentRequest, ClaudeProcessHome,
    compose_claude_process_environment,
};
use crate::driver::claude::spawn::settings::ClaudeSessionAdvisor;
use crate::driver::contract::StartRunParams;
use crate::driver::mcp_server_status::McpServerStatusProducer;
use crate::driver::session_control::{SessionToolServer, SubagentPolicy};
use crate::run::posture::{
    CURATED_CREDENTIAL_POLICY_REF, CredentialPolicyResolveError, ExecutionPostureService,
};
use crate::spawn_environment::{
    ReservedEnvironmentNames, SessionEnvironment, SpawnEnvironmentError,
};

/// Why the callback tools are withheld while the daemon's in-process tool servers are not
/// registered: the tools ride that route, so nothing could answer them.
const CLAUDE_IN_PROCESS_ROUTE_UNAVAILABLE_DETAIL: &str = "the daemon's in-process tool servers are \
     not registered, so Claude Code has no route to reach the callback tools on";

/// Where one session's process runs and what it is started with, resolved at every spawn.
pub(crate) struct ClaudeSpawnContext {
    /// The session's working folder, its worktree, absolute.
    pub(crate) working_directory: PathBuf,
    /// The machine's `Every project` environment rows.
    pub(crate) every_project_rows: Vec<EnvironmentRow>,
    /// The session's project's own environment rows, which win over an `Every project` row.
    pub(crate) project_rows: Vec<EnvironmentRow>,
    /// The account's folders.
    pub(crate) account_folders: ClaudeAccountFolders,
    /// Each spelling of the agent-memory folder.
    pub(crate) memory_folders: Vec<PathBuf>,
    /// The session's advisor.
    pub(crate) advisor: ClaudeSessionAdvisor,
    /// The session's own output style, `None` where Claude Code's own setting holds.
    pub(crate) output_style: Option<String>,
    /// The session's own bound on the steps one turn takes; `None` where none is set.
    pub(crate) step_bound: Option<SafeInt<1>>,
}

/// What one spawn's legs are built from: the create's or resume's spawn-bound members and the
/// context resolved for it.
pub(crate) struct ClaudeSpawnLegsRequest {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The session's model.
    pub(crate) model: String,
    /// How the session may touch the machine.
    pub(crate) execution_posture: Option<ExecutionPosture>,
    /// The session's helper policy.
    pub(crate) subagent_policy: Option<SubagentPolicy>,
    /// Every tool server the session can reach.
    pub(crate) tool_servers: Option<Vec<SessionToolServer>>,
    /// The JSON Schema the final output must meet.
    pub(crate) output_schema: Option<Map<String, Value>>,
    /// Receives each tool server's status.
    pub(crate) on_mcp_server_status: Option<McpServerStatusProducer>,
    /// The account the spawn is admitted against.
    pub(crate) provider_account_id: ProviderAccountId,
    /// The command channel a session process's commands reach the daemon through, opened before
    /// the spawn; `None` for a process that runs no session's commands, or where none opens.
    pub(crate) command_channel: Option<Arc<ClaudeCommandChannel>>,
    /// Where it runs.
    pub(crate) context: ClaudeSpawnContext,
}

/// The daemon's services a spawn's legs are built with.
pub(crate) struct ClaudeSpawnLegServices<'a> {
    /// Resolves the curated credential list.
    posture_service: &'a ExecutionPostureService,
    /// The daemon's data folder, absolute.
    data_folder: Cow<'a, str>,
    /// The login shell's environment captured at the daemon's start.
    base_environment: &'a [(String, String)],
    /// The names no environment row may set.
    reserved_names: &'a ReservedEnvironmentNames,
    /// Every provider's background work, which the process's settings deny.
    background_work: &'a Arc<BackgroundWorkForms>,
    /// How the place the process runs in spells paths and names.
    path_rules: PathRules,
}

impl<'a> ClaudeSpawnLegServices<'a> {
    /// The services every spawn path builds its legs with, from the driver's spawn sources, on
    /// the paths of the place the daemon runs in.
    pub(crate) fn of(sources: &'a ClaudeSpawnSources) -> Self {
        Self {
            posture_service: &sources.execution_postures,
            data_folder: sources.data_folder.to_string_lossy(),
            base_environment: &sources.base_environment,
            reserved_names: &sources.reserved_names,
            background_work: &sources.background_work,
            path_rules: PathRules::NATIVE,
        }
    }
}

/// The callback-tool host a session's process installs its registry in, and whether the daemon's
/// in-process tool servers, the tools' route, are registered.
pub(crate) struct ClaudeCallbackToolRegistry<'a> {
    /// The host.
    pub(crate) host: &'a Arc<CallbackToolHost>,
    /// Whether the in-process tool servers are registered.
    pub(crate) is_in_process_route_registered: bool,
}

/// Why a spawn's legs could not be built.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ClaudeSpawnLegsError {
    /// The account home's retention could not be written.
    #[error("the Claude Code home's retention could not be set")]
    HomeRetention(#[from] ClaudeSettingsFileError),
    /// The curated credential list could not be resolved.
    #[error("the credential list could not be resolved")]
    CredentialPolicy(#[from] CredentialPolicyResolveError),
    /// The process's environment could not be built.
    #[error("the Claude Code process's environment could not be built")]
    Environment(#[from] SpawnEnvironmentError),
}

/// Builds the legs every spawn path starts a process from, offering no callback tools and
/// installing no registry: the account home's retention set, git kept from asking on a terminal,
/// and a command channel's variables where one opened. Fails when the retention cannot be
/// written, the curated credential list cannot be resolved or the environment cannot be built.
pub(crate) async fn build_claude_spawn_bound_legs(
    request: ClaudeSpawnLegsRequest,
    services: &ClaudeSpawnLegServices<'_>,
) -> Result<ClaudeSpawnBoundLegs, ClaudeSpawnLegsError> {
    let context = request.context;
    write_claude_home_retention(Path::new(&context.account_folders.config_folder)).await?;
    // The curated list is handed over on every level, a posture-less spawn included.
    let credential_policy = services
        .posture_service
        .resolve_credential_policy(
            request
                .execution_posture
                .as_ref()
                .map_or(CURATED_CREDENTIAL_POLICY_REF, |posture| {
                    posture.credential_policy_ref().as_str()
                }),
        )
        .await?;
    let (prompt_variable, prompt_off) = GIT_TERMINAL_PROMPT_OFF;
    let command_environment = std::iter::once((prompt_variable.to_owned(), prompt_off.to_owned()))
        .chain(
            request
                .command_channel
                .iter()
                .flat_map(|channel| channel.environment().iter().cloned()),
        )
        .collect::<Vec<_>>();
    let spawn_environment = compose_claude_process_environment(
        ClaudeProcessEnvironmentRequest {
            session: SessionEnvironment {
                base: services.base_environment,
                every_project_rows: &context.every_project_rows,
                project_rows: &context.project_rows,
                reserved_names: services.reserved_names,
                rules: services.path_rules,
            },
            deny_env_vars: credential_policy.deny_env_vars,
            home: ClaudeProcessHome::Account {
                folders: &context.account_folders,
                provider_account_id: &request.provider_account_id,
            },
            data_folder: &services.data_folder,
        },
        &command_environment,
    )?;
    Ok(ClaudeSpawnBoundLegs {
        session_id: request.session_id,
        model: request.model,
        execution_posture: request.execution_posture,
        working_directory: context.working_directory,
        on_callback_tool_call: None,
        callback_tools: None,
        subagent_policy: request.subagent_policy,
        tool_servers: request.tool_servers.unwrap_or_default(),
        output_schema: request.output_schema,
        on_mcp_server_status: request.on_mcp_server_status,
        credential_deny_paths: credential_policy.deny_paths,
        memory_folders: context.memory_folders,
        background_work: Arc::clone(services.background_work),
        spawn_environment,
        advisor: context.advisor,
        output_style: context.output_style,
        command_channel: request.command_channel,
    })
}

/// Installs the callback-tool registry of the session `legs` start, in `registry`, and returns
/// `legs` offering the tools it admits, with the binding the live session holds and a failed
/// spawn rolls back. A withheld registry costs the model no turns, unlike one offered and then
/// refused.
pub(crate) fn bind_claude_callback_tools(
    legs: ClaudeSpawnBoundLegs,
    registry: &ClaudeCallbackToolRegistry<'_>,
    requested_tools: Option<Vec<SessionCallbackTool>>,
) -> (ClaudeSpawnBoundLegs, CallbackToolSpawnBinding) {
    let callback_tools = bind_callback_tools_for_spawn(
        registry.host,
        CallbackToolSpawnRequest {
            session_id: legs.session_id,
            provider: DESCRIPTOR.provider_id(),
            requested_tools: requested_tools.unwrap_or_default(),
            provider_registration_unavailable: (!registry.is_in_process_route_registered)
                .then(|| CLAUDE_IN_PROCESS_ROUTE_UNAVAILABLE_DETAIL.to_owned()),
        },
    );
    let offered_tools = match &callback_tools.admission {
        CallbackToolAdmission::Admitted { tools } if !tools.is_empty() => Some(tools.clone()),
        CallbackToolAdmission::Admitted { .. } | CallbackToolAdmission::Withheld { .. } => None,
    };
    let legs = ClaudeSpawnBoundLegs {
        on_callback_tool_call: offered_tools
            .is_some()
            .then(|| Arc::clone(&callback_tools.dispatcher)),
        callback_tools: offered_tools,
        ..legs
    };
    (legs, callback_tools)
}

/// The posture and output-schema digest a session is spawned under, which later runs must match.
/// Fails when the schema has no canonical form.
pub(crate) fn build_claude_spawn_binding(
    legs: &ClaudeSpawnBoundLegs,
) -> Result<ClaudeSpawnBinding, CanonicalizationRefusal> {
    Ok(ClaudeSpawnBinding {
        execution_posture: legs.execution_posture.clone(),
        output_schema_digest: legs
            .output_schema
            .as_ref()
            .map(digest_output_schema)
            .transpose()?,
    })
}

/// Refuses a run admitted against another realization than its session's spawn: Claude Code binds
/// the posture's credential list and writable roots, and the output schema, when it starts. Each
/// axis the run declares nothing on is free. Fails with `ExecutionPostureMismatch`,
/// `OutputSchemaUnbound` or `OutputSchemaMismatch`.
pub(crate) fn assert_claude_spawn_bound_realization(
    params: &StartRunParams,
    live: &LiveClaudeSession,
) -> Result<(), ClaudeSessionError> {
    let unavailable = |reason, detail| ClaudeSessionError::Unavailable {
        reason,
        detail,
        session_id: Some(live.session_id),
        run_id: Some(params.run_id),
    };
    if let Some(run_posture) = &params.execution_posture {
        let Some(spawn_posture) = &live.spawn_binding.execution_posture else {
            return Err(unavailable(
                ClaudeSessionUnavailableReason::ExecutionPostureMismatch,
                Some(
                    "The run declares an execution posture, but the Claude session was spawned \
                     with none."
                        .to_owned(),
                ),
            ));
        };
        if let Some(axis) = find_posture_divergence(run_posture, spawn_posture) {
            return Err(unavailable(
                ClaudeSessionUnavailableReason::ExecutionPostureMismatch,
                Some(format!("Execution posture diverges on {axis}.")),
            ));
        }
    }
    let Some(run_schema) = &params.output_schema else {
        return Ok(());
    };
    let Some(spawn_digest) = &live.spawn_binding.output_schema_digest else {
        return Err(unavailable(
            ClaudeSessionUnavailableReason::OutputSchemaUnbound,
            None,
        ));
    };
    let run_digest = digest_output_schema(run_schema).map_err(|refusal| {
        unavailable(
            ClaudeSessionUnavailableReason::OutputSchemaMismatch,
            Some(format!(
                "The run's schema has no canonical form: {refusal}."
            )),
        )
    })?;
    if &run_digest != spawn_digest {
        return Err(unavailable(
            ClaudeSessionUnavailableReason::OutputSchemaMismatch,
            Some(format!(
                "Run schema digest {}, session schema digest {}.",
                &run_digest[..16],
                &spawn_digest[..16]
            )),
        ));
    }
    Ok(())
}
