use std::collections::HashMap;
use std::rc::Rc;

use jiff::Timestamp;
use jiff::tz::TimeZone;
use jsonata_core::evaluator::EvaluatorOptions;
use jsonata_core::parser::parse;
use rstest::rstest;
use serde_json::{Map, Value, json};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::workflow::definition::document::{
    WorkflowDefinitionId, WorkflowName, WorkflowNodeId,
};
use sidekicks_contracts::workflow::definition::item::WorkflowItem;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::trigger::WorkflowTriggerKind;

use super::{ExpressionBindings, ExpressionError};
use crate::definitions::kept_values::WorkflowKeptValue;
use crate::expressions::lineage::{LineageError, StepKey, StepOutput, StepOutputs};
use crate::runs::creation::WorkflowRunTrigger;

const RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e62";
const DEFINITION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e60";

fn node_id(id: &str) -> WorkflowNodeId {
    WorkflowNodeId::new(id.to_owned()).expect("a node id")
}

fn step_key(id: &str) -> StepKey {
    StepKey {
        node_id: node_id(id),
        execution_index: 0,
    }
}

fn from_json<T: serde::de::DeserializeOwned>(json: Value) -> T {
    serde_json::from_value(json).expect("the fixture reads")
}

/// The step `current`, fed by `source`'s two items and evaluating its input item 1 in loop run 2,
/// in a run whose instant is 15:00 UTC on 4 March 2025, which is already 5 March on Kiritimati.
/// `empty` ran with no items; the project holds a plain row and a credential-shaped one.
fn bindings() -> ExpressionBindings {
    let source_items: Vec<WorkflowItem> = vec![
        from_json(json!({ "json": { "name": "Bob" }, "pairedItem": { "item": 0 } })),
        from_json(json!({ "json": { "name": "Ada" }, "pairedItem": { "item": 0 } })),
    ];
    let mut steps = StepOutputs::new(
        ["trigger", "source", "empty", "current"].map(|label| (node_id(label), label.to_owned())),
    );
    steps.record(
        step_key("trigger"),
        StepOutput {
            sources: vec![],
            outputs: vec![vec![from_json(json!({ "json": {} }))]],
        },
    );
    steps.record(
        step_key("source"),
        StepOutput {
            sources: vec![from_json(
                json!({ "nodeId": "trigger", "outputIndex": 0, "executionIndex": 0 }),
            )],
            outputs: vec![source_items.clone()],
        },
    );
    steps.record(
        step_key("empty"),
        StepOutput {
            sources: vec![],
            outputs: vec![vec![]],
        },
    );
    steps.record(
        step_key("current"),
        StepOutput {
            sources: vec![from_json(
                json!({ "nodeId": "source", "outputIndex": 0, "executionIndex": 0 }),
            )],
            outputs: vec![],
        },
    );
    let instant: Timestamp = "2025-03-04T15:00:00Z".parse().expect("an instant");
    let run_id = WorkflowRunId::new(RUN_ID).expect("a run id");
    ExpressionBindings {
        step: step_key("current"),
        input_items: source_items.into(),
        steps: Rc::new(steps),
        node_params: Rc::new(HashMap::from([(
            node_id("source"),
            from_json(json!({ "mode": "fast" })),
        )])),
        run_index: 2,
        item_index: 1,
        instant,
        time_zone: TimeZone::get("Pacific/Kiritimati").expect("a zone"),
        environment_rows: vec![
            from_json(json!({ "name": "REGION", "value": "eu" })),
            from_json(json!({ "name": "GITHUB_TOKEN", "value": "leaked-value" })),
        ]
        .into(),
        run_variables: Rc::new(
            [("both".to_owned(), json!("this run's"))]
                .into_iter()
                .collect::<Map<String, Value>>(),
        ),
        kept_values: vec![
            WorkflowKeptValue {
                name: "kept".to_owned(),
                value: json!("kept earlier"),
                kept_by_run_id: run_id,
                kept_at: WireInstant::from_timestamp(instant).expect("an instant"),
            },
            WorkflowKeptValue {
                name: "both".to_owned(),
                value: json!("kept earlier"),
                kept_by_run_id: run_id,
                kept_at: WireInstant::from_timestamp(instant).expect("an instant"),
            },
        ]
        .into(),
        run_id,
        run_started_at: WireInstant::from_timestamp(instant).expect("an instant"),
        run_trigger: WorkflowRunTrigger {
            kind: WorkflowTriggerKind::Manual,
            node_id: node_id("trigger"),
        },
        workflow_id: WorkflowDefinitionId::new(DEFINITION_ID).expect("a definition id"),
        workflow_name: WorkflowName::new("Nightly".to_owned()).expect("a name"),
    }
}

