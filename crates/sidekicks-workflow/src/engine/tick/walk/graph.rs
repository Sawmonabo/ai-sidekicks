//! A run's graph: each node of the pinned version in visiting order, with its main input slots and,
//! for each main output, the slots it feeds. Tool edges are left out, since a node wired into a
//! `tool` input runs only when its agent calls it.

use std::collections::HashMap;

use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_contracts::workflow::definition::document::{
    WorkflowEdge, WorkflowNode, WorkflowNodeId,
};
use sidekicks_contracts::workflow::definition::handle::{
    WorkflowHandleMode, WorkflowHandleType, parse_workflow_handle,
};
use sidekicks_contracts::workflow::definition::refusals::WorkflowNodeHandles;

use crate::kinds::NodeKindTable;

/// Why a run's graph could not be built from its pinned version.
#[derive(Debug, thiserror::Error)]
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
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
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct SlotTarget {
    /// The target node's place, which is its visiting rank.
    pub(crate) node: usize,
    /// The target's main input slot.
    pub(crate) slot: usize,
}

/// One main input slot of a node: slot k is the input whose id is `inputs/main/k`.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct InputSlot {
    /// The input's position among the kind's inputs, tool inputs included.
    pub(crate) spec_position: usize,
    /// The places of the nodes whose main outputs feed the slot, lowest first, each once; an
    /// unwired slot has none and reads as settled empty.
    pub(crate) feeders: Vec<usize>,
}

/// One node of a run's graph.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct RunGraphNode {
    /// The node.
    pub(crate) id: WorkflowNodeId,
    /// Whether the node is switched off, so its rounds are skipped and pass their first input on.
    pub(crate) is_disabled: bool,
    /// Whether the node's step runs on the first main input that settles with items, the branches
    /// feeding its other inputs canceled; never for a disabled node, whose rounds wait for every
    /// input.
    pub(crate) readies_on_first_input: bool,
    /// How many inputs the kind's spec lists, tool inputs included.
    pub(crate) input_count: usize,
    /// Its main input slots, slot k at index k.
    pub(crate) slots: Vec<InputSlot>,
    /// For each main output, the error output last where the node has one, the slots it feeds,
    /// sorted by the target's place and then by slot.
    pub(crate) outputs: Vec<Vec<SlotTarget>>,
}

/// A run's graph: its nodes sorted by `(order, id)`, so a node's place is its visiting rank and no
/// hash order reaches the walk.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct RunGraph {
    /// The nodes in visiting order.
    nodes: Vec<RunGraphNode>,
    /// Each node's place by its id.
    places: HashMap<WorkflowNodeId, usize>,
    /// The trigger's place.
    trigger: usize,
    /// Each node's ancestors along forward main edges, by place, lowest first.
    ancestors: Vec<Vec<usize>>,
}

