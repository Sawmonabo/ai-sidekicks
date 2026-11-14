//! The refusal a save answers with when a document breaks a rule, the check over the document's
//! graph that the builder runs before a save and the daemon runs again at save, and the check of
//! one connection the builder runs while it is dragged, which answers only what that connection
//! adds.

use std::collections::{HashMap, HashSet};
use std::hash::BuildHasher;
use std::iter;

use petgraph::algo::kosaraju_scc;
use petgraph::graph::{DiGraph, NodeIndex};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::jsonrpc::refusal::RefusalCode;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::list::BoundedVec;
use crate::wire::record::Record;
use crate::wire::text::NonEmptyText;
use crate::workflow::definition::document::{
    WorkflowEdge, WorkflowNode, WorkflowNodeId, WorkflowTriggerNode,
};
use crate::workflow::definition::handle::{
    WorkflowHandle, WorkflowHandleMode, WorkflowHandleType, parse_workflow_handle,
};
use crate::workflow::kind::{
    WorkflowInputHandleSpec, WorkflowNodeKindCategory, WorkflowOutputHandleSpec, WorkflowParamId,
};

ts_constants! {
    /// A document the daemon's check at save refused; it carries every finding at once.
    WORKFLOW_DEFINITION_REFUSED_CODE = RefusalCode::WorkflowDefinitionRefused;
}

