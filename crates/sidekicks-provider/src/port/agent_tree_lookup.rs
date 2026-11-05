//! How a driver's hook finds a helper of the session from what a tool call names: its id, its
//! name or its path in its provider's tree, with the state of its newest own run.

use std::error::Error;

use futures::future::BoxFuture;
use sidekicks_contracts::agent::tree::ChildHandle;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::control::StopTrigger;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;

/// One helper of a session's agent tree, as a driver's hook reads it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentTreeHelper {
    /// The handle the daemon minted for the helper.
    pub child_handle: ChildHandle,
    /// The helper's id in its provider.
    pub subagent_id: String,
    /// Its path in its provider's tree, where the provider keeps one.
    pub provider_path: Option<String>,
    /// Its newest own run.
    pub own_run_id: RunId,
    /// That run's state, which is the helper's.
    pub own_run_state: RunState,
    /// The trigger its newest own run's `agent.run.stopped` carries, `None` for a run not stopped
    /// or stopped with none; the deny of a message to a helper the person stopped for good reads
    /// it after a restart.
    pub own_run_stop_trigger: Option<StopTrigger>,
}

/// The session's agent tree, registered through a `PortRegistration`.
pub trait AgentTreeLookup: Send + Sync {
    /// The helper `provider_name` named `subagent_id` in `session_id`, or `None` when the tree
    /// holds none. Fails when the read fails.
    fn helper_by_subagent_id(
        &self,
        session_id: SessionId,
        provider_name: ProviderId,
        subagent_id: String,
    ) -> BoxFuture<'_, Result<Option<AgentTreeHelper>, Box<dyn Error + Send + Sync>>>;

    /// The newest-bound helper of `session_id` its provider named `name`, or `None`. Fails when
    /// the read fails.
    fn helper_by_name(
        &self,
        session_id: SessionId,
        name: String,
    ) -> BoxFuture<'_, Result<Option<AgentTreeHelper>, Box<dyn Error + Send + Sync>>>;

    /// The newest-bound helper of `session_id` at `provider_path` in its provider's tree, or
    /// `None`. Fails when the read fails.
    fn helper_by_provider_path(
        &self,
        session_id: SessionId,
        provider_path: String,
    ) -> BoxFuture<'_, Result<Option<AgentTreeHelper>, Box<dyn Error + Send + Sync>>>;
}
