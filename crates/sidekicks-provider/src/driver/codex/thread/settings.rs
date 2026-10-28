//! The settings every Codex conversation is started, resumed and forked with: its folder, model,
//! permission level and profile, base instructions, and a `config` carrying its model's window, the
//! features it runs with, its tool servers, its connectors' defaults, its commands' environment,
//! its helper limit and its helpers' role files. A resume and a fork send them all again, so a
//! conversation never falls back to what Codex persisted. A start and every turn select the
//! daemon's executor relay as the conversation's environment. Also the `turn/start` and
//! `thread/settings/update` params, whose members carry absent, `null` and a value as three
//! meanings, the Build or Plan collaboration mode they carry, and the item-injection method a
//! loaded conversation takes changed instructions through.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sidekicks_contracts::session::controls::methods::{PermissionLevel, SessionMode};
use sidekicks_contracts::session::id::SessionId;

use crate::driver::codex::app_server_protocol::{
    ApprovalsReviewer, AskForApproval, CollaborationMode, ModeKind, ReasoningEffort, Settings,
    ThreadForkParams, ThreadResumeParams, ThreadStartParams, TurnEnvironmentParams, UserInput,
};
use crate::driver::codex::exec_relay::CODEX_RELAY_ENVIRONMENT_ID;
use crate::driver::codex::permission_level::{
    CodexApprovalPolicy, CodexApprovalsReviewer, CodexProfileFolders,
    compose_codex_connector_defaults, compose_codex_level_settings,
    compose_codex_permission_config,
};
use crate::driver::codex::session::helper_roles::CodexHelperRole;
use crate::driver::session_control::{SessionToolServer, SubagentPolicy};
use crate::port::tool_server_route::ToolServerRoute;
use crate::tool_server_name::DAEMON_TOOL_SERVER_NAME;

/// Seconds Codex waits on one call to the daemon's tool server: Codex's own default, above the
/// route's own bound, so the route answers first.
const CODEX_DAEMON_TOOL_TIMEOUT_SECONDS: u64 = 300;

/// The largest helper count Codex accepts, sent where the person set no limit.
const CODEX_UNLIMITED_HELPERS: i64 = i64::MAX;

/// Everything one conversation's thread settings are composed from.
#[derive(Clone, Debug)]
pub(crate) struct CodexThreadSettings {
    /// The session the conversation belongs to, which names its tool servers' addresses.
    pub(crate) session_id: SessionId,
    /// The conversation's working folder, absolute.
    pub(crate) working_directory: PathBuf,
    /// The model the conversation runs.
    pub(crate) model: String,
    /// The larger window the session chose for its model, in tokens, sent as
    /// `model_context_window`; `None` runs the model's default window and sends none.
    pub(crate) model_context_window: Option<u64>,
    /// The session's permission level.
    pub(crate) level: PermissionLevel,
    /// The folders and denies the level's profiles are built from.
    pub(crate) profile_folders: CodexProfileFolders,
    /// The whole environment each command the conversation runs receives, nothing inherited.
    pub(crate) command_environment: Vec<(String, String)>,
    /// The session's helper policy; `None` runs no helpers.
    pub(crate) subagent_policy: Option<SubagentPolicy>,
    /// The role file of each helper the policy defines, written before the conversation starts.
    pub(crate) helper_roles: Vec<CodexHelperRole>,
    /// Every tool server the session can reach, each with the person's switch.
    pub(crate) tool_servers: Vec<SessionToolServer>,
    /// The instructions the conversation runs under; sent on every start, resume and fork.
    pub(crate) base_instructions: Option<String>,
}

/// The members `thread/start`, `thread/resume` and `thread/fork` all carry.
struct CodexThreadMembers {
    cwd: String,
    model: String,
    permissions: String,
    approval_policy: AskForApproval,
    approvals_reviewer: ApprovalsReviewer,
    base_instructions: Option<String>,
    config: Map<String, Value>,
}

