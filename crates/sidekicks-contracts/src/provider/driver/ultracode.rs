//! The provider's own report of its Ultracode state on one binding.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::typescript::{Definition, TypeScriptModule};

/// The provider's own report of its Ultracode state, read after each spawn and each change and
/// held for the binding's life; absent until the first report and never stored.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObservedUltracode {
    /// Whether the provider reports it in effect.
    pub is_on: bool,
    /// Whether the session can run it.
    pub is_available: bool,
}

/// The TypeScript module of the Ultracode state.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "provider/driver/ultracode",
    doc: "The provider's own report of its Ultracode state on one binding.",
    definitions: &[Definition::read::<ObservedUltracode>().checked()],
    constants: &[],
    method_tables: &[],
};
