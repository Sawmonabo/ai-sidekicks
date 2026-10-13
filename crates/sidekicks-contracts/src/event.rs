//! Session events: the envelope, the registry of event types and their variants.

use crate::typescript::TypeScriptModule;

pub mod version;

/// The topic's TypeScript modules.
pub(crate) const TYPESCRIPT_MODULES: &[&TypeScriptModule] = &[&version::TYPESCRIPT_MODULE];
