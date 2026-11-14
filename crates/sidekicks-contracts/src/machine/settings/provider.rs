//! The provider members of the machine's settings file, which `provider.update` writes and
//! `machine.settings.update` never does: the values set on each provider's declared Settings rows,
//! each provider's command paths and the knobs every provider offers.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::free_form_string::FilesystemPath;
use crate::place::Place;
use crate::provider::declaration::{
    ProviderDeclarationId, ProviderPlaceSwitches, ProviderValueText,
};
use crate::provider::id::ProviderId;
use crate::provider::settings::CompactPercent;
use crate::wire::NullableSchema;
use crate::wire::integer::SafeInt;
use crate::wire::list::{ListKey, UniqueList};
use crate::wire::record::Record;

/// One declared Settings row's value set in the app, split by the row's shape; its check refuses
/// two entries for one place.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
#[garde(allow_unvalidated)]
pub enum ProviderRowValue {
    /// A switch's entry for each place it was set in, keyed by place; a place left out follows the
    /// provider's own value there.
    Places(#[garde(dive)] ProviderPlaceSwitches),
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

/// One place's command path the person set in place of auto-detect. A computer without a WSL 2
/// distribution has one entry and names no place.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderCommandPath {
    /// The place; absent on a computer without a WSL 2 distribution.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Place")]
    pub place: Option<Place>,
    /// The path the provider's command is started from there.
    pub path: FilesystemPath,
}

impl ListKey for ProviderCommandPath {
    type Key = Option<Place>;
    const KEY_MEMBER: Option<&'static str> = Some("place");

    fn list_key(&self) -> Option<Place> {
        self.place.clone()
    }

    // It carries no rule its read does not hold.
    fn validate_item(&self, _parent: &mut dyn FnMut() -> garde::Path, _report: &mut garde::Report) {
    }
}

/// One provider's command paths, one entry per place set; a place without one auto-detects.
pub type ProviderCommandPaths = UniqueList<ProviderCommandPath, 1, { usize::MAX }>;

/// Each provider's command paths, by provider; a provider left out auto-detects in every place.
/// A provider id never reads `__proto__`, which its pattern excludes, and the schema refuses it
/// too.
pub type ProviderCommandPathValues = Record<ProviderId, ProviderCommandPaths>;

/// The knobs every provider offers, each absent until set: availability absent reads on, the
/// helper limit absent or `null` reads no limit and `0` none, and the compaction threshold absent
/// follows the provider's own setting.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderKnobs {
    /// Whether a new session may use the provider.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "bool")]
    pub available_for_new_sessions: Option<bool>,
    /// How many helpers run at once: absent or `null` for no limit, `0` for none.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "serde_with::rust::double_option"
    )]
    #[schemars(with = "NullableSchema<SafeInt<0>>")]
    pub helpers_at_once: Option<Option<SafeInt<0>>>,
    /// The compaction threshold in percent full.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "CompactPercent")]
    pub auto_compact_percent: Option<CompactPercent>,
}

impl ProviderKnobs {
    /// Whether a new session may use the provider: on until it is turned off.
    pub fn is_available_for_new_sessions(&self) -> bool {
        self.available_for_new_sessions.unwrap_or(true)
    }

    /// How many helpers run at once, `None` for no limit, whether the limit was never set or set
    /// to `null`.
    pub fn helpers_at_once_limit(&self) -> Option<SafeInt<0>> {
        self.helpers_at_once.flatten()
    }
}

/// Each provider's knobs, by provider; a provider left out reads every knob unset. A provider id
/// never reads `__proto__`, which its pattern excludes, and the schema refuses it too.
pub type ProviderKnobValues = Record<ProviderId, ProviderKnobs>;

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::ProviderKnobs;
    use crate::wire::integer::SafeInt;

    // Killed by reading `null` as `0`, or absent as `null`: each keeps its own value and is
    // written back as it was read.
    #[test]
    fn helpers_at_once_absent_null_and_zero_read_as_three_values() {
        let cases = [
            (json!({}), None, None),
            (json!({ "helpersAtOnce": null }), Some(None), None),
            (
                json!({ "helpersAtOnce": 0 }),
                Some(Some(SafeInt::ZERO)),
                Some(SafeInt::ZERO),
            ),
        ];
        for (file, helpers_at_once, limit) in cases {
            let knobs: ProviderKnobs = serde_json::from_value(file.clone()).expect("knobs read");
            assert_eq!(knobs.helpers_at_once, helpers_at_once, "{file}");
            assert_eq!(knobs.helpers_at_once_limit(), limit, "{file}");
            assert_eq!(serde_json::to_value(&knobs).expect("knobs serialize"), file);
        }
    }
}