/// The `thread/start` params for `settings`, without the output speed, which the caller sets per
/// request, the conversation's commands running on the daemon's relay. With no tool-server route
/// registered yet, the conversation reaches no tool server.
pub(crate) fn compose_codex_thread_start_params(
    settings: &CodexThreadSettings,
    route: Option<&dyn ToolServerRoute>,
) -> ThreadStartParams {
    let members = compose_thread_members(settings, route);
    ThreadStartParams {
        environments: Some(compose_codex_relay_environments(
            &settings.working_directory,
        )),
        cwd: Some(members.cwd),
        model: Some(members.model),
        permissions: Some(members.permissions),
        approval_policy: Some(members.approval_policy),
        approvals_reviewer: Some(members.approvals_reviewer),
        base_instructions: members.base_instructions,
        config: Some(members.config),
        ..ThreadStartParams::default()
    }
}

/// The `thread/resume` params that resume `thread_id` under `settings`, without the output speed,
/// which the caller sets per request.
pub(crate) fn compose_codex_thread_resume_params(
    settings: &CodexThreadSettings,
    route: Option<&dyn ToolServerRoute>,
    thread_id: String,
) -> ThreadResumeParams {
    let members = compose_thread_members(settings, route);
    ThreadResumeParams {
        thread_id,
        cwd: Some(members.cwd),
        model: Some(members.model),
        permissions: Some(members.permissions),
        approval_policy: Some(members.approval_policy),
        approvals_reviewer: Some(members.approvals_reviewer),
        base_instructions: members.base_instructions,
        config: Some(members.config),
        developer_instructions: None,
        exclude_turns: None,
        history: None,
        initial_turns_page: None,
        model_provider: None,
        path: None,
        personality: None,
        runtime_workspace_roots: None,
        sandbox: None,
        service_tier: None,
    }
}

/// The `thread/fork` params that fork `thread_id` under `settings`, without the output speed,
/// which the caller sets per request, or the turn the fork keeps up to.
pub(crate) fn compose_codex_thread_fork_params(
    settings: &CodexThreadSettings,
    route: Option<&dyn ToolServerRoute>,
    thread_id: String,
) -> ThreadForkParams {
    let members = compose_thread_members(settings, route);
    ThreadForkParams {
        thread_id,
        cwd: Some(members.cwd),
        model: Some(members.model),
        permissions: Some(members.permissions),
        approval_policy: Some(members.approval_policy),
        approvals_reviewer: Some(members.approvals_reviewer),
        base_instructions: members.base_instructions,
        config: Some(members.config),
        before_turn_id: None,
        defer_goal_continuation: None,
        developer_instructions: None,
        ephemeral: None,
        exclude_turns: None,
        experimental_prediction_mode: None,
        last_turn_id: None,
        model_provider: None,
        path: None,
        runtime_workspace_roots: None,
        sandbox: None,
        service_tier: None,
        thread_source: None,
    }
}

/// The environments a `thread/start` or `turn/start` selects: the daemon's executor relay alone,
/// in `working_directory`. A resume and a fork carry none, so a conversation's next turn selects
/// it again.
pub(crate) fn compose_codex_relay_environments(
    working_directory: &Path,
) -> Vec<TurnEnvironmentParams> {
    vec![TurnEnvironmentParams {
        cwd: working_directory.to_string_lossy().into_owned().into(),
        environment_id: CODEX_RELAY_ENVIRONMENT_ID.to_owned(),
        runtime_workspace_roots: None,
    }]
}

/// The `config` members a level sets, which only a start, resume or fork carries, so a level move
/// that changes them reaches the conversation through a fork.
pub(crate) fn compose_codex_level_config(
    level: PermissionLevel,
    folders: &CodexProfileFolders,
) -> Map<String, Value> {
    let mut config = into_object(&compose_codex_permission_config(level, folders));
    config.extend(into_object(&compose_codex_connector_defaults(level)));
    config
}

/// A thread request's service tier as the daemon sets it: `None` returns the thread to the standard
/// tier, sent as `null`, and a tier id sets that tier; a request that leaves the tier as it is
/// carries no member.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(transparent)]
pub(crate) struct CodexServiceTierChange(pub(crate) Option<String>);

