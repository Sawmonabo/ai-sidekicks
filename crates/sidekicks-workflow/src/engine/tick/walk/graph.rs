//! A run's graph: each node of the pinned version in visiting order, with its main input slots and,
//! for each main output, the slots it feeds. Tool edges are left out, since a node wired into a
//! `tool` input runs only when its agent calls it.

use std::collections::{BTreeSet, HashMap};

use fixedbitset::FixedBitSet;
use petgraph::algo::kosaraju_scc;
use petgraph::graph::{DiGraph, NodeIndex};
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_contracts::workflow::definition::document::{
    WorkflowEdge, WorkflowNode, WorkflowNodeId,
};
use sidekicks_contracts::workflow::definition::handle::{
    WorkflowHandleMode, WorkflowHandleType, parse_workflow_handle,
};
use sidekicks_contracts::workflow::definition::refusals::WorkflowNodeHandles;

use crate::engine::tick::node_settings::main_output_count;
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
    /// For a node of the loop kind, each of whose steps starts a pass of its loop, the main output
    /// that starts its body; `None` for any other node.
    pub(crate) loop_output: Option<usize>,
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
    /// Each node's feeders along forward main edges, by place, each once.
    forward_feeders: Vec<Vec<usize>>,
    /// Each node's ancestors along forward main edges as one bit per place, so a graph of n nodes
    /// keeps n² bits.
    ancestors: Vec<FixedBitSet>,
    /// Each loop node's body as one bit per place, by place; empty for any other node.
    loop_bodies: Vec<FixedBitSet>,
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
            let is_disabled = node.disabled == Some(true);
            let kind = kinds.kind_of(node);
            graph_nodes.push(RunGraphNode {
                id: node.id.clone(),
                is_disabled,
                loop_output: kind.and_then(|kind| kind.loop_output),
                readies_on_first_input: !is_disabled
                    && kind.is_some_and(|kind| kind.executor.readies_on_first_input(node)),
                input_count: rules.handles.inputs.len(),
                slots: main_inputs
                    .iter()
                    .map(|&(_, spec_position)| InputSlot {
                        spec_position,
                        feeders: Vec::new(),
                    })
                    .collect(),
                outputs: vec![Vec::new(); main_output_count(&rules.handles.outputs)],
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
            let output = node_handles[source]
                .outputs
                .iter()
                .filter(|output| !output.is_tool())
                .position(|output| output.id_text() == edge.source_handle.as_str())
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
        let forward_feeders = forward_feeders(&graph_nodes);
        let ancestors = forward_ancestors(&forward_feeders);
        let loop_bodies = (0..graph_nodes.len())
            .map(|place| match graph_nodes[place].loop_output {
                Some(_) => loop_body(&graph_nodes, |_| true, place),
                None => FixedBitSet::new(),
            })
            .collect();
        Ok(Self {
            nodes: graph_nodes,
            places,
            trigger,
            forward_feeders,
            ancestors,
            loop_bodies,
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
    pub(crate) fn ancestors(&self, place: usize) -> impl Iterator<Item = usize> + '_ {
        self.ancestors[place].ones()
    }

    /// Whether the node at `place` is in the body of the loop node at `loop_place`, so it runs
    /// once a pass of that loop; never when `loop_place` holds no loop node.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) fn is_in_loop_body(&self, place: usize, loop_place: usize) -> bool {
        self.loop_bodies[loop_place].contains(place)
    }

    /// The places of the nodes that feed the node at `place` along forward main edges, each once;
    /// a loop's back edge is left out.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) fn forward_feeders(&self, place: usize) -> &[usize] {
        &self.forward_feeders[place]
    }
}

