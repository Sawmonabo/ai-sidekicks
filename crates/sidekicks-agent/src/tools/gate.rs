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
    use crate::tools::session::{list, options, read, search};

    // Every tool the session group lists has its gate in the map: the four reading tools `Read`,
    // every other `Level`. Killed by leaving a tool out of the map, which the approval seam then
    // refuses as ungated, or by flipping an acting tool to `Read`, which allows it with no level
    // check.
    #[test]
    fn the_gate_map_reads_the_four_reading_tools_and_levels_every_other() {
        let gates = gates_by_tool();
        let group = AgentToolGroup::session(None);
        assert_eq!(
            group.tools.len(),
            12,
            "the session group lists all twelve tools"
        );
        let reading = [
            list::DESCRIPTION.name,
            search::DESCRIPTION.name,
            options::DESCRIPTION.name,
            read::DESCRIPTION.name,
        ];
        for tool in group.tools {
            let name = tool.description.name;
            let gate = gates.get(name);
            if reading.contains(&name) {
                assert!(matches!(gate, Some(CallbackToolGate::Read)), "{name} reads");
            } else {
                assert!(matches!(gate, Some(CallbackToolGate::Level)), "{name} acts");
            }
        }
    }
}
