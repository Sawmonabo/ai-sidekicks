//! The closed set of providers the daemon drives, and what each is called on screen, where the
//! wire's name never appears.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::typescript::{Definition, TypeScriptModule, ts_constants};

/// A provider the daemon drives. The set is closed because the provider selects the driver, the
/// credential-home layout and the quota words, so an unknown value has no safe reading.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "lowercase")]
pub enum ProviderName {
    /// Claude Code.
    Claude,
    /// Codex.
    Codex,
}

impl ProviderName {
    /// The provider's wire name, the text serde writes for it.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }

    /// The provider's on-screen name.
    pub const fn label(self) -> &'static str {
        match self {
            Self::Claude => "Claude Code",
            Self::Codex => "Codex",
        }
    }
}

ts_constants! {
    /// Every provider, in declaration order.
    pub const PROVIDER_NAMES: [ProviderName; 2] = [ProviderName::Claude, ProviderName::Codex];
    /// The on-screen name of each provider.
    PROVIDER_LABELS = PROVIDER_NAMES
        .iter()
        .map(|provider| (*provider, provider.label()))
        .collect::<BTreeMap<_, _>>();
}

/// The TypeScript module of the provider names.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "provider/name",
    doc: "The closed set of providers the daemon drives, and what each is called on screen, where \
          the wire's name never appears.",
    definitions: &[Definition::read::<ProviderName>().checked()],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
