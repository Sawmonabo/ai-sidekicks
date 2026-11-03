//! The check a save runs over every expression a document holds: each part must parse, name a node
//! by a label the document holds, and hold only patterns the evaluator builds, and a command step's
//! fills must each land where a reference to it expands as one value.

use std::collections::HashSet;
use std::convert::Infallible;
use std::iter;

use jsonata_core::ast::AstNode;
use jsonata_core::functions::string::build_regex;
use jsonata_core::parser::parse;
use sidekicks_contracts::wire::record::JsonRecord;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_contracts::workflow::definition::document::WorkflowNode;
use sidekicks_contracts::workflow::definition::expression_template::{
    TemplateError, TemplatePart, TemplateText, read_template,
};
use sidekicks_contracts::workflow::definition::refusals::WorkflowDefinitionFinding;
use sidekicks_policy::shell_commands::fills::{CommandLineFills, RefusedFill};
use sidekicks_policy::shell_commands::reading_bound::ShellLineReadingBound;
use tokio::task::JoinError;

use crate::expressions::bindings::{is_item_reader_name, reads_a_label};
use crate::expressions::param_strings::walk_param_strings;
use crate::expressions::syntax_tree::find_in_syntax_tree;

/// The expression findings of `trigger` and then `nodes`, in that order, at most one per node and
/// rule: a template that does not parse or calls a reader as a method, with why its first such
/// expression fails, a label no node is named,
/// a pattern the evaluator cannot build, and, on a node whose kind holds its shell line in the
/// param `shell_line_param` answers, a fill that would not reach the command as one value. Each
/// command line is read inside `bound`; fails only when that read panics.
pub(crate) async fn check_expressions(
    trigger: &WorkflowNode,
    nodes: &[WorkflowNode],
    shell_line_param: impl Fn(&WorkflowNode) -> Option<&'static str>,
    bound: &ShellLineReadingBound,
) -> Result<Vec<WorkflowDefinitionFinding>, JoinError> {
    let labels: HashSet<&str> = iter::once(trigger)
        .chain(nodes)
        .map(|node| node.name.as_str())
        .collect();
    let mut findings = Vec::new();
    for node in iter::once(trigger).chain(nodes) {
        let mut check = NodeExpressions::default();
        check.read_params(&node.params, shell_line_param(node), &labels);
        let node_ids = || vec![node.id.clone()];
        if let Some(reason) = check.unparsable_reason {
            findings.push(WorkflowDefinitionFinding::ExpressionUnparsable {
                node_ids: node_ids(),
                detail: NonEmptyText::new(reason).expect("an unparsable reason is never empty"),
            });
        }
        if check.names_an_unknown_node {
            findings.push(WorkflowDefinitionFinding::ExpressionUnknownNode {
                node_ids: node_ids(),
            });
        }
        if check.holds_an_unbuilt_pattern {
            findings.push(WorkflowDefinitionFinding::ExpressionRegexUnsupported {
                node_ids: node_ids(),
            });
        }
        if let Some(fills) = check.command_line
            && let Some(refused) = first_refused_fill(fills, bound).await?
        {
            findings.push(WorkflowDefinitionFinding::ExpressionNotExpanded {
                node_ids: node_ids(),
                detail: NonEmptyText::new(refused.to_string())
                    .expect("a refused fill's reason is never empty"),
            });
        }
    }
    Ok(findings)
}

/// The reason a reader called as a method is refused: the spellings that read a node instead.
const METHOD_CALL_REASON: &str = "A node is read as $all('<label>'), $first('<label>'), \
     $last('<label>') or $item('<label>'), and the node's own input as $all(), never as a method \
     such as $('<label>').first() or $input.all().";

/// What one node's params hold: which rules its expressions break, with why the first of them
/// does not parse, and its command line's fills.
#[derive(Default)]
struct NodeExpressions {
    unparsable_reason: Option<String>,
    names_an_unknown_node: bool,
    holds_an_unbuilt_pattern: bool,
    command_line: Option<CommandLineFills>,
}

