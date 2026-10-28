//! The `mcp.*` method table, the status notice and the sign-in event payload. A notice or a payload
//! names a binding by its provider, scope and server name, never its folder, which is a path on
//! this machine.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::jsonrpc::refusal::RefusalCode;
use crate::mcp::server::requests::{
    McpRegistrySearchRequest, McpRegistrySearchResponse, McpServerDeleteRequest,
    McpServerDeleteResponse, McpServerEnabledUpdateRequest, McpServerListRequest,
    McpServerListResponse, McpServerMutationResponse, McpServerReadResponse,
    McpServerReconnectRequest, McpServerReconnectResponse, McpServerSignInRequest,
    McpServerSignInResponse, McpServerSignOutRequest, McpServerUpsertRequest,
    McpToolOverrideClearRequest, McpToolOverrideMutationResponse, McpToolOverrideUpdateRequest,
};
use crate::mcp::server::{McpBindingScope, McpServerBindingRef, McpServerName, McpServerStatus};
use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::provider::driver::runtime_binding::RuntimeBindingId;
use crate::provider::id::ProviderId;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::{Never, literal};

literal! {
    /// The `type` of a status notice.
    pub enum McpServerStatusChangedType = "mcp.server.status.changed";
}

/// Declares the status notice: each origin's arm repeats the notice's members, then adds its own.
macro_rules! status_notice {
    (
        $(#[doc = $doc:literal])+
        pub enum $name:ident {
            $($(#[doc = $arm_doc:literal])+ $arm:ident { $($extra:tt)* },)+
        }
    ) => {
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
        #[serde(
            tag = "origin",
            rename_all = "camelCase",
            rename_all_fields = "camelCase",
            deny_unknown_fields
        )]
        pub enum $name {$(
            $(#[doc = $arm_doc])+
            $arm {
                /// Always `mcp.server.status.changed`.
                #[serde(rename = "type")]
                notice_type: McpServerStatusChangedType,
                /// The provider.
                provider: ProviderId,
                /// The binding's scope.
                scope: McpBindingScope,
                /// The server's name.
                server_name: McpServerName,
                /// The status before.
                previous_status: McpServerStatus,
                /// The status now.
                status: McpServerStatus,
                /// Why it failed, where the provider said.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "String")]
                failure_reason: Option<String>,
                $($extra)*
            },
        )+}
    };
}

status_notice! {
    /// `mcp.server.status.changed`, the live notice of a status change on `mcp.subscribe`,
    /// written to no log, tagged on `origin`: a `sessionFeed` observation names the session and
    /// the live leg it came from; a `sessionEnded` notice names the session whose leg left, its
    /// `status` the aggregate over the legs that remain; a `machineProbe` observation has neither.
    pub enum McpServerStatusChangedNotice {
        /// A session's live leg saw the change.
        SessionFeed {
            /// The session.
            session_id: SessionId,
            /// The live leg.
            binding_id: RuntimeBindingId,
        },
        /// A session ended and its live leg left the aggregate; a page drops that leg and reads
        /// nothing again.
        SessionEnded {
            /// The session that ended.
            session_id: SessionId,
            /// The leg that left.
            binding_id: RuntimeBindingId,
        },
        /// The daemon's own probe saw the change.
        MachineProbe {
            /// Never present: no session saw it.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Never")]
            session_id: Option<Never>,
            /// Never present: no live leg saw it.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Never")]
            binding_id: Option<Never>,
        },
    }
}

/// How a sign-in ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum McpServerSignInOutcome {
    /// Signed in.
    Success,
    /// Not signed in.
    Failure,
}

/// The payload of `mcp.server.signIn.completed`: how a sign-in ended. A sign-in that fails after
/// `mcp.server.signIn` has answered arrives here as `failure`, never as a late error.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpServerSignInCompletedPayload {
    /// The provider.
    pub provider: ProviderId,
    /// The binding's scope.
    pub scope: McpBindingScope,
    /// The server's name.
    pub server_name: McpServerName,
    /// How it ended.
    pub outcome: McpServerSignInOutcome,
    /// Why it failed.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "String")]
    pub failure_reason: Option<String>,
    /// The session the sign-in was started from.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SessionId")]
    pub initiating_session_id: Option<SessionId>,
}

