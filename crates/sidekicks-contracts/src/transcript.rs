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

/// The topic's TypeScript modules.
pub(crate) const TYPESCRIPT_MODULES: &[&TypeScriptModule] = &[
    &child_run_summary::TYPESCRIPT_MODULE,
    &content::TYPESCRIPT_MODULE,
    &limits::TYPESCRIPT_MODULE,
    &methods::TYPESCRIPT_MODULE,
    &operations::TYPESCRIPT_MODULE,
    &row::TYPESCRIPT_MODULE,
    &run_attribution::TYPESCRIPT_MODULE,
    &run_facts::TYPESCRIPT_MODULE,
    &search::TYPESCRIPT_MODULE,
    &turn_attribution::TYPESCRIPT_MODULE,
];
