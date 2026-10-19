//! The run configuration each Codex turn starts from, read from a run's `agentConfig`, which
//! refuses every posture-affecting turn member a caller sets, since the daemon derives them.

use serde::Deserialize;
use serde_json::{Map, Value};
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;

use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::contract::DriverError;
use crate::provider::driver::error_causes::{ProviderAxis, ProviderAxisInvalid};
use crate::provider::driver::run_control::PickedSkill;

/// The `turn/start` members that change a turn's posture, which the daemon derives; a run's
/// `agentConfig` holds no typed policy, so a caller that sets one is refused.
const CALLER_DERIVED_TURN_POSTURE_FIELDS: [&str; 7] = [
    "cwd",
    "sandbox",
    "sandboxPolicy",
    "permissions",
    "permissionProfile",
    "approvalPolicy",
    "approvalsReviewer",
];

/// What one Codex turn starts from: the session, the binding its deliveries go on, the agent whose
/// run it is, the turn's text and staged files, its model and window, and the skills picked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexRunConfig {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The runtime binding the run's deliveries go on.
    pub(crate) binding_id: RuntimeBindingId,
    /// The agent whose run it is.
    pub(crate) agent_id: AgentId,
    /// The turn's text.
    pub(crate) input: String,
    /// The message's staged files, in staging order.
    pub(crate) attachments: Vec<ArtifactId>,
    /// The model the turn runs; `None` keeps the conversation's model and window.
    pub(crate) model: Option<String>,
    /// The larger window chosen for the turn's model, in tokens, sent as recorded when it was
    /// picked; `None` with a model named runs that model's default window.
    pub(crate) model_context_window: Option<SafeInt<1>>,
    /// The client's id for the person's message, when it sent one.
    pub(crate) client_user_message_id: Option<String>,
    /// The skills picked for the message, in the order picked.
    pub(crate) skills: Vec<PickedSkill>,
}

/// Reads a run's `agentConfig` into the turn's run configuration. A posture-affecting turn member
/// the caller set, whatever its value, fails as `DriverError::ProviderAxisInvalid` on the options
/// axis naming the member and its value; any other missing or malformed member fails as
/// `CodexError::DriverConfig` naming it.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the Codex run start reads each run's config with it"
    )
)]
pub(crate) fn parse_codex_run_config(
    agent_config: &Map<String, Value>,
) -> Result<CodexRunConfig, DriverError> {
    // Refused even when the value matches what the daemon derives; no comparison needed.
    for field in CALLER_DERIVED_TURN_POSTURE_FIELDS {
        if let Some(value) = agent_config.get(field) {
            return Err(DriverError::ProviderAxisInvalid(ProviderAxisInvalid {
                axis: ProviderAxis::Options,
                value: Value::Object(Map::from_iter([(field.to_owned(), value.clone())])),
            }));
        }
    }
    Ok(CodexRunConfig {
        session_id: read_required(agent_config, "sessionId")?,
        binding_id: read_required(agent_config, "bindingId")?,
        agent_id: read_required(agent_config, "agentId")?,
        input: read_required_text(agent_config, "input")?,
        attachments: read_optional(agent_config, "attachments")?.unwrap_or_default(),
        model: read_optional_text(agent_config, "model")?,
        model_context_window: read_optional(agent_config, "largerWindow")?,
        client_user_message_id: read_optional_text(agent_config, "clientUserMessageId")?,
        skills: read_optional(agent_config, "skills")?.unwrap_or_default(),
    })
}

// The member `key` read as `T`; absent or unreadable fails naming it.
fn read_required<'config, T: Deserialize<'config>>(
    agent_config: &'config Map<String, Value>,
    key: &str,
) -> Result<T, DriverError> {
    read_optional(agent_config, key)?.ok_or_else(|| config_error(key, "it is missing", None))
}

// The member `key` read as `T`, or `None` when absent; present but unreadable, `null` included,
// fails naming it.
fn read_optional<'config, T: Deserialize<'config>>(
    agent_config: &'config Map<String, Value>,
    key: &str,
) -> Result<Option<T>, DriverError> {
    agent_config
        .get(key)
        .map(|value| {
            T::deserialize(value)
                .map_err(|error| config_error(key, "it does not read as its type", Some(error)))
        })
        .transpose()
}

// A required member that must be non-empty text.
fn read_required_text(agent_config: &Map<String, Value>, key: &str) -> Result<String, DriverError> {
    read_optional_text(agent_config, key)?.ok_or_else(|| config_error(key, "it is missing", None))
}

// An optional member that, when present, must be non-empty text.
fn read_optional_text(
    agent_config: &Map<String, Value>,
    key: &str,
) -> Result<Option<String>, DriverError> {
    let text: Option<String> = read_optional(agent_config, key)?;
    if text.as_deref() == Some("") {
        return Err(config_error(key, "it is empty", None));
    }
    Ok(text)
}

// The configuration failure for the member `key`.
fn config_error(key: &str, detail: &str, cause: Option<serde_json::Error>) -> DriverError {
    DriverError::from(CodexError::DriverConfig {
        field: format!("StartRunParams.agentConfig.{key}"),
        detail: detail.to_owned(),
        cause: cause.map(Into::into),
    })
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::{Map, Value, json};

    use super::parse_codex_run_config;
    use crate::provider::driver::contract::DriverError;
    use crate::provider::driver::error_causes::ProviderAxis;

    fn run_config() -> Map<String, Value> {
        serde_json::from_value(json!({
            "sessionId": "0190f3a2-7b4c-7d1e-8f00-000000000001",
            "bindingId": "binding-1",
            "agentId": "0190f3a2-7b4c-7d1e-8f00-000000000002",
            "input": "Fix the build.",
        }))
        .expect("the literal is an object")
    }

    #[rstest]
    #[case::cwd("cwd", json!("/tmp"))]
    #[case::sandbox("sandbox", json!("danger-full-access"))]
    #[case::sandbox_policy("sandboxPolicy", json!({"type": "dangerFullAccess"}))]
    #[case::permissions("permissions", json!({}))]
    #[case::permission_profile("permissionProfile", json!(null))]
    #[case::approval_policy("approvalPolicy", json!("never"))]
    #[case::approvals_reviewer("approvalsReviewer", json!("user"))]
    fn a_posture_member_the_caller_sets_is_refused(#[case] field: &str, #[case] value: Value) {
        assert!(parse_codex_run_config(&run_config()).is_ok());
        let mut config = run_config();
        config.insert(field.to_owned(), value.clone());

        let Err(DriverError::ProviderAxisInvalid(refusal)) = parse_codex_run_config(&config) else {
            panic!("a caller-set {field} is refused on the options axis");
        };
        assert_eq!(refusal.axis, ProviderAxis::Options);
        assert_eq!(
            refusal.value,
            Value::Object(Map::from_iter([(field.to_owned(), value)]))
        );
    }
}
