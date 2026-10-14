//! Workflows: definitions, node kinds, runs and the secrets their steps read.

use crate::typescript::TypeScriptModule;

pub mod definition;
pub mod kind;
pub mod run;
pub mod secret;

/// The topic's TypeScript modules, its folders' among them.
pub(crate) const TYPESCRIPT_MODULES: &[&TypeScriptModule] = &[
    &definition::builder::TYPESCRIPT_MODULE,
    &definition::document::TYPESCRIPT_MODULE,
    &definition::events::TYPESCRIPT_MODULE,
    &definition::handle::TYPESCRIPT_MODULE,
    &definition::item::TYPESCRIPT_MODULE,
    &definition::refusals::TYPESCRIPT_MODULE,
    &definition::versions::TYPESCRIPT_MODULE,
    &kind::TYPESCRIPT_MODULE,
    &run::control::TYPESCRIPT_MODULE,
    &run::events::TYPESCRIPT_MODULE,
    &run::failures::TYPESCRIPT_MODULE,
    &run::gate_resolution::TYPESCRIPT_MODULE,
    &run::housekeeping::TYPESCRIPT_MODULE,
    &run::id::TYPESCRIPT_MODULE,
    &run::list::TYPESCRIPT_MODULE,
    &run::records::TYPESCRIPT_MODULE,
    &run::snapshot::TYPESCRIPT_MODULE,
    &run::status::TYPESCRIPT_MODULE,
    &run::step::events::TYPESCRIPT_MODULE,
    &run::step::methods::TYPESCRIPT_MODULE,
    &run::step::record::TYPESCRIPT_MODULE,
    &run::tool::TYPESCRIPT_MODULE,
    &run::trigger::TYPESCRIPT_MODULE,
    &secret::TYPESCRIPT_MODULE,
];