/// The `turn/start` params the daemon sends: the turn's input and the overrides it carries from
/// that turn on. `service_tier` keeps its three meanings: absent keeps the thread's tier, `null`
/// returns it to standard, a value sets it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexTurnStartParams {
    /// The conversation the turn runs on.
    pub(crate) thread_id: String,
    /// The turn's input.
    pub(crate) input: Vec<UserInput>,
    /// Who answers the turn's asks, from this turn on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) approvals_reviewer: Option<ApprovalsReviewer>,
    /// The collaboration mode the turn runs in, carrying its model and effort.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) collaboration_mode: Option<CollaborationMode>,
    /// The model the turn runs, from this turn on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) model: Option<String>,
    /// The id the person's message was sent with, which Codex keeps on the message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) client_user_message_id: Option<String>,
    /// The JSON Schema the turn's final message must follow.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) output_schema: Option<Value>,
    /// The reasoning effort the turn runs at, from this turn on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) effort: Option<ReasoningEffort>,
    /// The thread's service tier from this turn on.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "serde_with::rust::double_option"
    )]
    #[expect(
        clippy::option_option,
        reason = "absent, `null` and a tier are three meanings the wire keeps apart"
    )]
    pub(crate) service_tier: Option<Option<String>>,
    /// The service tier of this turn alone, leaving the thread's as it is; `default` is standard.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) service_tier_for_turn: Option<String>,
    /// The environments the turn's commands run in, from this turn on; an empty list runs none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) environments: Option<Vec<TurnEnvironmentParams>>,
}

/// The `thread/settings/update` params the daemon sends, each member changing the thread from its
/// next turn. `service_tier` keeps its three meanings: absent leaves the tier, `null` clears it, a
/// value sets it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexThreadSettingsUpdateParams {
    /// The conversation to update.
    pub(crate) thread_id: String,
    /// The collaboration mode its turns run in.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) collaboration_mode: Option<CollaborationMode>,
    /// The permission profile id its turns run under.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) permissions: Option<String>,
    /// When it asks before acting.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) approval_policy: Option<AskForApproval>,
    /// Who answers its asks.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) approvals_reviewer: Option<ApprovalsReviewer>,
    /// Its service tier.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "serde_with::rust::double_option"
    )]
    #[expect(
        clippy::option_option,
        reason = "absent, `null` and a tier are three meanings the wire keeps apart"
    )]
    pub(crate) service_tier: Option<Option<String>>,
}

/// Codex's collaboration mode for Build or Plan on `model` at `reasoning_effort`, with the mode's
/// built-in instructions. It takes precedence over a request's own model and effort, so both are
/// carried; an effort Codex reported that this build's schema does not list is left out.
pub(crate) fn compose_codex_collaboration_mode(
    mode: SessionMode,
    model: String,
    reasoning_effort: Option<&str>,
) -> CollaborationMode {
    CollaborationMode {
        mode: match mode {
            SessionMode::Build => ModeKind::Default,
            SessionMode::Plan => ModeKind::Plan,
        },
        settings: Settings {
            developer_instructions: None,
            model,
            reasoning_effort: reasoning_effort.and_then(|effort| effort.parse().ok()),
        },
    }
}

/// Codex's item-injection method: appends items to a loaded thread's model-visible history, one
/// way a conversation takes changed instructions from its next turn. Codex takes any JSON as an
/// item, so one it does not recognize is dropped while the request still succeeds.
#[expect(
    dead_code,
    reason = "the Codex leg that hands a loaded conversation changed instructions sends it"
)]
pub(crate) const CODEX_THREAD_INJECT_ITEMS_METHOD: &str = "thread/inject_items";

impl From<CodexApprovalPolicy> for AskForApproval {
    fn from(policy: CodexApprovalPolicy) -> Self {
        match policy {
            CodexApprovalPolicy::OnRequest => Self::OnRequest,
            CodexApprovalPolicy::Never => Self::Never,
        }
    }
}

