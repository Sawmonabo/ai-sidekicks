//! Workflows: definitions, node kinds, kept values, runs, the secrets their steps read and the live
//! stream.

use crate::typescript::TypeScriptModule;

pub mod definition;
pub mod kept_values;
pub mod kind;
pub mod run;
pub mod secret;
pub mod subscription;

/// The topic's TypeScript modules, its folders' among them.
pub(crate) const TYPESCRIPT_MODULES: &[&TypeScriptModule] = &[
    &definition::builder::TYPESCRIPT_MODULE,
    &definition::document::TYPESCRIPT_MODULE,
    &definition::events::TYPESCRIPT_MODULE,
    &definition::handle::TYPESCRIPT_MODULE,
    &definition::item::TYPESCRIPT_MODULE,
    &definition::methods::TYPESCRIPT_MODULE,
    &definition::params::TYPESCRIPT_MODULE,
    &definition::refusals::TYPESCRIPT_MODULE,
    &definition::versions::TYPESCRIPT_MODULE,
    &kept_values::TYPESCRIPT_MODULE,
    &kind::TYPESCRIPT_MODULE,
    &run::attention::TYPESCRIPT_MODULE,
    &run::control::TYPESCRIPT_MODULE,
    &run::events::TYPESCRIPT_MODULE,
    &run::failures::TYPESCRIPT_MODULE,
    &run::gate_resolution::TYPESCRIPT_MODULE,
    &run::id::TYPESCRIPT_MODULE,
    &run::list::TYPESCRIPT_MODULE,
    &run::new_run_hold::TYPESCRIPT_MODULE,
    &run::records::TYPESCRIPT_MODULE,
    &run::retention::TYPESCRIPT_MODULE,
    &run::snapshot::TYPESCRIPT_MODULE,
    &run::status::TYPESCRIPT_MODULE,
    &run::step::events::TYPESCRIPT_MODULE,
    &run::step::methods::TYPESCRIPT_MODULE,
    &run::step::record::TYPESCRIPT_MODULE,
    &run::tool::TYPESCRIPT_MODULE,
    &run::trigger::TYPESCRIPT_MODULE,
    &secret::TYPESCRIPT_MODULE,
    &subscription::TYPESCRIPT_MODULE,
];
