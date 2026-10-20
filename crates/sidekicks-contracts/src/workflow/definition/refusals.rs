//! The refusal a save answers with when a document breaks a rule, and the check over the
//! document's graph that the builder runs while a connection is dragged and the daemon runs again
//! at save, so both refuse the same shapes.

use std::collections::{HashMap, HashSet};
use std::hash::BuildHasher;
use std::iter;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::jsonrpc::refusal::RefusalCode;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::list::BoundedVec;
use crate::wire::text::NonEmptyText;
use crate::workflow::definition::document::{WorkflowEdge, WorkflowNode, WorkflowNodeId};
use crate::workflow::definition::handle::{
    WorkflowHandle, WorkflowHandleMode, WorkflowHandleType, parse_workflow_handle,
};
use crate::workflow::kind::{
    WorkflowInputHandleSpec, WorkflowNodeKindCategory, WorkflowOutputHandleSpec,
};

ts_constants! {
    /// A document the daemon's check at save refused; it carries every finding at once.
    WORKFLOW_DEFINITION_REFUSED_CODE = RefusalCode::WorkflowDefinitionRefused;
}

/// Declares the findings: each named rule, with the nodes it marks, then the one finding that also
/// names a package.
macro_rules! workflow_definition_findings {
    ($($(#[doc = $doc:literal])+ $rule:ident,)+) => {
        /// One finding: the rule a refused document breaks, with the nodes it marks. The validation
        /// strip lists every finding and the canvas marks each node.
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
        #[serde(
            tag = "rule",
            rename_all = "camelCase",
            rename_all_fields = "camelCase",
            deny_unknown_fields
        )]
        pub enum WorkflowDefinitionFinding {
            $(
                $(#[doc = $doc])+
                $rule {
                    /// The nodes the finding marks.
                    node_ids: Vec<WorkflowNodeId>,
                },
            )+
            /// A full-tier Code step naming one package at two versions in two imports. A package
            /// that merely cannot be locked is no finding; the save is kept.
            CodePackagesUnresolved {
                /// The Code steps.
                node_ids: BoundedVec<WorkflowNodeId, 1, { usize::MAX }>,
                /// The package.
                detail: NonEmptyText,
            },
        }
    };
}

workflow_definition_findings! {
    /// A cycle among `main` edges that no loop closes.
    Cycle,
    /// A node the trigger does not reach.
    Orphan,
    /// A document with no node but its trigger.
    EmptyDocument,
    /// A node id used twice, raised by the document's read, since a document that cannot be read
    /// never reaches the check.
    NodeIdDuplicate,
    /// An edge naming a node the document does not hold, marking the end it holds.
    NodeMissing,
    /// No trigger, or a node in the trigger's place whose kind is not a trigger.
    TriggerMissing,
    /// A trigger kind among the other nodes.
    TriggerDuplicate,
    /// An edge into the trigger.
    EdgeIntoTrigger,
    /// An edge out of a node with no outputs.
    EdgeOutOfTerminal,
    /// A required parameter left empty.
    ParamMissing,
    /// An expression that does not parse.
    ExpressionUnparsable,
    /// An expression naming a node the document does not hold.
    ExpressionUnknownNode,
    /// An expression using a regular expression feature the engine does not run.
    ExpressionRegexUnsupported,
    /// A `tool` edge into a node with no `tool` input.
    ToolEdgeWithoutToolInput,
    /// An edge end that does not read as a declared handle of its node.
    HandleTypeUnknown,
    /// A `main` end joined to a `tool` end.
    HandleTypeMismatch,
    /// More edges into an input than it takes.
    InputConnectionsExceeded,
    /// A name another workflow in the library holds, in any letter case.
    NameTaken,
    /// A step that needs a repository under a trigger whose `Repository` is `None`.
    RepositoryRequired,
    /// A member the node's kind does not list.
    UnknownKey,
    /// A `secret://` reference in a parameter the kind does not mark sensitive.
    SecretOutsideSensitiveField,
}

/// The details of `workflow.definition.refused`: the whole list of findings.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowDefinitionRefusedDetails {
    /// Every finding, at least one.
    pub findings: BoundedVec<WorkflowDefinitionFinding, 1, { usize::MAX }>,
}

