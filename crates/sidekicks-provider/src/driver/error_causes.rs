//! The typed causes a driver error carries where its caller acts on more than a code: a provider
//! command that names no runnable build, a request the provider got with no answer back, a model
//! catalog that cannot be read, and a provider axis set to a value the provider does not offer;
//! the refusals every driver answers a provider's own failure, a refused side question and a run
//! on a session whose process is not running with.

use std::error::Error;
use std::io;
use std::sync::LazyLock;

use serde_json::{Value, json};
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::failure_cause::RunFailureCause;
use sidekicks_contracts::session::controls::methods::SideQuestionId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_std::error_description::describe_error;

#[cfg(any(test, feature = "test-support"))]
use crate::driver::contract::DriverError;
use crate::driver::contract::bound_failure_detail;

/// Stands in for a provider failure whose words are blank once bounded.
pub(crate) static UNSPECIFIED_PROVIDER_FAILURE_DETAIL: LazyLock<
    FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>,
> = LazyLock::new(|| {
    FreeFormText::new("The provider reported a failure with no diagnostic message.".to_owned())
        .expect("the fallback is non-blank and within the cap")
});

/// A provider failure's refusal with `code` and `message`: the provider and the failure's words,
/// bounded as `providerFailureDetail`, as its fields, and the failure kept as its source.
pub(crate) fn provider_failure_refusal(
    provider: &ProviderId,
    message: &str,
    code: RefusalCode,
    error: impl Error + Send + Sync + 'static,
) -> DomainError {
    let provider_failure_detail = bound_failure_detail(
        &describe_error(&error),
        UNSPECIFIED_PROVIDER_FAILURE_DETAIL.clone(),
    );
    DomainError::new(message, code)
        .with_detail(json!({
            "providerId": provider.as_str(),
            "providerFailureDetail": provider_failure_detail.as_str(),
        }))
        .with_source(error)
}

/// The refusal of a run on a session whose provider process is down, or did not come back within
/// the bound its caller set: `provider.unavailable`, which a later send may clear.
pub fn session_process_unavailable(session_id: SessionId) -> DomainError {
    DomainError::new(
        "The session's provider process is not running",
        RefusalCode::ProviderUnavailable,
    )
    .with_detail(json!({ "sessionId": session_id }))
}

/// The refusal of a side question the model refused: `session.sideQuestion.refused`, naming the
/// session and the question, with the refusal as the driver read it as `cause`.
pub(crate) fn side_question_refusal(
    session_id: SessionId,
    side_question_id: SideQuestionId,
    cause: &RunFailureCause,
) -> DomainError {
    DomainError::new(
        "The model refused the side question",
        RefusalCode::SessionSideQuestionRefused,
    )
    .with_detail(json!({
        "sessionId": session_id,
        "sideQuestionId": side_question_id,
        "cause": cause,
    }))
}

/// The configured provider command names no runnable build, or one whose real path cannot be
/// read. It carries the command as the person configured it, never a path they did not type.
#[derive(Debug, thiserror::Error)]
#[error("the provider command {requested_command:?} names no runnable build")]
pub struct ExecutableUnresolvable {
    /// The provider.
    pub provider: ProviderId,
    /// The command as configured: a bare name or a path.
    pub requested_command: String,
    /// Whether the system reads the command as a path the person typed, rather than a bare name
    /// searched for.
    pub is_typed_path: bool,
    /// Whether a build the command names was found, one that then could not be resolved or
    /// started.
    pub is_build_found: bool,
    /// Why it resolves to no build: none was found, or its real path could not be read.
    #[source]
    pub cause: io::Error,
}

/// The provider's model catalog reply could not be read whole: no list, an entry it cannot name,
/// an id listed twice, a page cursor repeated, or more pages or rows than a catalog holds. The
/// catalog is refused, never kept short.
#[derive(Debug, thiserror::Error)]
#[error("the provider's {reply_name} reply could not be read: {}", .detail.as_str())]
pub struct ModelCatalogUnreadable {
    /// The provider.
    pub(crate) provider: ProviderId,
    /// The provider's name for the reply, as its wire spells it.
    pub(crate) reply_name: &'static str,
    /// What in the reply could not be read, naming the row, the cursor or the counts, bounded as
    /// a provider failure's detail.
    pub(crate) detail: FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>,
}

/// A provider axis an agent's request set to a value the provider does not offer now, naming the
/// agent the refusal answers for.
#[derive(Debug, thiserror::Error)]
#[error("the provider does not offer {value} on its {axis} axis")]
pub struct ProviderAxisInvalid {
    /// The agent whose binding set the axis.
    pub(crate) agent_id: AgentId,
    /// The request's member the value was set on.
    pub(crate) axis: ProviderAxis,
    /// The value as the request set it.
    pub(crate) value: Value,
}

