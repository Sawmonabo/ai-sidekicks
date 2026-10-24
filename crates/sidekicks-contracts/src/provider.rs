//! Providers: ids, accounts, driver declarations, drivers, settings, installs, imports, tools.

use crate::typescript::TypeScriptModule;

pub mod account;
pub mod declaration;
pub mod driver;
pub mod id;
pub mod import;
pub mod install;
pub mod settings;
pub mod tool_call;
pub mod tools;

/// The topic's TypeScript modules, its folders' among them.
pub(crate) const TYPESCRIPT_MODULES: &[&TypeScriptModule] = &[
    &account::methods::TYPESCRIPT_MODULE,
    &account::record::TYPESCRIPT_MODULE,
    &account::sign_in::TYPESCRIPT_MODULE,
    &declaration::TYPESCRIPT_MODULE,
    &driver::capabilities::TYPESCRIPT_MODULE,
    &driver::commands::TYPESCRIPT_MODULE,
    &driver::compaction::TYPESCRIPT_MODULE,
    &driver::declared_loss::TYPESCRIPT_MODULE,
    &driver::length_limits::TYPESCRIPT_MODULE,
    &driver::methods::TYPESCRIPT_MODULE,
    &driver::output_speed::TYPESCRIPT_MODULE,
    &driver::recovery::TYPESCRIPT_MODULE,
    &driver::runtime_binding::TYPESCRIPT_MODULE,
    &driver::tools::TYPESCRIPT_MODULE,
    &driver::usage_limit::TYPESCRIPT_MODULE,
    &id::TYPESCRIPT_MODULE,
    &import::TYPESCRIPT_MODULE,
    &install::TYPESCRIPT_MODULE,
    &settings::TYPESCRIPT_MODULE,
    &tool_call::TYPESCRIPT_MODULE,
    &tools::TYPESCRIPT_MODULE,
];
