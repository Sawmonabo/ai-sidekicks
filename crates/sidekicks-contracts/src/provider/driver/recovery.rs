//! Why a run needs recovery: the axis a resume failure and a run's state change carry.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::VariantArray;

use crate::typescript::{Definition, TypeScriptModule, ts_constants};

/// Why a run needs attention.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, VariantArray,
)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryCondition {
    /// The person must reconcile the run.
    RecoveryNeeded,
    /// The provider's session or credential expired; recovery may retry once the provider is
    /// signed in again.
    ReauthRequired,
}

ts_constants! {
    /// Every recovery condition.
    RECOVERY_CONDITIONS = RecoveryCondition::VARIANTS;
}

/// The TypeScript module of the recovery conditions.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "provider/driver/recovery",
    doc: "Why a run needs recovery: the axis a resume failure and a run's state change carry.",
    definitions: &[Definition::read::<RecoveryCondition>().checked()],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
