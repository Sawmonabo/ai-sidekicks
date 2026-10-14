//! What every method table shares: the payload of a method whose request or reply carries nothing,
//! and the `null` reply of an act that reads nothing back.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::typescript::{Definition, TypeScriptModule};

/// A request or reply that carries nothing: the method's whole effect is what it changed. Any
/// member is refused.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate,
)]
#[serde(deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct EmptyPayload {}

/// The reply of an act that reads nothing back: `null`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct NullPayload;

/// `null` holds no rule; garde's derive takes no unit struct, so the empty check is written out.
impl garde::Validate for NullPayload {
    type Context = ();

    fn validate_into(
        &self,
        (): &Self::Context,
        _parent: &mut dyn FnMut() -> garde::Path,
        _report: &mut garde::Report,
    ) {
    }
}

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
