//! The provider members of the machine's settings file, which `provider.update` writes and
//! `machine.settings.update` never does: the values set on each provider's declared Settings rows.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::provider::declaration::{
    ProviderDeclarationId, ProviderPlaceSwitches, ProviderValueText,
};
use crate::provider::id::ProviderId;
use crate::wire::NullableSchema;
use crate::wire::record::Record;

/// One declared Settings row's value set in the app, split by the row's shape.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum ProviderRowValue {
    /// A switch's entry for each place it was set in, keyed by place; a place left out follows the
    /// provider's own value there.
    Places(ProviderPlaceSwitches),
    /// A choice's option or `null` for its none, or a text setting's text or `null` for none.
    Value(#[schemars(with = "NullableSchema<ProviderValueText>")] Option<ProviderValueText>),
}

/// One provider's values of the Settings rows its driver declares, by row. A row left out follows
/// the provider's own value. A row id never reads `__proto__`, which its pattern excludes, and the
/// schema refuses it too.
pub type ProviderRowValues = Record<ProviderDeclarationId, ProviderRowValue>;

/// Each provider's values of its declared Settings rows, by provider; a provider left out follows
/// its own values on every row. A provider id never reads `__proto__`, which its pattern excludes,
/// and the schema refuses it too.
pub type ProviderSettingValues = Record<ProviderId, ProviderRowValues>;
