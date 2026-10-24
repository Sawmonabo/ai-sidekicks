//! The machine-wide service settings on Settings › Runtime, and the two package caches whose size
//! limit is one of them. A port already taken is saved all the same: the listener's own state
//! reports that nothing is listening, and the service never moves to another port.

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};

use crate::free_form_string::FilesystemPath;
use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::schema::doc_description;
use crate::session::cost::{TokensPerRun, UsdMicros};
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::instant::WireInstant;
use crate::wire::integer::{Port, SafeInt};

/// The port a workflow started by a web request listens on until the person picks another: one
/// constant, from a range no common developer tool uses, never a free port picked at the start.
pub const DEFAULT_WORKFLOW_LISTENER_PORT: u16 = 7391;

/// Declares a whole number that takes one of a fixed list of steps, as its own definition.
macro_rules! step_set {
    ($(#[doc = $doc:literal])+ $name:ident, $steps:ident = [$($step:literal),+]) => {
        /// Every step, in order.
        pub const $steps: &[u16] = &[$($step),+];

        $(#[doc = $doc])+
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
        #[serde(transparent)]
        pub struct $name(u16);

        impl $name {
            /// `value` when it is one of the steps, else `None`.
            pub fn new(value: u16) -> Option<Self> {
                $steps.contains(&value).then_some(Self(value))
            }

            /// The step.
            pub const fn get(self) -> u16 {
                self.0
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let value = u16::deserialize(deserializer)?;
                Self::new(value)
                    .ok_or_else(|| D::Error::custom(format!("{value} is not one of the steps")))
            }
        }

        impl JsonSchema for $name {
            fn schema_name() -> Cow<'static, str> {
                stringify!($name).into()
            }

            fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
                json_schema!({
                    "description": doc_description(concat!($($doc, "\n"),+)),
                    "enum": [$($step),+],
                })
            }
        }
    };
}

step_set! {
    /// `Stop a run after`'s steps, in minutes.
    RunTimeLimitMinutes, RUN_TIME_LIMIT_MINUTES = [30, 60, 240, 720, 1440]
}

step_set! {
    /// `Ask me after one start leads to`'s steps, in runs.
    WorkflowChainAskAfterRuns, WORKFLOW_CHAIN_ASK_AFTER_RUNS_STEPS = [25, 100, 500, 2000]
}

/// The settings, and the two facts the page draws beside them.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct DaemonConfig {
    /// The port a workflow started by a web request listens on.
    pub workflow_listener_port: Port,
    /// `Stop a run after`; `null` is `No limit`.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<RunTimeLimitMinutes>")]
    pub run_time_limit_minutes: Option<RunTimeLimitMinutes>,
    /// How many runs one start may lead to before the next asks; `null` is `Never ask`.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<WorkflowChainAskAfterRuns>")]
    pub workflow_chain_ask_after_runs: Option<WorkflowChainAskAfterRuns>,
    /// `Max steps per turn`; `null` is `Unlimited`, each provider's own behavior.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<SafeInt<1>>")]
    pub max_steps_per_turn: Option<SafeInt<1>>,
    /// `Spend limit`, what each new session starts from; `null` is `Unlimited`.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<UsdMicros>")]
    pub spend_limit_usd_micros: Option<UsdMicros>,
    /// `Tokens per run`, what each new session starts from; `null` is `Unlimited`.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<TokensPerRun>")]
    pub tokens_per_run: Option<TokensPerRun>,
    /// `Memory cap for tool processes`, in bytes; `null` is no cap.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<SafeInt<1>>")]
    pub tool_memory_cap_bytes: Option<SafeInt<1>>,
    /// `Cache limit`, in bytes, applied to each package cache on its own; `null` is `Unlimited`.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<SafeInt<1>>")]
    pub package_cache_limit_bytes: Option<SafeInt<1>>,
    /// `Record traces`.
    pub record_traces: bool,
    /// `Record raw provider messages`.
    pub record_provider_messages: bool,
    /// Whether this operating system lets the service enforce the memory cap.
    pub tool_memory_cap_enforceable: bool,
    /// The folder raw provider messages are written to.
    pub provider_messages_path: FilesystemPath,
}

