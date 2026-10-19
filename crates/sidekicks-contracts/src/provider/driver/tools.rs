//! The tools a driver declares and the daemon offers: each tool's metadata and idempotency class,
//! and the callback tools the daemon serves the model.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use strum::{IntoStaticStr, VariantArray};

use crate::provider::driver::length_limits::{
    PROVIDER_TOOL_DESCRIPTION_MAX_LEN, PROVIDER_TOOL_NAME_MAX_LEN,
};
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::text::FreeFormText;

/// A tool's declared idempotency: safe to repeat, undoable, or needing a person to reconcile. A
/// daemon restart runs no call again, whatever its class.
#[derive(
    Clone,
    Copy,
    Debug,
    Default,
    PartialEq,
    Eq,
    Hash,
    Serialize,
    Deserialize,
    JsonSchema,
    VariantArray,
    IntoStaticStr,
)]
#[serde(rename_all = "camelCase")]
#[strum(serialize_all = "camelCase")]
pub enum IdempotencyClass {
    /// Safe to repeat.
    Idempotent,
    /// Undoable.
    Compensable,
    /// Needs a person to reconcile; a tool that declares no class reads as this.
    #[default]
    ManualReconcileOnly,
}

ts_constants! {
    /// Every idempotency class, safest to repeat first.
    IDEMPOTENCY_CLASSES = IdempotencyClass::VARIANTS;
}

/// A tool a driver declares. An undeclared class reads as `manualReconcileOnly`, and unknown
/// members are dropped rather than refused, because providers extend the declaration.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ProviderToolMetadata {
    /// The tool's name.
    pub name: FreeFormText<PROVIDER_TOOL_NAME_MAX_LEN>,
    /// The tool's idempotency.
    #[serde(default)]
    pub idempotency_class: IdempotencyClass,
    /// The tool's description.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<PROVIDER_TOOL_DESCRIPTION_MAX_LEN>")]
    pub description: Option<FreeFormText<PROVIDER_TOOL_DESCRIPTION_MAX_LEN>>,
}

/// A tool the daemon offers the model: a name, a description and a JSON Schema input. Every call
/// goes through the daemon's approval pipeline and lands as an ordinary tool activity row.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionCallbackTool {
    /// The tool's name.
    pub name: String,
    /// What the tool does, for the model.
    pub description: String,
    /// The tool's input as a JSON Schema.
    pub input_schema: Map<String, Value>,
}

/// The TypeScript module of driver tools.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "provider/driver/tools",
    doc: "The tools a driver declares and the daemon offers: each tool's metadata and idempotency \
          class, and the callback tools the daemon serves the model.",
    definitions: &[
        Definition::read::<IdempotencyClass>(),
        Definition::read::<ProviderToolMetadata>().checked(),
        Definition::read::<SessionCallbackTool>(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
