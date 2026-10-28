//! The wire's one source: serde types with garde checks for every message the daemon, the
//! command line, the desktop and the control plane exchange, from which the TypeScript types and
//! checks are generated.

pub mod account;
pub mod agent;
pub mod app_identity;
pub mod app_link;
pub mod approval;
pub mod artifacts;
pub mod attention;
pub mod browser;
pub mod callback_tool;
pub mod channel;
pub mod cloud;
pub mod color;
pub mod command;
pub mod context_window;
pub mod daemon;
pub mod device;
pub mod error;
pub mod event;
pub mod free_form_string;
pub mod git;
pub mod highlight;
mod internal;
pub mod jsonrpc;
pub mod keychain;
pub mod machine;
pub mod mcp;
pub mod method;
pub mod method_descriptor;
pub mod name_fold;
pub mod orchestration;
pub mod place;
pub mod plan;
pub mod platform;
pub mod plugin;
pub mod presence;
pub mod preview;
pub mod process_identity;
pub mod project;
pub mod provider;
pub mod push;
pub mod question;
pub mod rate_limiter;
pub mod relay;
pub mod release_manifest;
pub mod repo;
pub mod review_note;
pub mod run;
pub mod schema;
pub mod session;
pub mod skill;
pub mod tag;
pub mod terminal;
pub mod transcript;
pub mod trust;
pub mod trust_statement;
pub mod turn;
pub mod typescript;
pub mod voice;
pub mod web_address;
pub mod webauthn;
pub mod wire;
pub mod workflow;
pub mod worktree;

use std::collections::HashMap;
use std::sync::OnceLock;

use crate::method::MethodDescriptor;
use crate::typescript::TypeScriptModule;

/// Every contract module's TypeScript face, topic by topic: what the emit writes for the
/// TypeScript generator.
pub fn typescript_modules() -> impl Iterator<Item = &'static TypeScriptModule> {
    [
        agent::TYPESCRIPT_MODULES,
        artifacts::TYPESCRIPT_MODULES,
        daemon::TYPESCRIPT_MODULES,
        event::TYPESCRIPT_MODULES,
        git::TYPESCRIPT_MODULES,
        internal::TYPESCRIPT_MODULES,
        jsonrpc::TYPESCRIPT_MODULES,
        machine::TYPESCRIPT_MODULES,
        mcp::TYPESCRIPT_MODULES,
        preview::TYPESCRIPT_MODULES,
        provider::TYPESCRIPT_MODULES,
        repo::TYPESCRIPT_MODULES,
        run::TYPESCRIPT_MODULES,
        session::TYPESCRIPT_MODULES,
        transcript::TYPESCRIPT_MODULES,
        webauthn::TYPESCRIPT_MODULES,
        wire::TYPESCRIPT_MODULES,
        workflow::TYPESCRIPT_MODULES,
        worktree::TYPESCRIPT_MODULES,
        ROOT_TYPESCRIPT_MODULES,
    ]
    .into_iter()
    .flatten()
    .copied()
}

/// The method `method` names in the contracts' method tables, or `None` for a name no table
/// declares; the protocol's own methods (`connection.initialize`, `$/subscription/cancel`) are in
/// none of them.
pub fn method_descriptor(method: &str) -> Option<&'static MethodDescriptor> {
    static DESCRIPTORS: OnceLock<HashMap<&'static str, &'static MethodDescriptor>> =
        OnceLock::new();
    DESCRIPTORS
        .get_or_init(|| {
            typescript_modules()
                .flat_map(|module| module.method_tables)
                .flat_map(|table| table.methods)
                .map(|descriptor| (descriptor.method, descriptor))
                .collect()
        })
        .get(method)
        .copied()
}

/// The TypeScript modules of the root contract modules.
const ROOT_TYPESCRIPT_MODULES: &[&TypeScriptModule] = &[
    &account::TYPESCRIPT_MODULE,
    &app_identity::TYPESCRIPT_MODULE,
    &app_link::TYPESCRIPT_MODULE,
    &approval::TYPESCRIPT_MODULE,
    &attention::TYPESCRIPT_MODULE,
    &browser::TYPESCRIPT_MODULE,
    &callback_tool::TYPESCRIPT_MODULE,
    &channel::TYPESCRIPT_MODULE,
    &cloud::TYPESCRIPT_MODULE,
    &color::TYPESCRIPT_MODULE,
    &command::TYPESCRIPT_MODULE,
    &context_window::TYPESCRIPT_MODULE,
    &device::TYPESCRIPT_MODULE,
    &error::TYPESCRIPT_MODULE,
    &free_form_string::TYPESCRIPT_MODULE,
    &highlight::TYPESCRIPT_MODULE,
    &keychain::TYPESCRIPT_MODULE,
    &method_descriptor::TYPESCRIPT_MODULE,
    &orchestration::TYPESCRIPT_MODULE,
    &place::TYPESCRIPT_MODULE,
    &plan::TYPESCRIPT_MODULE,
    &platform::TYPESCRIPT_MODULE,
    &plugin::TYPESCRIPT_MODULE,
    &presence::TYPESCRIPT_MODULE,
    &process_identity::TYPESCRIPT_MODULE,
    &project::TYPESCRIPT_MODULE,
    &push::TYPESCRIPT_MODULE,
    &question::TYPESCRIPT_MODULE,
    &rate_limiter::TYPESCRIPT_MODULE,
    &relay::TYPESCRIPT_MODULE,
    &release_manifest::TYPESCRIPT_MODULE,
    &review_note::TYPESCRIPT_MODULE,
    &skill::TYPESCRIPT_MODULE,
    &tag::TYPESCRIPT_MODULE,
    &terminal::TYPESCRIPT_MODULE,
    &trust_statement::TYPESCRIPT_MODULE,
    &turn::TYPESCRIPT_MODULE,
    &voice::TYPESCRIPT_MODULE,
    &web_address::TYPESCRIPT_MODULE,
];