methods! {
    /// Every `mcp.*` method but `mcp.subscribe`, whose emissions are session events and live
    /// notices.
    pub const MCP_METHOD_DESCRIPTORS = [
        /// Reads the whole inventory.
        McpServerList = query "mcp.server.list" {
            mutating: false,
            params: McpServerListRequest,
            result: McpServerListResponse,
            refusals: [],
        },
        /// Reads one binding.
        McpServerRead = query "mcp.server.read" {
            mutating: false,
            params: McpServerBindingRef,
            result: McpServerReadResponse,
            refusals: [McpServerNotFound],
        },
        /// Searches the public MCP Registry.
        McpRegistrySearch = query "mcp.registry.search" {
            mutating: false,
            params: McpRegistrySearchRequest,
            result: McpRegistrySearchResponse,
            refusals: [],
        },
        /// Adds a binding or changes its declaration.
        McpServerUpsert = mutation "mcp.server.upsert" {
            mutating: true,
            params: McpServerUpsertRequest,
            result: McpServerMutationResponse,
            refusals: [
                McpBindingStoreUnavailable,
                McpServerConfigInvalid,
                McpServerConfigWriteConflict,
            ],
        },
        /// Removes a binding.
        McpServerDelete = mutation "mcp.server.delete" {
            mutating: true,
            params: McpServerDeleteRequest,
            result: McpServerDeleteResponse,
            refusals: [
                McpBindingStoreUnavailable,
                McpServerNotFound,
                McpServerConfigWriteConflict,
                ApprovalRuleNotKept,
            ],
        },
        /// Turns a binding on or off.
        McpServerEnabledUpdate = mutation "mcp.server.enabled.update" {
            mutating: true,
            params: McpServerEnabledUpdateRequest,
            result: McpServerMutationResponse,
            refusals: [McpBindingStoreUnavailable, McpServerNotFound, McpServerConfigWriteConflict],
        },
        /// Sets one tool's override.
        McpToolOverrideUpdate = mutation "mcp.toolOverride.update" {
            mutating: true,
            params: McpToolOverrideUpdateRequest,
            result: McpToolOverrideMutationResponse,
            refusals: [McpBindingStoreUnavailable, McpServerNotFound, McpServerConfigWriteConflict],
        },
        /// Clears one facet of one tool's override.
        McpToolOverrideClear = mutation "mcp.toolOverride.clear" {
            mutating: true,
            params: McpToolOverrideClearRequest,
            result: McpToolOverrideMutationResponse,
            refusals: [McpBindingStoreUnavailable, McpServerNotFound, McpServerConfigWriteConflict],
        },
        /// Starts the daemon's sign-in to a server.
        McpServerSignIn = mutation "mcp.server.signIn" {
            mutating: true,
            params: McpServerSignInRequest,
            result: McpServerSignInResponse,
            refusals: [
                McpBindingStoreUnavailable,
                McpServerNotFound,
                McpServerSignInFailed,
                McpServerSignInUnsupported,
                ProviderNotInstalled,
                ProviderUnavailable,
                ProviderTimeout,
                SystemInternalError,
            ],
        },
        /// Signs out of a server.
        McpServerSignOut = mutation "mcp.server.signOut" {
            mutating: true,
            params: McpServerSignOutRequest,
            result: EmptyPayload,
            refusals: [McpBindingStoreUnavailable],
        },
        /// Opens a binding's connection again.
        McpServerReconnect = mutation "mcp.server.reconnect" {
            mutating: true,
            params: McpServerReconnectRequest,
            result: McpServerReconnectResponse,
            refusals: [SessionNotFound, McpBindingStoreUnavailable, McpServerNotFound],
        },
    ];
}

ts_constants! {
    /// No binding with the requested provider, scope, folder and name exists.
    MCP_SERVER_NOT_FOUND_CODE = RefusalCode::McpServerNotFound;
    /// The submitted configuration failed validation before anything was written.
    MCP_SERVER_CONFIG_INVALID_CODE = RefusalCode::McpServerConfigInvalid;
    /// The provider's config file changed under the write: the provider's own version check
    /// failed, or a project file no longer hashes to what the daemon last read.
    MCP_SERVER_CONFIG_WRITE_CONFLICT_CODE = RefusalCode::McpServerConfigWriteConflict;
    /// The sign-in could not be started for a passing reason; retry under a new key. A failure
    /// after it started arrives as an event.
    MCP_SERVER_SIGN_IN_FAILED_CODE = RefusalCode::McpServerSignInFailed;
}

/// The TypeScript module of the `mcp.*` method table, the status notice and the sign-in payload.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "mcp/governance",
    doc: "The `mcp.*` method table, the sign-in event payload, the status notice and the refusal \
          codes.",
    definitions: &[
        Definition::read::<McpServerStatusChangedNotice>().checked(),
        Definition::read::<McpServerSignInOutcome>(),
        Definition::read::<McpServerSignInCompletedPayload>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[&MCP_METHOD_DESCRIPTORS],
};
