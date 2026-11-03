//! Workflow expressions: the one thread that evaluates them, the bindings they can name, the walk
//! back through item lineage that answers `$item('<label>')`, the walk over the strings a node's
//! params hold, the walk over a parsed expression's tree, and the check a save runs over every
//! expression a document holds.

pub(crate) mod bindings;
pub(crate) mod evaluator;
pub(crate) mod lineage;
pub(crate) mod param_strings;
pub(crate) mod save_check;
pub(crate) mod syntax_tree;