/// The loop kind: an edge into its own input closes the loop body and is no cycle.
const LOOP_KIND: &str = "flow.loopItems";

/// One node's category and the handles it has. For a kind whose outputs derive from its params,
/// `outputs` is what this node's params give; a node that routes failures to an error output lists
/// that output too.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowNodeHandles {
    /// The kind's category.
    pub category: WorkflowNodeKindCategory,
    /// The node's input handles.
    pub inputs: Vec<WorkflowInputHandleSpec>,
    /// The node's output handles.
    pub outputs: Vec<WorkflowOutputHandleSpec>,
}

/// The findings for the rules that need only a document's trigger, as a node, its nodes and edges
/// and the kinds' handles: the trigger, an empty document, each edge's nodes and ends, the inputs
/// over their connection limit, cycles, then orphans, each in document order. `node_handles` holds
/// each node's handles by node id, built by the caller from the kinds table; a node missing from
/// it is of a kind the catalog does not list, whose handles and category then go unchecked though
/// its edges still count toward cycles and reach. An edge naming a node the document does not
/// hold is `nodeMissing` and is checked no further at that end.
pub fn check_workflow_graph<S: BuildHasher>(
    trigger: Option<&WorkflowNode>,
    document_nodes: &[WorkflowNode],
    edges: &[WorkflowEdge],
    node_handles: &HashMap<WorkflowNodeId, WorkflowNodeHandles, S>,
) -> Vec<WorkflowDefinitionFinding> {
    let graph = GraphFacts::new(trigger, document_nodes, edges, node_handles);
    let mut findings = Vec::new();
    match graph.trigger_id {
        None => findings.push(WorkflowDefinitionFinding::TriggerMissing { node_ids: vec![] }),
        Some(trigger_id) if graph.is_listed_as_non_trigger(trigger_id) => {
            findings.push(WorkflowDefinitionFinding::TriggerMissing {
                node_ids: vec![trigger_id.clone()],
            });
        }
        Some(_) => {}
    }
    if document_nodes.is_empty() {
        findings.push(WorkflowDefinitionFinding::EmptyDocument { node_ids: vec![] });
    }
    let duplicate_trigger_ids: Vec<WorkflowNodeId> = document_nodes
        .iter()
        .filter(|node| {
            graph.handles_of(&node.id).map(|handles| handles.category)
                == Some(WorkflowNodeKindCategory::Trigger)
        })
        .map(|node| node.id.clone())
        .collect();
    if !duplicate_trigger_ids.is_empty() {
        findings.push(WorkflowDefinitionFinding::TriggerDuplicate {
            node_ids: duplicate_trigger_ids,
        });
    }
    let mut refused_edges = HashSet::new();
    for (edge_index, parsed_edge) in graph.edges.iter().enumerate() {
        let edge_findings = graph.edge_findings(parsed_edge);
        if !edge_findings.is_empty() {
            refused_edges.insert(edge_index);
        }
        findings.extend(edge_findings);
    }
    findings.extend(graph.connection_limit_findings(&refused_edges));
    findings.extend(
        graph
            .cycles()
            .into_iter()
            .map(|node_ids| WorkflowDefinitionFinding::Cycle { node_ids }),
    );
    // With no trigger every node would be an orphan; the missing trigger is the one finding.
    if let Some(trigger_id) = graph.trigger_id {
        findings.extend(graph.orphans(trigger_id).into_iter().map(|node_id| {
            WorkflowDefinitionFinding::Orphan {
                node_ids: vec![node_id],
            }
        }));
    }
    findings
}

/// The findings a connection dragged onto the document adds, which the builder refuses while it
/// is dragged: the edge's own rules, the cycle it would close (the edge closing a loop body
/// excepted) and the input limit it would pass. It is `check_workflow_graph` over the document
/// with the edge and without it, answering each finding of the first not in the second, so a
/// finding the document already holds is not the connection's. Empty when it is accepted.
pub fn check_workflow_connection<S: BuildHasher>(
    trigger: Option<&WorkflowNode>,
    document_nodes: &[WorkflowNode],
    edges: &[WorkflowEdge],
    edge: &WorkflowEdge,
    node_handles: &HashMap<WorkflowNodeId, WorkflowNodeHandles, S>,
) -> Vec<WorkflowDefinitionFinding> {
    let edges_with_connection: Vec<WorkflowEdge> =
        edges.iter().chain(iter::once(edge)).cloned().collect();
    let mut findings = check_workflow_graph(
        trigger,
        document_nodes,
        &edges_with_connection,
        node_handles,
    );
    // Each finding the document holds already accounts for one equal finding, so a second bad
    // edge like one already there is still refused.
    for held in check_workflow_graph(trigger, document_nodes, edges, node_handles) {
        if let Some(index) = findings.iter().position(|finding| *finding == held) {
            findings.remove(index);
        }
    }
    findings
}

