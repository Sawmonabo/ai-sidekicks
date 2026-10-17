//! The result of a provider's compaction, composed by the daemon from the wait's own end.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::integer::SafeInt;

/// Why a compaction was refused before anything was sent.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum CompactionRefusal {
    /// The provider's own command list for this binding lacks the command.
    CommandAbsent,
}

/// Why a compaction that was sent brought no boundary.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
pub enum CompactionFailure {
    /// The binding ended before the provider's frame came.
    BindingLost,
    /// The provider's mechanism errored.
    ProviderError,
    /// The provider ended the compaction's turn without compacting.
    NotCompacted,
}

/// The result of a compaction attempt: `applied` only after the provider's compaction frame was
/// seen, `refused` when nothing was sent, `failed` when something was sent and no boundary came.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate,
)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[garde(allow_unvalidated)]
pub enum DriverCompactionResult {
    /// The provider compacted.
    Applied {
        /// Where the boundary sits; `null` where the provider's frame carried none.
        #[serde(deserialize_with = "crate::wire::nullable")]
        #[schemars(with = "crate::wire::NullableSchema<SafeInt<0>>")]
        boundary_position: Option<SafeInt<0>>,
    },
    /// Nothing was sent.
    Refused {
        /// Why.
        reason: CompactionRefusal,
    },
    /// Something was sent and no boundary came.
    Failed {
        /// Why.
        reason: CompactionFailure,
    },
}

/// The TypeScript module of a compaction's result.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "provider/driver/compaction",
    doc: "The result of a provider's compaction, composed by the daemon from the wait's own end.",
    definitions: &[Definition::read::<DriverCompactionResult>().checked()],
    constants: &[],
    method_tables: &[],
};
