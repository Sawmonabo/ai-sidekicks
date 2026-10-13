//! Preview: a session's pages and their verbs, the dev servers the daemon discovers, the marks
//! sent to the provider, the live picture for another device, the page host's link to the desktop,
//! and the ports shared with the person's other devices.

use crate::typescript::TypeScriptModule;

pub mod dev_server;
pub mod marks;
pub mod methods;
pub mod page;
pub mod page_host;
pub mod port;
pub mod screencast;

/// The topic's TypeScript modules.
pub(crate) const TYPESCRIPT_MODULES: &[&TypeScriptModule] = &[
    &methods::TYPESCRIPT_MODULE,
    &page_host::TYPESCRIPT_MODULE,
    &port::TYPESCRIPT_MODULE,
];
