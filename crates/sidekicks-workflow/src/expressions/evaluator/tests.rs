use std::pin::pin;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use futures::poll;
use serde_json::{Map, Value, json};
use sidekicks_contracts::workflow::definition::document::WorkflowNodeId;
use sidekicks_contracts::workflow::definition::expression_template::{TemplateText, read_template};
use sidekicks_contracts::workflow::definition::item::WorkflowItem;
use tokio_util::sync::CancellationToken;

use super::{ExpressionEvaluator, JOB_CAPACITY, OpenSteps, ParamTemplate};
use crate::expressions::bindings::{ExpressionError, test_expression_bindings};
use crate::expressions::lineage::{StepKey, StepOutput, StepOutputs};

/// An evaluation that runs until its step is canceled: each of a hundred thousand elements sums
/// a hundred thousand more, the cancel read at every element.
const UNENDING: &str = "={{ $reduce([1..100000], function($total, $value) { \
                        $reduce([1..100000], function($sum, $next) { $sum + $next }, $total) \
                        }, 0) }}";

fn node_id(id: &str) -> WorkflowNodeId {
    WorkflowNodeId::new(id.to_owned()).expect("a node id")
}

fn step_key(id: &str) -> StepKey {
    StepKey {
        node_id: node_id(id),
        execution_index: 0,
    }
}

/// An item whose `json` is `json`.
fn item(json: Value) -> WorkflowItem {
    serde_json::from_value(Value::Object(Map::from_iter([("json".to_owned(), json)])))
        .expect("an item")
}

fn named_items(names: &[&str]) -> Vec<WorkflowItem> {
    names
        .iter()
        .map(|name| item(json!({ "name": name })))
        .collect()
}

fn no_steps() -> StepOutputs {
    StepOutputs::new(["L", "current"].map(|label| (node_id(label), label.to_owned())))
}

fn template(text: &str) -> ParamTemplate {
    match read_template(text).expect("the template cuts") {
        TemplateText::Expression(template) => ParamTemplate::from(&template),
        TemplateText::Literal(literal) => unreachable!("{literal} is no template"),
    }
}

/// What the template `text` answers for one input item whose `json` is `item_json`.
async fn evaluated(item_json: Value, text: &str) -> Value {
    let evaluator = ExpressionEvaluator::start().expect("the thread starts");
    let step = evaluator
        .open_step(
            test_expression_bindings(vec![item(item_json)], no_steps()),
            vec![template(text)],
            &CancellationToken::new(),
        )
        .await
        .expect("the step opens");
    let [value] = step
        .evaluate_item(0)
        .await
        .expect("the item evaluates")
        .try_into()
        .expect("one template gives one value");
    value
}

/// Each item is evaluated with its own index: a joined template is a string of its parts, and a
/// whole one keeps its value's JSON type.
#[tokio::test]
async fn each_item_evaluates_with_its_own_index() {
    let evaluator = ExpressionEvaluator::start().expect("the thread starts");
    let names = ["Ada", "Bob", "Cy"];
    let step = evaluator
        .open_step(
            test_expression_bindings(named_items(&names), no_steps()),
            vec![
                template("=Hi {{ $json.name }}, item {{ $itemIndex }}"),
                template("={{ $json }}"),
            ],
            &CancellationToken::new(),
        )
        .await
        .expect("the step opens");
    for (index, name) in names.into_iter().enumerate() {
        assert_eq!(
            step.evaluate_item(index).await.expect("the item evaluates"),
            vec![
                json!(format!("Hi {name}, item {index}")),
                json!({ "name": name })
            ]
        );
    }
}

/// On a real clock, since the evaluation runs on its own thread outside tokio's: a step canceled
/// while its evaluation runs ends `Canceled` within 72 ms of the cancel, every later evaluation
/// of it too, and a sibling step on the same thread evaluates as if nothing happened.
#[tokio::test]
async fn a_canceled_step_ends_alone() {
    let evaluator = ExpressionEvaluator::start().expect("the thread starts");
    let long_cancel = CancellationToken::new();
    let long = evaluator
        .open_step(
            test_expression_bindings(named_items(&["Ada"]), no_steps()),
            vec![template(UNENDING)],
            &long_cancel,
        )
        .await
        .expect("the step opens");
    let sibling = evaluator
        .open_step(
            test_expression_bindings(named_items(&["Ada"]), no_steps()),
            vec![template("={{ $json.name }}")],
            &CancellationToken::new(),
        )
        .await
        .expect("the step opens");
    // Each evaluation is queued at its first poll.
    let mut long_value = pin!(long.evaluate_item(0));
    let mut sibling_value = pin!(sibling.evaluate_item(0));
    assert!(poll!(long_value.as_mut()).is_pending());
    assert!(poll!(sibling_value.as_mut()).is_pending());
    tokio::time::sleep(Duration::from_millis(50)).await;

    let canceled_at = Instant::now();
    long_cancel.cancel();
    assert!(matches!(long_value.await, Err(ExpressionError::Canceled)));
    assert!(canceled_at.elapsed() < Duration::from_millis(72));
    assert!(matches!(
        long.evaluate_item(0).await,
        Err(ExpressionError::Canceled)
    ));
    assert_eq!(
        sibling_value.await.expect("the sibling evaluates"),
        vec![json!("Ada")]
    );
}

