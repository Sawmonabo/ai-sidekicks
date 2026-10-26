use std::collections::HashMap;

use rstest::rstest;
use serde_json::{Value, json};

use super::{
    WorkflowConnectionCheckInput, WorkflowGraphCheckInput, WorkflowNodeHandles,
    check_workflow_connection, check_workflow_graph,
};
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
            json!([
                limited_in,
                { "type": "main", "id": "inputs/main/1", "label": "Also", "maxConnections": 1 }
            ]),
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

// The connection check answers only what the dragged edge adds: its own rules, the cycle it
// closes, the input limit it passes, never a finding the document already holds, and no cycle for
// the edge that closes a loop body. An edge joining a cycle or an input limit the document already
// breaks, or repeating a bad edge it already holds, is still refused; a non-`main` edge closes no
// cycle, an edge refused for its own fault closes no cycle and passes no input limit, a refused
// edge the document holds counts toward no limit, and only the target handle's limit is checked.
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
    json!([main_edge("a", "b"), main_edge("b", "a")]),
    main_edge("t", "a"),
    json!([]),
)]
#[case::a_connection_inside_a_cycle_the_document_holds(
    json!([node("a", "agent.run"), node("b", "agent.run")]),
    json!([main_edge("t", "a"), main_edge("a", "b"), main_edge("b", "a")]),
    main_edge("b", "a"),
    json!([{ "rule": "cycle", "nodeIds": ["a", "b"] }]),
)]
#[case::a_connection_into_an_input_already_past_its_limit(
    json!([node("l", "flow.loopItems"), node("n", "output.notify")]),
    json!([main_edge("t", "l"), main_edge("t", "n"), main_edge("l", "n")]),
    edge("l", "outputs/main/1", "n", "inputs/main/0"),
    json!([{ "rule": "inputConnectionsExceeded", "nodeIds": ["n", "l"] }]),
)]
#[case::a_bad_connection_the_document_already_holds(
    json!([node("a", "agent.run"), node("b", "agent.run")]),
    json!([main_edge("t", "a"), main_edge("b", "t")]),
    main_edge("b", "t"),
    json!([{ "rule": "edgeIntoTrigger", "nodeIds": ["b", "t"] }]),
)]
#[case::a_mismatched_connection_between_nodes_of_a_cycle(
    json!([node("a", "agent.run"), node("b", "agent.run")]),
    json!([main_edge("t", "a"), main_edge("a", "b"), main_edge("b", "a")]),
    edge("a", "outputs/main/0", "b", "inputs/tool/0"),
    json!([{ "rule": "handleTypeMismatch", "nodeIds": ["a", "b"] }]),
)]
#[case::a_refused_connection_into_an_input_already_past_its_limit(
    json!([node("a", "agent.run"), node("n", "output.notify"), node("m", "developer.mcpTool")]),
    json!([main_edge("t", "a"), main_edge("t", "n"), main_edge("a", "n")]),
    edge("m", "outputs/tool/0", "n", "inputs/main/0"),
    json!([{ "rule": "handleTypeMismatch", "nodeIds": ["m", "n"] }]),
)]
#[case::a_refused_connection_between_nodes_of_a_cycle_the_document_holds(
    json!([node("a", "agent.run"), node("b", "agent.run")]),
    json!([main_edge("t", "a"), main_edge("a", "b"), main_edge("b", "a")]),
    edge("b", "outputs/main/7", "a", "inputs/main/0"),
    json!([{ "rule": "handleTypeUnknown", "nodeIds": ["b", "a"] }]),
)]
#[case::an_accepted_connection_beside_an_input_already_past_its_limit(
    json!([node("a", "agent.run"), node("b", "agent.run"), node("n", "output.notify")]),
    json!([main_edge("t", "a"), main_edge("t", "n"), main_edge("a", "n")]),
    main_edge("a", "b"),
    json!([]),
)]
#[case::a_refused_edge_the_document_holds_counts_toward_no_limit(
    json!([node("a", "agent.run"), node("n", "output.notify"), node("m", "developer.mcpTool")]),
    json!([main_edge("t", "a"), edge("m", "outputs/tool/0", "n", "inputs/main/0")]),
    main_edge("a", "n"),
    json!([]),
)]
#[case::a_connection_past_the_limit_of_a_second_input(
    json!([node("a", "agent.run"), node("b", "agent.run"), node("n", "output.notify")]),
    json!([main_edge("t", "a"), main_edge("t", "b"), edge("a", "outputs/main/0", "n", "inputs/main/1")]),
    edge("b", "outputs/main/0", "n", "inputs/main/1"),
    json!([{ "rule": "inputConnectionsExceeded", "nodeIds": ["n", "b"] }]),
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

// Killed by `node_handles` typed as a plain map: the member `__proto__` would then read and its
// handles reach the check.
#[rstest]
#[case::the_graph_check(|mut input: Value| {
    input.as_object_mut().expect("an object").remove("edge");
    serde_json::from_value::<WorkflowGraphCheckInput>(input).is_err()
})]
#[case::the_connection_check(|input: Value| {
    serde_json::from_value::<WorkflowConnectionCheckInput>(input).is_err()
})]
fn a_prototype_member_among_the_node_handles_does_not_read(
    #[case] does_not_read: fn(Value) -> bool,
) {
    let handles = json!({
        "category": "agent",
        "inputs": [{ "type": "main", "id": "inputs/main/0", "label": "In" }],
        "outputs": [{ "type": "main", "id": "outputs/main/0", "label": "Out" }],
    });
    let input = json!({
        "trigger": node("t", "trigger.manual"),
        "nodes": [node("a", "agent.run")],
        "edges": [],
        "edge": main_edge("t", "a"),
        "nodeHandles": { "a": handles, "__proto__": handles },
    });
    let mut accepted = input.clone();
    accepted["nodeHandles"]
        .as_object_mut()
        .expect("an object")
        .remove("__proto__");
    assert!(
        !does_not_read(accepted),
        "the input without the member reads"
    );
    assert!(does_not_read(input));
}