impl From<CodexApprovalsReviewer> for ApprovalsReviewer {
    fn from(reviewer: CodexApprovalsReviewer) -> Self {
        match reviewer {
            CodexApprovalsReviewer::User => Self::User,
            CodexApprovalsReviewer::AutoReview => Self::AutoReview,
        }
    }
}

fn compose_thread_members(
    settings: &CodexThreadSettings,
    route: Option<&dyn ToolServerRoute>,
) -> CodexThreadMembers {
    let level_settings = compose_codex_level_settings(settings.level, &settings.profile_folders);
    CodexThreadMembers {
        cwd: settings.working_directory.to_string_lossy().into_owned(),
        model: settings.model.clone(),
        permissions: level_settings.permissions,
        approval_policy: level_settings.approval_policy.into(),
        approvals_reviewer: level_settings.approvals_reviewer.into(),
        base_instructions: settings.base_instructions.clone(),
        config: compose_thread_config(settings, route),
    }
}

// The `config` a start, resume and fork carry. Dotted keys are Codex's own paths into its config;
// `agents`, `mcp_servers` and `permissions` are whole tables.
fn compose_thread_config(
    settings: &CodexThreadSettings,
    route: Option<&dyn ToolServerRoute>,
) -> Map<String, Value> {
    let mut config = Map::new();
    if let Some(window) = settings.model_context_window {
        config.insert("model_context_window".to_owned(), json!(window));
    }
    config.insert(
        "features.default_mode_request_user_input".to_owned(),
        json!(true),
    );
    config.insert("model_reasoning_summary".to_owned(), json!("auto"));
    // The task list tool is off unless enabled, and Codex reads the setting as a table.
    config.insert("tools.update_plan.enabled".to_owned(), json!(true));
    config.extend(compose_helper_limit(settings.subagent_policy.as_ref()));
    if let Some(roles) = compose_helper_roles(settings) {
        config.insert("agents".to_owned(), roles);
    }
    config.insert(
        "mcp_servers".to_owned(),
        Value::Object(compose_tool_servers(settings, route)),
    );
    config.insert(
        "shell_environment_policy".to_owned(),
        compose_shell_environment_policy(&settings.command_environment),
    );
    config.extend(compose_codex_level_config(
        settings.level,
        &settings.profile_folders,
    ));
    config
}

// The helper limit: Codex counts the lead among the conversations at once, so N helpers is N + 1;
// Codex refuses zero, so no helpers switches the feature off instead.
fn compose_helper_limit(policy: Option<&SubagentPolicy>) -> Map<String, Value> {
    let mut members = Map::new();
    match policy {
        None | Some(SubagentPolicy::Disabled {}) => {
            members.insert("features.multi_agent_v2".to_owned(), json!(false));
            members.insert("agents.enabled".to_owned(), json!(false));
        }
        Some(SubagentPolicy::Enabled {
            helpers_at_once, ..
        }) => {
            let threads_at_once = helpers_at_once
                .map_or(json!(CODEX_UNLIMITED_HELPERS), |helpers| {
                    json!(helpers.get() + 1)
                });
            members.insert(
                "features.multi_agent_v2".to_owned(),
                json!({ "enabled": true, "max_concurrent_threads_per_session": threads_at_once }),
            );
        }
    }
    members
}

// Each helper's entry as a nested `agents` table, which Codex merges with the roles the person's
// own config defines and which carries any name, a dot included; the helper's instructions stay
// in its file, so none reach the lead. `None` when no helper runs.
fn compose_helper_roles(settings: &CodexThreadSettings) -> Option<Value> {
    match settings.subagent_policy {
        None | Some(SubagentPolicy::Disabled {}) => None,
        Some(SubagentPolicy::Enabled { .. }) if settings.helper_roles.is_empty() => None,
        Some(SubagentPolicy::Enabled { .. }) => Some(Value::Object(
            settings
                .helper_roles
                .iter()
                .map(|role| {
                    let entry = json!({
                        "description": role.description,
                        "config_file": role.config_file.to_string_lossy(),
                    });
                    (role.name.clone(), entry)
                })
                .collect(),
        )),
    }
}