/// Declares the findings: each named rule, with the nodes it marks, then the three findings that
/// also carry a text: a package, why an expression does not parse, and why a command's fill does
/// not expand. The named rules alone also make `WorkflowDefinitionRule`.
macro_rules! workflow_definition_findings {
    ($($(#[doc = $doc:literal])+ $rule:ident,)+) => {
        /// A named rule of a finding that marks only nodes, by which the parameter check names the
        /// finding a refused value raises at save.
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, JsonSchema)]
        #[serde(rename_all = "camelCase")]
        pub enum WorkflowDefinitionRule {
            $(
                $(#[doc = $doc])+
                $rule,
            )+
        }

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
            /// An expression that does not parse, or calls a reader the way no workflow expression
            /// does.
            ExpressionUnparsable {
                /// The nodes the finding marks.
                node_ids: Vec<WorkflowNodeId>,
                /// Why the node's first such expression does not parse; for a reader called as a
                /// method, the spellings that read a node, `$all('<label>')` among them.
                detail: NonEmptyText,
            },
            /// A `Run a command` fill in a place where no reference to it expands, so the value
            /// would not reach the command as one value.
            ExpressionNotExpanded {
                /// The command steps.
                node_ids: Vec<WorkflowNodeId>,
                /// Why the first such fill of the step does not expand, naming the fill, and the
                /// line for a here-document that does not end where bash ends it.
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
    /// A node named as an earlier node is, which an expression naming it could not tell apart,
    /// marking the later node.
    NodeNameDuplicate,
    /// An edge into the trigger.
    EdgeIntoTrigger,
    /// An edge out of a node with no outputs.
    EdgeOutOfTerminal,
    /// An edge joining the same two handles an earlier edge joins, which would hand its target
    /// the same items twice.
    EdgeDuplicate,
    /// A required parameter left empty.
    ParamMissing,
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
    /// A `secret://` reference inside an expression, the `=` form, in any parameter, a sensitive
    /// one included, since no expression resolves a secret.
    SecretInExpression,
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

/// What the graph check reads of a node's kind: its category, the handles the node has, whether
/// it needs a project's repository and which param holds a trigger's `Repository`. For a kind
/// whose outputs derive from its params, `outputs` is what this node's params give; a node that
/// routes failures to an error output lists that output too.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowNodeHandles {
    /// The kind's category.
    pub category: WorkflowNodeKindCategory,
    /// The node's input handles.
    pub inputs: Vec<WorkflowInputHandleSpec>,
    /// The node's output handles.
    pub outputs: Vec<WorkflowOutputHandleSpec>,
    /// Whether a run of the kind needs the run to work in a project's repository.
    pub needs_repository: bool,
    /// The id of the kind's `project` param, which on a trigger is its `Repository`; absent for a
    /// kind that has none.
    #[serde(default, deserialize_with = "crate::wire::present")]
    #[schemars(with = "WorkflowParamId")]
    pub repository_param: Option<WorkflowParamId>,
}

impl WorkflowNodeHandles {
    /// Where the handle an edge names `handle_id` sits among the node's handles on `mode`'s side,
    /// tool handles included, or `None` when the node declares no such handle there.
    pub fn declared_position(&self, handle_id: &str, mode: WorkflowHandleMode) -> Option<usize> {
        match mode {
            WorkflowHandleMode::Inputs => self
                .inputs
                .iter()
                .position(|spec| spec.id_text() == handle_id),
            WorkflowHandleMode::Outputs => self
                .outputs
                .iter()
                .position(|spec| spec.id_text() == handle_id),
        }
    }
}

/// The graph check's arguments as the builder sends them: the document's trigger, its other nodes
/// and edges, and each node's handles by node id, built from the kinds table.
#[derive(Clone, Debug, PartialEq, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowGraphCheckInput {
    /// The trigger node, once placed.
    #[serde(default, deserialize_with = "crate::wire::present")]
    #[schemars(with = "WorkflowTriggerNode")]
    pub trigger: Option<WorkflowTriggerNode>,
    /// The other nodes.
    pub nodes: Vec<WorkflowNode>,
    /// The edges.
    pub edges: Vec<WorkflowEdge>,
    /// Each node's handles by node id.
    pub node_handles: Record<WorkflowNodeId, WorkflowNodeHandles>,
}

/// The connection check's arguments as the builder sends them: the document's trigger, its other
/// nodes and edges, each node's handles, and the one connection being drawn.
#[derive(Clone, Debug, PartialEq, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowConnectionCheckInput {
    /// The trigger node, once placed.
    #[serde(default, deserialize_with = "crate::wire::present")]
    #[schemars(with = "WorkflowTriggerNode")]
    pub trigger: Option<WorkflowTriggerNode>,
    /// The other nodes.
    pub nodes: Vec<WorkflowNode>,
    /// The document's edges; on a reconnect, without the edge being moved.
    pub edges: Vec<WorkflowEdge>,
    /// The connection being drawn, with the id the page will store it under.
    pub edge: WorkflowEdge,
    /// Each node's handles by node id.
    pub node_handles: Record<WorkflowNodeId, WorkflowNodeHandles>,
}

/// The findings for the rules that need only a document's trigger, as a node, its nodes and edges
/// and the kinds' handles: the trigger, an empty document, repeated node names, each edge's nodes,
/// ends and repeats, the inputs over their connection limit, cycles, orphans, then the repository
/// rule, each in document order. `node_handles` holds each node's handles by node id, built by the
/// caller from the kinds table; a node missing from it is of a kind the catalog does not list,
/// whose handles and category then go unchecked though its edges still count toward cycles and
/// reach. An edge naming a node the document does not hold is `nodeMissing` and is checked no
/// further at that end.
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
    findings.extend(graph.repeated_names().into_iter().map(|node_id| {
        WorkflowDefinitionFinding::NodeNameDuplicate {
            node_ids: vec![node_id],
        }
    }));
    let findings_by_edge = graph.findings_by_edge();
    let refused_edges = refused_edge_indices(&findings_by_edge);
    findings.extend(findings_by_edge.into_iter().flatten());
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
    // A trigger whose `Repository` is `None` gives the run no repository for a step that needs one.
    let is_repository_none = trigger.is_some_and(|trigger| {
        node_handles
            .get(&trigger.id)
            .and_then(|handles| handles.repository_param.as_ref())
            .is_some_and(|param| !trigger.params.as_map().contains_key(param.0.as_str()))
    });
    if is_repository_none {
        let node_ids = enabled_nodes_needing(trigger, document_nodes, |node| {
            node_handles
                .get(&node.id)
                .is_some_and(|handles| handles.needs_repository)
        });
        if !node_ids.is_empty() {
            findings.push(WorkflowDefinitionFinding::RepositoryRequired { node_ids });
        }
    }
    findings
}

/// The nodes for which `needs` holds, the trigger first, then in document order, leaving out a
/// disabled node, which never runs.
pub fn enabled_nodes_needing(
    trigger: Option<&WorkflowNode>,
    document_nodes: &[WorkflowNode],
    needs: impl Fn(&WorkflowNode) -> bool,
) -> Vec<WorkflowNodeId> {
    trigger
        .into_iter()
        .chain(document_nodes)
        .filter(|node| node.disabled != Some(true) && needs(node))
        .map(|node| node.id.clone())
        .collect()
}

