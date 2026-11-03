//! The one walk over a parsed expression's syntax tree, which every reader of the tree that looks
//! for a node shares.

use jsonata_core::ast::{AstNode, PathStep, Stage};

/// The first answer `visit` gives over `root`'s nodes, each node visited before its children and
/// the children in their order: a path step's node before its filters, a function's arguments, a
/// condition before its branches. `None` when `visit` answers none.
pub(crate) fn find_in_syntax_tree<'a, T>(
    root: &'a AstNode,
    visit: &mut impl FnMut(&'a AstNode) -> Option<T>,
) -> Option<T> {
    if let Some(found) = visit(root) {
        return Some(found);
    }
    let mut find = |node: &'a AstNode| find_in_syntax_tree(node, visit);
    match root {
        AstNode::String(_)
        | AstNode::Name(_)
        | AstNode::Number(_)
        | AstNode::Boolean(_)
        | AstNode::Null
        | AstNode::Undefined
        | AstNode::Placeholder
        | AstNode::Regex { .. }
        | AstNode::Variable(_)
        | AstNode::ParentVariable(_)
        | AstNode::Wildcard
        | AstNode::Descendant
        | AstNode::Parent(_) => None,
        AstNode::Path { steps } => steps
            .iter()
            .find_map(|step| find_in_path_step(step, &mut find)),
        AstNode::Binary { lhs, rhs, .. } => find(lhs).or_else(|| find(rhs)),
        AstNode::Unary { operand, .. } => find(operand),
        AstNode::Function { args, .. } => args.iter().find_map(find),
        AstNode::Call { procedure, args } => {
            find(procedure).or_else(|| args.iter().find_map(&mut find))
        }
        AstNode::Lambda { body, .. } => find(body),
        AstNode::Array(elements) | AstNode::Block(elements) | AstNode::ArrayGroup(elements) => {
            elements.iter().find_map(find)
        }
        AstNode::Object(pairs) => pairs
            .iter()
            .find_map(|(key, value)| find(key).or_else(|| find(value))),
        AstNode::ObjectTransform { input, pattern } => find(input).or_else(|| {
            pattern
                .iter()
                .find_map(|(key, value)| find(key).or_else(|| find(value)))
        }),
        AstNode::Conditional {
            condition,
            then_branch,
            else_branch,
        } => find(condition)
            .or_else(|| find(then_branch))
            .or_else(|| else_branch.as_deref().and_then(&mut find)),
        AstNode::FunctionApplication(inner) => find(inner),
        AstNode::Sort { input, terms } => {
            find(input).or_else(|| terms.iter().find_map(|(term, _)| find(term)))
        }
        AstNode::Transform {
            location,
            update,
            delete,
        } => find(location)
            .or_else(|| find(update))
            .or_else(|| delete.as_deref().and_then(&mut find)),
    }
}

/// The first answer over a path step's node and then its filters.
fn find_in_path_step<'a, T>(
    step: &'a PathStep,
    find: &mut impl FnMut(&'a AstNode) -> Option<T>,
) -> Option<T> {
    find(&step.node).or_else(|| {
        step.stages.iter().find_map(|stage| match stage {
            Stage::Filter(filter) => find(filter),
            Stage::KeepArray | Stage::Index(_) => None,
        })
    })
}
