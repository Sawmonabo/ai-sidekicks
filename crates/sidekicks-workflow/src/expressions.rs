//! Workflow expressions: the one thread that evaluates them, the bindings they can name, the walk
//! back through item lineage that answers `$item('<label>')`, and stored JSON turned into the
//! evaluator's values in JavaScript's key order.

pub(crate) mod bindings;
pub(crate) mod evaluator;
pub(crate) mod key_order;
pub(crate) mod lineage;
