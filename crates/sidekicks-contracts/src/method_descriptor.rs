//! What every method table shares: the payload of a method whose request or reply carries nothing,
//! and the `null` reply of an act that reads nothing back.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::typescript::{Definition, TypeScriptModule};

/// A request or reply that carries nothing: the method's whole effect is what it changed. Any
/// member is refused.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct EmptyPayload {}

/// The reply of an act that reads nothing back: `null`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct NullPayload;

/// The TypeScript module of what every method table shares.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "method-descriptor",
    doc: "What every method table shares: the payload of a method whose request or reply carries \
          nothing, and the `null` reply of an act that reads nothing back.",
    definitions: &[
        Definition::read::<EmptyPayload>().checked(),
        Definition::read::<NullPayload>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};
