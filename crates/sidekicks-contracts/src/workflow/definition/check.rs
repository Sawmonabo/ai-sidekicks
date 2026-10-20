//! The workflow checks as WebAssembly exports for the builder, which runs them in the page while a
//! connection is dragged and before a save, so it refuses what the daemon's check at save refuses.
//! Each takes its arguments as one JSON text, each node's handles among them as data, and answers
//! JSON text; a text that does not read throws.

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::{Map, Value};
use wasm_bindgen::JsError;
use wasm_bindgen::prelude::wasm_bindgen;

use crate::workflow::definition::document::{
    WorkflowEdge, WorkflowNode, WorkflowNodeId, WorkflowTriggerNode,
};
use crate::workflow::definition::params::check_workflow_node_params;
use crate::workflow::definition::refusals::{
    WorkflowNodeHandles, check_workflow_connection, check_workflow_graph,
};
use crate::workflow::kind::WorkflowParamSpec;

/// The graph check's arguments: the document's trigger, its other nodes and edges, and each node's
/// handles by node id, built from the kinds table.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GraphCheckInput {
    #[serde(default, deserialize_with = "crate::wire::present")]
    trigger: Option<WorkflowTriggerNode>,
    nodes: Vec<WorkflowNode>,
    edges: Vec<WorkflowEdge>,
    node_handles: HashMap<WorkflowNodeId, WorkflowNodeHandles>,
}

/// The connection check's arguments: the document's trigger, its other nodes and edges, each
/// node's handles, and the one connection being drawn.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConnectionCheckInput {
    #[serde(default, deserialize_with = "crate::wire::present")]
    trigger: Option<WorkflowTriggerNode>,
    nodes: Vec<WorkflowNode>,
    edges: Vec<WorkflowEdge>,
    edge: WorkflowEdge,
    node_handles: HashMap<WorkflowNodeId, WorkflowNodeHandles>,
}

/// The parameter check's arguments: one node's parameters and its kind's parameter list.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NodeParamsCheckInput {
    params: Map<String, Value>,
    specs: Vec<WorkflowParamSpec>,
}

/// Runs the graph check over `{trigger?, nodes, edges, nodeHandles}` and answers its findings as a
/// JSON array, empty when the graph is accepted; throws when the input does not read.
#[wasm_bindgen(js_name = checkWorkflowGraph)]
pub fn check_workflow_graph_json(input: &str) -> Result<String, JsError> {
    let input: GraphCheckInput = serde_json::from_str(input)?;
    let trigger = input.trigger.as_ref().map(WorkflowNode::from);
    let findings = check_workflow_graph(
        trigger.as_ref(),
        &input.nodes,
        &input.edges,
        &input.node_handles,
    );
    Ok(serde_json::to_string(&findings)?)
}

/// Runs the connection check over `{trigger?, nodes, edges, edge, nodeHandles}` and answers the
/// findings the connection adds to the document as a JSON array, empty when it is accepted; throws
/// when the input does not read.
#[wasm_bindgen(js_name = checkWorkflowConnection)]
pub fn check_workflow_connection_json(input: &str) -> Result<String, JsError> {
    let input: ConnectionCheckInput = serde_json::from_str(input)?;
    let trigger = input.trigger.as_ref().map(WorkflowNode::from);
    let findings = check_workflow_connection(
        trigger.as_ref(),
        &input.nodes,
        &input.edges,
        &input.edge,
        &input.node_handles,
    );
    Ok(serde_json::to_string(&findings)?)
}

/// Runs the parameter check over `{params, specs}` and answers the refused values as a JSON array
/// of `{path, message}`, empty when every value is accepted; throws when the input does not read.
#[wasm_bindgen(js_name = checkWorkflowNodeParams)]
pub fn check_workflow_node_params_json(input: &str) -> Result<String, JsError> {
    let input: NodeParamsCheckInput = serde_json::from_str(input)?;
    let issues = check_workflow_node_params(&input.params, &input.specs);
    Ok(serde_json::to_string(&issues)?)
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::{Value, json};

    use super::{
        check_workflow_connection_json, check_workflow_graph_json, check_workflow_node_params_json,
    };
    use crate::workflow::definition::document::node;

    fn graph_input() -> Value {
        json!({
            "trigger": node("t", "trigger.manual"),
            "nodes": [node("a", "agent.run"), node("b", "agent.run")],
            "nodeHandles": {
                "t": {
                    "category": "trigger",
                    "inputs": [],
                    "outputs": [{ "type": "main", "id": "outputs/main/0", "label": "Out" }],
                },
                "a": {
                    "category": "agent",
                    "inputs": [{ "type": "main", "id": "inputs/main/0", "label": "In" }],
                    "outputs": [{ "type": "main", "id": "outputs/main/0", "label": "Out" }],
                },
                "b": {
                    "category": "agent",
                    "inputs": [{
                        "type": "main", "id": "inputs/main/0", "label": "In", "maxConnections": 1,
                    }],
                    "outputs": [{ "type": "main", "id": "outputs/main/0", "label": "Out" }],
                },
            },
        })
    }

    fn with(mut input: Value, key: &str, value: Value) -> Value {
        input[key] = value;
        input
    }

    fn edge(source: &str, target: &str) -> Value {
        json!({
            "id": format!("{source}-{target}"),
            "source": source,
            "sourceHandle": "outputs/main/0",
            "target": target,
            "targetHandle": "inputs/main/0",
        })
    }

    // Each export reads its arguments from the JSON the page sends and answers the findings in the
    // JSON the page reads.
    #[rstest]
    #[case::the_graph_check(
        check_workflow_graph_json,
        with(graph_input(), "edges", json!([edge("t", "a")])),
        json!([{ "rule": "orphan", "nodeIds": ["b"] }]),
    )]
    #[case::the_connection_check(
        check_workflow_connection_json,
        with(with(graph_input(), "edges", json!([])), "edge", edge("a", "t")),
        json!([{ "rule": "edgeIntoTrigger", "nodeIds": ["a", "t"] }]),
    )]
    #[case::the_connection_check_closing_a_cycle(
        check_workflow_connection_json,
        with(
            with(graph_input(), "edges", json!([edge("t", "a"), edge("a", "b")])),
            "edge",
            edge("b", "a"),
        ),
        json!([{ "rule": "cycle", "nodeIds": ["a", "b"] }]),
    )]
    #[case::the_connection_check_past_an_input_limit(
        check_workflow_connection_json,
        with(
            with(graph_input(), "edges", json!([edge("t", "a"), edge("t", "b")])),
            "edge",
            edge("a", "b"),
        ),
        json!([{ "rule": "inputConnectionsExceeded", "nodeIds": ["b", "a"] }]),
    )]
    #[case::the_node_params_check(
        check_workflow_node_params_json,
        json!({
            "params": { "prompt": "secret://shared/mail" },
            "specs": [{ "id": "prompt", "label": "Prompt", "type": "text" }],
        }),
        json!([{
            "path": "prompt",
            "message": "A secret:// reference stands only in a parameter its kind marks sensitive.",
        }]),
    )]
    fn each_export_answers_its_checks_findings_as_json(
        #[case] export: fn(&str) -> Result<String, wasm_bindgen::JsError>,
        #[case] input: Value,
        #[case] findings: Value,
    ) {
        let answer = export(&input.to_string()).expect("the input reads");
        let answer: Value = serde_json::from_str(&answer).expect("the answer is JSON");
        assert_eq!(answer, findings);
    }
}
