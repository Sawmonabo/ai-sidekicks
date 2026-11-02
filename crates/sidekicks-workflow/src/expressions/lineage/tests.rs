use serde_json::{Value, json};
use sidekicks_contracts::workflow::definition::document::WorkflowNodeId;
use sidekicks_contracts::workflow::definition::item::WorkflowItem;
use sidekicks_contracts::workflow::run::step::record::WorkflowStepSource;

use super::{LineageError, StepKey, StepOutput, StepOutputs, walk_paired_item};

fn node_id(id: &str) -> WorkflowNodeId {
    WorkflowNodeId::new(id.to_owned()).expect("a node id")
}

fn key(id: &str) -> StepKey {
    StepKey {
        node_id: node_id(id),
        execution_index: 0,
    }
}

/// An item holding `json`, with `paired_item` as its `pairedItem` when it is not null.
fn item(json: Value, paired_item: Value) -> WorkflowItem {
    let mut item = json!({});
    item["json"] = json;
    if !paired_item.is_null() {
        item["pairedItem"] = paired_item;
    }
    serde_json::from_value(item).expect("an item")
}

/// The feed from output 0 of the first execution of `id`.
fn fed_by(id: &str) -> Option<WorkflowStepSource> {
    serde_json::from_value(json!({ "nodeId": id, "outputIndex": 0, "executionIndex": 0 }))
        .expect("a source")
}

/// One step of a fixture run: its node's id, which is also its label, its sources and the items of
/// its output 0.
type FixtureStep<'id> = (&'id str, Vec<Option<WorkflowStepSource>>, Vec<WorkflowItem>);

/// A run of `steps`, each the first execution of its node.
fn run(steps: Vec<FixtureStep<'_>>) -> StepOutputs {
    let mut step_outputs = StepOutputs::new(
        steps
            .iter()
            .map(|(id, _, _)| (node_id(id), (*id).to_owned())),
    );
    for (id, sources, items) in steps {
        step_outputs.record(
            key(id),
            StepOutput {
                sources,
                outputs: vec![items],
            },
        );
    }
    step_outputs
}

/// `start` → `first` (three items) → `second`, whose item 0 came from `first`'s item 2 through a
/// one-entry list → `third`, one item per item → the current step, reading its input item 0.
#[test]
fn a_one_to_one_chain_walks_back_to_the_labeled_node() {
    let steps = run(vec![
        ("start", vec![], vec![item(json!({}), Value::Null)]),
        (
            "first",
            vec![fed_by("start")],
            (0..3)
                .map(|n| item(json!({ "first": n }), json!({ "item": 0 })))
                .collect(),
        ),
        (
            "second",
            vec![fed_by("first")],
            vec![
                item(json!({ "second": 0 }), json!([{ "item": 2 }])),
                item(json!({ "second": 1 }), json!({ "item": 1 })),
            ],
        ),
        (
            "third",
            vec![fed_by("second")],
            vec![item(json!({ "third": 0 }), json!({ "item": 0 }))],
        ),
        ("current", vec![fed_by("third")], vec![]),
    ]);

    let found = walk_paired_item(&steps, &key("current"), 0, "first").expect("the walk ends");
    assert_eq!(found.json.0, json!({ "first": 2 }));
    let found = walk_paired_item(&steps, &key("current"), 0, "third").expect("the walk ends");
    assert_eq!(found.json.0, json!({ "third": 0 }));
}

/// An item made from several answers `Ambiguous` naming the node that made it and the fixes, one
/// with no `pairedItem` answers `LineageMissing`, a label the item's way back never passes answers
/// `NotUpstream` rather than blaming the trigger, and a label no node has answers `UnknownLabel`.
/// Mutations: answer the trigger's missing lineage for a label off the path.
#[test]
fn a_collapse_a_missing_lineage_and_an_unknown_label_are_typed_errors() {
    let steps = run(vec![
        ("start", vec![], vec![item(json!({}), Value::Null)]),
        (
            "first",
            vec![fed_by("start")],
            (0..3)
                .map(|n| item(json!({ "first": n }), json!({ "item": 0 })))
                .collect(),
        ),
        (
            "sum",
            vec![fed_by("first")],
            vec![item(
                json!({ "total": 3 }),
                json!([{ "item": 0 }, { "item": 1 }, { "item": 2 }]),
            )],
        ),
        (
            "code",
            vec![fed_by("first")],
            vec![item(json!({ "made": true }), Value::Null)],
        ),
        ("after sum", vec![fed_by("sum")], vec![]),
        ("after code", vec![fed_by("code")], vec![]),
    ]);

    let ambiguous = walk_paired_item(&steps, &key("after sum"), 0, "first")
        .expect_err("a collapse has no one answer");
    assert_eq!(
        ambiguous,
        LineageError::Ambiguous {
            label: "first".to_owned(),
            at_node: "sum".to_owned(),
        }
    );
    assert_eq!(
        ambiguous.to_string(),
        "Can't follow this item back to 'first': 'sum' made it from several items. Use \
         $first('first'), $last('first') or $all('first')[i] instead."
    );
    assert_eq!(
        walk_paired_item(&steps, &key("after code"), 0, "first"),
        Err(LineageError::LineageMissing {
            label: "first".to_owned(),
            at_node: "code".to_owned(),
        })
    );
    assert_eq!(
        walk_paired_item(&steps, &key("first"), 0, "sum"),
        Err(LineageError::NotUpstream {
            label: "sum".to_owned(),
        })
    );
    assert_eq!(
        walk_paired_item(&steps, &key("after sum"), 0, "nowhere"),
        Err(LineageError::UnknownLabel {
            label: "nowhere".to_owned(),
        })
    );
}

/// A merge's item that arrived on input 1 walks back through the node feeding that slot, not the
/// node feeding slot 0.
#[test]
fn a_paired_items_input_picks_the_upstream_of_a_fan_in() {
    let steps = run(vec![
        ("start", vec![], vec![item(json!({}), Value::Null)]),
        (
            "left",
            vec![fed_by("start")],
            vec![item(json!({ "left": 0 }), json!({ "item": 0 }))],
        ),
        (
            "right",
            vec![fed_by("start")],
            vec![
                item(json!({ "right": 0 }), json!({ "item": 0 })),
                item(json!({ "right": 1 }), json!({ "item": 0 })),
            ],
        ),
        (
            "merge",
            vec![fed_by("left"), fed_by("right")],
            vec![item(
                json!({ "merged": 0 }),
                json!({ "item": 1, "input": 1 }),
            )],
        ),
        ("current", vec![fed_by("merge")], vec![]),
    ]);

    let found = walk_paired_item(&steps, &key("current"), 0, "right").expect("the walk ends");
    assert_eq!(found.json.0, json!({ "right": 1 }));
}

/// Records that feed two executions from each other end the walk with `LineageMissing` instead of
/// spinning the expression thread. Mutations: drop the bound on the walk.
#[test]
fn a_cycle_in_the_records_ends_the_walk() {
    let steps = run(vec![
        (
            "ping",
            vec![fed_by("pong")],
            vec![item(json!({ "ping": 0 }), json!({ "item": 0 }))],
        ),
        (
            "pong",
            vec![fed_by("ping")],
            vec![item(json!({ "pong": 0 }), json!({ "item": 0 }))],
        ),
        ("current", vec![fed_by("ping")], vec![]),
    ]);

    assert!(matches!(
        walk_paired_item(&steps, &key("current"), 0, "current"),
        Err(LineageError::LineageMissing { .. })
    ));
}
