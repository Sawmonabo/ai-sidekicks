//! The driver methods a client calls (`provider.model.list`, `provider.mode.list`,
//! `provider.command.list` and `agent.run.context.compact`), their requests and replies. Every
//! list answers for every driver as a list grouped by `driverName`, never a merged array: model and
//! mode ids collide across providers, so grouping keeps one provider's value from being sent
//! through an agent bound to another.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::agent::definition::AgentId;
use crate::jsonrpc::refusal::RefusalCode;
use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::provider::driver::capabilities::{ProviderMode, ProviderModel};
use crate::provider::driver::commands::ProviderCommandListResponse;
use crate::provider::driver::compaction::AgentRunContextCompactResponse;
use crate::provider::id::ProviderId;
use crate::run::id::RunId;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};

ts_constants! {
    /// The longest short identifier or label: a model's and a mode's id and name, and the words
    /// in its capabilities, effort levels and output-speed levels.
    pub const DRIVER_WIRE_TOKEN_MAX_LEN: usize = 128;
    /// The longest opaque provider handle a client echoes back, roomier than a token, because
    /// refusing a real handle would make a valid request unsendable.
    pub const DRIVER_WIRE_HANDLE_MAX_LEN: usize = 256;
    /// The longest reason the person gives on an interrupt or a cancel.
    pub const DRIVER_WIRE_REASON_MAX_LEN: usize = 512;
    /// The longest contract version a driver reports, where the daemon reads and stores it.
    pub const DRIVER_WIRE_CONTRACT_VERSION_MAX_LEN: usize = 64;
    /// The refusal of a provider operation that outlived its deadline.
    PROVIDER_TIMEOUT_CODE = RefusalCode::ProviderTimeout;
}

/// The request of `provider.model.list`: the session whose model control reads the catalog.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderModelListRequest {
    /// The session.
    pub session_id: SessionId,
}

/// One driver's models in the `provider.model.list` reply.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DriverModelReport {
    /// The provider.
    pub driver_name: ProviderId,
    /// Its models.
    pub models: Vec<ProviderModel>,
}

/// The reply of `provider.model.list`: one group per driver.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderModelListResponse {
    /// The groups.
    pub drivers: Vec<DriverModelReport>,
}

/// One driver's modes in the `provider.mode.list` reply.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DriverModeReport {
    /// The provider.
    pub driver_name: ProviderId,
    /// Its modes.
    pub modes: Vec<ProviderMode>,
}

/// The reply of `provider.mode.list`: one group per driver.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderModeListResponse {
    /// The groups.
    pub drivers: Vec<DriverModeReport>,
}

/// The request of `agent.run.context.compact`, the person's compaction of one run's context. The
/// reply's `refused` and `failed` arms are data a caller branches on, never a refusal.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AgentRunContextCompactRequest {
    /// The session, the scope checked first.
    pub session_id: SessionId,
    /// The run within it.
    pub run_id: RunId,
}

/// The request of `provider.command.list`: the commands and skills one agent's providers
/// publish, one group per live binding the agent holds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderCommandListRequest {
    /// The session, the scope checked first.
    pub session_id: SessionId,
    /// The agent within it.
    pub agent_id: AgentId,
}

methods! {
    /// The driver methods a client calls: their names, how each answers, and their shapes.
    pub const PROVIDER_DRIVER_METHOD_DESCRIPTORS = [
        /// Lists each driver's models for a session's model control.
        ProviderModelList = query "provider.model.list" {
            mutating: false,
            params: ProviderModelListRequest,
            result: ProviderModelListResponse,
            refusals: [SessionNotFound, ProviderUnavailable, ProviderTimeout],
        },
        /// Lists each driver's modes.
        ProviderModeList = query "provider.mode.list" {
            mutating: false,
            params: EmptyPayload,
            result: ProviderModeListResponse,
            refusals: [],
        },
        /// Compacts one run's provider-side context.
        AgentRunContextCompact = mutation "agent.run.context.compact" {
            mutating: true,
            params: AgentRunContextCompactRequest,
            result: AgentRunContextCompactResponse,
            refusals: [
                SessionNotFound,
                AgentRunNotFound,
                ProviderUnavailable,
                ProviderCapabilityUnsupported,
                ProviderTimeout,
            ],
        },
        /// Lists the commands and skills an agent's providers publish.
        ProviderCommandList = query "provider.command.list" {
            mutating: false,
            params: ProviderCommandListRequest,
            result: ProviderCommandListResponse,
            refusals: [
                SessionNotFound,
                AgentNotFound,
                ProviderUnavailable,
                ProviderCapabilityUnsupported,
                ProviderTimeout,
            ],
        },
    ];
}

/// The TypeScript module of the driver methods.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "provider/driver/methods",
    doc: "The driver methods a client calls (`provider.model.list`, `provider.mode.list`, \
          `provider.command.list`, `agent.run.context.compact`), their requests and replies, \
          grouped by driver.",
    definitions: &[
        Definition::read::<ProviderModelListRequest>(),
        Definition::read::<DriverModelReport>(),
        Definition::read::<ProviderModelListResponse>(),
        Definition::read::<DriverModeReport>(),
        Definition::read::<ProviderModeListResponse>(),
        Definition::read::<AgentRunContextCompactRequest>(),
        Definition::read::<ProviderCommandListRequest>(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[&PROVIDER_DRIVER_METHOD_DESCRIPTORS],
};
