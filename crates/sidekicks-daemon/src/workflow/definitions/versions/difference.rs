//! The structural difference between two saved versions, over the hashed body alone: a node is
//! matched by its id and an edge by its id, so a moved node or a changed tag is never a change.

use std::collections::{HashMap, HashSet};

use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::document::{
    WorkflowDocumentHashedBody, WorkflowEdge, WorkflowNodeId,
};
use sidekicks_contracts::workflow::definition::versions::{
    WorkflowVersionChangeCounts, WorkflowVersionDiffReadResponse, WorkflowVersionNode,
    WorkflowVersionNodeChange,
};

/// The nodes added, removed and changed, the trigger counted as a node and compared whole with its
/// inputs, and the edges added and removed between two bodies. An edge whose id stays while its
/// ends move is one removed and one added, since an edge has nothing to change but its ends.
pub(crate) fn diff_workflow_bodies(
    before: &WorkflowDocumentHashedBody,
    after: &WorkflowDocumentHashedBody,
) -> WorkflowVersionDiffReadResponse {
    let before_nodes = version_nodes(before);
    let after_nodes = version_nodes(after);
    let before_node_by_id: HashMap<&WorkflowNodeId, &WorkflowVersionNode> = before_nodes
        .iter()
        .map(|node| (node_id(node), node))
        .collect();
    let after_node_ids: HashSet<&WorkflowNodeId> = after_nodes.iter().map(node_id).collect();
    let mut nodes_added = Vec::new();
    let mut nodes_changed = Vec::new();
    for after_node in &after_nodes {
        match before_node_by_id.get(node_id(after_node)) {
            None => nodes_added.push(after_node.clone()),
            Some(&before_node) if before_node != after_node => {
                nodes_changed.push(WorkflowVersionNodeChange {
                    before: before_node.clone(),
                    after: after_node.clone(),
                });
            }
            Some(_) => {}
        }
    }
    let nodes_removed = before_nodes
        .iter()
        .filter(|node| !after_node_ids.contains(node_id(node)))
        .cloned()
        .collect();
    WorkflowVersionDiffReadResponse {
        nodes_added,
        nodes_removed,
        nodes_changed,
        edges_added: edges_missing_from(&after.edges, &before.edges),
        edges_removed: edges_missing_from(&before.edges, &after.edges),
    }
}

/// How many nodes and edges a difference names, which a version list entry carries.
pub(crate) fn count_workflow_changes(
    difference: &WorkflowVersionDiffReadResponse,
) -> WorkflowVersionChangeCounts {
    WorkflowVersionChangeCounts {
        nodes_added: count(difference.nodes_added.len()),
        nodes_removed: count(difference.nodes_removed.len()),
        nodes_changed: count(difference.nodes_changed.len()),
        edges_added: count(difference.edges_added.len()),
        edges_removed: count(difference.edges_removed.len()),
    }
}

// The body's nodes as a difference carries them: the trigger first, with its inputs, then the rest.
fn version_nodes(body: &WorkflowDocumentHashedBody) -> Vec<WorkflowVersionNode> {
    std::iter::once(WorkflowVersionNode::Trigger(body.trigger.clone()))
        .chain(body.nodes.iter().cloned().map(WorkflowVersionNode::Node))
        .collect()
}

fn node_id(node: &WorkflowVersionNode) -> &WorkflowNodeId {
    match node {
        WorkflowVersionNode::Node(node) => &node.id,
        WorkflowVersionNode::Trigger(trigger) => &trigger.id,
    }
}

// The edges of `edges` that `others` holds no identical edge of the same id for.
fn edges_missing_from(edges: &[WorkflowEdge], others: &[WorkflowEdge]) -> Vec<WorkflowEdge> {
    let other_by_id: HashMap<_, _> = others.iter().map(|edge| (&edge.id, edge)).collect();
    edges
        .iter()
        .filter(|edge| other_by_id.get(&edge.id).is_none_or(|other| other != edge))
        .cloned()
        .collect()
}

fn count(length: usize) -> SafeInt<0> {
    u64::try_from(length)
        .ok()
        .and_then(SafeInt::new)
        .expect("a list held in memory is shorter than 2^53 items")
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};
    use sidekicks_contracts::workflow::definition::document::WorkflowDocumentHashedBody;
    use sidekicks_contracts::workflow::definition::versions::{
        WorkflowVersionNode, WorkflowVersionNodeChange,
    };

    use super::diff_workflow_bodies;

    /// A body whose trigger declares one text input starting on `default`.
    fn body_with_trigger_input(default: &str) -> WorkflowDocumentHashedBody {
        let trigger: Value = json!({
            "id": "trigger", "kind": "trigger.manual", "kindVersion": 1, "name": "Start",
            "order": 0, "params": {},
            "inputs": [{ "type": "string", "name": "topic", "default": default }],
        });
        serde_json::from_value(json!({
            "name": "Nightly",
            "trigger": trigger,
            "nodes": [{
                "id": "read", "kind": "files.read", "kindVersion": 1, "name": "Read notes",
                "order": 0, "params": { "path": "notes.md" },
            }],
            "edges": [{
                "id": "trigger-to-read", "source": "trigger", "sourceHandle": "outputs/main/0",
                "target": "read", "targetHandle": "inputs/main/0",
            }],
        }))
        .expect("the body reads")
    }

    /// A version that changed only the trigger's inputs names the trigger changed and carries both
    /// input lists. Mutation: compare the trigger after converting it to a plain node.
    #[test]
    fn an_inputs_only_change_names_the_trigger_with_both_input_lists() {
        let before = body_with_trigger_input("weekly");
        let after = body_with_trigger_input("daily");
        let difference = diff_workflow_bodies(&before, &after);
        assert_eq!(
            difference.nodes_changed,
            vec![WorkflowVersionNodeChange {
                before: WorkflowVersionNode::Trigger(before.trigger),
                after: WorkflowVersionNode::Trigger(after.trigger),
            }]
        );
        assert_eq!(difference.nodes_added, []);
        assert_eq!(difference.nodes_removed, []);
        assert_eq!(difference.edges_added, []);
        assert_eq!(difference.edges_removed, []);
    }
}
