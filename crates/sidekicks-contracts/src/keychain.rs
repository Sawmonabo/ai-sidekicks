//! Why this machine's keychain could not be used: the one cause a refused seal carries, whether of
//! a provider account's token, a workflow secret or a notification delivery secret.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::VariantArray;

use crate::typescript::{Definition, TypeScriptModule, ts_constants};

/// Why this machine's keychain could not be used: it is `locked`, or there is no keychain the app
/// can use (`unavailable`). A secret that cannot be sealed is refused and stored nowhere else.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, VariantArray,
)]
#[serde(rename_all = "camelCase")]
pub enum KeychainRefusalCause {
    /// The keychain is locked.
    Locked,
    /// There is no keychain the app can use.
    Unavailable,
}

ts_constants! {
    /// Every [`KeychainRefusalCause`], one line each on the paste-token refusal.
    KEYCHAIN_REFUSAL_CAUSES = KeychainRefusalCause::VARIANTS;
}

/// The TypeScript module of the keychain's refusal cause.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "keychain",
    doc: "Why this machine's keychain could not be used: the one cause a refused seal carries.",
    definitions: &[Definition::read::<KeychainRefusalCause>()],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
