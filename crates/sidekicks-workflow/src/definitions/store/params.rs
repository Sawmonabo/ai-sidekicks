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
    let mut bindings: Vec<(Vec<IssuePathSegment>, &Value)> = Vec::new();
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
                if let Some((place, binding)) = tool_binding_at(specs, &params, &issue.path)
                    && !bindings.iter().any(|(found, _)| *found == place)
                {
                    bindings.push((place, binding));
                }
            }
        }
    }
    let mut unreadable = Vec::new();
    for (place, binding) in bindings {
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

// The tool binding param at or above `path`, a place the check names: its place, as the steps
// into the node's params, a member per param and an index per entry of a repeating collection,
// and the value `params` holds there. `None` where the param there is no tool binding.
fn tool_binding_at<'params>(
    specs: &[WorkflowParamSpec],
    params: &'params Map<String, Value>,
    path: &[IssuePathSegment],
) -> Option<(Vec<IssuePathSegment>, &'params Value)> {
    let mut steps = path.iter();
    let mut specs = specs;
    let mut values = params;
    let mut place = Vec::new();
    loop {
        let step = steps.next()?;
        let IssuePathSegment::Member(id) = step else {
            return None;
        };
        place.push(step.clone());
        let value = values.get(id)?;
        match specs.iter().find(|spec| match spec {
            WorkflowParamSpec::Leaf(leaf) => leaf.id.0.as_str() == id,
            WorkflowParamSpec::Collection(collection) => collection.id.0.as_str() == id,
        })? {
            WorkflowParamSpec::Leaf(leaf) => {
                return (leaf.param_type == WorkflowParamType::McpTool).then_some((place, value));
            }
            WorkflowParamSpec::Collection(collection) => {
                let fields = if collection.multiple == Some(true) {
                    let step = steps.next()?;
                    let IssuePathSegment::Index(index) = step else {
                        return None;
                    };
                    place.push(step.clone());
                    value.get(usize::try_from(index.get()).ok()?)?
                } else {
                    value
                };
                values = fields.as_object()?;
                specs = &collection.fields;
            }
        }
    }
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