// The whole `mcp_servers` table: every server on the daemon's route, each as switched; empty with
// no route, so Codex adds none of its own config's.
fn compose_tool_servers(
    settings: &CodexThreadSettings,
    route: Option<&dyn ToolServerRoute>,
) -> Map<String, Value> {
    let mut servers = Map::new();
    let Some(route) = route else {
        return servers;
    };
    for tool_server in &settings.tool_servers {
        let server_name = tool_server.server_name.as_str();
        servers.insert(
            server_name.to_owned(),
            json!({
                "url": route.url_for(&settings.session_id, server_name),
                "enabled": tool_server.is_enabled,
            }),
        );
    }
    servers.insert(
        DAEMON_TOOL_SERVER_NAME.to_owned(),
        json!({
            "url": route.url_for(&settings.session_id, DAEMON_TOOL_SERVER_NAME),
            "enabled": true,
            // The daemon judges each of its own calls itself, so Codex asks nothing first.
            "default_tools_approval_mode": "approve",
            "tool_timeout_sec": CODEX_DAEMON_TOOL_TIMEOUT_SECONDS,
        }),
    );
    servers
}

// Each command gets exactly the conversation's environment: nothing inherited from the service.
fn compose_shell_environment_policy(command_environment: &[(String, String)]) -> Value {
    let set: Map<String, Value> = command_environment
        .iter()
        .map(|(name, value)| (name.clone(), Value::String(value.clone())))
        .collect();
    json!({ "inherit": "none", "set": set })
}