/// `$all`, `$first` and `$last` by label read the labeled node's latest run and its first output
/// only.
#[tokio::test]
async fn a_label_reads_the_first_output_of_the_latest_run() {
    let mut steps = no_steps();
    steps.record(
        step_key("L"),
        StepOutput {
            sources: vec![],
            outputs: vec![named_items(&["earlier"])],
        },
    );
    steps.record(
        StepKey {
            node_id: node_id("L"),
            execution_index: 1,
        },
        StepOutput {
            sources: vec![],
            outputs: vec![named_items(&["first", "second"]), named_items(&["other"])],
        },
    );
    let evaluator = ExpressionEvaluator::start().expect("the thread starts");
    let step = evaluator
        .open_step(
            test_expression_bindings(named_items(&["Ada"]), steps),
            vec![template(
                "={{ [$all('L').json.name, $first('L').json.name, $last('L').json.name] }}",
            )],
            &CancellationToken::new(),
        )
        .await
        .expect("the step opens");
    assert_eq!(
        step.evaluate_item(0).await.expect("the item evaluates"),
        vec![json!(["first", "second", "first", "second"])]
    );
}

/// With the thread held and 256 jobs waiting, one more waits for room rather than being refused,
/// and all of them, the one that waited too, run once the thread is free. Mutations: refuse the
/// next job at once; drop a job while it waits for room.
#[tokio::test]
async fn a_full_channel_holds_the_next_job_until_there_is_room() {
    let evaluator = ExpressionEvaluator::start().expect("the thread starts");
    let step = evaluator
        .open_step(
            test_expression_bindings(named_items(&["Ada"]), no_steps()),
            vec![template("={{ $json.name }}")],
            &CancellationToken::new(),
        )
        .await
        .expect("the step opens");
    let (started, has_started) = mpsc::channel();
    let (release, released) = mpsc::channel::<()>();
    evaluator
        .send(Box::new(move |_: &mut OpenSteps| {
            started.send(()).expect("the test waits for the start");
            released.recv().expect("the test releases the thread");
        }))
        .await;
    has_started.recv().expect("the thread runs the holding job");

    let mut waiting: Vec<_> = (0..JOB_CAPACITY)
        .map(|_| Box::pin(step.evaluate_item(0)))
        .collect();
    for value in &mut waiting {
        assert!(poll!(value.as_mut()).is_pending());
    }
    let mut next = Box::pin(step.evaluate_item(0));
    assert!(poll!(next.as_mut()).is_pending());
    release.send(()).expect("the holding job waits");
    waiting.push(next);
    for value in waiting {
        assert_eq!(value.await.expect("the item evaluates"), vec![json!("Ada")]);
    }
}

/// `$now(picture)` formats the run's instant, not the clock's, through the call the step parsed
/// once, for every item.
#[tokio::test]
async fn now_formats_the_runs_instant() {
    let evaluator = ExpressionEvaluator::start().expect("the thread starts");
    let step = evaluator
        .open_step(
            test_expression_bindings(named_items(&["Ada", "Bob"]), no_steps()),
            vec![template("={{ $now('[Y0001]-[M01]-[D01]') }}")],
            &CancellationToken::new(),
        )
        .await
        .expect("the step opens");
    for index in 0..2 {
        assert_eq!(
            step.evaluate_item(index).await.expect("the item evaluates"),
            vec![json!("2025-03-04")]
        );
    }
}

/// A regex class takes JavaScript's meaning: `\d` is `[0-9]`, so an Arabic-Indic digit is none.
#[tokio::test]
async fn a_regex_digit_class_is_ascii() {
    assert_eq!(
        evaluated(json!({}), r#"={{ $contains("٣", /\d/) }}"#).await,
        json!(false)
    );
}

/// On a real clock: a step canceled 50 ms into a `$distinct` over fifty thousand distinct
/// numbers, over a billion comparisons uncanceled, ends `Canceled` within 72 ms of the cancel,
/// since the cancel is read at every element and not only once the call returns.
#[tokio::test]
async fn a_canceled_distinct_ends_within_its_bound() {
    let evaluator = ExpressionEvaluator::start().expect("the thread starts");
    let cancel = CancellationToken::new();
    let step = evaluator
        .open_step(
            test_expression_bindings(named_items(&["Ada"]), no_steps()),
            vec![template("={{ $distinct([1..50000]) }}")],
            &cancel,
        )
        .await
        .expect("the step opens");
    // The evaluation is queued at its first poll.
    let mut value = pin!(step.evaluate_item(0));
    assert!(poll!(value.as_mut()).is_pending());
    tokio::time::sleep(Duration::from_millis(50)).await;

    let canceled_at = Instant::now();
    cancel.cancel();
    assert!(matches!(value.await, Err(ExpressionError::Canceled)));
    assert!(canceled_at.elapsed() < Duration::from_millis(72));
}

/// Object keys read in JavaScript's own-key order, the array-index keys first in ascending number
/// and every other key in its written order, both in an object an expression builds and in an
/// item's `json`, nested ones too.
#[tokio::test]
async fn object_keys_read_in_javascript_order() {
    assert_eq!(
        evaluated(json!({}), r#"={{ $keys({"b":1,"2":2}) }}"#).await,
        json!(["2", "b"])
    );
    assert_eq!(
        evaluated(
            json!({ "b": 1, "2": 2, "1": 3, "4294967295": 4, "01": 5 }),
            "={{ $keys($json) }}"
        )
        .await,
        json!(["1", "2", "b", "4294967295", "01"])
    );
    assert_eq!(
        evaluated(
            json!({ "rows": [{ "z": 1, "10": 2, "9": 3, "0": 4 }] }),
            "={{ $keys($json.rows[0]) }}"
        )
        .await,
        json!(["0", "9", "10", "z"])
    );
}
