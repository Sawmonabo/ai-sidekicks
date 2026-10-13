//! Building blocks the other modules share and no client imports: the branded id macros.

use crate::typescript::TypeScriptModule;

pub(crate) mod branded;

/// The internal modules' TypeScript modules.
pub(crate) const TYPESCRIPT_MODULES: &[&TypeScriptModule] = &[&branded::TYPESCRIPT_MODULE];
