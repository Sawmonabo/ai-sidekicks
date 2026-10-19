//! The settings every Codex conversation is started, resumed and forked with: its folder, model,
//! permission level and profile, base instructions, and a `config` carrying its model's window, the
//! features it runs with, its tool servers, its connectors' defaults, its commands' environment,
//! its helper limit and its helpers' role files. A resume and a fork send them all again, so a
//! conversation never falls back to what Codex persisted. Also the `turn/start` and
//! `thread/settings/update` params, whose members carry absent, `null` and a value as three
//! meanings.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;

use crate::provider::driver::codex::app_server_protocol::{
    ApprovalsReviewer, AskForApproval, CollaborationMode, ThreadForkParams, ThreadResumeParams,
    ThreadStartParams, UserInput,
};
use crate::provider::driver::codex::permission_level::{
    CodexApprovalPolicy, CodexApprovalsReviewer, CodexProfileFolders,
    compose_codex_connector_defaults, compose_codex_level_settings,
    compose_codex_permission_config,
};
use crate::provider::driver::codex::session::helper_roles::CodexHelperRole;
use crate::provider::driver::contract::{SessionToolServer, SubagentPolicy};
use crate::provider::port::tool_server_route::ToolServerRoute;
use crate::provider::tool_server_name::DAEMON_TOOL_SERVER_NAME;

/// Seconds Codex waits on one call to the daemon's tool server: Codex's own default, above the
/// route's own bound, so the route answers first.
const CODEX_DAEMON_TOOL_TIMEOUT_SECONDS: u64 = 300;

/// The largest helper count Codex accepts, sent where the person set no limit.
const CODEX_UNLIMITED_HELPERS: i64 = i64::MAX;

/// Everything one conversation's thread settings are composed from.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the Codex session's start, resume and fork compose a conversation's settings"
    )
)]
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
/// request. With no tool-server route registered yet, the conversation reaches no tool server.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the Codex session's start opens its conversation with these"
    )
)]
pub(crate) fn compose_codex_thread_start_params(
    settings: &CodexThreadSettings,
    route: Option<&dyn ToolServerRoute>,
) -> ThreadStartParams {
    let members = compose_thread_members(settings, route);
    ThreadStartParams {
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
#[expect(
    dead_code,
    reason = "the Codex session's resume brings a conversation back with these"
)]
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
#[expect(
    dead_code,
    reason = "the Codex session's fork and rewind move a conversation with these"
)]
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
#[expect(
    dead_code,
    reason = "the Codex run start and side questions send a turn with these"
)]
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
    /// The thread's service tier from this turn on.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "serde_with::rust::double_option"
    )]
    pub(crate) service_tier: Option<Option<String>>,
    /// The service tier of this turn alone, leaving the thread's as it is; `default` is standard.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) service_tier_for_turn: Option<String>,
}

/// The `thread/settings/update` params the daemon sends, each member changing the thread from its
/// next turn. `service_tier` keeps its three meanings: absent leaves the tier, `null` clears it, a
/// value sets it.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the Codex mode move, level move and profile restore update a thread with these"
    )
)]
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
    pub(crate) service_tier: Option<Option<String>>,
}

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
    use std::path::PathBuf;

    use rstest::rstest;
    use serde_json::{Value, json};
    use sidekicks_contracts::session::controls::methods::PermissionLevel;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::integer::SafeInt;

    use super::{
        CodexThreadSettings, CodexThreadSettingsUpdateParams, compose_codex_thread_start_params,
    };
    use crate::provider::driver::codex::permission_level::CodexProfileFolders;
    use crate::provider::driver::contract::SubagentPolicy;

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
            },
            command_environment: Vec::new(),
            subagent_policy,
            helper_roles: Vec::new(),
            tool_servers: Vec::new(),
            base_instructions: None,
        }
    }

    fn enabled(helpers_at_once: Option<u64>) -> Option<SubagentPolicy> {
        Some(SubagentPolicy::Enabled {
            helpers_at_once: helpers_at_once
                .map(|count| SafeInt::new(count).expect("a positive safe integer")),
            definitions: Vec::new(),
        })
    }

    #[rstest]
    #[case::no_policy(None, json!(false), Some(json!(false)))]
    #[case::helpers_off(Some(SubagentPolicy::Disabled {}), json!(false), Some(json!(false)))]
    #[case::unlimited(
        enabled(None),
        json!({ "enabled": true, "max_concurrent_threads_per_session": i64::MAX }),
        None
    )]
    #[case::two_at_once(
        enabled(Some(2)),
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

    #[rstest]
    #[case::absent(None, json!({ "threadId": "thread" }))]
    #[case::null(Some(None), json!({ "threadId": "thread", "serviceTier": null }))]
    #[case::value(
        Some(Some("fast".to_owned())),
        json!({ "threadId": "thread", "serviceTier": "fast" })
    )]
    fn the_service_tier_keeps_absent_null_and_a_value_apart(
        #[case] service_tier: Option<Option<String>>,
        #[case] expected: Value,
    ) {
        let params = CodexThreadSettingsUpdateParams {
            thread_id: "thread".to_owned(),
            collaboration_mode: None,
            permissions: None,
            approval_policy: None,
            approvals_reviewer: None,
            service_tier,
        };
        assert_eq!(
            serde_json::to_value(&params).expect("the params serialize"),
            expected
        );
    }
}
