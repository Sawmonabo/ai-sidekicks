//! What a driver offers a client: its models and modes, its capability flags and its contract
//! version. The `driver.list*` replies that carry them are in the driver's methods.

use std::borrow::Cow;
use std::collections::BTreeMap;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};

use crate::free_form_string::FILE_PATH_MAX_LEN;
use crate::provider::driver::methods::{
    DRIVER_WIRE_CONTRACT_VERSION_MAX_LEN, DRIVER_WIRE_HANDLE_MAX_LEN, DRIVER_WIRE_TOKEN_MAX_LEN,
};
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::integer::SafeInt;
use crate::wire::list::BoundedVec;
use crate::wire::text::FreeFormText;

/// One selectable model of one provider, normalized at the driver's boundary. A model's default
/// row and its larger-window row share the model's id, so a row is found by its id and its
/// `largerWindow` together.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderModel {
    /// The model's id.
    pub id: FreeFormText<DRIVER_WIRE_TOKEN_MAX_LEN>,
    /// The model's name.
    pub name: FreeFormText<DRIVER_WIRE_TOKEN_MAX_LEN>,
    /// What the model can do, in the provider's words.
    pub capabilities: Vec<FreeFormText<DRIVER_WIRE_TOKEN_MAX_LEN>>,
    /// The model's reasoning-effort levels, as the installed build offers them; absent means the
    /// model has no effort axis, which an empty list would deny.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Vec<FreeFormText<DRIVER_WIRE_TOKEN_MAX_LEN>>")]
    pub effort_levels: Option<Vec<FreeFormText<DRIVER_WIRE_TOKEN_MAX_LEN>>>,
    /// The model's output-speed levels where its provider publishes them per model; absent means
    /// the model exposes no speed selection.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Vec<FreeFormText<DRIVER_WIRE_TOKEN_MAX_LEN>>")]
    pub output_speed_levels: Option<Vec<FreeFormText<DRIVER_WIRE_TOKEN_MAX_LEN>>>,
    /// Whether the model has a fast output mode, as its provider reports it.
    pub fast: bool,
    /// Whether this row is the model's larger window, offered beside its default row.
    pub larger_window: bool,
    /// The window in tokens as the provider reports it; absent until a reading arrives.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SafeInt<1>")]
    pub context_window: Option<SafeInt<1>>,
}

/// The catalog row a choice names, found by the model's id and whether it is the larger window;
/// `None` when the catalog holds no such row.
pub fn find_provider_model_row<'rows>(
    rows: &'rows [ProviderModel],
    model_id: &str,
    larger_window: bool,
) -> Option<&'rows ProviderModel> {
    rows.iter()
        .find(|row| row.id.as_str() == model_id && row.larger_window == larger_window)
}

/// One selectable mode of one provider, normalized at the driver's boundary.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderMode {
    /// The mode's id.
    pub id: FreeFormText<DRIVER_WIRE_TOKEN_MAX_LEN>,
    /// The mode's name.
    pub name: FreeFormText<DRIVER_WIRE_TOKEN_MAX_LEN>,
}

/// One driver capability flag. The database's list and every map over the flags follow this
/// order, and the daemon stores one row per flag.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum DriverCapabilityFlag {
    /// Resumes a provider session.
    Resume,
    /// Steers a running turn.
    Steer,
    /// Asks the person mid-turn.
    InteractiveRequests,
    /// Runs tool servers.
    Mcp,
    /// Calls tools.
    ToolCalls,
    /// Streams its reasoning.
    ReasoningStream,
    /// Changes the model mid-session.
    ModelMutation,
    /// Answers in a given shape.
    StructuredOutput,
    /// Rolls a conversation back.
    Rollback,
    /// Moves the session onto a new provider conversation forked from the bound one at a message;
    /// never an undo.
    SessionFork,
    /// Keeps a session goal.
    SessionGoals,
    /// Calls the daemon's callback tools.
    CallbackTools,
    /// Runs subagents.
    Subagents,
    /// Compacts the bound session's provider-side context when the person asks.
    ContextCompaction,
    /// Lists the provider's commands and skills live.
    ProviderCommands,
    /// A faster-output mode the person sets and the provider declares a state for.
    OutputSpeed,
}

ts_constants! {
    /// Every driver capability flag, in canonical order.
    pub const DRIVER_CAPABILITY_FLAGS: [DriverCapabilityFlag; 16] = [
        DriverCapabilityFlag::Resume,
        DriverCapabilityFlag::Steer,
        DriverCapabilityFlag::InteractiveRequests,
        DriverCapabilityFlag::Mcp,
        DriverCapabilityFlag::ToolCalls,
        DriverCapabilityFlag::ReasoningStream,
        DriverCapabilityFlag::ModelMutation,
        DriverCapabilityFlag::StructuredOutput,
        DriverCapabilityFlag::Rollback,
        DriverCapabilityFlag::SessionFork,
        DriverCapabilityFlag::SessionGoals,
        DriverCapabilityFlag::CallbackTools,
        DriverCapabilityFlag::Subagents,
        DriverCapabilityFlag::ContextCompaction,
        DriverCapabilityFlag::ProviderCommands,
        DriverCapabilityFlag::OutputSpeed,
    ];
}