/// A rule one edge can break.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EdgeRule {
    NodeMissing,
    EdgeIntoTrigger,
    EdgeOutOfTerminal,
    ToolEdgeWithoutToolInput,
    HandleTypeUnknown,
    HandleTypeMismatch,
}

impl EdgeRule {
    /// The finding this rule raises, marking `node_ids`.
    fn finding(self, node_ids: Vec<WorkflowNodeId>) -> WorkflowDefinitionFinding {
        match self {
            Self::NodeMissing => WorkflowDefinitionFinding::NodeMissing { node_ids },
            Self::EdgeIntoTrigger => WorkflowDefinitionFinding::EdgeIntoTrigger { node_ids },
            Self::EdgeOutOfTerminal => WorkflowDefinitionFinding::EdgeOutOfTerminal { node_ids },
            Self::ToolEdgeWithoutToolInput => {
                WorkflowDefinitionFinding::ToolEdgeWithoutToolInput { node_ids }
            }
            Self::HandleTypeUnknown => WorkflowDefinitionFinding::HandleTypeUnknown { node_ids },
            Self::HandleTypeMismatch => WorkflowDefinitionFinding::HandleTypeMismatch { node_ids },
        }
    }
}

/// An edge with its two ends read.
struct ParsedEdge<'a> {
    edge: &'a WorkflowEdge,
    source: WorkflowHandle,
    target: WorkflowHandle,
}

impl<'a> ParsedEdge<'a> {
    fn new(edge: &'a WorkflowEdge) -> Self {
        Self {
            edge,
            source: parse_workflow_handle(edge.source_handle.as_str()),
            target: parse_workflow_handle(edge.target_handle.as_str()),
        }
    }

    fn is_main(&self) -> bool {
        self.source.handle_type == WorkflowHandleType::Main
            && self.target.handle_type == WorkflowHandleType::Main
    }

    fn is_tool(&self) -> bool {
        self.source.handle_type == WorkflowHandleType::Tool
            && self.target.handle_type == WorkflowHandleType::Tool
    }

    // A `main` end joined to a `tool` end, each naming a type the grammar knows.
    fn is_type_mismatch(&self) -> bool {
        self.source.is_type_known
            && self.target.is_type_known
            && self.source.handle_type != self.target.handle_type
    }
}

/// What the check reads of the document: its nodes, the trigger first, by id, with their handles.
struct GraphFacts<'a, S> {
    trigger_id: Option<&'a WorkflowNodeId>,
    nodes: Vec<&'a WorkflowNode>,
    node_by_id: HashMap<&'a WorkflowNodeId, &'a WorkflowNode>,
    node_handles: &'a HashMap<WorkflowNodeId, WorkflowNodeHandles, S>,
    edges: Vec<ParsedEdge<'a>>,
}

impl<'a, S: BuildHasher> GraphFacts<'a, S> {
    fn new(
        trigger: Option<&'a WorkflowNode>,
        document_nodes: &'a [WorkflowNode],
        edges: &'a [WorkflowEdge],
        node_handles: &'a HashMap<WorkflowNodeId, WorkflowNodeHandles, S>,
    ) -> Self {
        let nodes: Vec<&WorkflowNode> = trigger.into_iter().chain(document_nodes).collect();
        Self {
            trigger_id: trigger.map(|trigger| &trigger.id),
            node_by_id: nodes.iter().map(|&node| (&node.id, node)).collect(),
            node_handles,
            edges: edges.iter().map(ParsedEdge::new).collect(),
            nodes,
        }
    }

    fn handles_of(&self, node_id: &WorkflowNodeId) -> Option<&WorkflowNodeHandles> {
        self.node_handles.get(node_id)
    }

