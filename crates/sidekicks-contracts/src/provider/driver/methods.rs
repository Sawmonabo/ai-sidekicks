//! The `driver.*` methods a client calls, their requests and replies. Every reply answers for every
//! driver as a list grouped by `driverName`, never a merged array: model and mode ids collide
//! across providers, so grouping keeps one provider's value from being sent through an agent bound
//! to the other.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::agent::definition::AgentId;
use crate::jsonrpc::refusal::RefusalCode;
use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::provider::driver::capabilities::{DriverCapabilities, ProviderMode, ProviderModel};
use crate::provider::driver::commands::ProviderCommandListResult;
use crate::provider::driver::compaction::DriverCompactionResult;
use crate::provider::driver::intervention::{
    ApplyInterventionRequest, DriverInterventionResult, InterruptRunParams,
};
use crate::provider::name::ProviderName;
use crate::run::id::RunId;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::text::FreeFormText;

ts_constants! {
    /// The longest short identifier or label: a model's and a mode's id and name, and the words
    /// in its capabilities, effort levels and output-speed levels.
    pub const DRIVER_WIRE_TOKEN_MAX_LEN: usize = 128;
    /// The longest opaque provider handle a client echoes back, roomier than a token, because
    /// refusing a real handle would make a valid request unsendable.
    pub const DRIVER_WIRE_HANDLE_MAX_LEN: usize = 256;
    /// The longest reason the person gives on an interrupt or a cancel.
    pub const DRIVER_WIRE_REASON_MAX_LEN: usize = 512;
    /// The longest contract version a driver reports, on the capability reply and where the
    /// daemon stores it.
    pub const DRIVER_WIRE_CONTRACT_VERSION_MAX_LEN: usize = 64;
    /// The refusal of a provider operation that outlived its deadline.
    DRIVER_TIMEOUT_CODE = RefusalCode::DriverTimeout;
}

/// The request of `driver.listModels`: the session whose model control reads the catalog.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ListModelsRequest {
    /// The session.
    pub session_id: SessionId,
}

/// One driver's entry in the `driver.listCapabilities` reply: its flags, the output-speed levels
/// it declares for every model, and the provider's own tool names, which the tool picker offers. A
/// provider that publishes its speed levels per model carries them on each model instead.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DriverCapabilityReport {
    /// The provider.
    pub driver_name: ProviderName,
    /// Its flags and contract version.
    pub capabilities: DriverCapabilities,
    /// The output-speed levels it declares for every model, sent exactly when `output_speed` is on
    /// and the driver declares them statically.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Vec<FreeFormText<DRIVER_WIRE_TOKEN_MAX_LEN>>")]
    pub output_speed_levels: Option<Vec<FreeFormText<DRIVER_WIRE_TOKEN_MAX_LEN>>>,
    /// The provider's own tool names, in its own words.
    pub built_in_tools: Vec<FreeFormText<DRIVER_WIRE_TOKEN_MAX_LEN>>,
}

/// The reply of `driver.listCapabilities`: one report per driver.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListCapabilitiesResult {
    /// The reports.
    pub drivers: Vec<DriverCapabilityReport>,
}

/// One driver's models in the `driver.listModels` reply.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DriverModelReport {
    /// The provider.
    pub driver_name: ProviderName,
    /// Its models.
    pub models: Vec<ProviderModel>,
}

/// The reply of `driver.listModels`: one group per driver.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListModelsResult {
    /// The groups.
    pub drivers: Vec<DriverModelReport>,
}

/// One driver's modes in the `driver.listModes` reply.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DriverModeReport {
    /// The provider.
    pub driver_name: ProviderName,
    /// Its modes.
    pub modes: Vec<ProviderMode>,
}

/// The reply of `driver.listModes`: one group per driver.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListModesResult {
    /// The groups.
    pub drivers: Vec<DriverModeReport>,
}

/// The request of `driver.compactContext`, the person's compaction of one run's context. The
/// reply's `refused` and `failed` arms are data a caller branches on, never a refusal.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct CompactContextRequest {
    /// The session, the scope checked first.
    pub session_id: SessionId,
    /// The run within it.
    pub run_id: RunId,
}

/// The request of `driver.listProviderCommands`: the commands and skills one agent's providers
/// publish, one group per live binding the agent holds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ListProviderCommandsRequest {
    /// The session, the scope checked first.
    pub session_id: SessionId,
    /// The agent within it.
    pub agent_id: AgentId,
}

methods! {
    /// The driver methods a client calls: their names, how each answers, and their shapes.
    pub const DRIVER_METHOD_DESCRIPTORS = [
        /// Lists each driver's capability flags, speed levels and built-in tools.
        DriverListCapabilities = query "driver.listCapabilities" {
            mutating: false,
            params: EmptyPayload,
            result: ListCapabilitiesResult,
            refusals: [],
        },
        /// Lists each driver's models for a session's model control.
        DriverListModels = query "driver.listModels" {
            mutating: false,
            params: ListModelsRequest,
            result: ListModelsResult,
            refusals: [SessionNotFound, DriverUnavailable, DriverTimeout],
        },
        /// Lists each driver's modes.
        DriverListModes = query "driver.listModes" {
            mutating: false,
            params: EmptyPayload,
            result: ListModesResult,
            refusals: [],
        },
        /// Interrupts one run.
        DriverInterruptRun = mutation "driver.interruptRun" {
            mutating: true,
            params: InterruptRunParams,
            result: EmptyPayload,
            refusals: [RunNotFound, DriverUnavailable, DriverTimeout],
        },
        /// Applies an interrupt to a live run.
        DriverApplyIntervention = mutation "driver.applyIntervention" {
            mutating: true,
            params: ApplyInterventionRequest,
            result: DriverInterventionResult,
            refusals: [
                RunNotFound,
                InterventionIdempotencyConflict,
                DriverUnavailable,
                DriverCapabilityUnsupported,
                DriverTimeout,
            ],
        },
        /// Compacts one run's provider-side context.
        DriverCompactContext = mutation "driver.compactContext" {
            mutating: true,
            params: CompactContextRequest,
            result: DriverCompactionResult,
            refusals: [
                SessionNotFound,
                RunNotFound,
                DriverUnavailable,
                DriverCapabilityUnsupported,
                DriverTimeout,
            ],
        },
        /// Lists the commands and skills an agent's providers publish.
        DriverListProviderCommands = query "driver.listProviderCommands" {
            mutating: false,
            params: ListProviderCommandsRequest,
            result: ProviderCommandListResult,
            refusals: [
                SessionNotFound,
                AgentNotFound,
                DriverUnavailable,
                DriverCapabilityUnsupported,
                DriverTimeout,
            ],
        },
    ];
}

/// The TypeScript module of the driver methods.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "provider/driver/methods",
    doc: "The `driver.*` methods a client calls, their requests and replies, grouped by driver.",
    definitions: &[
        Definition::read::<ListModelsRequest>(),
        Definition::read::<DriverCapabilityReport>().checked(),
        Definition::read::<ListCapabilitiesResult>(),
        Definition::read::<DriverModelReport>(),
        Definition::read::<ListModelsResult>(),
        Definition::read::<DriverModeReport>(),
        Definition::read::<ListModesResult>(),
        Definition::read::<CompactContextRequest>(),
        Definition::read::<ListProviderCommandsRequest>(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[&DRIVER_METHOD_DESCRIPTORS],
};