/// Each of `nodes`' feeders along forward main edges, by place, each once: every main edge but
/// the back edges that close a loop. Each group of nodes that all reach one another holds a loop;
/// its back edges are those from inside it into its loop nodes fed from outside it, or into all its
/// loop nodes where none is, and the group is searched again without them for a loop inside the
/// body. Where several loop nodes are fed from outside, one inside another's body, reached from
/// that one's loop output while that one is not inside its own, is inner, and only the others are
/// cut first, so an inner loop keeps the outer body's edge into it as its entry; where none is
/// outer, all are cut. No order of nodes or edges decides which edge closes a loop.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
fn forward_feeders(nodes: &[RunGraphNode]) -> Vec<Vec<usize>> {
    let mut feeders: Vec<Vec<usize>> = vec![Vec::new(); nodes.len()];
    for (place, node) in nodes.iter().enumerate() {
        for target in node.outputs.iter().flatten() {
            feeders[target.node].push(place);
        }
    }
    for node_feeders in &mut feeders {
        node_feeders.sort_unstable();
        node_feeders.dedup();
    }
    let mut groups = vec![(0..nodes.len()).collect::<BTreeSet<usize>>()];
    while let Some(members) = groups.pop() {
        for inside in looping_groups(&members, &feeders) {
            // A group holding no loop node, which the save refuses, is cut at every node, so the
            // search ends whatever graph it is handed.
            let loops: Vec<usize> = inside
                .iter()
                .copied()
                .filter(|&place| nodes[place].loop_output.is_some())
                .collect();
            let candidates = if loops.is_empty() {
                inside.iter().copied().collect()
            } else {
                loops
            };
            let entered: Vec<usize> = candidates
                .iter()
                .copied()
                .filter(|&place| feeders[place].iter().any(|feeder| !inside.contains(feeder)))
                .collect();
            let headers = match entered.len() {
                0 => candidates,
                1 => entered,
                _ => {
                    let bodies: Vec<FixedBitSet> = entered
                        .iter()
                        .map(|&header| loop_body(nodes, |place| inside.contains(&place), header))
                        .collect();
                    let outer: Vec<usize> = entered
                        .iter()
                        .zip(&bodies)
                        .filter(|&(&header, body)| {
                            entered.iter().zip(&bodies).all(|(&other, other_body)| {
                                !other_body.contains(header) || body.contains(other)
                            })
                        })
                        .map(|(&header, _)| header)
                        .collect();
                    if outer.is_empty() { entered } else { outer }
                }
            };
            // Each member is fed from inside, so every pass cuts at least one edge and ends.
            for header in headers {
                feeders[header].retain(|feeder| !inside.contains(feeder));
            }
            groups.push(inside);
        }
    }
    feeders
}

/// The groups of more than one of `members` that all reach one another along `feeders`.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
fn looping_groups(members: &BTreeSet<usize>, feeders: &[Vec<usize>]) -> Vec<BTreeSet<usize>> {
    let mut group: DiGraph<usize, ()> = DiGraph::with_capacity(members.len(), members.len());
    let indices: HashMap<usize, NodeIndex> = members
        .iter()
        .map(|&place| (place, group.add_node(place)))
        .collect();
    for &target in members {
        for feeder in &feeders[target] {
            if let Some(&feeder_index) = indices.get(feeder) {
                group.add_edge(feeder_index, indices[&target], ());
            }
        }
    }
    // Kosaraju's search walks with its own stack, so a long chain cannot exhaust the call stack.
    kosaraju_scc(&group)
        .into_iter()
        .filter(|component| component.len() >= 2)
        .map(|component| component.iter().map(|&index| group[index]).collect())
        .collect()
}

/// The nodes `is_inside` accepts that the node at `header` reaches from its loop output along main
/// edges without coming back through it, one bit per place: its loop's body among them, empty for
/// a node with no loop output.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
fn loop_body(
    nodes: &[RunGraphNode],
    is_inside: impl Fn(usize) -> bool,
    header: usize,
) -> FixedBitSet {
    let mut body = FixedBitSet::with_capacity(nodes.len());
    let mut pending: Vec<usize> = nodes[header]
        .loop_output
        .map(|output| {
            nodes[header].outputs[output]
                .iter()
                .map(|target| target.node)
                .collect()
        })
        .unwrap_or_default();
    while let Some(place) = pending.pop() {
        if place != header && is_inside(place) && !body.put(place) {
            pending.extend(
                nodes[place]
                    .outputs
                    .iter()
                    .flatten()
                    .map(|target| target.node),
            );
        }
    }
    body
}

/// Each node's ancestors along `forward_feeders`, one bit per place.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
fn forward_ancestors(forward_feeders: &[Vec<usize>]) -> Vec<FixedBitSet> {
    let node_count = forward_feeders.len();
    forward_feeders
        .iter()
        .map(|feeders| {
            let mut ancestors = FixedBitSet::with_capacity(node_count);
            let mut pending = feeders.clone();
            while let Some(feeder) = pending.pop() {
                if !ancestors.put(feeder) {
                    pending.extend(&forward_feeders[feeder]);
                }
            }
            ancestors
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
