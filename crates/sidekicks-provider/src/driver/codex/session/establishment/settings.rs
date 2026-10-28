//! The settings a Codex session's conversation is started and resumed with: its folder, level,
//! profile folders, the commands' environment, its helpers' role files and its tool servers,
//! resolved afresh at every start and resume.

use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_platforms::PathRules;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::exec_relay::compose_codex_command_channel_folder;
use crate::driver::codex::permission_level::CodexProfileFolders;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::establishment::CodexSessionEstablishment;
use crate::driver::codex::session::helper_roles::{
    read_codex_role_file_withheld_fields, write_codex_helper_roles,
};
use crate::driver::codex::thread::settings::CodexThreadSettings;
use crate::driver::codex::transport::diagnostics::CodexTransportDiagnostic;
use crate::driver::contract::DriverError;
use crate::driver::session_control::{
    ResumeSessionParams, SessionToolServer, SubagentDefinition, SubagentPolicy,
};
use crate::spawn_environment::{
    ProviderEnvironmentRequest, SessionEnvironment, build_conversation_command_environment,
};

/// What a start or a resume composes the conversation's settings from.
pub(super) struct CodexSettingsRequest<'params> {
    pub(super) session_id: SessionId,
    pub(super) model: &'params str,
    pub(super) larger_window: Option<SafeInt<1>>,
    pub(super) execution_posture: Option<&'params ExecutionPosture>,
    pub(super) subagent_policy: Option<&'params SubagentPolicy>,
    pub(super) tool_servers: Option<&'params [SessionToolServer]>,
    pub(super) provider_account_id: &'params ProviderAccountId,
}

impl CodexSessionEstablishment {
    /// The settings a session's conversation runs with, resolved afresh at every start and
    /// resume, with its helpers' role files written again. Fails with `CodexError::DriverConfig`
    /// with no posture, since every conversation runs at a level, and as the context, the
    /// credential list, the environment or the role files fail.
    pub(super) async fn compose_thread_settings(
        &self,
        request: CodexSettingsRequest<'_>,
    ) -> Result<CodexThreadSettings, CodexError> {
        let posture = require_execution_posture(request.execution_posture)?;
        let dependencies = &self.dependencies;
        let spawn_contexts = &dependencies.spawn_contexts;
        let context = spawn_contexts
            .require_port()
            .map_err(|error| CodexError::Driver(DriverError::Internal(Box::new(error))))?
            .resolve_spawn_context(request.session_id, request.provider_account_id.clone())
            .await
            .map_err(|cause| CodexError::PortFailed {
                port: spawn_contexts.port_name(),
                cause,
            })?;
        let credential_policy = dependencies
            .execution_postures
            .resolve_credential_policy(posture.credential_policy_ref().as_str())
            .await
            .map_err(|error| config_error("credentialPolicy", "the credential list", error))?;
        // The account's own Codex home is the commands' too.
        let codex_home = context
            .account_folders
            .configuration_folder
            .to_string_lossy()
            .into_owned();
        let credential_homes: Vec<(String, String)> = DESCRIPTOR
            .credential_home_environment_names
            .iter()
            .map(|name| ((*name).to_owned(), codex_home.clone()))
            .collect();
        let command_environment =
            build_conversation_command_environment(&ProviderEnvironmentRequest {
                session: SessionEnvironment {
                    base: &dependencies.base_environment,
                    every_project_rows: &context.every_project_rows,
                    project_rows: &context.project_rows,
                    reserved_names: &dependencies.reserved_names,
                    rules: PathRules::NATIVE,
                },
                descriptor: &DESCRIPTOR,
                deny_env_vars: credential_policy.deny_env_vars,
                credential_homes: &credential_homes,
            })
            .map_err(|error| config_error("environment", "the commands' environment", error))?;
        let definitions = match request.subagent_policy {
            Some(SubagentPolicy::Enabled { definitions, .. }) => definitions.as_slice(),
            Some(SubagentPolicy::Disabled {}) | None => &[],
        };
        let helper_roles = write_codex_helper_roles(
            &dependencies.helper_roles_folder,
            request.session_id,
            definitions,
        )
        .await
        .map_err(CodexError::Driver)?;
        report_withheld_definition_fields(definitions, request.provider_account_id);
        Ok(CodexThreadSettings {
            session_id: request.session_id,
            working_directory: context.working_directory.clone(),
            model: request.model.to_owned(),
            // A resume sends the recorded figure whatever the catalog offers now; Codex refuses
            // one it cannot run, and that failure surfaces like any other.
            model_context_window: request.larger_window.map(SafeInt::get),
            level: posture.permission_level(),
            profile_folders: CodexProfileFolders {
                working_directory: context.working_directory,
                git_common_folder: context.git_common_folder,
                // Codex denies a folder's whole tree and a file alike by its path.
                deny_paths: credential_policy
                    .deny_paths
                    .into_iter()
                    .map(|denied| denied.path)
                    .collect(),
                command_channel_folder: compose_codex_command_channel_folder(
                    &dependencies.command_channel_root,
                    request.session_id,
                ),
            },
            command_environment,
            subagent_policy: request.subagent_policy.cloned(),
            helper_roles,
            tool_servers: request.tool_servers.map(<[_]>::to_vec).unwrap_or_default(),
            // The daemon's spawn context carries no instructions for a conversation.
            base_instructions: None,
        })
    }
}

/// What a resume composes its conversation's settings from.
pub(super) fn compose_resume_settings_request(
    params: &ResumeSessionParams,
) -> CodexSettingsRequest<'_> {
    CodexSettingsRequest {
        session_id: params.session_id,
        model: params.model.as_str(),
        larger_window: params.larger_window,
        execution_posture: params.execution_posture.as_ref(),
        subagent_policy: params.subagent_policy.as_ref(),
        tool_servers: params.tool_servers.as_deref(),
        provider_account_id: &params.provider_account_id,
    }
}

/// The session's posture. Fails with `CodexError::DriverConfig` with none: every conversation
/// runs at a level.
pub(super) fn require_execution_posture(
    posture: Option<&ExecutionPosture>,
) -> Result<ExecutionPosture, CodexError> {
    posture.cloned().ok_or_else(|| CodexError::DriverConfig {
        field: "executionPosture".to_owned(),
        detail: "a Codex conversation always runs at a permission level, so the session needs an \
                 execution posture"
            .to_owned(),
        cause: None,
    })
}

fn config_error(
    field: &str,
    what: &str,
    error: impl std::error::Error + Send + Sync + 'static,
) -> CodexError {
    CodexError::DriverConfig {
        field: field.to_owned(),
        detail: format!("{what} could not be composed"),
        cause: Some(Box::new(error)),
    }
}

// Reports each field of a helper definition its role file cannot carry, so the helper is known
// to run without it.
fn report_withheld_definition_fields(
    definitions: &[SubagentDefinition],
    provider_account_id: &ProviderAccountId,
) {
    for definition in definitions {
        for field in read_codex_role_file_withheld_fields(definition) {
            CodexTransportDiagnostic::SubagentDefinitionFieldWithheld {
                provider_account_id: Some(provider_account_id.clone()),
                definition_name: definition.name.clone(),
                field,
            }
            .report();
        }
    }
}
