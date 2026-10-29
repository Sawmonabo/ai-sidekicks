//! The driver methods a client calls (`provider.model.list`, `provider.mode.list`,
//! `provider.command.list` and `agent.run.context.compact`), their requests and replies. Every
//! list answers for every provider as a list grouped by `providerName`, never a merged array:
//! model and mode ids collide across providers, so grouping keeps one provider's value from being
//! sent through an agent bound to another.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::agent::definition::AgentId;
use crate::jsonrpc::refusal::RefusalCode;
use crate::method::methods;
use crate::provider::driver::capabilities::{ProviderMode, ProviderModel};
use crate::provider::driver::commands::ProviderCommandListResponse;
use crate::provider::driver::compaction::AgentRunContextCompactResponse;
use crate::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use crate::provider::id::ProviderId;
use crate::run::id::RunId;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::Never;
use crate::wire::text::FreeFormText;

ts_constants! {
    /// The longest short identifier or label: a model's and a mode's id and name, and the words
    /// in its capabilities, effort levels and output-speed levels.
    pub const PROVIDER_WIRE_TOKEN_MAX_LEN: usize = 128;
    /// The longest opaque provider handle a client echoes back, roomier than a token, because
    /// refusing a real handle would make a valid request unsendable.
    pub const PROVIDER_WIRE_HANDLE_MAX_LEN: usize = 256;
    /// The longest reason the person gives on an interrupt or a cancel.
    pub const PROVIDER_WIRE_REASON_MAX_LEN: usize = 512;
    /// The longest contract version a driver reports, where the daemon reads and stores it.
    pub const PROVIDER_WIRE_CONTRACT_VERSION_MAX_LEN: usize = 64;
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

/// The request of `provider.mode.list`: the session whose level control reads the report.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderModeListRequest {
    /// The session.
    pub session_id: SessionId,
}

/// Why one provider's models or modes could not be read: the refusal its read answered with, and
/// the provider's own words where it gave any.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderReadFailure {
    /// The refusal's code, as a JSON-RPC error's `data.type` carries it.
    pub code: String,
    /// What the provider said, where it said anything.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>")]
    pub provider_failure_detail: Option<FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>>,
}

/// Declares one arm of a provider's outcome in the `provider.model.list` or `provider.mode.list`
/// reply, the provider it names written once.
macro_rules! provider_report_arm {
    ($(#[doc = $doc:literal])+ $name:ident { $($arm_member:tt)* }) => {
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[schemars(inline)]
        pub struct $name {
            /// The provider.
            pub provider_name: ProviderId,
            $($arm_member)*
        }
    };
}

provider_report_arm! {
    /// A provider whose catalog was read: its models.
    ProviderModelsListed {
        /// Its models.
        pub models: Vec<ProviderModel>,
        /// Only a failed read carries a failure.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub failure: Option<Never>,
    }
}

provider_report_arm! {
    /// A provider whose catalog could not be read: why, never an empty catalog.
    ProviderModelsFailed {
        /// Why the read failed.
        pub failure: ProviderReadFailure,
        /// Only a read catalog carries models.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub models: Option<Never>,
    }
}

/// One installed provider's outcome in the `provider.model.list` reply: its models, or the failure
/// its catalog's read answered, so one provider's outage never hides another's models.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum ProviderModelReport {
    /// The catalog was read.
    Listed(ProviderModelsListed),
    /// The catalog's read failed.
    Failed(ProviderModelsFailed),
}

/// The reply of `provider.model.list`: one outcome per installed provider, the session's own
/// provider first, then the provider table's order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderModelListResponse {
    /// The groups.
    pub providers: Vec<ProviderModelReport>,
}

provider_report_arm! {
    /// A provider whose modes were read: its modes.
    ProviderModesListed {
        /// Its modes.
        pub modes: Vec<ProviderMode>,
        /// Only a failed read carries a failure.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub failure: Option<Never>,
    }
}

provider_report_arm! {
    /// A provider whose modes could not be read: why, never an empty list.
    ProviderModesFailed {
        /// Why the read failed.
        pub failure: ProviderReadFailure,
        /// Only a read list carries modes.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub modes: Option<Never>,
    }
}

/// One installed provider's outcome in the `provider.mode.list` reply: its modes, or the failure
/// their read answered, so one provider's outage never hides another's modes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum ProviderModeReport {
    /// The modes were read.
    Listed(ProviderModesListed),
    /// The modes' read failed.
    Failed(ProviderModesFailed),
}

/// The reply of `provider.mode.list`: one outcome per installed provider, in the provider table's
/// order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderModeListResponse {
    /// The groups.
    pub providers: Vec<ProviderModeReport>,
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
        /// Lists each provider's models for a session's model control.
        ProviderModelList = query "provider.model.list" {
            mutating: false,
            params: ProviderModelListRequest,
            result: ProviderModelListResponse,
            refusals: [SessionNotFound, ProviderUnavailable, ProviderTimeout],
        },
        /// Lists each provider's modes for a session's level control.
        ProviderModeList = query "provider.mode.list" {
            mutating: false,
            params: ProviderModeListRequest,
            result: ProviderModeListResponse,
            refusals: [SessionNotFound, ProviderUnavailable, ProviderTimeout],
        },
        /// Compacts one run's provider-side context.
        AgentRunContextCompact = mutation "agent.run.context.compact" {
            mutating: true,
            params: AgentRunContextCompactRequest,
            result: AgentRunContextCompactResponse,
            refusals: [
                SessionNotFound,
                AgentRunNotFound,
                ProviderNotFound,
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
                ProviderNotFound,
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
          grouped by provider.",
    definitions: &[
        Definition::read::<ProviderModelListRequest>(),
        Definition::read::<ProviderModeListRequest>(),
        Definition::read::<ProviderReadFailure>(),
        Definition::read::<ProviderModelsListed>(),
        Definition::read::<ProviderModelsFailed>(),
        Definition::read::<ProviderModelReport>(),
        Definition::read::<ProviderModelListResponse>(),
        Definition::read::<ProviderModesListed>(),
        Definition::read::<ProviderModesFailed>(),
        Definition::read::<ProviderModeReport>(),
        Definition::read::<ProviderModeListResponse>(),
        Definition::read::<AgentRunContextCompactRequest>(),
        Definition::read::<ProviderCommandListRequest>(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[&PROVIDER_DRIVER_METHOD_DESCRIPTORS],
};
