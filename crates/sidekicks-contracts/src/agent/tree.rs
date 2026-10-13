//! The session's agent tree: how the daemon's index names each agent in a session, an agent with
//! an id or a provider's own helper by its run and handle. Spend and tree positions key on it.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::agent::definition::AgentId;
use crate::provider::driver::methods::DRIVER_WIRE_HANDLE_MAX_LEN;
use crate::run::id::RunId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::text::branded_text;

branded_text! {
    /// The daemon-minted handle of a provider's own helper inside its parent's run: opaque, and
    /// resolved only by the daemon's parent-to-child index that minted it.
    pub struct ChildHandle(1..=DRIVER_WIRE_HANDLE_MAX_LEN);
}

/// One agent in the session's tree as the daemon's index names it: an agent with an id (the lead,
/// or one a bridge `run` started), or a provider's own helper by the run it runs in and its
/// handle.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AgentTreeMember {
    /// An agent with an id.
    Agent {
        /// The agent.
        agent_id: AgentId,
    },
    /// A provider's own helper.
    ProviderChild {
        /// The run it runs in.
        run_id: RunId,
        /// Its handle.
        child_handle: ChildHandle,
    },
}

/// The TypeScript module of the agent tree.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "agent/tree",
    doc: "The session's agent tree: how the daemon's index names each agent in a session.",
    definitions: &[
        Definition::read::<ChildHandle>().checked(),
        Definition::read::<AgentTreeMember>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};
