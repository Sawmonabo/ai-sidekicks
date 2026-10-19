//! The typed causes a driver error carries where a client reads more than a code: a provider
//! command that names no runnable build, a model catalog that cannot be read, and a provider axis
//! set to a value the provider does not offer.

use std::io;

use serde_json::Value;
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::wire::text::FreeFormText;

/// The configured provider command names no runnable build, or one whose real path cannot be
/// read. It carries the command as the person configured it, never a path they did not type.
#[derive(Debug, thiserror::Error)]
#[error("the provider command {requested_command:?} names no runnable build")]
pub(crate) struct ExecutableUnresolvable {
    /// The provider.
    pub(crate) provider: ProviderId,
    /// The command as configured: a bare name or a path.
    pub(crate) requested_command: String,
    /// Why it resolves to no build: none was found, or its real path could not be read.
    #[source]
    pub(crate) cause: io::Error,
}

/// The provider's model catalog reply could not be read whole: no list, an entry it cannot name,
/// an id listed twice, a page cursor repeated, or more pages or rows than a catalog holds. The
/// catalog is refused, never kept short.
#[derive(Debug, thiserror::Error)]
#[error("the provider's {reply_name} reply could not be read: {}", .detail.as_str())]
pub(crate) struct ModelCatalogUnreadable {
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
pub(crate) struct ProviderAxisInvalid {
    /// The agent whose binding set the axis.
    pub(crate) agent_id: AgentId,
    /// The request's member the value was set on.
    pub(crate) axis: ProviderAxis,
    /// The value as the request set it.
    pub(crate) value: Value,
}

/// The request members that set a provider axis, named as the request names them.
#[expect(
    dead_code,
    reason = "the session start's axis checks name the provider, model, window, effort and speed"
)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, strum::Display, strum::IntoStaticStr)]
#[strum(serialize_all = "camelCase")]
pub(crate) enum ProviderAxis {
    /// The provider.
    ProviderName,
    /// The model.
    ModelId,
    /// The model's larger context window.
    LargerWindow,
    /// The reasoning effort.
    Effort,
    /// The output speed.
    OutputSpeed,
    /// A session option.
    Options,
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};
    use sidekicks_contracts::agent::definition::AgentId;
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;

    use super::{ProviderAxis, ProviderAxisInvalid};
    use crate::ipc::registry::HandlerError;
    use crate::provider::driver::contract::DriverError;

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