    // A node in the trigger's place whose kind the catalog lists under another category.
    fn is_listed_as_non_trigger(&self, node_id: &WorkflowNodeId) -> bool {
        self.handles_of(node_id)
            .is_some_and(|handles| handles.category != WorkflowNodeKindCategory::Trigger)
    }

    // The edge's findings, each marking the ends the document holds.
    fn edge_findings(&self, parsed_edge: &ParsedEdge<'_>) -> Vec<WorkflowDefinitionFinding> {
        let WorkflowEdge { source, target, .. } = parsed_edge.edge;
        let held_end_ids: Vec<WorkflowNodeId> = [source, target]
            .into_iter()
            .filter(|node_id| self.node_by_id.contains_key(node_id))
            .cloned()
            .collect();
        self.edge_rules(parsed_edge)
            .into_iter()
            .map(|rule| rule.finding(held_end_ids.clone()))
            .collect()
    }

    // One rule at most for each end the document holds; a rule that names the end's problem
    // outright stands in for the undeclared-handle finding it would also raise. Only when both
    // ends name a handle their nodes declare is a join of two types a mismatch.
    fn edge_rules(&self, parsed_edge: &ParsedEdge<'_>) -> Vec<EdgeRule> {
        let edge = parsed_edge.edge;
        let has_source = self.node_by_id.contains_key(&edge.source);
        let has_target = self.node_by_id.contains_key(&edge.target);
        let mut rules = Vec::new();
        if !has_source || !has_target {
            rules.push(EdgeRule::NodeMissing);
        }
        let source_rule = has_source
            .then(|| self.source_end_rule(parsed_edge))
            .flatten();
        let target_rule = has_target
            .then(|| self.target_end_rule(parsed_edge))
            .flatten();
        for rule in [source_rule, target_rule].into_iter().flatten() {
            if !rules.contains(&rule) {
                rules.push(rule);
            }
        }
        if rules.is_empty() && parsed_edge.is_type_mismatch() {
            rules.push(EdgeRule::HandleTypeMismatch);
        }
        rules
    }

    fn source_end_rule(&self, parsed_edge: &ParsedEdge<'_>) -> Option<EdgeRule> {
        let edge = parsed_edge.edge;
        let source_handles = self.handles_of(&edge.source);
        if source_handles.is_some_and(|handles| handles.outputs.is_empty()) {
            return Some(EdgeRule::EdgeOutOfTerminal);
        }
        let is_declared = is_declared_handle(
            edge.source_handle.as_str(),
            &parsed_edge.source,
            WorkflowHandleMode::Outputs,
            source_handles,
        );
        (!is_declared).then_some(EdgeRule::HandleTypeUnknown)
    }

    fn target_end_rule(&self, parsed_edge: &ParsedEdge<'_>) -> Option<EdgeRule> {
        let edge = parsed_edge.edge;
        let target_handles = self.handles_of(&edge.target);
        if self.trigger_id == Some(&edge.target) {
            return Some(EdgeRule::EdgeIntoTrigger);
        }
        let lacks_tool_input = target_handles
            .is_some_and(|handles| !handles.inputs.iter().any(WorkflowInputHandleSpec::is_tool));
        if parsed_edge.is_tool() && lacks_tool_input {
            return Some(EdgeRule::ToolEdgeWithoutToolInput);
        }
        let is_declared = is_declared_handle(
            edge.target_handle.as_str(),
            &parsed_edge.target,
            WorkflowHandleMode::Inputs,
            target_handles,
        );
        (!is_declared).then_some(EdgeRule::HandleTypeUnknown)
    }

