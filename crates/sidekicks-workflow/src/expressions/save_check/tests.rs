use rstest::rstest;
use serde_json::{Map, Value, json};
use sidekicks_contracts::workflow::definition::document::{WorkflowNode, WorkflowNodeId};
use sidekicks_contracts::workflow::definition::refusals::WorkflowDefinitionFinding;
use sidekicks_policy::shell_commands::reading_bound::ShellLineReadingBound;

use super::check_expressions;

fn node(id: &str, kind: &str, name: &str, params: &Value) -> WorkflowNode {
    serde_json::from_value(json!({
        "id": id, "kind": kind, "kindVersion": 1, "name": name, "order": 0, "params": params,
    }))
    .expect("the test's node reads")
}

// The findings of a document whose trigger is `Start` and whose nodes are `Fetch`, a file read
// whose id is `fetch`, and `step`; the command step `developer.shell` holds its line in `command`.
async fn findings_beside_fetch(step: WorkflowNode) -> Vec<WorkflowDefinitionFinding> {
    let trigger = node("trigger", "trigger.manual", "Start", &json!({}));
    let nodes = [
        node(
            "fetch",
            "files.read",
            "Fetch",
            &json!({ "path": "notes.md" }),
        ),
        step,
    ];
    check_expressions(
        &trigger,
        &nodes,
        |node| (node.kind.0.as_str() == "developer.shell").then_some("command"),
        &ShellLineReadingBound::new(4_096),
    )
    .await
    .expect("the reading ends without a panic")
}

// The one step each case marks.
fn step_ids() -> Vec<WorkflowNodeId> {
    vec![WorkflowNodeId::new("step".to_owned()).expect("the id is well formed")]
}

/// An expression that does not parse marks the step whose param holds it, nested params included,
/// with why its first such expression fails: a template left open, a part the parser refuses with
/// the parser's words, and a reader called as a method with the spellings that read a node.
/// Mutations: drop any one check; read only top-level params; keep a later reason over the first;
/// leave the method-call reason without `$all('<label>')`.
#[rstest]
#[case::an_open_template(json!("={{ a"), "A template opens {{ and never closes it.")]
#[case::a_part_that_does_not_parse(json!("={{ $json. }}"), "An expression does not parse: ")]
#[case::a_method_on_the_input(json!("={{ $input.all() }}"), "A node is read as $all('<label>')")]
#[case::a_method_on_a_label(json!("={{ $('Fetch').first() }}"), "A node is read as $all('<label>')")]
#[case::a_nested_param(json!({ "rows": ["={{ a"] }), "A template opens {{")]
#[case::the_first_reason(
    json!({ "rows": ["={{ $input.all() }}", "={{ a"] }),
    "A node is read as $all('<label>')"
)]
#[tokio::test]
async fn an_unparsable_expression_marks_its_step_with_why(
    #[case] value: Value,
    #[case] reason_start: &str,
) {
    let step = node("step", "files.write", "Write", &json!({ "content": value }));

    let findings = findings_beside_fetch(step).await;
    let [WorkflowDefinitionFinding::ExpressionUnparsable { node_ids, detail }] =
        findings.as_slice()
    else {
        panic!("one unparsable finding, not {findings:?}");
    };
    assert_eq!(node_ids, &step_ids());
    assert!(detail.as_str().starts_with(reason_start), "{detail:?}");
}

/// Each other expression rule marks the step whose param breaks it: a label no node is named (a
/// node's id is no label) and a pattern the evaluator cannot build; a label a node is named passes.
/// Mutations: drop either check; compare labels with node ids; check patterns with a builder other
/// than the evaluator's.
#[rstest]
#[case::an_unknown_label(json!("={{ $all('Nope') }}"), vec![WorkflowDefinitionFinding::ExpressionUnknownNode { node_ids: step_ids() }])]
#[case::a_node_id_as_label(json!("={{ $first('fetch') }}"), vec![WorkflowDefinitionFinding::ExpressionUnknownNode { node_ids: step_ids() }])]
#[case::a_known_label(json!("={{ $all('Fetch') }}"), Vec::new())]
#[case::the_trigger_label(json!("={{ $params('Start') }}"), Vec::new())]
#[case::a_backreference(json!("={{ $match($json.x, /(a)\\1/) }}"), vec![WorkflowDefinitionFinding::ExpressionRegexUnsupported { node_ids: step_ids() }])]
#[case::a_look_ahead(json!("={{ $match($json.x, /(?=a)/) }}"), vec![WorkflowDefinitionFinding::ExpressionRegexUnsupported { node_ids: step_ids() }])]
#[tokio::test]
async fn an_expression_breaking_a_rule_marks_its_step(
    #[case] value: Value,
    #[case] expected: Vec<WorkflowDefinitionFinding>,
) {
    let step = node("step", "files.write", "Write", &json!({ "content": value }));

    assert_eq!(findings_beside_fetch(step).await, expected);
}

/// A fill that would not expand on a command step's line is no finding in its other params or in
/// another kind's `command`; the store's save tests prove the line's own refusal. Mutations: read
/// the fills of every param; read every kind's `command`.
#[rstest]
#[case::another_param("developer.shell", "notes")]
#[case::another_kinds_command("files.write", "command")]
#[tokio::test]
async fn only_a_command_steps_line_is_read_for_fills(#[case] kind: &str, #[case] param: &str) {
    let params = Map::from_iter([(param.to_owned(), json!("=echo '{{ $json.x }}'"))]);
    let step = node("step", kind, "Run", &Value::Object(params));

    assert_eq!(findings_beside_fetch(step).await, Vec::new());
}
