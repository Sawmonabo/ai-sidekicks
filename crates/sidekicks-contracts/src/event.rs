//! Session events: the envelope, the registry of event types, their categories and variants.

use crate::typescript::TypeScriptModule;

pub mod declared_variants;
pub mod envelope;
pub mod registry;
pub mod session;
pub mod type_categories;
pub mod version;

/// The topic's TypeScript modules.
pub(crate) const TYPESCRIPT_MODULES: &[&TypeScriptModule] = &[
    &declared_variants::TYPESCRIPT_MODULE,
    &envelope::TYPESCRIPT_MODULE,
    &registry::TYPESCRIPT_MODULE,
    &session::TYPESCRIPT_MODULE,
    &type_categories::TYPESCRIPT_MODULE,
    &version::TYPESCRIPT_MODULE,
];
