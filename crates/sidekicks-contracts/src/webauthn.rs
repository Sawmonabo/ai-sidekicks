//! The passkeys the control plane is relying party for: the ceremonies that register one and sign
//! in with it, and a passkey's removal.

use crate::typescript::TypeScriptModule;

pub mod ceremony;
pub mod credential;

/// The topic's TypeScript modules.
pub(crate) const TYPESCRIPT_MODULES: &[&TypeScriptModule] =
    &[&ceremony::TYPESCRIPT_MODULE, &credential::TYPESCRIPT_MODULE];
