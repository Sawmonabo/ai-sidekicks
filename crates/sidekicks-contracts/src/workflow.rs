//! Workflows: definitions, node kinds and runs.

use crate::typescript::TypeScriptModule;

pub mod definition;
pub mod kind;
pub mod run;

/// The topic's TypeScript modules, its folders' among them.
pub(crate) const TYPESCRIPT_MODULES: &[&TypeScriptModule] = &[
    &definition::document::TYPESCRIPT_MODULE,
    &definition::handle::TYPESCRIPT_MODULE,
    &definition::item::TYPESCRIPT_MODULE,
    &definition::refusals::TYPESCRIPT_MODULE,
    &kind::TYPESCRIPT_MODULE,
    &run::control::TYPESCRIPT_MODULE,
    &run::events::TYPESCRIPT_MODULE,
    &run::failures::TYPESCRIPT_MODULE,
    &run::id::TYPESCRIPT_MODULE,
    &run::snapshot::TYPESCRIPT_MODULE,
    &run::status::TYPESCRIPT_MODULE,
    &run::step::events::TYPESCRIPT_MODULE,
    &run::step::record::TYPESCRIPT_MODULE,
    &run::trigger::TYPESCRIPT_MODULE,
];
