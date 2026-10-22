//! Hands a live Claude Code process its session's standing rules: a session rule by resending the
//! session's whole permissions document in its flag settings, which apply from the next call, and
//! a project rule through the local settings file Claude Code keeps for each of the project's
//! working folders.

use std::error::Error;
use std::path::Path;
use std::sync::Arc;

use sidekicks_contracts::approval::RememberedRuleSense;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::PathRules;

use crate::cleanup_failures::CleanupFailures;
use crate::mutex_lock::lock;
use crate::provider::driver::claude::session::errors::ClaudeSessionError;
use crate::provider::driver::claude::session::permission_level::permission_level_of;
use crate::provider::driver::claude::session::rules::{
    ClaudeProjectFolder, ClaudeRulesError, remove_claude_project_rule,
    resolve_claude_local_settings_file, write_claude_project_rule,
};
use crate::provider::driver::claude::session::state::LiveClaudeSession;
use crate::provider::driver::claude::session::transport::control::{
    ClaudeControlRequest, ClaudeFlagSettings, ClaudePermissionsDocument,
};
use crate::provider::driver::claude::spawn::settings::{
    ClaudePermissionsRequest, compose_claude_permissions,
};
use crate::provider::driver::contract::DriverError;
use crate::provider::port::permission_ask::ProviderAskRule;
use crate::provider::port::registration::PortRegistration;
use crate::provider::port::session_rules::SessionRulePort;

/// Why a standing rule could not be handed to Claude Code or taken out of force there.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ClaudePermissionsError {
    /// The session's permissions document could not be composed; nothing was sent.
    #[error("the session's Claude Code permission rules could not be composed")]
    Compose(#[source] ClaudeRulesError),
    /// Claude Code refused or did not answer the request.
    #[error(transparent)]
    Session(#[from] ClaudeSessionError),
    /// A project rule could not be written into every working folder, and taking it back out of
    /// the ones written may have failed too.
    #[error(transparent)]
    ProjectRuleWrite(CleanupFailures<ClaudeRulesError>),
    /// A revoked project rule could not be taken out of the folder's local settings.
    #[error(transparent)]
    ProjectRuleRemoval(ClaudeRulesError),
}

impl From<ClaudePermissionsError> for DriverError {
    /// Claude Code's refusal or silence keeps its own answer; every other failure is internal.
    fn from(error: ClaudePermissionsError) -> Self {
        match error {
            ClaudePermissionsError::Session(error) => error.into(),
            error @ (ClaudePermissionsError::Compose(_)
            | ClaudePermissionsError::ProjectRuleWrite(_)
            | ClaudePermissionsError::ProjectRuleRemoval(_)) => Self::Internal(Box::new(error)),
        }
    }
}

/// Where a project rule an answer made is written: every working folder of the project, each with
/// what Claude Code reads to place its local settings, and the session's own among them.
pub(crate) struct ClaudeProjectRuleFolders<'a> {
    /// Every working folder of the project.
    pub(crate) project_folders: &'a [ClaudeProjectFolder<'a>],
    /// The session's own working folder, whose file Claude Code writes an allow into itself.
    pub(crate) own_folder: &'a ClaudeProjectFolder<'a>,
    /// The home folder of the place the session runs in.
    pub(crate) home_folder: &'a Path,
}

/// Where a revoked project rule is taken out, and the files Claude Code also reads it from, which
/// the daemon never edits.
pub(crate) struct ClaudeProjectRuleRemoval<'a> {
    /// The working folder whose local settings hold the rule.
    pub(crate) project_folder: &'a ClaudeProjectFolder<'a>,
    /// The administrator's managed settings folder; `None` where the system has none.
    pub(crate) managed_settings_folder: Option<&'a Path>,
    /// The config folder of the Claude Code home the session runs on.
    pub(crate) config_folder: &'a Path,
    /// The home folder of the place the session runs in.
    pub(crate) home_folder: &'a Path,
}

/// The session's own standing rules, oldest first; none while the approval pipeline has not
/// registered its port. Fails as the port's read fails.
pub(crate) async fn read_claude_session_rules(
    registration: &PortRegistration<Arc<dyn SessionRulePort>>,
    session_id: SessionId,
) -> Result<Vec<ProviderAskRule>, Box<dyn Error + Send + Sync>> {
    match registration.port() {
        Some(port) => port.read_session_rules(session_id).await,
        None => Ok(Vec::new()),
    }
}

