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

/// Each expression rule marks the step whose param breaks it, nested params included: a template
/// left open, a part that does not parse, a reader called as a method, a label no node is named
/// (a node's id is no label), and a pattern the evaluator cannot build; a label a node is named
/// passes. Mutations: drop any one check; compare labels with node ids; read only top-level
/// params; check patterns with a builder other than the evaluator's.
#[rstest]
#[case::an_open_template(json!("={{ a"), vec![WorkflowDefinitionFinding::ExpressionUnparsable { node_ids: step_ids() }])]
#[case::a_part_that_does_not_parse(json!("={{ $json. }}"), vec![WorkflowDefinitionFinding::ExpressionUnparsable { node_ids: step_ids() }])]
#[case::a_method_on_the_input(json!("={{ $input.all() }}"), vec![WorkflowDefinitionFinding::ExpressionUnparsable { node_ids: step_ids() }])]
#[case::a_method_on_a_label(json!("={{ $('Fetch').first() }}"), vec![WorkflowDefinitionFinding::ExpressionUnparsable { node_ids: step_ids() }])]
#[case::a_nested_param(json!({ "rows": ["={{ a"] }), vec![WorkflowDefinitionFinding::ExpressionUnparsable { node_ids: step_ids() }])]
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

/// A command step's fill that does not expand marks that step with the reason naming the fill,
/// while the same text in its other params, or in another kind's `command`, is no finding.
/// Mutations: read the fills of every param; read every kind's `command`; drop the fill check.
#[rstest]
#[case::the_command_line("developer.shell", "command", true)]
#[case::another_param("developer.shell", "notes", false)]
#[case::another_kinds_command("files.write", "command", false)]
#[tokio::test]
async fn only_a_command_steps_line_is_read_for_fills(
    #[case] kind: &str,
    #[case] param: &str,
    #[case] is_refused: bool,
) {
    let params = Map::from_iter([(param.to_owned(), json!("=echo '{{ $json.x }}'"))]);
    let step = node("step", kind, "Run", &Value::Object(params));

    let findings = findings_beside_fetch(step).await;

    if is_refused {
        let [WorkflowDefinitionFinding::ExpressionNotExpanded { node_ids, detail }] =
            findings.as_slice()
        else {
            panic!("the step is marked for its fill alone, not {findings:?}");
        };
        assert_eq!(
            node_ids
                .iter()
                .map(WorkflowNodeId::as_str)
                .collect::<Vec<_>>(),
            ["step"]
        );
        assert!(
            detail.as_str().starts_with("Fill 1 sits in single quotes"),
            "{detail:?}"
        );
    } else {
        assert_eq!(findings, Vec::new());
    }
}