/// `expression`'s value against [`bindings`], read back as JSON.
fn evaluated(expression: &str) -> Result<Value, ExpressionError> {
    bindings()
        .evaluate(
            &parse(expression).expect("the expression parses"),
            EvaluatorOptions::default(),
        )
        .map(|value| Value::from(&value))
}

/// Each binding reads what it names, and each absent case reads as its row says: no first item
/// of an empty node, no variable nobody set.
#[rstest]
#[case::json("$json.name", json!("Ada"))]
#[case::own_input(
    "[$first().json.name, $last().json.name, $item().json.name, $count($all())]",
    json!(["Bob", "Ada", "Ada", 2.0])
)]
#[case::labeled_node(
    "[$first('source').json.name, $last('source').json.name, $count($all('source'))]",
    json!(["Bob", "Ada", 2.0])
)]
#[case::linked_item("$item('source').json.name", json!("Ada"))]
#[case::empty_node("$exists($first('empty'))", json!(false))]
#[case::params("$params('source').mode", json!("fast"))]
#[case::indexes("[$runIndex, $itemIndex]", json!([2.0, 1.0]))]
#[case::now_value("$now", json!("2025-03-04T15:00:00.000Z"))]
#[case::now_call("$now()", json!("2025-03-04T15:00:00.000Z"))]
#[case::now_picture(
    "$now('[Y0001]-[M01]-[D01] [H01]:[m01]', '+0100')",
    json!("2025-03-04 16:00")
)]
#[case::millis("$string($millis())", json!("1741100400000"))]
#[case::today("$today", json!("2025-03-05"))]
#[case::env("$env.REGION", json!("eu"))]
#[case::vars(
    "[$vars.kept, $vars.both, $exists($vars.never)]",
    json!(["kept earlier", "this run's", false])
)]
#[case::run(
    "[$run.id, $run.startedAt, $run.trigger.kind, $run.trigger.nodeId]",
    json!([RUN_ID, "2025-03-04T15:00:00.000Z", "trigger.manual", "trigger"])
)]
#[case::workflow("[$workflow.id, $workflow.name]", json!([DEFINITION_ID, "Nightly"]))]
fn each_binding_reads_what_it_names(#[case] expression: &str, #[case] expected: Value) {
    assert_eq!(
        evaluated(expression).expect("the expression evaluates"),
        expected
    );
}

/// A read of `$env` by a credential's name is refused before evaluating, and a credential-shaped
/// row's value is never bound, so no spelling the refusal misses reaches it.
#[test]
fn env_never_answers_a_credentials_name() {
    assert!(matches!(
        evaluated("$env.GITHUB_TOKEN"),
        Err(ExpressionError::CredentialEnvironmentName { name }) if name == "GITHUB_TOKEN"
    ));
    assert!(matches!(
        evaluated("$uppercase($lookup($env, 'GITHUB_TOKEN'))"),
        Err(ExpressionError::CredentialEnvironmentName { name }) if name == "GITHUB_TOKEN"
    ));
    assert_eq!(
        evaluated("[$string($env), $lookup($env, 'GITHUB' & '_TOKEN')]")
            .expect("the expression evaluates"),
        json!([r#"{"REGION":"eu"}"#])
    );
}

/// A label no node has is a typed error naming it, read back from the evaluation.
#[test]
fn an_unknown_label_is_a_typed_error() {
    assert!(matches!(
        evaluated("$item('nowhere')"),
        Err(ExpressionError::Lineage(LineageError::UnknownLabel { label })) if label == "nowhere"
    ));
    assert!(matches!(
        evaluated("$first('nowhere')"),
        Err(ExpressionError::Lineage(LineageError::UnknownLabel { label })) if label == "nowhere"
    ));
}