/// The live session's whole permissions document at `level` with `writable_roots` and the rules
/// in force, `session_rules`, from the legs its process was started with. Fails as the session's
/// own rules fail to compose.
pub(crate) fn compose_live_claude_permissions(
    live: &LiveClaudeSession,
    writable_roots: &[FilesystemPath],
    level: Option<PermissionLevel>,
    session_rules: &[ProviderAskRule],
    path_rules: PathRules,
) -> Result<ClaudePermissionsDocument, ClaudeRulesError> {
    let legs = &live.spawn_bound_legs;
    compose_claude_permissions(
        &ClaudePermissionsRequest {
            credential_deny_paths: &legs.credential_deny_paths,
            memory_folders: &legs.memory_folders,
            session_rules,
            path_rules,
        },
        writable_roots,
        level,
    )
}

/// Resends the live session's whole permissions document at the level it runs at, with the rules
/// in force, `session_rules`, from the process's next call; a rule the person revoked is left out
/// of them. Fails when the document cannot be composed or Claude Code refuses it.
pub(crate) async fn resend_claude_permissions(
    live: &LiveClaudeSession,
    session_rules: &[ProviderAskRule],
    path_rules: PathRules,
) -> Result<(), ClaudePermissionsError> {
    let posture = lock(&live.settings).execution_posture.clone();
    let permissions = compose_live_claude_permissions(
        live,
        posture
            .as_ref()
            .map(ExecutionPosture::writable_roots)
            .unwrap_or_default(),
        posture.as_ref().map(permission_level_of),
        session_rules,
        path_rules,
    )
    .map_err(ClaudePermissionsError::Compose)?;
    live.channel
        .send_control_request(ClaudeControlRequest::ApplyFlagSettings {
            settings: ClaudeFlagSettings {
                permissions: Some(permissions),
                ..ClaudeFlagSettings::default()
            },
        })
        .await?;
    Ok(())
}

/// Hands Claude Code the session rule an answer made, once the answer went: the permissions
/// document is resent with the rules in force, `session_rules`, the made rule in place of any with
/// its kind, action and subject. Fails as [`resend_claude_permissions`] does.
pub(crate) async fn keep_claude_session_rule(
    live: &LiveClaudeSession,
    rule: &ProviderAskRule,
    session_rules: &[ProviderAskRule],
    path_rules: PathRules,
) -> Result<(), ClaudePermissionsError> {
    let mut standing: Vec<ProviderAskRule> = session_rules
        .iter()
        .filter(|other| {
            other.kind != rule.kind || other.action != rule.action || other.subject != rule.subject
        })
        .cloned()
        .collect();
    standing.push(rule.clone());
    resend_claude_permissions(live, &standing, path_rules).await
}

/// Writes the project rule an answer made into the local settings of each of the project's
/// working folders, except the session's own file for an allow, which rode the answer for Claude
/// Code to write; a failed write takes the rule back out of the files already written. Fails with
/// the write's failure and any of taking it back.
pub(crate) async fn keep_claude_project_rule(
    rule: &ProviderAskRule,
    folders: &ClaudeProjectRuleFolders<'_>,
    path_rules: PathRules,
) -> Result<(), ClaudePermissionsError> {
    let written_by_answer = (rule.sense == RememberedRuleSense::Allow).then(|| {
        resolve_claude_local_settings_file(folders.own_folder, folders.home_folder, path_rules).path
    });
    write_claude_project_rule(
        folders.project_folders,
        folders.home_folder,
        path_rules,
        rule,
        written_by_answer.as_deref(),
    )
    .await
    .map_err(ClaudePermissionsError::ProjectRuleWrite)
}

/// Takes a revoked project rule out of the local settings of the folder `removal` names, unless a
/// file the daemon never edits keeps it. Fails as the removal fails.
#[expect(
    dead_code,
    reason = "the approvals' revoke takes a project rule out of force through it"
)]
pub(crate) async fn revoke_claude_project_rule(
    rule: &ProviderAskRule,
    removal: &ClaudeProjectRuleRemoval<'_>,
    path_rules: PathRules,
) -> Result<(), ClaudePermissionsError> {
    remove_claude_project_rule(
        std::slice::from_ref(removal.project_folder),
        removal.managed_settings_folder,
        removal.config_folder,
        removal.home_folder,
        path_rules,
        rule,
    )
    .await
    .map_err(ClaudePermissionsError::ProjectRuleRemoval)
}
