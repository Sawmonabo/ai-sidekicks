//! The typed causes a driver error carries where a client reads more than a code: a provider
//! command that names no runnable build, a model catalog that cannot be read, and a provider axis
//! set to a value the provider does not offer.

use std::io;

use serde_json::Value;
use sidekicks_contracts::provider::id::ProviderId;

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
/// an id listed twice or a page cursor repeated. The catalog is refused, never kept short.
#[derive(Debug, thiserror::Error)]
#[error("the provider's {reply_name} reply could not be read: {detail}")]
pub(crate) struct ModelCatalogUnreadable {
    /// The provider.
    pub(crate) provider: ProviderId,
    /// The provider's name for the reply, as its wire spells it.
    pub(crate) reply_name: &'static str,
    /// What in the reply could not be read, naming the row or the cursor.
    pub(crate) detail: String,
}

/// A provider axis a session's request set to a value the provider does not offer now. The
/// handler that checks the axis knows the agent and names it in the refusal it answers with.
#[derive(Debug, thiserror::Error)]
#[error("the provider does not offer {value} on its {axis} axis")]
pub(crate) struct ProviderAxisInvalid {
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