    /// One finding for each input handle holding more edges than its `maxConnections`, marking the
    /// node and the sources of the edges past the limit in document order. An edge already refused
    /// for its own fault is not counted, so one bad edge never raises two findings.
    fn connection_limit_findings(
        &self,
        refused_edges: &HashSet<usize>,
    ) -> Vec<WorkflowDefinitionFinding> {
        let mut findings = Vec::new();
        for node in &self.nodes {
            let Some(handles) = self.handles_of(&node.id) else {
                continue;
            };
            for input in &handles.inputs {
                let Some(max_connections) = input.max_connections() else {
                    continue;
                };
                let input_id = input.id_text();
                let source_ids: Vec<&WorkflowNodeId> = self
                    .edges
                    .iter()
                    .enumerate()
                    .filter(|(edge_index, parsed_edge)| {
                        !refused_edges.contains(edge_index)
                            && parsed_edge.edge.target == node.id
                            && parsed_edge.edge.target_handle.as_str() == input_id
                    })
                    .map(|(_, parsed_edge)| &parsed_edge.edge.source)
                    .collect();
                let limit = usize::try_from(max_connections).unwrap_or(usize::MAX);
                if source_ids.len() > limit {
                    let mut marked: Vec<WorkflowNodeId> = vec![node.id.clone()];
                    for source_id in &source_ids[limit..] {
                        if !marked.contains(*source_id) {
                            marked.push((*source_id).clone());
                        }
                    }
                    findings.push(WorkflowDefinitionFinding::InputConnectionsExceeded {
                        node_ids: marked,
                    });
                }
            }
        }
        findings
    }

    /// Every cycle among `main` edges as its nodes in document order, found as the strongly
    /// connected components of more than one node or with a self-edge. An edge into a loop node's
    /// input closes the loop body and is left out, unless it is the loop node's own self-edge.
    fn cycles(&self) -> Vec<Vec<WorkflowNodeId>> {
        let mut successors: HashMap<&WorkflowNodeId, Vec<&WorkflowNodeId>> = HashMap::new();
        let mut self_edge_node_ids = HashSet::new();
        for parsed_edge in &self.edges {
            let WorkflowEdge { source, target, .. } = parsed_edge.edge;
            let is_loop_closing = source != target
                && self
                    .node_by_id
                    .get(target)
                    .is_some_and(|node| node.kind.0.as_str() == LOOP_KIND);
            if !parsed_edge.is_main() || is_loop_closing {
                continue;
            }
            if self.node_by_id.contains_key(source) && self.node_by_id.contains_key(target) {
                successors.entry(source).or_default().push(target);
                if source == target {
                    self_edge_node_ids.insert(source);
                }
            }
        }
        let node_ids: Vec<&WorkflowNodeId> = self.nodes.iter().map(|node| &node.id).collect();
        let mut component_by_node_id = HashMap::new();
        for (component_index, component) in strongly_connected_components(&node_ids, &successors)
            .iter()
            .enumerate()
        {
            let is_cycle = component.len() > 1
                || component
                    .iter()
                    .any(|node_id| self_edge_node_ids.contains(node_id));
            if is_cycle {
                for node_id in component {
                    component_by_node_id.insert(*node_id, component_index);
                }
            }
        }
        // One walk in document order fills each cycle's members and lists the cycles by their
        // first member.
        let mut found: Vec<Vec<WorkflowNodeId>> = Vec::new();
        let mut found_index_by_component = HashMap::new();
        for node_id in node_ids {
            if let Some(component_index) = component_by_node_id.get(node_id) {
                let found_index = *found_index_by_component
                    .entry(*component_index)
                    .or_insert_with(|| {
                        found.push(Vec::new());
                        found.len() - 1
                    });
                found[found_index].push(node_id.clone());
            }
        }
        found
    }

    /// The nodes the trigger does not reach, in document order. A node is reached along a `main`
    /// edge from a reached node, or as the tool of a reached node it is wired into by a `tool`
    /// edge, because a tool node runs only when the agent it serves calls it. An edge joining a
    /// `main` end to a `tool` end reaches both ways, since its mismatch is already refused.
    fn orphans(&self, trigger_id: &'a WorkflowNodeId) -> Vec<WorkflowNodeId> {
        let mut next_by_id: HashMap<&WorkflowNodeId, Vec<&WorkflowNodeId>> = HashMap::new();
        for parsed_edge in &self.edges {
            let WorkflowEdge { source, target, .. } = parsed_edge.edge;
            if parsed_edge.is_main() {
                next_by_id.entry(source).or_default().push(target);
            } else if parsed_edge.is_tool() {
                next_by_id.entry(target).or_default().push(source);
            } else {
                next_by_id.entry(source).or_default().push(target);
                next_by_id.entry(target).or_default().push(source);
            }
        }
        let mut reached = HashSet::from([trigger_id]);
        let mut pending = vec![trigger_id];
        while let Some(node_id) = pending.pop() {
            for next in next_by_id.get(node_id).into_iter().flatten() {
                if reached.insert(*next) {
                    pending.push(*next);
                }
            }
        }
        self.nodes
            .iter()
            .filter(|node| !reached.contains(&node.id))
            .map(|node| node.id.clone())
            .collect()
    }
}

