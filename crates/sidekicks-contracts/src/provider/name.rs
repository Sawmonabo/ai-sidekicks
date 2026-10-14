//! The closed set of providers the daemon drives, and what each is called on screen, where the
//! wire's name never appears.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::{EnumString, VariantArray};

use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::literal;

/// A provider the daemon drives. The set is closed because the provider selects the driver, the
/// credential-home layout and the quota words, so an unknown value has no safe reading. Text parses
/// to a name with `str::parse` in the spelling serde writes.
#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    Hash,
    Serialize,
    Deserialize,
    JsonSchema,
    VariantArray,
    EnumString,
)]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase")]
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
    pub const PROVIDER_NAMES: &[ProviderName] = ProviderName::VARIANTS;
    /// The on-screen name of each provider.
    PROVIDER_LABELS = PROVIDER_NAMES
        .iter()
        .map(|provider| (*provider, provider.label()))
        .collect::<BTreeMap<_, _>>();
}

literal! {
    /// The `claude` provider name alone, in a member only Claude Code may name.
    pub enum ClaudeProviderWord = const ProviderName::Claude.as_str();
    /// The `codex` provider name alone, in a member only Codex may name.
    pub enum CodexProviderWord = const ProviderName::Codex.as_str();
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
