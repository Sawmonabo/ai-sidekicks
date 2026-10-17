//! Where the window size on a `usage.contextWindow.updated` row came from.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::VariantArray;

use crate::typescript::{Definition, TypeScriptModule, ts_constants};

/// Where a context window's figures came from: the provider reported them, or the window is the
/// model's declared default.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, VariantArray,
)]
#[serde(rename_all = "camelCase")]
pub enum ContextWindowSource {
    /// The provider reported the figures.
    ProviderReported,
    /// The window is the model's declared default.
    ModelDefault,
}

ts_constants! {
    /// Every [`ContextWindowSource`].
    CONTEXT_WINDOW_SOURCES = ContextWindowSource::VARIANTS;
}

/// The TypeScript module of the context window's source.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "context-window",
    doc: "Where the window size on a `usage.contextWindow.updated` row came from.",
    definitions: &[Definition::read::<ContextWindowSource>()],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