// A handle is declared when it names a known type on the right side and, where the node's kind is
// in the catalog, one of the handles that node has.
fn is_declared_handle(
    handle_id: &str,
    handle: &WorkflowHandle,
    mode: WorkflowHandleMode,
    handles: Option<&WorkflowNodeHandles>,
) -> bool {
    let is_listed = handles.is_none_or(|handles| match mode {
        WorkflowHandleMode::Inputs => handles
            .inputs
            .iter()
            .any(|spec| spec.id_text() == handle_id),
        WorkflowHandleMode::Outputs => handles
            .outputs
            .iter()
            .any(|spec| spec.id_text() == handle_id),
    });
    handle.is_type_known && handle.mode == mode && is_listed
}

/// One node's place in Tarjan's walk.
#[derive(Clone, Copy)]
struct Visit {
    index: usize,
    low_link: usize,
}

/// One node being walked: the node and how many of its successors the walk has taken.
struct Frame<'a> {
    node_id: &'a WorkflowNodeId,
    next_index: usize,
}

/// Tarjan's bookkeeping: each entered node's visit, and the stack of nodes not yet in a component.
#[derive(Default)]
struct TarjanWalk<'a> {
    visits: HashMap<&'a WorkflowNodeId, Visit>,
    stack: Vec<&'a WorkflowNodeId>,
    on_stack: HashSet<&'a WorkflowNodeId>,
}

impl<'a> TarjanWalk<'a> {
    fn enter(&mut self, node_id: &'a WorkflowNodeId) -> Frame<'a> {
        let index = self.visits.len();
        self.visits.insert(
            node_id,
            Visit {
                index,
                low_link: index,
            },
        );
        self.stack.push(node_id);
        self.on_stack.insert(node_id);
        Frame {
            node_id,
            next_index: 0,
        }
    }

    fn lower_link(&mut self, node_id: &WorkflowNodeId, low_link: usize) {
        let visit = self
            .visits
            .get_mut(node_id)
            .expect("a walked node was entered");
        visit.low_link = visit.low_link.min(low_link);
    }
}

// Tarjan's algorithm, walked with an explicit stack so a long chain cannot exhaust the call stack:
// each component is popped off the node stack once its root is finished.
fn strongly_connected_components<'a>(
    node_ids: &[&'a WorkflowNodeId],
    successors: &HashMap<&'a WorkflowNodeId, Vec<&'a WorkflowNodeId>>,
) -> Vec<Vec<&'a WorkflowNodeId>> {
    let mut walk = TarjanWalk::default();
    let mut components = Vec::new();
    for &root_id in node_ids {
        if walk.visits.contains_key(root_id) {
            continue;
        }
        let mut frames = vec![walk.enter(root_id)];
        while let Some(frame) = frames.last_mut() {
            let node_id = frame.node_id;
            let next_id = successors
                .get(node_id)
                .and_then(|next| next.get(frame.next_index))
                .copied();
            if let Some(next_id) = next_id {
                frame.next_index += 1;
                match walk.visits.get(next_id).map(|visit| visit.index) {
                    None => {
                        let next_frame = walk.enter(next_id);
                        frames.push(next_frame);
                    }
                    Some(seen_index) if walk.on_stack.contains(next_id) => {
                        walk.lower_link(node_id, seen_index);
                    }
                    Some(_) => {}
                }
                continue;
            }
            frames.pop();
            let finished = *walk.visits.get(node_id).expect("a walked node was entered");
            if let Some(parent) = frames.last() {
                walk.lower_link(parent.node_id, finished.low_link);
            }
            if finished.low_link == finished.index {
                let mut component = Vec::new();
                while let Some(member) = walk.stack.pop() {
                    walk.on_stack.remove(member);
                    component.push(member);
                    if member == node_id {
                        break;
                    }
                }
                components.push(component);
            }
        }
    }
    components
}