impl RunGraph {
    /// The graph of a pinned version's `nodes`, `trigger` among them, and `edges`, with each node's
    /// handles read from `kinds`. Fails with [`RunGraphError::UnknownKind`] when the table no
    /// longer lists a node's kind at its version, and with [`RunGraphError::UndeclaredHandle`]
    /// when a main edge names a handle its node's kind does not declare.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) fn new(
        nodes: &HashMap<WorkflowNodeId, WorkflowNode>,
        trigger: &WorkflowNodeId,
        edges: &[WorkflowEdge],
        kinds: &NodeKindTable,
    ) -> Result<Self, RunGraphError> {
        let mut sorted: Vec<&WorkflowNode> = nodes.values().collect();
        sorted.sort_by(|left, right| (left.order, &left.id).cmp(&(right.order, &right.id)));
        let places: HashMap<WorkflowNodeId, usize> = sorted
            .iter()
            .enumerate()
            .map(|(place, node)| (node.id.clone(), place))
            .collect();
        let mut node_handles: Vec<WorkflowNodeHandles> = Vec::with_capacity(sorted.len());
        let mut graph_nodes = Vec::with_capacity(sorted.len());
        for node in &sorted {
            let rules = kinds
                .kind_rules(node)
                .ok_or_else(|| RunGraphError::UnknownKind {
                    node_id: node.id.clone(),
                })?;
            let mut main_inputs: Vec<(u64, usize)> = rules
                .handles
                .inputs
                .iter()
                .enumerate()
                .filter(|(_, input)| !input.is_tool())
                .map(|(position, input)| {
                    (
                        parse_workflow_handle(&input.id_text()).index.get(),
                        position,
                    )
                })
                .collect();
            main_inputs.sort_unstable();
            let main_output_count = rules
                .handles
                .outputs
                .iter()
                .filter(|output| !output.is_tool())
                .count();
            let is_disabled = node.disabled == Some(true);
            graph_nodes.push(RunGraphNode {
                id: node.id.clone(),
                is_disabled,
                readies_on_first_input: !is_disabled
                    && kinds
                        .kind_of(node)
                        .is_some_and(|kind| kind.executor.readies_on_first_input(node)),
                input_count: rules.handles.inputs.len(),
                slots: main_inputs
                    .iter()
                    .map(|&(_, spec_position)| InputSlot {
                        spec_position,
                        feeders: Vec::new(),
                    })
                    .collect(),
                outputs: vec![Vec::new(); main_output_count],
            });
            node_handles.push(rules.handles);
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
            let source_outputs = &node_handles[source].outputs;
            let output = node_handles[source]
                .declared_position(edge.source_handle.as_str(), WorkflowHandleMode::Outputs)
                .map(|position| {
                    source_outputs[..position]
                        .iter()
                        .filter(|output| !output.is_tool())
                        .count()
                })
                .ok_or_else(|| undeclared_handle(&edge.source, &edge.source_handle))?;
            let slot = node_handles[target]
                .declared_position(edge.target_handle.as_str(), WorkflowHandleMode::Inputs)
                .and_then(|position| {
                    graph_nodes[target]
                        .slots
                        .iter()
                        .position(|slot| slot.spec_position == position)
                })
                .ok_or_else(|| undeclared_handle(&edge.target, &edge.target_handle))?;
            graph_nodes[source].outputs[output].push(SlotTarget { node: target, slot });
            graph_nodes[target].slots[slot].feeders.push(source);
        }
        for node in &mut graph_nodes {
            for targets in &mut node.outputs {
                targets.sort_unstable();
            }
            for slot in &mut node.slots {
                slot.feeders.sort_unstable();
                slot.feeders.dedup();
            }
        }
        let trigger = *places
            .get(trigger)
            .expect("a run's trigger is a node of its pinned version");
        let ancestors = forward_ancestors(&graph_nodes, trigger);
        Ok(Self {
            nodes: graph_nodes,
            places,
            trigger,
            ancestors,
        })
    }

    /// The node at `place`.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) fn node(&self, place: usize) -> &RunGraphNode {
        &self.nodes[place]
    }

    /// How many nodes the graph holds; their places run from 0 below it.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) fn node_count(&self) -> usize {
        self.nodes.len()
    }

    /// The trigger's place.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) fn trigger(&self) -> usize {
        self.trigger
    }

    /// The place of the node `node_id`, which the graph holds.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) fn place(&self, node_id: &WorkflowNodeId) -> usize {
        *self
            .places
            .get(node_id)
            .expect("a step's node is a node of its run's graph")
    }

    /// The places of the nodes that precede the node at `place` along forward main edges, lowest
    /// first; two nodes of one loop are never each other's ancestors.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) fn ancestors(&self, place: usize) -> &[usize] {
        &self.ancestors[place]
    }

    /// The places of the nodes whose main outputs feed the node at `place`, with repeats.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) fn feeders(&self, place: usize) -> impl Iterator<Item = usize> + '_ {
        self.nodes[place]
            .slots
            .iter()
            .flat_map(|slot| slot.feeders.iter().copied())
    }
}

/// Where a node stands in the depth-first walk that sorts the edges into forward and back ones.
#[derive(Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
enum WalkMark {
    /// The walk has not reached it.
    Unreached,
    /// It is on the walk's current path, so an edge into it closes a loop.
    OnPath,
    /// The walk has left it.
    Left,
}

/// Each of `nodes`' ancestors along forward main edges, by place, lowest first. A depth-first walk
/// from `trigger`, then from each node it has not reached in place order, following each node's
/// targets in output order, takes every edge but those that close a loop, its back edges.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
fn forward_ancestors(nodes: &[RunGraphNode], trigger: usize) -> Vec<Vec<usize>> {
    let node_count = nodes.len();
    let targets: Vec<Vec<usize>> = nodes
        .iter()
        .map(|node| {
            node.outputs
                .iter()
                .flatten()
                .map(|target| target.node)
                .collect()
        })
        .collect();
    let mut marks = vec![WalkMark::Unreached; node_count];
    let mut forward_feeders: Vec<Vec<usize>> = vec![Vec::new(); node_count];
    for start in std::iter::once(trigger).chain(0..node_count) {
        if marks[start] != WalkMark::Unreached {
            continue;
        }
        marks[start] = WalkMark::OnPath;
        let mut path = vec![(start, 0)];
        while let Some(top) = path.last_mut() {
            let node = top.0;
            let Some(&target) = targets[node].get(top.1) else {
                marks[node] = WalkMark::Left;
                path.pop();
                continue;
            };
            top.1 += 1;
            match marks[target] {
                WalkMark::OnPath => {}
                WalkMark::Unreached => {
                    forward_feeders[target].push(node);
                    marks[target] = WalkMark::OnPath;
                    path.push((target, 0));
                }
                WalkMark::Left => forward_feeders[target].push(node),
            }
        }
    }
    (0..node_count)
        .map(|place| {
            let mut is_ancestor = vec![false; node_count];
            let mut pending = forward_feeders[place].clone();
            while let Some(feeder) = pending.pop() {
                if !is_ancestor[feeder] {
                    is_ancestor[feeder] = true;
                    pending.extend(&forward_feeders[feeder]);
                }
            }
            (0..node_count).filter(|&node| is_ancestor[node]).collect()
        })
        .collect()
}

/// The refusal of an edge naming `handle` on `node_id`, whose kind declares no such main handle.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
fn undeclared_handle(node_id: &WorkflowNodeId, handle: &NonEmptyText) -> RunGraphError {
    RunGraphError::UndeclaredHandle {
        node_id: node_id.clone(),
        handle: handle.clone(),
    }
}
