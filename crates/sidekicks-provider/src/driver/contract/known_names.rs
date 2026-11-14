//! Every name a session knows on its provider, which a seed crossing to another provider is cleaned
//! of: the provider's commands, skills and prompts, and the agents the session offers.

use sidekicks_contracts::provider::driver::commands::{
    ProviderCommandBinding, ProviderCommandEntry,
};
use sidekicks_contracts::session::id::SessionId;

use crate::driver::session_control::SubagentDefinition;

/// Params of `list_known_names` (gated on `providerCommands`): the session, the driver and account
/// it runs on, and the helpers its spawn hands its provider, so a resting read offers the agents a
/// live session would.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KnownNamesParams {
    /// The session.
    pub session_id: SessionId,
    /// The driver and account the session runs on, which each entry carries.
    pub binding: ProviderCommandBinding,
    /// The helper definitions the session's spawn hands its provider.
    pub subagent_definitions: Vec<SubagentDefinition>,
}

/// One agent a session offers on its provider, by the name the lead hands work to it by.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderAgent {
    /// The name.
    pub name: String,
    /// When the lead should hand work to it, where the provider gives a description.
    pub description: Option<String>,
}

/// Every name a session knows on its provider: the entries its command list holds and the agents
/// it offers, each in the provider's order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderKnownNames {
    /// The commands, skills and prompts.
    pub entries: Vec<ProviderCommandEntry>,
    /// The agents.
    pub agents: Vec<ProviderAgent>,
}
