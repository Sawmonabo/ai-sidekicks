//! The transcript: rows, content, limits, run facts, attribution, search and its methods.

use crate::typescript::TypeScriptModule;

pub mod child_run_summary;
pub mod content;
pub mod limits;
pub mod methods;
pub mod operations;
pub mod row;
pub mod run_attribution;
pub mod run_facts;
pub mod search;
pub mod turn_attribution;

/// The topic's TypeScript modules. The content, run-attribution, run-fact and turn-attribution
/// modules have none of their own: their readers are hand-written TypeScript at those paths, and
/// their types and constants are written with the reads and the row.
pub(crate) const TYPESCRIPT_MODULES: &[&TypeScriptModule] = &[
    &child_run_summary::TYPESCRIPT_MODULE,
    &limits::TYPESCRIPT_MODULE,
    &methods::TYPESCRIPT_MODULE,
    &operations::TYPESCRIPT_MODULE,
    &row::TYPESCRIPT_MODULE,
    &search::TYPESCRIPT_MODULE,
];
