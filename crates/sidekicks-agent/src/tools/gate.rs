//! How each of the daemon's own agent tools is gated, declared once beside the tool's contract,
//! and the map the approval seam reads those declarations from.

use std::collections::HashMap;

use serde_json::{Map, Value};
use sidekicks_contracts::workflow::definition::document::WorkflowDefinitionId;

use crate::tools::session;

/// How one of the daemon's own agent tools is gated.
#[derive(Clone, Copy, Debug)]
pub enum CallbackToolGate {
    /// It only reads what the calling session may already read.
    Read,
    /// It acts, gated by the session's level alone.
    Level,
    /// It starts the workflow its arguments name, read by `workflow_id_of`, which answers `None`
    /// for arguments that name none.
    WorkflowStart {
        /// Reads the workflow a call's arguments name.
        workflow_id_of: fn(&Map<String, Value>) -> Option<WorkflowDefinitionId>,
    },
}

/// Every agent tool's gate by the tool's name, collected from each tool's own declaration; a tool
/// missing here is refused by the approval seam.
pub fn gates_by_tool() -> HashMap<String, CallbackToolGate> {
    session::TOOLS
        .iter()
        .map(|tool| (tool.description.name.to_owned(), tool.gate))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{CallbackToolGate, gates_by_tool};
    use crate::tools::group::AgentToolGroup;
    use crate::tools::session::{read, send};

    // Every tool the session group lists has its declared gate in the map. Killed by leaving a
    // tool out of the map, which the approval seam then refuses as ungated.
    #[test]
    fn the_gate_map_holds_every_session_tool_with_its_declared_gate() {
        let gates = gates_by_tool();
        let group = AgentToolGroup::session(None);
        assert_eq!(
            group.tools.len(),
            12,
            "the session group lists all twelve tools"
        );
        for tool in group.tools {
            assert!(
                gates.contains_key(tool.description.name),
                "{} has no gate",
                tool.description.name
            );
        }
        assert!(matches!(
            gates.get(read::DESCRIPTION.name),
            Some(CallbackToolGate::Read)
        ));
        assert!(matches!(
            gates.get(send::DESCRIPTION.name),
            Some(CallbackToolGate::Level)
        ));
    }
}
