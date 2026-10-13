//! MCP server bindings: what a binding is, the words its status and its changes are told in, and
//! the binding union every request addressed to a binding is built on.
//!
//! No read-back shape carries a configuration value. Credential-bearing input values are
//! write-only, and the redacted view carries names (`envVarNames`, `headerNames`,
//! `urlQueryParamNames`) where the wire carries values, so a client rendering every read-back
//! still cannot render an environment-variable value, a header value or a token.
//!
//! Every governance mutation, and the sign-in and sign-out commands, carries a
//! `clientIdempotencyKey` the caller mints: a retry of one press reuses it, since a key minted per
//! call would make every retry a new operation. `mcp.reconnect` alone carries none, because it
//! writes nothing and has no saved result for a key to return.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::VariantArray;

use crate::provider::driver::length_limits::{
    DRIVER_MCP_SERVER_NAME_MAX_LEN, DRIVER_TOOL_NAME_MAX_LEN,
};
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::literal;
use crate::wire::text::FreeFormText;

pub mod config;
pub mod inventory;
pub mod requests;

/// A server's connection state; it says nothing about which of its tools a session can see.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum McpServerStatus {
    /// It could not start or broke.
    Failed,
    /// It waits for a sign-in.
    NeedsAuth,
    /// The daemon cannot observe it.
    Unknown,
    /// It is starting.
    Starting,
    /// It is connected.
    Connected,
}

ts_constants! {
    /// The five statuses, most severe first: the daemon's order for folding a server's sessions
    /// into one status, so lost observability (`unknown`) outranks a known-healthy state. A client
    /// draws the folded status and never applies the order itself.
    pub const MCP_SERVER_STATUS_SEVERITY_ORDER: [McpServerStatus; 5] = [
        McpServerStatus::Failed,
        McpServerStatus::NeedsAuth,
        McpServerStatus::Unknown,
        McpServerStatus::Starting,
        McpServerStatus::Connected,
    ];
    /// Every application grade, in declaration order.
    MCP_APPLICATION_GRADES = McpApplicationGrade::VARIANTS;
    /// Every approval mode, in the order the per-tool control offers them.
    MCP_APPROVAL_MODES = McpApprovalMode::VARIANTS;
    /// The longest command, argument, name, value, address or search text an `mcp.*` request
    /// carries.
    MCP_REQUEST_TEXT_MAX_LEN = config::MCP_REQUEST_TEXT_MAX_LEN;
    /// Every tool override facet, in declaration order.
    MCP_TOOL_OVERRIDE_FACETS = inventory::MCP_TOOL_OVERRIDE_FACETS;
}

/// A server's name as a binding and an event carry it.
pub type McpServerName = FreeFormText<DRIVER_MCP_SERVER_NAME_MAX_LEN>;

/// A tool's name as an override and a reading carry it.
pub type McpToolName = FreeFormText<DRIVER_TOOL_NAME_MAX_LEN>;

/// When and where a mutation took effect: in the live sessions now, in the provider's config store
/// for later runs, in the next run's composed config, or at the daemon's decision layer at once.
/// Always stated, never silent.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, VariantArray,
)]
#[serde(rename_all = "snake_case")]
pub enum McpApplicationGrade {
    /// Applied to the live sessions now.
    LiveReconcile,
    /// Written to the provider's config store for later runs.
    UserConfigWrite,
    /// Applied in the next run's composed config.
    NextRun,
    /// Enforced at the daemon's decision layer at once.
    DaemonEnforced,
}

impl McpApplicationGrade {
    /// The grade's wire name.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::LiveReconcile => "live_reconcile",
            Self::UserConfigWrite => "user_config_write",
            Self::NextRun => "next_run",
            Self::DaemonEnforced => "daemon_enforced",
        }
    }
}

/// The normalized approval vocabulary a tool override may pin.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, VariantArray,
)]
#[serde(rename_all = "snake_case")]
pub enum McpApprovalMode {
    /// Every call runs without asking.
    Auto,
    /// Every call asks.
    Prompt,
    /// Calls that write ask.
    Writes,
    /// Every call needs an approval.
    Approve,
}

