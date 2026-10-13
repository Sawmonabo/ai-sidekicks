//! The fields two refusals carry in `data.fields`: `resource.limit_exceeded` and
//! `pty.backend_unavailable`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire;
use crate::wire::AnyValue;
use crate::wire::integer::SafeInt;
use crate::wire::text::FreeFormText;

ts_constants! {
    /// The longest name of a limit a `resource.limit_exceeded` refusal reports.
    pub const RESOURCE_LABEL_MAX_LEN: usize = 128;
    /// The longest message a refusal carries: well above any readable message, still bounded.
    pub const ERROR_MESSAGE_MAX_LEN: usize = 8192;
}

/// A `resource.limit_exceeded` refusal's fields: the name of the limit that tripped, its ceiling
/// and the count that passed it. The screen says the limit was reached in words and draws no
/// figure.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ResourceLimitExceededFields {
    /// The limit's name.
    pub resource: FreeFormText<RESOURCE_LABEL_MAX_LEN>,
    /// The limit's ceiling.
    pub limit: SafeInt<0>,
    /// The count that passed it.
    pub current: SafeInt<0>,
}

/// A `pty.backend_unavailable` refusal's fields: why the daemon could not open the PTY a shell
/// needs, rendered opaquely and never branched on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PtyBackendUnavailableFields {
    /// What the platform's PTY reported.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "wire::present"
    )]
    #[schemars(with = "AnyValue")]
    pub cause: Option<AnyValue>,
}

/// The TypeScript module of the refusals' fields.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "error",
    doc: "The fields two refusals carry in `data.fields`: `resource.limit_exceeded` and \
          `pty.backend_unavailable`.",
    definitions: &[
        Definition::read::<ResourceLimitExceededFields>(),
        Definition::read::<PtyBackendUnavailableFields>(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
