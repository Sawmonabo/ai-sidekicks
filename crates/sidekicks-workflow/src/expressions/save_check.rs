//! The check a save runs over every expression a document holds: each part must parse, name a node
//! by a label the document holds, and hold only patterns the evaluator builds, and a command step's
//! fills must each land where a reference to it expands as one value.

#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the workflow definition handlers and the workflow agent tools, through the \
                  workflow definition store"
    )
)]

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
/// rule: a template that does not parse or calls a reader as a method, a label no node is named,
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
        if check.is_unparsable {
            findings.push(WorkflowDefinitionFinding::ExpressionUnparsable {
                node_ids: node_ids(),
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

/// What one node's params hold: which rules its expressions break, and its command line's fills.
#[derive(Default)]
struct NodeExpressions {
    is_unparsable: bool,
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
                Err(TemplateError::Unclosed { .. }) => self.is_unparsable = true,
            }
            Ok::<(), Infallible>(())
        });
    }

    /// Parses one part once and notes each rule it breaks.
    fn read_expression(&mut self, expression: &str, labels: &HashSet<&str>) {
        let Ok(tree) = parse(expression) else {
            self.is_unparsable = true;
            return;
        };
        self.is_unparsable |= find_in_syntax_tree(&tree, &mut |node| {
            is_method_call_spelling(node).then_some(())
        })
        .is_some();
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
mod tests;