/// The TypeScript module of the definition refusal.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "workflow/definition/refusals",
    doc: "The refusal a save answers with when a document breaks a rule.",
    definitions: &[
        Definition::read::<WorkflowDefinitionFinding>().checked(),
        Definition::read::<WorkflowDefinitionRefusedDetails>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use rstest::rstest;
    use serde_json::{Value, json};

    use super::{WorkflowNodeHandles, check_workflow_connection, check_workflow_graph};
    use crate::workflow::definition::document::{
        WorkflowDraftDocument, WorkflowNode, WorkflowNodeId, node,
    };
    use crate::workflow::kind::WorkflowNodeKindCategory;

    fn edge(source: &str, source_handle: &str, target: &str, target_handle: &str) -> Value {
        json!({
            "id": format!("{source}-{target}"),
            "source": source,
            "sourceHandle": source_handle,
            "target": target,
            "targetHandle": target_handle,
        })
    }

    fn main_edge(source: &str, target: &str) -> Value {
        edge(source, "outputs/main/0", target, "inputs/main/0")
    }

    // The handles of the kinds the cases place; any other kind is one the catalog does not list.
    fn handles_of(node: &WorkflowNode) -> Option<WorkflowNodeHandles> {
        let main_in = json!({ "type": "main", "id": "inputs/main/0", "label": "In" });
        let limited_in =
            json!({ "type": "main", "id": "inputs/main/0", "label": "In", "maxConnections": 1 });
        let main_out = json!({ "type": "main", "id": "outputs/main/0", "label": "Out" });
        let (category, inputs, outputs) = match node.kind.0.as_str() {
            "trigger.manual" => (
                WorkflowNodeKindCategory::Trigger,
                json!([]),
                json!([main_out]),
            ),
            "agent.run" => (
                WorkflowNodeKindCategory::Agent,
                json!([main_in, { "type": "tool", "id": "inputs/tool/0", "label": "Tools" }]),
                json!([main_out]),
            ),
            "developer.mcpTool" => (
                WorkflowNodeKindCategory::Developer,
                json!([]),
                json!([{ "type": "tool", "id": "outputs/tool/0", "label": "Tool" }]),
            ),
            "flow.loopItems" => (
                WorkflowNodeKindCategory::Flow,
                json!([main_in]),
                json!([main_out, { "type": "main", "id": "outputs/main/1", "label": "Each" }]),
            ),
            "output.notify" => (
                WorkflowNodeKindCategory::Output,
                json!([limited_in]),
                json!([]),
            ),
            _ => return None,
        };
        Some(WorkflowNodeHandles {
            category,
            inputs: serde_json::from_value(inputs).expect("the inputs read"),
            outputs: serde_json::from_value(outputs).expect("the outputs read"),
        })
    }

    #[rstest]
    #[case::a_cycle_of_main_edges(
        json!([node("a", "agent.run"), node("b", "agent.run")]),
        json!([main_edge("t", "a"), main_edge("a", "b"), main_edge("b", "a")]),
        json!([{ "rule": "cycle", "nodeIds": ["a", "b"] }]),
    )]
    #[case::an_edge_back_into_a_loop_closes_its_body(
        json!([node("l", "flow.loopItems"), node("x", "agent.run")]),
        json!([
            main_edge("t", "l"),
            edge("l", "outputs/main/1", "x", "inputs/main/0"),
            main_edge("x", "l"),
        ]),
        json!([]),
    )]
    #[case::a_loop_into_itself_is_a_cycle(
        json!([node("l", "flow.loopItems")]),
        json!([main_edge("t", "l"), main_edge("l", "l")]),
        json!([{ "rule": "cycle", "nodeIds": ["l"] }]),
    )]
    #[case::a_tool_is_reached_through_the_agent_it_serves(
        json!([node("a", "agent.run"), node("m", "developer.mcpTool")]),
        json!([main_edge("t", "a"), edge("m", "outputs/tool/0", "a", "inputs/tool/0")]),
        json!([]),
    )]
    #[case::an_input_past_its_connection_limit(
        json!([node("a", "agent.run"), node("n", "output.notify")]),
        json!([main_edge("t", "a"), main_edge("t", "n"), main_edge("a", "n")]),
        json!([{ "rule": "inputConnectionsExceeded", "nodeIds": ["n", "a"] }]),
    )]
    #[case::an_edge_into_the_trigger(
        json!([node("a", "agent.run"), node("b", "agent.run")]),
        json!([main_edge("t", "a"), main_edge("b", "t")]),
        json!([
            { "rule": "edgeIntoTrigger", "nodeIds": ["b", "t"] },
            { "rule": "orphan", "nodeIds": ["b"] },
        ]),
    )]
    #[case::a_kind_the_catalog_does_not_list_keeps_only_the_handle_grammar(
        json!([node("u", "custom.thing"), node("a", "agent.run")]),
        json!([
            edge("t", "outputs/main/0", "u", "inputs/main/3"),
            edge("u", "outputs/weird/0", "a", "inputs/main/0"),
        ]),
        json!([{ "rule": "handleTypeUnknown", "nodeIds": ["u", "a"] }]),
    )]
    fn the_graph_check_finds_what_the_save_refuses(
        #[case] nodes: Value,
        #[case] edges: Value,
        #[case] findings: Value,
    ) {
        let (document, trigger, node_handles) = graph(&nodes, &edges);
        let found = check_workflow_graph(
            trigger.as_ref(),
            &document.nodes,
            &document.edges,
            &node_handles,
        );
        assert_eq!(
            serde_json::to_value(found).expect("the findings write"),
            findings
        );
    }

    // The connection check answers only what the dragged edge adds: the cycle it closes, the
    // input limit it passes, never a finding the document already holds, and no cycle for the
    // edge that closes a loop body.
    #[rstest]
    #[case::a_connection_closing_a_cycle(
        json!([node("a", "agent.run"), node("b", "agent.run")]),
        json!([main_edge("t", "a"), main_edge("a", "b")]),
        main_edge("b", "a"),
        json!([{ "rule": "cycle", "nodeIds": ["a", "b"] }]),
    )]
    #[case::a_connection_closing_a_loop_body(
        json!([node("l", "flow.loopItems"), node("x", "agent.run")]),
        json!([main_edge("t", "l"), edge("l", "outputs/main/1", "x", "inputs/main/0")]),
        main_edge("x", "l"),
        json!([]),
    )]
    #[case::a_connection_past_an_input_limit(
        json!([node("a", "agent.run"), node("n", "output.notify")]),
        json!([main_edge("t", "a"), main_edge("t", "n")]),
        main_edge("a", "n"),
        json!([{ "rule": "inputConnectionsExceeded", "nodeIds": ["n", "a"] }]),
    )]
    #[case::a_finding_the_document_already_holds(
        json!([node("a", "agent.run"), node("b", "agent.run")]),
        json!([]),
        main_edge("t", "a"),
        json!([]),
    )]
    fn the_connection_check_refuses_what_the_edge_adds(
        #[case] nodes: Value,
        #[case] edges: Value,
        #[case] connection: Value,
        #[case] findings: Value,
    ) {
        let (document, trigger, node_handles) = graph(&nodes, &edges);
        let connection = serde_json::from_value(connection).expect("the connection reads");
        let found = check_workflow_connection(
            trigger.as_ref(),
            &document.nodes,
            &document.edges,
            &connection,
            &node_handles,
        );
        assert_eq!(
            serde_json::to_value(found).expect("the findings write"),
            findings
        );
    }

    // The document under a manual trigger `t`, its trigger as a node, and each node's handles.
    fn graph(
        nodes: &Value,
        edges: &Value,
    ) -> (
        WorkflowDraftDocument,
        Option<WorkflowNode>,
        HashMap<WorkflowNodeId, WorkflowNodeHandles>,
    ) {
        let document: WorkflowDraftDocument = serde_json::from_value(json!({
            "schemaVersion": "2",
            "name": "Graph",
            "trigger": node("t", "trigger.manual"),
            "nodes": nodes,
            "edges": edges,
        }))
        .expect("the document reads");
        let trigger = document.trigger.as_ref().map(WorkflowNode::from);
        let node_handles = trigger
            .iter()
            .chain(&document.nodes)
            .filter_map(|node| Some((node.id.clone(), handles_of(node)?)))
            .collect();
        (document, trigger, node_handles)
    }
}
