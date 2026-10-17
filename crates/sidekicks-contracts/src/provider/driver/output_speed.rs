//! The provider's own report of its accelerated-output state on one binding.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::provider::driver::length_limits::{
    PROVIDER_DECLARED_TOKEN_MAX_LEN, PROVIDER_OUTPUT_SPEED_REASON_MAX_LEN,
};
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::text::FreeFormText;

/// The provider's own report of its accelerated-output state, held for the binding's life from the
/// first declaration the provider makes; absent until then and never stored.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderOutputSpeedState {
    /// The provider's level as sent; a level the driver does not list is kept, not coerced.
    pub declared: FreeFormText<PROVIDER_DECLARED_TOKEN_MAX_LEN>,
    /// The provider's own explanation, where it gave one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<PROVIDER_OUTPUT_SPEED_REASON_MAX_LEN>")]
    pub reason: Option<FreeFormText<PROVIDER_OUTPUT_SPEED_REASON_MAX_LEN>>,
}

/// The TypeScript module of the output speed state.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "provider/driver/output-speed",
    doc: "The provider's own report of its accelerated-output state on one binding.",
    definitions: &[Definition::read::<ProviderOutputSpeedState>().checked()],
    constants: &[],
    method_tables: &[],
};