/// The findings a connection dragged onto the document adds, which the builder refuses while it is
/// dragged: the edge's own rules, the cycle it closes (the edge closing a loop body excepted) and
/// the input limit it passes. One graph is built over the document's edges and the connection,
/// which takes the place of the edge the document holds under its id, so it is never its own
/// repeat; a cycle is the connection's when the connection is a `main` edge whose two ends it
/// holds, and an input past its limit when it is the connection's target handle and the connection
/// is not refused for its own fault. Empty when the connection is accepted.
pub fn check_workflow_connection<S: BuildHasher>(
    trigger: Option<&WorkflowNode>,
    document_nodes: &[WorkflowNode],
    edges: &[WorkflowEdge],
    edge: &WorkflowEdge,
    node_handles: &HashMap<WorkflowNodeId, WorkflowNodeHandles, S>,
) -> Vec<WorkflowDefinitionFinding> {
    let edges_with_connection: Vec<WorkflowEdge> = edges
        .iter()
        .filter(|held| held.id != edge.id)
        .chain(iter::once(edge))
        .cloned()
        .collect();
    let graph = GraphFacts::new(
        trigger,
        document_nodes,
        &edges_with_connection,
        node_handles,
    );
    let mut findings_by_edge = graph.findings_by_edge();
    let refused_edges = refused_edge_indices(&findings_by_edge);
    let mut findings = findings_by_edge
        .pop()
        .expect("the connection is the last edge");
    let is_refused = !findings.is_empty();
    let connection = graph.edges.last().expect("the connection is the last edge");
    if connection.is_main() && !is_refused {
        findings.extend(
            graph
                .cycles()
                .into_iter()
                .filter(|node_ids| {
                    node_ids.contains(&edge.source) && node_ids.contains(&edge.target)
                })
                .map(|node_ids| WorkflowDefinitionFinding::Cycle { node_ids }),
        );
    }
    if !is_refused {
        let target_input = graph.handles_of(&edge.target).and_then(|handles| {
            handles
                .inputs
                .iter()
                .find(|input| input.id_text() == edge.target_handle.as_str())
        });
        if let Some(input) = target_input {
            findings.extend(graph.input_limit_finding(&edge.target, input, &refused_edges));
        }
    }
    findings
}

// The indices of the edges refused for their own fault, which no input limit counts.
fn refused_edge_indices(findings_by_edge: &[Vec<WorkflowDefinitionFinding>]) -> HashSet<usize> {
    findings_by_edge
        .iter()
        .enumerate()
        .filter(|(_, edge_findings)| !edge_findings.is_empty())
        .map(|(edge_index, _)| edge_index)
        .collect()
}