impl NodeExpressions {
    /// Reads every string `params` hold, in arrays and objects too; the string of the param
    /// `line_param` names, at its top level, is the node's command line.
    fn read_params(
        &mut self,
        params: &JsonRecord,
        line_param: Option<&str>,
        labels: &HashSet<&str>,
    ) {
        let Ok(()) = walk_param_strings(params, |path, text| {
            match read_template(text) {
                Ok(TemplateText::Literal(_)) => {}
                Ok(TemplateText::Expression(template)) => {
                    for part in template.parts() {
                        if let TemplatePart::Expression(expression) = part {
                            self.read_expression(expression, labels);
                        }
                    }
                    if path.segments.is_empty() && line_param == Some(path.param.as_str()) {
                        self.command_line = Some(CommandLineFills::new(&template));
                    }
                }
                Err(TemplateError::Unclosed { .. }) => {
                    self.note_unparsable(|| "A template opens {{ and never closes it.".to_owned());
                }
            }
            Ok::<(), Infallible>(())
        });
    }

    /// Notes the node's expressions as unparsable, keeping the first reason given.
    fn note_unparsable(&mut self, reason: impl FnOnce() -> String) {
        self.unparsable_reason.get_or_insert_with(reason);
    }

    /// Parses one part once and notes each rule it breaks.
    fn read_expression(&mut self, expression: &str, labels: &HashSet<&str>) {
        let tree = match parse(expression) {
            Ok(tree) => tree,
            Err(error) => {
                self.note_unparsable(|| format!("An expression does not parse: {error}"));
                return;
            }
        };
        if find_in_syntax_tree(&tree, &mut |node| {
            is_method_call_spelling(node).then_some(())
        })
        .is_some()
        {
            self.note_unparsable(|| METHOD_CALL_REASON.to_owned());
        }
        self.names_an_unknown_node |= find_in_syntax_tree(&tree, &mut |node| {
            labeled_node(node).filter(|label| !labels.contains(label))
        })
        .is_some();
        self.holds_an_unbuilt_pattern |= find_in_syntax_tree(&tree, &mut |node| {
            let AstNode::Regex { pattern, flags } = node else {
                return None;
            };
            build_regex(pattern, flags).err()
        })
        .is_some();
    }
}

/// Whether `node` is a reader called the way no workflow expression calls one: bare `$` called
/// with a label, as in `$('Fetch')`, or a method spelling of an item reader, as in `$input.all()`.
fn is_method_call_spelling(node: &AstNode) -> bool {
    let AstNode::Function {
        name, is_builtin, ..
    } = node
    else {
        return false;
    };
    if *is_builtin {
        name.is_empty()
    } else {
        is_item_reader_name(name)
    }
}

/// The label a label reader's call names as a string, as `$all('Fetch')` names `Fetch`; a label
/// computed at run time is left to evaluation.
fn labeled_node(node: &AstNode) -> Option<&str> {
    if let AstNode::Function {
        name,
        args,
        is_builtin: true,
    } = node
        && reads_a_label(name)
        && let Some(AstNode::String(label)) = args.first()
    {
        return Some(label.as_str());
    }
    None
}

/// The first of `fills` the save's reading refuses, read inside `bound`.
async fn first_refused_fill(
    fills: CommandLineFills,
    bound: &ShellLineReadingBound,
) -> Result<Option<RefusedFill>, JoinError> {
    let verdicts = bound
        .read(fills.line_length(), move |reader| {
            fills.check_for_save(reader)
        })
        .await?;
    Ok(verdicts
        .into_iter()
        .enumerate()
        .find_map(|(index, verdict)| {
            verdict.err().map(|refusal| RefusedFill {
                number: index + 1,
                refusal,
            })
        }))
}

#[cfg(test)]
mod tests {
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
}