impl ProviderAxisInvalid {
    /// The refusal of a binding that names `provider`, which no registered driver answers, for
    /// the agent `agent_id`.
    pub fn provider_not_registered(agent_id: AgentId, provider: &ProviderId) -> Self {
        Self {
            agent_id,
            axis: ProviderAxis::ProviderName,
            value: json!(provider.as_str()),
        }
    }
}

/// The request members that set a provider axis, named as the request names them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, strum::Display, strum::IntoStaticStr)]
#[strum(serialize_all = "camelCase")]
pub(crate) enum ProviderAxis {
    /// The provider.
    ProviderName,
    /// The model.
    ModelId,
    /// The model's larger context window.
    #[expect(
        dead_code,
        reason = "the binding checks of an agent's provider switch and a session's create name it"
    )]
    LargerWindow,
    /// The reasoning effort.
    #[expect(
        dead_code,
        reason = "the binding checks of an agent's provider switch and a session's create name it"
    )]
    Effort,
    /// The output speed.
    #[expect(
        dead_code,
        reason = "the binding checks of an agent's provider switch and a session's create name it"
    )]
    OutputSpeed,
    /// A session option.
    #[expect(
        dead_code,
        reason = "the binding checks of an agent's provider switch and a session's create name it"
    )]
    Options,
}

impl ExecutableUnresolvable {
    /// Whether the provider is not installed: a bare command name no search found, as against a
    /// typed path that does not run or a build found that the system cannot resolve or start.
    pub fn is_not_installed(&self) -> bool {
        !self.is_typed_path && !self.is_build_found && self.cause.kind() == io::ErrorKind::NotFound
    }

    /// The refusal a call answers with, naming the command as configured:
    /// `provider.commandPath.notRunnable` for a typed path, else `provider.unavailable`.
    pub(crate) fn into_refusal(self) -> DomainError {
        let refusal = if self.is_typed_path {
            DomainError::new(
                "Nothing runnable sits at the command path the person typed",
                RefusalCode::ProviderCommandPathNotRunnable,
            )
        } else {
            DomainError::new(
                "The provider's command names no runnable build",
                RefusalCode::ProviderUnavailable,
            )
        };
        refusal
            .with_detail(json!({
                "providerId": self.provider.as_str(),
                "requestedCommand": self.requested_command.as_str(),
            }))
            .with_source(self)
    }
}

/// The request went out to the provider and no answer came back: its deadline passed or the link
/// broke first, so the provider may still act on it. Only the driver knows the request was
/// written; a caller holding what the request carried keeps it until the provider's own record
/// says what became of it, and never sends it again blind.
#[derive(Debug, thiserror::Error)]
#[error("the provider got the request and no answer came")]
pub struct RequestUnanswered {
    /// The refusal the call answers with, `provider.timeout` or `provider.unavailable`.
    #[source]
    pub refusal: DomainError,
}

/// The driver's answer when the request went out and no answer came, as tests hand it back.
#[cfg(any(test, feature = "test-support"))]
pub fn unanswered() -> DriverError {
    DriverError::Unanswered(RequestUnanswered {
        refusal: DomainError::new("the provider did not answer", RefusalCode::ProviderTimeout),
    })
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};
    use sidekicks_contracts::agent::definition::AgentId;
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_ipc::registry::HandlerError;

    use super::{ProviderAxis, ProviderAxisInvalid};
    use crate::driver::contract::DriverError;

    #[test]
    fn an_axis_refusal_names_the_agent_the_axis_and_the_value() {
        let agent_id = AgentId::new("0190f3a2-7b4c-7d1e-8f00-000000000002").expect("an agent id");
        let refusal = HandlerError::from(DriverError::ProviderAxisInvalid(ProviderAxisInvalid {
            agent_id,
            axis: ProviderAxis::ModelId,
            value: json!("gpt-retired"),
        }));

        let HandlerError::Refused(refusal) = refusal else {
            panic!("an axis the provider does not offer is refused: {refusal:?}");
        };
        assert_eq!(refusal.code, RefusalCode::AgentProviderAxisInvalid);
        assert_eq!(
            refusal.detail.map(Value::Object),
            Some(json!({
                "agentId": "0190f3a2-7b4c-7d1e-8f00-000000000002",
                "axis": "modelId",
                "value": "gpt-retired",
            }))
        );
    }
}