/// A rule one edge can break.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EdgeRule {
    NodeMissing,
    EdgeIntoTrigger,
    EdgeOutOfTerminal,
    EdgeDuplicate,
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
            Self::EdgeDuplicate => WorkflowDefinitionFinding::EdgeDuplicate { node_ids },
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

    // Each node after the first holding a name, in document order, the trigger first.
    fn repeated_names(&self) -> Vec<WorkflowNodeId> {
        let mut names = HashSet::new();
        self.nodes
            .iter()
            .filter(|node| !names.insert(node.name.as_str()))
            .map(|node| node.id.clone())
            .collect()
    }

    // Each edge's own findings, in document order; an edge joining the handles an earlier one
    // joins is a repeat.
    fn findings_by_edge(&self) -> Vec<Vec<WorkflowDefinitionFinding>> {
        let mut joins = HashSet::new();
        self.edges
            .iter()
            .map(|parsed_edge| {
                let WorkflowEdge {
                    source,
                    source_handle,
                    target,
                    target_handle,
                    ..
                } = parsed_edge.edge;
                let is_repeat = !joins.insert((
                    source,
                    source_handle.as_str(),
                    target,
                    target_handle.as_str(),
                ));
                self.edge_findings(parsed_edge, is_repeat)
            })
            .collect()
    }

    // The edge's findings, each marking the ends the document holds.
    fn edge_findings(
        &self,
        parsed_edge: &ParsedEdge<'_>,
        is_repeat: bool,
    ) -> Vec<WorkflowDefinitionFinding> {
        let WorkflowEdge { source, target, .. } = parsed_edge.edge;
        let mut held_end_ids: Vec<WorkflowNodeId> = [source, target]
            .into_iter()
            .filter(|node_id| self.node_by_id.contains_key(node_id))
            .cloned()
            .collect();
        held_end_ids.dedup();
        self.edge_rules(parsed_edge, is_repeat)
            .into_iter()
            .map(|rule| rule.finding(held_end_ids.clone()))
            .collect()
    }

    // One rule at most for each end the document holds; a rule that names the end's problem
    // outright stands in for the undeclared-handle finding it would also raise. Only when both
    // ends name a handle their nodes declare is a join of two types a mismatch, and only an edge
    // breaking no other rule is refused as a repeat.
    fn edge_rules(&self, parsed_edge: &ParsedEdge<'_>, is_repeat: bool) -> Vec<EdgeRule> {
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
        if rules.is_empty() && is_repeat {
            rules.push(EdgeRule::EdgeDuplicate);
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

    /// One finding for each input handle holding more edges than its `maxConnections`, in document
    /// order. An edge already refused for its own fault is not counted, so one bad edge never
    /// raises two findings.
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
                findings.extend(self.input_limit_finding(&node.id, input, refused_edges));
            }
        }
        findings
    }

    /// The finding for one input of `node_id` holding more edges than its `maxConnections`,
    /// marking the node and the sources of the edges past the limit in document order; `None`
    /// within the limit or for an input with none. Edges in `refused_edges` are not counted.
    fn input_limit_finding(
        &self,
        node_id: &WorkflowNodeId,
        input: &WorkflowInputHandleSpec,
        refused_edges: &HashSet<usize>,
    ) -> Option<WorkflowDefinitionFinding> {
        let max_connections = input.max_connections()?;
        let input_id = input.id_text();
        let source_ids: Vec<&WorkflowNodeId> = self
            .edges
            .iter()
            .enumerate()
            .filter(|(edge_index, parsed_edge)| {
                !refused_edges.contains(edge_index)
                    && parsed_edge.edge.target == *node_id
                    && parsed_edge.edge.target_handle.as_str() == input_id
            })
            .map(|(_, parsed_edge)| &parsed_edge.edge.source)
            .collect();
        let limit = usize::try_from(max_connections).unwrap_or(usize::MAX);
        if source_ids.len() <= limit {
            return None;
        }
        let mut marked: Vec<WorkflowNodeId> = vec![node_id.clone()];
        for source_id in &source_ids[limit..] {
            if !marked.contains(*source_id) {
                marked.push((*source_id).clone());
            }
        }
        Some(WorkflowDefinitionFinding::InputConnectionsExceeded { node_ids: marked })
    }

    /// Every cycle among `main` edges as its nodes in document order, found as the strongly
    /// connected components of more than one node or with a self-edge. An edge into a loop node's
    /// input closes the loop body and is left out, unless it is the loop node's own self-edge.
    fn cycles(&self) -> Vec<Vec<WorkflowNodeId>> {
        let node_ids: Vec<&WorkflowNodeId> = self.nodes.iter().map(|node| &node.id).collect();
        let mut graph: DiGraph<&WorkflowNodeId, ()> =
            DiGraph::with_capacity(node_ids.len(), self.edges.len());
        // A repeated id is one node of the graph, as it is one key of `node_by_id`.
        let mut index_by_node_id: HashMap<&WorkflowNodeId, NodeIndex> = HashMap::new();
        for &node_id in &node_ids {
            index_by_node_id
                .entry(node_id)
                .or_insert_with(|| graph.add_node(node_id));
        }
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
            if let (Some(&source_index), Some(&target_index)) =
                (index_by_node_id.get(source), index_by_node_id.get(target))
            {
                graph.add_edge(source_index, target_index, ());
                if source == target {
                    self_edge_node_ids.insert(source);
                }
            }
        }
        // Kosaraju's search walks with its own stack, so a long chain cannot exhaust the call
        // stack.
        let mut component_by_node_id = HashMap::new();
        for (component_index, component) in kosaraju_scc(&graph).iter().enumerate() {
            let is_cycle = component.len() > 1
                || component
                    .iter()
                    .any(|&index| self_edge_node_ids.contains(graph[index]));
            if is_cycle {
                for &index in component {
                    component_by_node_id.insert(graph[index], component_index);
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
    let is_listed =
        handles.is_none_or(|handles| handles.declared_position(handle_id, mode).is_some());
    handle.is_type_known && handle.mode == mode && is_listed
}

/// The TypeScript module of the definition refusal and the graph checks' arguments.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "workflow/definition/refusals",
    doc: "The refusal a save answers with when a document breaks a rule, and the arguments of the \
          graph and connection checks.",
    definitions: &[
        Definition::read::<WorkflowDefinitionRule>(),
        Definition::read::<WorkflowDefinitionFinding>(),
        Definition::read::<WorkflowDefinitionRefusedDetails>(),
        Definition::read::<WorkflowNodeHandles>(),
        Definition::read::<WorkflowGraphCheckInput>(),
        Definition::read::<WorkflowConnectionCheckInput>(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};

#[cfg(test)]
mod tests;