/// `daemon.config.update`: exactly one setting, as `{"<setting>": value}`; a nullable setting's
/// `null` clears it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub enum DaemonConfigUpdateRequest {
    /// The port a workflow started by a web request listens on.
    WorkflowListenerPort(Port),
    /// `Stop a run after`; `null` is `No limit`.
    RunTimeLimitMinutes(Option<RunTimeLimitMinutes>),
    /// `Ask me after one start leads to`; `null` is `Never ask`.
    WorkflowChainAskAfterRuns(Option<WorkflowChainAskAfterRuns>),
    /// `Max steps per turn`; `null` is `Unlimited`.
    MaxStepsPerTurn(Option<SafeInt<1>>),
    /// `Spend limit`; `null` is `Unlimited`.
    SpendLimitUsdMicros(Option<UsdMicros>),
    /// `Tokens per run`; `null` is `Unlimited`.
    TokensPerRun(Option<TokensPerRun>),
    /// `Memory cap for tool processes`, in bytes; `null` is no cap.
    ToolMemoryCapBytes(Option<SafeInt<1>>),
    /// `Cache limit`, in bytes; `null` is `Unlimited`.
    PackageCacheLimitBytes(Option<SafeInt<1>>),
    /// `Record traces`.
    RecordTraces(bool),
    /// `Record raw provider messages`.
    RecordProviderMessages(bool),
}

/// One cache's size, read by walking its folder when asked.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PackageCacheReading {
    /// The cache's size in bytes.
    pub bytes: SafeInt<0>,
    /// When it was read.
    #[garde(dive)]
    pub read_at: WireInstant,
}

/// Each cache's size and when it was read; the page adds the total.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct DaemonPackageCacheReading {
    /// The bun cache.
    #[garde(dive)]
    pub bun: PackageCacheReading,
    /// The uv cache.
    #[garde(dive)]
    pub uv: PackageCacheReading,
}

/// Which cache a clear empties.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum PackageCacheClearTarget {
    /// The bun cache.
    Bun,
    /// The uv cache.
    Uv,
    /// Both caches.
    All,
}

/// `daemon.packageCache.clear`. A clear waits for the installs using that cache, never removes a
/// step already installed, and answers with the new reading.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct DaemonPackageCacheClearRequest {
    /// The cache to empty.
    pub cache: PackageCacheClearTarget,
}

methods! {
    /// The config and package-cache methods.
    pub const DAEMON_CONFIG_METHOD_DESCRIPTORS = [
        /// Reads the settings.
        DaemonConfigRead = query "daemon.config.read" {
            mutating: false,
            params: EmptyPayload,
            result: DaemonConfig,
            refusals: [],
        },
        /// Changes one setting.
        DaemonConfigUpdate = mutation "daemon.config.update" {
            mutating: true,
            params: DaemonConfigUpdateRequest,
            result: DaemonConfig,
            refusals: [],
        },
        /// Reads each package cache's size.
        DaemonPackageCacheList = query "daemon.packageCache.list" {
            mutating: false,
            params: EmptyPayload,
            result: DaemonPackageCacheReading,
            refusals: [],
        },
        /// Empties a package cache.
        DaemonPackageCacheClear = mutation "daemon.packageCache.clear" {
            mutating: true,
            params: DaemonPackageCacheClearRequest,
            result: DaemonPackageCacheReading,
            refusals: [],
        },
    ];
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "daemon/config",
    doc: "The machine-wide service settings on Settings › Runtime, and the two package caches \
          whose size limit is one of them.",
    definitions: &[
        Definition::read::<RunTimeLimitMinutes>(),
        Definition::read::<WorkflowChainAskAfterRuns>(),
        Definition::read::<DaemonConfig>().checked(),
        Definition::read::<DaemonConfigUpdateRequest>().checked(),
        Definition::read::<PackageCacheReading>(),
        Definition::read::<DaemonPackageCacheReading>().checked(),
        Definition::read::<PackageCacheClearTarget>(),
        Definition::read::<DaemonPackageCacheClearRequest>().checked(),
    ],
    constants: &[],
    method_tables: &[&DAEMON_CONFIG_METHOD_DESCRIPTORS],
};