/// Where a server binding applies: `user` in all projects, `project` in one project with its
/// declaration in the repository, `local` in one project with its declaration outside the
/// repository, `plugin` for a server an installed plugin carries, and, on Claude Code only,
/// `connector` for a claude.ai connector and `managed` for an organization's server. The first
/// three are writable on both providers; Codex has no per-project layer outside the repository, so
/// the daemon emulates `local` there with a user entry that is off by default and switched on in
/// that project's sessions. The last two are read-only.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum McpBindingScope {
    /// In all projects.
    User,
    /// In one project, declared in the repository.
    Project,
    /// In one project, declared outside the repository.
    Local,
    /// Carried by an installed plugin.
    Plugin,
    /// A claude.ai connector of one provider account.
    Connector,
    /// An organization's server.
    Managed,
}

/// Declares a union tagged on `scope` whose arms are the binding scopes, each arm holding the
/// binding's identity and the members the caller adds. `in writable scopes` keeps the three scopes
/// a person writes; `in every scope` adds `plugin`, `connector` and `managed`, whose declarations
/// the daemon never writes. An `in every scope` union may end with `on connector and managed { … }
/// elsewhere { … }`: members only the two read-only Claude Code arms take, and their form on the
/// other four arms.
macro_rules! binding_addressed {
    (
        $(#[$meta:meta])+
        pub enum $name:ident in writable scopes { $($extra:tt)* }
    ) => {
        $crate::mcp::server::binding_addressed! {
            @union [$(#[$meta])+] $name [$($extra)*] {}
        }
    };
    (
        $(#[$meta:meta])+
        pub enum $name:ident in every scope { $($extra:tt)* }
        $(on connector and managed { $($read_only:tt)* } elsewhere { $($elsewhere:tt)* })?
    ) => {
        $crate::mcp::server::binding_addressed! {
            @union [$(#[$meta])+] $name [$($extra)* $($($elsewhere)*)?] {
                /// A server an installed plugin carries: switched on and off and given tool
                /// overrides, its declaration changing only with the plugin.
                Plugin {
                    /// The provider.
                    provider: $crate::provider::name::ProviderName,
                    /// The plugin's name.
                    scope_ref: $crate::plugin::PluginToken,
                    /// The server's name.
                    server_name: $crate::mcp::server::McpServerName,
                    $($extra)*
                    $($($elsewhere)*)?
                },
                /// A claude.ai connector, the provider account's own: read-only, switched off per
                /// project only by the daemon's own switch, and given tool overrides.
                Connector {
                    /// Always `claude`.
                    provider: $crate::provider::name::ClaudeProviderWord,
                    /// The provider account the connector belongs to.
                    scope_ref: $crate::provider::account::record::ProviderAccountId,
                    /// The name Claude Code reports for it, such as `claude.ai Slack`.
                    server_name: $crate::mcp::server::McpServerName,
                    $($extra)*
                    $($($read_only)*)?
                },
                /// An organization's server, from its managed settings: read-only, served with its
                /// address's host only, switched off per project only by the daemon's own switch,
                /// and given tool overrides.
                Managed {
                    /// Always `claude`.
                    provider: $crate::provider::name::ClaudeProviderWord,
                    /// The server's name.
                    server_name: $crate::mcp::server::McpServerName,
                    $($extra)*
                    $($($read_only)*)?
                },
            }
        }
    };
    (@union [$(#[$meta:meta])+] $name:ident [$($writable_extra:tt)*] { $($other_arms:tt)* }) => {
        #[derive(
            Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize, schemars::JsonSchema,
            garde::Validate,
        )]
        #[serde(
            tag = "scope",
            rename_all = "snake_case",
            rename_all_fields = "camelCase",
            deny_unknown_fields
        )]
        #[garde(allow_unvalidated)]
        $(#[$meta])+
        pub enum $name {
            /// A binding in all projects.
            User {
                /// The provider.
                provider: $crate::provider::name::ProviderName,
                /// The server's name.
                server_name: $crate::mcp::server::McpServerName,
                $($writable_extra)*
            },
            /// A binding in one project, declared in the repository.
            Project {
                /// The provider.
                provider: $crate::provider::name::ProviderName,
                /// The project's root folder.
                scope_ref: $crate::free_form_string::FilesystemPath,
                /// The server's name.
                server_name: $crate::mcp::server::McpServerName,
                $($writable_extra)*
            },
            /// A binding in one project, declared outside the repository.
            Local {
                /// The provider.
                provider: $crate::provider::name::ProviderName,
                /// The project's root folder.
                scope_ref: $crate::free_form_string::FilesystemPath,
                /// The server's name.
                server_name: $crate::mcp::server::McpServerName,
                $($writable_extra)*
            },
            $($other_arms)*
        }
    };
}

pub(crate) use binding_addressed;

binding_addressed! {
    /// A binding in a scope the person writes: its declaration lives in a provider's own config,
    /// so it can be added, changed and removed. `user` carries no `scopeRef`; `project` and `local`
    /// name the project's root folder.
    pub enum McpWritableBindingRef in writable scopes {}
}

binding_addressed! {
    /// The scope-qualified identity of one server binding: a writable binding, a server an
    /// installed plugin carries, or one Claude Code brings itself (a claude.ai connector or an
    /// organization's server). Same-named servers in two scopes stay two rows.
    pub enum McpServerBindingRef in every scope {}
}

literal! {
    /// The `type` of a config-changed notice.
    pub enum McpServerConfigChangedType = "mcp.server_config_changed";
}

binding_addressed! {
    /// The live notice `mcp.subscribe` sends after each edit to a binding, from this machine or a
    /// linked device: an add, a change, a switch on or off, a tool override or a removal. A page
    /// showing the binding reads it again with `mcp.get`; a removed one answers
    /// `mcp.server_not_found`. Sent live only, written to no session's log.
    pub enum McpServerConfigChangedNotice in every scope {
        /// Always `mcp.server_config_changed`.
        #[serde(rename = "type")]
        notice_type: McpServerConfigChangedType,
    }
}

/// The TypeScript module of the bindings, their inventory, and the `mcp.*` requests and replies.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "mcp/server",
    doc: "MCP server bindings: what a binding is, what the daemon reports about it, what a \
          mutation did to the live sessions behind it, and each `mcp.*` method's request and \
          reply.",
    definitions: &[
        Definition::read::<McpServerStatus>(),
        Definition::read::<McpApplicationGrade>(),
        Definition::read::<McpApprovalMode>(),
        Definition::read::<McpBindingScope>(),
        Definition::read::<McpWritableBindingRef>(),
        Definition::read::<McpServerBindingRef>().checked(),
        Definition::read::<McpServerConfigChangedNotice>().checked(),
        Definition::read::<config::McpServerConfigInput>(),
        Definition::read::<config::McpServerConfigView>(),
        Definition::read::<inventory::McpRuntimeBindingId>().checked(),
        Definition::read::<inventory::McpServerLegStatus>(),
        Definition::read::<inventory::McpServerFailedReason>(),
        Definition::read::<inventory::McpAssignableIdempotencyClass>(),
        Definition::read::<inventory::McpToolOverride>(),
        Definition::read::<inventory::McpToolOverrideFacet>(),
        Definition::read::<inventory::McpToolReading>(),
        Definition::read::<inventory::McpServerInventoryEntry>(),
        Definition::read::<requests::McpListRequest>().checked(),
        Definition::read::<requests::McpListResponse>().checked(),
        Definition::read::<requests::McpGetResponse>().checked(),
        Definition::read::<requests::McpRegistrySearchRequest>().checked(),
        Definition::read::<requests::McpRegistryEnvironmentVariable>(),
        Definition::read::<requests::McpRegistryPackage>(),
        Definition::read::<requests::McpRegistryRemote>(),
        Definition::read::<requests::McpRegistryServer>(),
        Definition::read::<requests::McpRegistrySearchResponse>().checked(),
        Definition::read::<requests::McpUpsertServerRequest>().checked(),
        Definition::read::<requests::McpLiveApplicationOutcome>(),
        Definition::read::<requests::McpLiveApplicationResult>(),
        Definition::read::<requests::McpToolOverrideApplication>(),
        Definition::read::<requests::McpMutationResult>().checked(),
        Definition::read::<requests::McpRemoveServerRequest>().checked(),
        Definition::read::<requests::McpRemoveServerResult>().checked(),
        Definition::read::<requests::McpSetEnabledRequest>().checked(),
        Definition::read::<requests::McpSetToolOverrideRequest>().checked(),
        Definition::read::<requests::McpClearToolOverrideRequest>().checked(),
        Definition::read::<requests::McpToolOverrideMutationResult>().checked(),
        Definition::read::<requests::McpKeyedBindingRequest>().checked(),
        Definition::read::<requests::McpOauthLoginResponse>().checked(),
        Definition::read::<requests::McpOauthLogoutRequest>().checked(),
        Definition::read::<requests::McpReconnectRequest>().checked(),
        Definition::read::<requests::McpReconnectResponse>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
