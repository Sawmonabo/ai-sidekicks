//! A run's graph: each node of the pinned version in visiting order, with its main input slots and,
//! for each main output, the slots it feeds. Tool edges are left out, since a node wired into a
//! `tool` input runs only when its agent calls it.

use std::collections::HashMap;

use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_contracts::workflow::definition::document::{
    WorkflowEdge, WorkflowNode, WorkflowNodeId,
};
use sidekicks_contracts::workflow::definition::handle::{
    WorkflowHandleType, parse_workflow_handle,
};
use sidekicks_contracts::workflow::kind::WorkflowOutputHandleSpec;

use crate::kinds::NodeKindTable;

/// Why a run's graph could not be built from its pinned version.
#[derive(Debug, thiserror::Error)]
pub(crate) enum RunGraphError {
    /// The table no longer lists the node's kind at the version the node records.
    #[error("the kind of node {} is not listed at its version", .node_id.as_str())]
    UnknownKind {
        /// The node.
        node_id: WorkflowNodeId,
    },
    /// An edge names a main handle the node's kind does not declare.
    #[error("node {} declares no handle {}", .node_id.as_str(), .handle.as_str())]
    UndeclaredHandle {
        /// The node the handle stands on.
        node_id: WorkflowNodeId,
        /// The handle as the edge names it.
        handle: NonEmptyText,
    },
}

/// One slot a main output feeds: the target node's place in the graph and its slot.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct SlotTarget {
    /// The target node's place, which is its visiting rank.
    pub(crate) node: usize,
    /// The target's main input slot.
    pub(crate) slot: usize,
}

/// One main input slot of a node: slot k is the input whose id is `inputs/main/k`.
pub(crate) struct InputSlot {
    /// The input's position among the kind's inputs, tool inputs included.
    #[cfg_attr(
        test,
        expect(
            dead_code,
            reason = "the ready step's input lists, built in spec order"
        )
    )]
    pub(crate) spec_position: usize,
    /// Whether any main edge enters the slot; an unwired slot reads as settled empty.
    pub(crate) is_wired: bool,
}

/// One node of a run's graph.
pub(crate) struct RunGraphNode {
    /// The node.
    pub(crate) id: WorkflowNodeId,
    /// Whether the node is switched off, so its rounds are skipped and pass their first input on.
    pub(crate) is_disabled: bool,
    /// Its main input slots, slot k at index k.
    pub(crate) slots: Vec<InputSlot>,
    /// For each main output, the error output last where the node has one, the slots it feeds,
    /// sorted by the target's place and then by slot.
    pub(crate) outputs: Vec<Vec<SlotTarget>>,
}

/// A run's graph: its nodes sorted by `(order, id)`, so a node's place is its visiting rank and no
/// hash order reaches the walk.
pub(crate) struct RunGraph {
    /// The nodes in visiting order.
    nodes: Vec<RunGraphNode>,
    /// The trigger's place.
    trigger: usize,
}

impl RunGraph {
    /// The graph of a pinned version's `nodes`, `trigger` among them, and `edges`, with each node's
    /// handles read from `kinds`. Fails with [`RunGraphError::UnknownKind`] when the table no
    /// longer lists a node's kind at its version, and with [`RunGraphError::UndeclaredHandle`]
    /// when a main edge names a handle its node's kind does not declare.
    pub(crate) fn new(
        nodes: &HashMap<WorkflowNodeId, WorkflowNode>,
        trigger: &WorkflowNodeId,
        edges: &[WorkflowEdge],
        kinds: &NodeKindTable,
    ) -> Result<Self, RunGraphError> {
        let mut sorted: Vec<&WorkflowNode> = nodes.values().collect();
        sorted.sort_by(|left, right| (left.order, &left.id).cmp(&(right.order, &right.id)));
        let places: HashMap<&WorkflowNodeId, usize> = sorted
            .iter()
            .enumerate()
            .map(|(place, node)| (&node.id, place))
            .collect();
        let mut input_ids = Vec::with_capacity(sorted.len());
        let mut output_ids = Vec::with_capacity(sorted.len());
        let mut graph_nodes = Vec::with_capacity(sorted.len());
        for node in &sorted {
            let rules = kinds
                .kind_rules(node)
                .ok_or_else(|| RunGraphError::UnknownKind {
                    node_id: node.id.clone(),
                })?;
            let mut main_inputs: Vec<(u64, usize, String)> = rules
                .handles
                .inputs
                .iter()
                .enumerate()
                .filter(|(_, input)| !input.is_tool())
                .map(|(position, input)| {
                    let id = input.id_text();
                    (parse_workflow_handle(&id).index.get(), position, id)
                })
                .collect();
            main_inputs.sort_unstable();
            let main_outputs: Vec<String> = rules
                .handles
                .outputs
                .iter()
                .filter(|output| !output.is_tool())
                .map(WorkflowOutputHandleSpec::id_text)
                .collect();
            graph_nodes.push(RunGraphNode {
                id: node.id.clone(),
                is_disabled: node.disabled == Some(true),
                slots: main_inputs
                    .iter()
                    .map(|&(_, spec_position, _)| InputSlot {
                        spec_position,
                        is_wired: false,
                    })
                    .collect(),
                outputs: vec![Vec::new(); main_outputs.len()],
            });
            input_ids.push(
                main_inputs
                    .into_iter()
                    .map(|(_, _, id)| id)
                    .collect::<Vec<_>>(),
            );
            output_ids.push(main_outputs);
        }
        for edge in edges {
            let is_tool = |handle: &NonEmptyText| {
                parse_workflow_handle(handle.as_str()).handle_type == WorkflowHandleType::Tool
            };
            if is_tool(&edge.source_handle) || is_tool(&edge.target_handle) {
                continue;
            }
            let place_of = |node_id: &WorkflowNodeId| {
                *places
                    .get(node_id)
                    .expect("the save refuses an edge to a node the version does not hold")
            };
            let source = place_of(&edge.source);
            let target = place_of(&edge.target);
            let output = declared_index(&output_ids[source], &edge.source, &edge.source_handle)?;
            let slot = declared_index(&input_ids[target], &edge.target, &edge.target_handle)?;
            graph_nodes[source].outputs[output].push(SlotTarget { node: target, slot });
            graph_nodes[target].slots[slot].is_wired = true;
        }
        for node in &mut graph_nodes {
            for targets in &mut node.outputs {
                targets.sort_unstable();
            }
        }
        Ok(Self {
            nodes: graph_nodes,
            trigger: *places
                .get(trigger)
                .expect("a run's trigger is a node of its pinned version"),
        })
    }

    /// The node at `place`.
    pub(crate) fn node(&self, place: usize) -> &RunGraphNode {
        &self.nodes[place]
    }

    /// How many nodes the graph holds; their places run from 0 below it.
    pub(crate) fn node_count(&self) -> usize {
        self.nodes.len()
    }

    /// The trigger's place.
    pub(crate) fn trigger(&self) -> usize {
        self.trigger
    }
}

/// Where `handle` sits among a node's declared main handle ids on its side, or
/// [`RunGraphError::UndeclaredHandle`] when the kind does not declare it there.
fn declared_index(
    declared: &[String],
    node_id: &WorkflowNodeId,
    handle: &NonEmptyText,
) -> Result<usize, RunGraphError> {
    declared
        .iter()
        .position(|id| id == handle.as_str())
        .ok_or_else(|| RunGraphError::UndeclaredHandle {
            node_id: node_id.clone(),
            handle: handle.clone(),
        })
}