// A level's config members, a struct of string-keyed maps and plain values, as one JSON object's
// members.
fn into_object(members: &impl Serialize) -> Map<String, Value> {
    let value = serde_json::to_value(members)
        .expect("a level's config members are string-keyed maps and plain values");
    serde_json::from_value(value).expect("a struct serializes as a JSON object")
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use rstest::rstest;
    use serde_json::{Value, json};
    use sidekicks_contracts::session::controls::methods::PermissionLevel;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::integer::SafeInt;
    use sidekicks_platforms::PathRules;

    use super::{
        ApprovalsReviewer, AskForApproval, CodexServiceTierChange, CodexThreadSettings,
        CodexThreadSettingsUpdateParams, CodexTurnStartParams, CollaborationMode, ThreadForkParams,
        ThreadResumeParams, ThreadStartParams, UserInput, compose_codex_relay_environments,
        compose_codex_thread_fork_params, compose_codex_thread_resume_params,
        compose_codex_thread_start_params,
    };
    use crate::driver::PROVIDERS;
    use crate::driver::codex::DESCRIPTOR;
    use crate::driver::codex::app_server_protocol::{ModeKind, Settings, TextUserInputType};
    use crate::driver::codex::permission_level::CodexProfileFolders;
    use crate::driver::codex::vendored_schema::vendored_schema_file;
    use crate::driver::session_control::SubagentPolicy;
    use crate::spawn_environment::{
        ProviderEnvironmentRequest, ReservedEnvironmentNames, SessionEnvironment,
        build_conversation_command_environment,
    };

    fn settings_with(subagent_policy: Option<SubagentPolicy>) -> CodexThreadSettings {
        CodexThreadSettings {
            session_id: SessionId::new("0192f3a4-5b6c-7d8e-9f01-23456789abcd")
                .expect("the text is a UUID"),
            working_directory: PathBuf::from("/work/repository"),
            model: "gpt-5".to_owned(),
            model_context_window: None,
            level: PermissionLevel::Ask,
            profile_folders: CodexProfileFolders {
                working_directory: PathBuf::from("/work/repository"),
                git_common_folder: None,
                deny_paths: Vec::new(),
                command_channel_folder: PathBuf::from("/data/command-channels/session"),
            },
            command_environment: Vec::new(),
            subagent_policy,
            helper_roles: Vec::new(),
            tool_servers: Vec::new(),
            base_instructions: None,
        }
    }

    fn enabled(helpers_at_once: Option<u64>) -> SubagentPolicy {
        SubagentPolicy::Enabled {
            helpers_at_once: helpers_at_once
                .map(|count| SafeInt::new(count).expect("a positive safe integer")),
            definitions: Vec::new(),
        }
    }

    #[rstest]
    #[case::no_policy(None, json!(false), Some(json!(false)))]
    #[case::helpers_off(Some(SubagentPolicy::Disabled {}), json!(false), Some(json!(false)))]
    #[case::unlimited(
        Some(enabled(None)),
        json!({ "enabled": true, "max_concurrent_threads_per_session": i64::MAX }),
        None
    )]
    #[case::two_at_once(
        Some(enabled(Some(2))),
        json!({ "enabled": true, "max_concurrent_threads_per_session": 3 }),
        None
    )]
    fn the_helper_limit_counts_the_lead_and_never_sends_zero(
        #[case] policy: Option<SubagentPolicy>,
        #[case] multi_agent: Value,
        #[case] agents_enabled: Option<Value>,
    ) {
        let params = compose_codex_thread_start_params(&settings_with(policy), None);
        let config = params.config.expect("a start always carries its config");
        assert_eq!(config.get("features.multi_agent_v2"), Some(&multi_agent));
        assert_eq!(config.get("agents.enabled"), agents_enabled.as_ref());
    }

    // Killed by building a conversation's command environment without the switches every
    // registered provider's background work is turned off by, or by dropping them from the policy.
    #[test]
    fn the_conversation_commands_carry_every_providers_background_switch() {
        let reserved_names = ReservedEnvironmentNames::of_providers(PROVIDERS);
        let request = ProviderEnvironmentRequest {
            session: SessionEnvironment {
                base: &[],
                every_project_rows: &[],
                project_rows: &[],
                reserved_names: &reserved_names,
                rules: PathRules::Posix,
            },
            descriptor: &DESCRIPTOR,
            deny_env_vars: &[],
            credential_homes: &[],
        };
        let settings = CodexThreadSettings {
            command_environment: build_conversation_command_environment(&request)
                .expect("the conversation's command environment builds"),
            ..settings_with(None)
        };

        let params = compose_codex_thread_start_params(&settings, None);
        let config = params.config.expect("a start always carries its config");
        let switches: Vec<_> = PROVIDERS
            .iter()
            .filter_map(|descriptor| descriptor.background_work.as_ref())
            .map(|work| work.off_switch)
            .collect();
        assert_ne!(switches.len(), 0);
        for (name, value) in switches {
            assert_eq!(
                config["shell_environment_policy"]["set"][name],
                json!(value)
            );
        }
    }

    /// A thread request that carries a service tier.
    #[derive(Clone, Copy, Debug)]
    enum TierRequest {
        Start,
        Resume,
        Fork,
        SettingsUpdate,
        TurnStart,
    }

    // `request`'s params with `service_tier` set, as their serialized `serviceTier` member.
    #[expect(
        clippy::option_option,
        reason = "absent, `null` and a tier are the three states under test"
    )]
    fn serialized_service_tier(
        request: TierRequest,
        service_tier: Option<Option<String>>,
    ) -> Option<Value> {
        let settings = settings_with(None);
        let change = service_tier.clone().map(CodexServiceTierChange);
        let params = match request {
            TierRequest::Start => serde_json::to_value(ThreadStartParams {
                service_tier: change,
                ..compose_codex_thread_start_params(&settings, None)
            }),
            TierRequest::Resume => serde_json::to_value(ThreadResumeParams {
                service_tier: change,
                ..compose_codex_thread_resume_params(&settings, None, "thread".to_owned())
            }),
            TierRequest::Fork => serde_json::to_value(ThreadForkParams {
                service_tier: change,
                ..compose_codex_thread_fork_params(&settings, None, "thread".to_owned())
            }),
            TierRequest::SettingsUpdate => serde_json::to_value(CodexThreadSettingsUpdateParams {
                thread_id: "thread".to_owned(),
                collaboration_mode: None,
                permissions: None,
                approval_policy: None,
                approvals_reviewer: None,
                service_tier,
            }),
            TierRequest::TurnStart => serde_json::to_value(CodexTurnStartParams {
                thread_id: "thread".to_owned(),
                input: Vec::new(),
                approvals_reviewer: None,
                collaboration_mode: None,
                model: None,
                client_user_message_id: None,
                output_schema: None,
                effort: None,
                service_tier,
                service_tier_for_turn: None,
                environments: None,
            }),
        };
        params
            .expect("the params serialize")
            .get("serviceTier")
            .cloned()
    }

    #[rstest]
    fn the_service_tier_keeps_absent_null_and_a_value_apart(
        #[values(
            TierRequest::Start,
            TierRequest::Resume,
            TierRequest::Fork,
            TierRequest::SettingsUpdate,
            TierRequest::TurnStart
        )]
        request: TierRequest,
    ) {
        assert_eq!(serialized_service_tier(request, None), None);
        assert_eq!(
            serialized_service_tier(request, Some(None)),
            Some(Value::Null)
        );
        assert_eq!(
            serialized_service_tier(request, Some(Some("fast".to_owned()))),
            Some(json!("fast"))
        );
    }

    // The member names of a hand-written request type, every member set so none is skipped.
    fn hand_written_members(type_name: &str) -> Vec<String> {
        let collaboration_mode = Some(CollaborationMode {
            mode: ModeKind::Default,
            settings: Settings {
                developer_instructions: None,
                model: "gpt".to_owned(),
                reasoning_effort: None,
            },
        });
        let params = match type_name {
            "TurnStartParams" => serde_json::to_value(CodexTurnStartParams {
                thread_id: "thread".to_owned(),
                input: vec![UserInput::TextUserInput {
                    text: "hello".to_owned(),
                    text_elements: Vec::new(),
                    type_: TextUserInputType::Text,
                }],
                approvals_reviewer: Some(ApprovalsReviewer::User),
                collaboration_mode,
                model: Some("gpt".to_owned()),
                client_user_message_id: Some("message".to_owned()),
                output_schema: Some(json!({ "type": "object" })),
                effort: Some("low".parse().expect("low is an effort")),
                service_tier: Some(Some("fast".to_owned())),
                service_tier_for_turn: Some("fast".to_owned()),
                environments: Some(compose_codex_relay_environments(Path::new("/work"))),
            }),
            "ThreadSettingsUpdateParams" => serde_json::to_value(CodexThreadSettingsUpdateParams {
                thread_id: "thread".to_owned(),
                collaboration_mode,
                permissions: Some("profile".to_owned()),
                approval_policy: Some(AskForApproval::Never),
                approvals_reviewer: Some(ApprovalsReviewer::User),
                service_tier: Some(Some("fast".to_owned())),
            }),
            _ => unreachable!("{type_name} is not hand-written"),
        };
        params
            .expect("the params serialize")
            .as_object()
            .expect("the params are an object")
            .keys()
            .cloned()
            .collect()
    }

    // The two request types the daemon writes by hand, for their three-state service tier, name
    // only members the vendored release's schema has and every member it requires, so a release
    // that drops, renames or newly requires one fails here instead of at the service. Killed by
    // a member the schema lacks or a required member the type lacks.
    #[rstest]
    #[case("TurnStartParams")]
    #[case("ThreadSettingsUpdateParams")]
    fn a_hand_written_request_names_the_schemas_members(#[case] type_name: &str) {
        let schema = vendored_schema_file("codex_app_server_protocol.v2.schemas.json");
        let definition = &schema["definitions"][type_name];
        let members = hand_written_members(type_name);
        let properties = definition["properties"]
            .as_object()
            .expect("the schema names the type's members");
        for member in &members {
            assert!(
                properties.contains_key(member),
                "{type_name} sends {member}, which the schema does not name"
            );
        }
        for required in definition["required"]
            .as_array()
            .expect("the schema names the type's required members")
        {
            let required = required.as_str().expect("a required member is a name");
            assert!(
                members.iter().any(|member| member == required),
                "the schema requires {type_name}.{required}, which the type does not send"
            );
        }
    }
}
