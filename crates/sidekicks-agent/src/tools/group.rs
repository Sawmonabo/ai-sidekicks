//! The groups the daemon's own agent tools ride in: which tools each holds, whether a provider
//! loads them up front or defers them, and which of their calls a cancel can stop. The server
//! sends `notifications/tools/list_changed` when a session's groups change; this module only says
//! which loadings changed.

use crate::tools::gate::CallbackToolGate;
use crate::tools::session::{self, ToolDescription, ask, remind, send, start, wait};

/// One of the daemon's own agent tools: what the model reads about it and how it is gated.
#[derive(Clone, Copy, Debug)]
pub struct AgentTool {
    /// The tool's name and description.
    pub description: ToolDescription,
    /// How a call to it is gated.
    pub gate: CallbackToolGate,
}

/// When a provider loads a group's tools.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolGroupLoading {
    /// In the model's tool listing from the start.
    UpFront,
    /// Held back until the model searches for them.
    Deferred,
}

/// The session tools whose calls wait on another session, so a cancel stops them.
const CANCELABLE_SESSION_TOOLS: &[&str] = &[
    send::DESCRIPTION.name,
    start::DESCRIPTION.name,
    ask::DESCRIPTION.name,
    wait::DESCRIPTION.name,
];

/// A group of agent tools a session is offered together.
#[derive(Clone, Debug)]
pub struct AgentToolGroup {
    /// The group's tools, in listing order.
    pub tools: Vec<AgentTool>,
    /// When the provider loads them.
    pub loading: ToolGroupLoading,
    /// The names of the tools whose calls a cancel can stop.
    cancelable: &'static [&'static str],
}

impl AgentToolGroup {
    /// The session tools, loaded up front. `own_wake_up_tool` is the provider's own tool for
    /// waking itself later, as its descriptor names it; a provider with one is not offered
    /// `session_remind`.
    pub fn session(own_wake_up_tool: Option<&str>) -> Self {
        let tools = session::TOOLS
            .into_iter()
            .filter(|tool| {
                own_wake_up_tool.is_none() || tool.description.name != remind::DESCRIPTION.name
            })
            .collect();
        Self {
            tools,
            loading: ToolGroupLoading::UpFront,
            cancelable: CANCELABLE_SESSION_TOOLS,
        }
    }

    /// Whether a cancel can stop a call to `tool_name`.
    pub fn can_cancel(&self, tool_name: &str) -> bool {
        self.cancelable.contains(&tool_name)
    }
}

/// The loadings whose tool listing differs between a session's groups `before` and `after`, each
/// once; an empty answer means the provider needs no `notifications/tools/list_changed`.
pub fn changed_loadings(
    before: &[AgentToolGroup],
    after: &[AgentToolGroup],
) -> Vec<ToolGroupLoading> {
    [ToolGroupLoading::UpFront, ToolGroupLoading::Deferred]
        .into_iter()
        .filter(|&loading| tool_names(before, loading).ne(tool_names(after, loading)))
        .collect()
}

// The names of the tools `groups` list under `loading`, in listing order.
fn tool_names(
    groups: &[AgentToolGroup],
    loading: ToolGroupLoading,
) -> impl Iterator<Item = &'static str> {
    groups
        .iter()
        .filter(move |group| group.loading == loading)
        .flat_map(|group| group.tools.iter().map(|tool| tool.description.name))
}