/// Each capability flag's value: every flag present, no other member.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct DriverCapabilityFlags(BTreeMap<DriverCapabilityFlag, bool>);

impl<'de> Deserialize<'de> for DriverCapabilityFlags {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let flags = BTreeMap::<DriverCapabilityFlag, bool>::deserialize(deserializer)?;
        match DRIVER_CAPABILITY_FLAGS
            .iter()
            .find(|flag| !flags.contains_key(flag))
        {
            Some(missing) => Err(D::Error::custom(format!("the flag {missing:?} is missing"))),
            None => Ok(Self(flags)),
        }
    }
}

impl JsonSchema for DriverCapabilityFlags {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "DriverCapabilityFlags".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        let names: Vec<serde_json::Value> = DRIVER_CAPABILITY_FLAGS
            .iter()
            .map(|flag| serde_json::to_value(flag).expect("a flag serializes as its name"))
            .collect();
        let properties: serde_json::Map<String, serde_json::Value> = names
            .iter()
            .filter_map(serde_json::Value::as_str)
            .map(|name| {
                (
                    name.to_owned(),
                    json_schema!({ "type": "boolean" }).to_value(),
                )
            })
            .collect();
        json_schema!({
            "type": "object",
            "properties": properties,
            "required": names,
            "additionalProperties": false,
        })
    }
}

/// A driver's capability flags and contract version.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DriverCapabilities {
    /// Each flag's value.
    pub flags: DriverCapabilityFlags,
    /// The driver's contract version.
    pub contract_version: FreeFormText<DRIVER_WIRE_CONTRACT_VERSION_MAX_LEN>,
}

/// A file path: at most [`FILE_PATH_MAX_LEN`] code points and no NUL. Blank stays legal, since a
/// folder may be named with a single space.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct FilesystemPath(String);

impl FilesystemPath {
    /// `path` when it is non-empty, within the cap and holds no NUL, else `None`.
    pub fn new(path: String) -> Option<Self> {
        let is_within_cap = !path.is_empty() && path.chars().nth(FILE_PATH_MAX_LEN).is_none();
        (is_within_cap && !path.contains('\0')).then_some(Self(path))
    }

    /// The path.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for FilesystemPath {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(String::deserialize(deserializer)?)
            .ok_or_else(|| D::Error::custom("a path is 1 to 4096 code points with no NUL"))
    }
}

impl JsonSchema for FilesystemPath {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "FilesystemPath".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "string",
            "minLength": 1,
            "maxLength": FILE_PATH_MAX_LEN,
            "pattern": "^[^\\x00]*$",
        })
    }
}

/// The name of the credential deny list handed to the provider, a reference so the list itself is
/// never embedded.
pub type CredentialPolicyRef = FreeFormText<DRIVER_WIRE_HANDLE_MAX_LEN>;

/// Declares the execution posture: each permission level's arm repeats the credential policy, then
/// adds its writable roots.
macro_rules! execution_posture {
    (
        $(#[doc = $doc:literal])+
        pub enum $name:ident {
            $($(#[doc = $arm_doc:literal])+ $arm:ident { $($extra:tt)* },)+
        }
    ) => {
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
        #[serde(
            tag = "mode",
            rename_all = "lowercase",
            rename_all_fields = "camelCase",
            deny_unknown_fields
        )]
        pub enum $name {$(
            $(#[doc = $arm_doc])+
            $arm {
                /// The credential deny list handed to the provider on every level.
                credential_policy_ref: CredentialPolicyRef,
                $($extra)*
            },
        )+}
    };
}

execution_posture! {
    /// How a run may touch the machine, tagged on `mode`, the permission level: `readonly` and
    /// `yolo` carry no writable roots, so only `ask`, `reviewed` and `sandboxed` name the folders a
    /// run may write.
    pub enum ExecutionPosture {
        /// Reads only.
        Readonly {
            /// Always empty.
            writable_roots: BoundedVec<FilesystemPath, 0, 0>,
        },
        /// Asks before every change.
        Ask {
            /// The folders a run may write.
            writable_roots: Vec<FilesystemPath>,
        },
        /// Asks before a reviewed change.
        Reviewed {
            /// The folders a run may write.
            writable_roots: Vec<FilesystemPath>,
        },
        /// Runs inside the sandbox without asking.
        Sandboxed {
            /// The folders a run may write.
            writable_roots: Vec<FilesystemPath>,
        },
        /// Runs without asking.
        Yolo {
            /// Always empty.
            writable_roots: BoundedVec<FilesystemPath, 0, 0>,
        },
    }
}

/// The TypeScript module of what a driver offers.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "provider/driver/capabilities",
    doc: "What a driver offers a client: its models and modes, its capability flags and its \
          contract version.",
    definitions: &[
        Definition::read::<ProviderModel>(),
        Definition::read::<ProviderMode>(),
        Definition::read::<DriverCapabilityFlag>(),
        Definition::read::<DriverCapabilities>(),
        Definition::read::<FilesystemPath>(),
        Definition::read::<ExecutionPosture>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
