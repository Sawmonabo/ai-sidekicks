//! Providers: names, accounts, drivers, settings, imports and tools.

use crate::typescript::TypeScriptModule;

pub mod account;
pub mod driver;
pub mod import;
pub mod name;
pub mod settings;
pub mod tools;

/// The topic's TypeScript modules, its folders' among them.
pub(crate) const TYPESCRIPT_MODULES: &[&TypeScriptModule] = &[
    &account::methods::TYPESCRIPT_MODULE,
    &account::record::TYPESCRIPT_MODULE,
    &account::sign_in::TYPESCRIPT_MODULE,
    &driver::capabilities::TYPESCRIPT_MODULE,
    &driver::commands::TYPESCRIPT_MODULE,
    &driver::compaction::TYPESCRIPT_MODULE,
    &driver::declared_loss::TYPESCRIPT_MODULE,
    &driver::intervention::TYPESCRIPT_MODULE,
    &driver::length_limits::TYPESCRIPT_MODULE,
    &driver::methods::TYPESCRIPT_MODULE,
    &driver::output_speed::TYPESCRIPT_MODULE,
    &driver::recovery::TYPESCRIPT_MODULE,
    &driver::tools::TYPESCRIPT_MODULE,
    &driver::ultracode::TYPESCRIPT_MODULE,
    &driver::usage_limit::TYPESCRIPT_MODULE,
    &import::TYPESCRIPT_MODULE,
    &name::TYPESCRIPT_MODULE,
    &settings::TYPESCRIPT_MODULE,
    &tools::TYPESCRIPT_MODULE,
];
