//! The save's check of each node's params against its kind's param list: a value whose fault a
//! finding names becomes that finding, and a tool binding that does not read as one is refused as
//! the request's own read refuses a value, each fault at its field.

use serde_json::{Map, Value};
use sidekicks_contracts::jsonrpc::issue::{
    ISSUE_PATH_SEGMENTS_MAX, Issue, IssuePathSegment, received_issues,
};
use sidekicks_contracts::schema::ReceivedCheckError;
use sidekicks_contracts::wire::attachment::check_received;
use sidekicks_contracts::workflow::definition::document::{
    WorkflowNode, WorkflowNodeId, WorkflowToolBinding,
};
use sidekicks_contracts::workflow::definition::params::check_workflow_node_params;
use sidekicks_contracts::workflow::definition::refusals::{
    WorkflowDefinitionFinding, WorkflowDefinitionRule,
};
use sidekicks_contracts::workflow::kind::{WorkflowParamSpec, WorkflowParamType};

/// What one node's params raise at a save.
pub(super) struct NodeParamFaults {
    /// The findings, at most one per rule.
    pub(super) findings: Vec<WorkflowDefinitionFinding>,
    /// Each fault of a tool binding that does not read as one, at its place in the save's request.
    pub(super) unreadable: Vec<Issue>,
}

/// Checks `node`'s params against `specs`, its kind's param list, `node_place` being the node's
/// place in the save's request. Fails where a tool binding's contract check cannot be built, which
/// is no fault of the document.
pub(super) fn check_node_params(
    node: &WorkflowNode,
    node_place: &[IssuePathSegment],
    specs: &[WorkflowParamSpec],
) -> Result<NodeParamFaults, ReceivedCheckError> {
    let params: Map<String, Value> = node
        .params
        .as_map()
        .iter()
        .map(|(id, value)| (id.clone(), value.0.clone()))
        .collect();
    let mut rules: Vec<WorkflowDefinitionRule> = Vec::new();
    let mut binding_places: Vec<Vec<IssuePathSegment>> = Vec::new();
    for issue in check_workflow_node_params(&params, specs) {
        match issue.rule {
            Some(rule) => {
                if !rules.contains(&rule) {
                    rules.push(rule);
                }
            }
            // A value no finding names is a reference that does not read as one; of those, a tool
            // binding is refused as the request's read would refuse it.
            None => {
                if let Some(place) = tool_binding_place(specs, &issue.path)
                    && !binding_places.contains(&place)
                {
                    binding_places.push(place);
                }
            }
        }
    }
    let mut unreadable = Vec::new();
    for place in binding_places {
        let binding = value_at(&params, &place).expect("the check refused a value the node holds");
        let json = serde_json::to_vec(binding).expect("a JSON value writes");
        if let Err(refused) = check_received::<WorkflowToolBinding>(&json, Vec::new()) {
            for issue in received_issues(refused)? {
                let mut path: Vec<IssuePathSegment> = node_place
                    .iter()
                    .cloned()
                    .chain([IssuePathSegment::Member("params".to_owned())])
                    .chain(place.iter().cloned())
                    .chain(issue.path)
                    .collect();
                path.truncate(ISSUE_PATH_SEGMENTS_MAX);
                unreadable.push(Issue { path, ..issue });
            }
        }
    }
    Ok(NodeParamFaults {
        findings: rules
            .into_iter()
            .map(|rule| node_finding(rule, &node.id))
            .collect(),
        unreadable,
    })
}

// The place of the tool binding param at or above `path`, a dotted place the check names, as the
// steps into the node's params: a member per param and an index per entry of a repeating
// collection. `None` where the param there is no tool binding.
fn tool_binding_place(specs: &[WorkflowParamSpec], path: &str) -> Option<Vec<IssuePathSegment>> {
    let mut steps = path.split('.');
    let mut specs = specs;
    let mut place = Vec::new();
    loop {
        let id = steps.next()?;
        place.push(IssuePathSegment::Member(id.to_owned()));
        match specs.iter().find(|spec| match spec {
            WorkflowParamSpec::Leaf(leaf) => leaf.id.0.as_str() == id,
            WorkflowParamSpec::Collection(collection) => collection.id.0.as_str() == id,
        })? {
            WorkflowParamSpec::Leaf(leaf) => {
                return (leaf.param_type == WorkflowParamType::McpTool).then_some(place);
            }
            WorkflowParamSpec::Collection(collection) => {
                if collection.multiple == Some(true) {
                    let index = steps.next()?.parse::<usize>().ok()?;
                    place.push(IssuePathSegment::index(index));
                }
                specs = &collection.fields;
            }
        }
    }
}

// The value `params` holds at `place`.
fn value_at<'params>(
    params: &'params Map<String, Value>,
    place: &[IssuePathSegment],
) -> Option<&'params Value> {
    let (first, rest) = place.split_first()?;
    let IssuePathSegment::Member(id) = first else {
        return None;
    };
    rest.iter()
        .try_fold(params.get(id)?, |value, step| match step {
            IssuePathSegment::Member(name) => value.get(name),
            IssuePathSegment::Index(index) => value.get(usize::try_from(index.get()).ok()?),
        })
}

// The finding of `rule` marking `node_id`. Each named rule is the tag of the finding of its name
// that marks only nodes, so the rule reads as that finding.
fn node_finding(
    rule: WorkflowDefinitionRule,
    node_id: &WorkflowNodeId,
) -> WorkflowDefinitionFinding {
    serde_json::from_value(serde_json::json!({ "rule": rule, "nodeIds": [node_id] }))
        .expect("a named rule is the tag of a finding that marks only nodes")
}
