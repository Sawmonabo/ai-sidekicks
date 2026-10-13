//! What the daemon reports about a binding: one inventory row, each live session's observation of
//! it, and each of its tools' settings in force with where they came from.

use schemars::{JsonSchema, Schema};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::mcp::server::config::McpServerConfigView;
use crate::mcp::server::{
    McpApprovalMode, McpProjectRoot, McpServerStatus, McpToolName, binding_addressed,
};
use crate::schema::{push_all_of, required_member};
use crate::session::id::SessionId;
use crate::wire::True;
use crate::wire::instant::WireInstant;
use crate::wire::list::BoundedVec;
use crate::wire::literal;
use crate::wire::text::BoundedText;

/// The runtime binding one live session's observation came from, not the config binding.
pub type McpRuntimeBindingId = BoundedText<1, { usize::MAX }>;

/// One live session's observation of one binding, kept per session because two sessions'
/// connections to one binding can disagree, and one verdict would hide a partial outage.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct McpServerLegStatus {
    /// The session.
    pub session_id: SessionId,
    /// The runtime binding the observation came from.
    pub binding_id: McpRuntimeBindingId,
    /// What the session saw.
    pub status: McpServerStatus,
    /// When it saw it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WireInstant")]
    #[garde(dive)]
    pub observed_at: Option<WireInstant>,
}

/// Why a server reads `failed`, where the daemon knows a reason the person can act on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum McpServerFailedReason {
    /// After the service moved between Windows and a WSL distribution, the command or its
    /// arguments name a program on the side it left.
    CommandNotRunnable,
}

/// The interrupted-call classes a person can assign to a tool. `manual_reconcile_only` is the floor
/// a tool reads with no assignment, so it is cleared to, never set.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum McpAssignableIdempotencyClass {
    /// Safe to repeat.
    Idempotent,
    /// Undoable.
    Compensable,
}

literal! {
    /// The interrupted-call class a server's own reading holds: the floor.
    pub enum McpServerIdempotencyClass = "manual_reconcile_only";
}

/// One tool's override as `mcp.setToolOverride` sets it, by facet: at least one facet is present,
/// and an absent facet is left as it stands. What a tool reads in force is its [`McpToolReading`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[garde(custom(override_sets_a_facet))]
#[schemars(transform = add_sets_a_facet_rule)]
pub struct McpToolOverride {
    /// The tool.
    pub tool_name: McpToolName,
    /// Whether the tool is on.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "bool")]
    pub enabled: Option<bool>,
    /// The approval mode pinned on it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "McpApprovalMode")]
    pub approval_mode: Option<McpApprovalMode>,
    /// The interrupted-call class assigned to it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "McpAssignableIdempotencyClass")]
    pub idempotency_class: Option<McpAssignableIdempotencyClass>,
}

/// Whether an override sets at least one facet.
fn override_sets_a_facet(tool_override: &McpToolOverride, _: &()) -> garde::Result {
    let sets_a_facet = tool_override.enabled.is_some()
        || tool_override.approval_mode.is_some()
        || tool_override.idempotency_class.is_some();
    if sets_a_facet {
        Ok(())
    } else {
        Err(garde::Error::new(
            "a tool override sets at least one of enabled, approvalMode or idempotencyClass",
        ))
    }
}

/// The schema twin of [`override_sets_a_facet`].
fn add_sets_a_facet_rule(schema: &mut Schema) {
    push_all_of(
        schema,
        json!({ "anyOf": MCP_TOOL_OVERRIDE_FACETS.map(|facet| required_member(facet.as_str())) }),
    );
}

/// One facet of a tool override, as `mcp.clearToolOverride` names the one it clears.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum McpToolOverrideFacet {
    /// Whether the tool is on.
    Enabled,
    /// The approval mode.
    ApprovalMode,
    /// The interrupted-call class.
    IdempotencyClass,
}

impl McpToolOverrideFacet {
    /// The facet's wire name, which is also its member's name on an override.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Enabled => "enabled",
            Self::ApprovalMode => "approvalMode",
            Self::IdempotencyClass => "idempotencyClass",
        }
    }
}

/// Every tool override facet, in declaration order.
pub const MCP_TOOL_OVERRIDE_FACETS: [McpToolOverrideFacet; 3] = [
    McpToolOverrideFacet::Enabled,
    McpToolOverrideFacet::ApprovalMode,
    McpToolOverrideFacet::IdempotencyClass,
];

/// One per-tool value in force, as the daemon resolved it, and where it came from. Under an
/// override it also carries `serverValue`, the server's own value that clearing the override
/// returns to, so a client choosing that value clears the facet rather than setting it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "source",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[schemars(inline)]
pub enum McpToolSetting<OverrideValue, ServerValue> {
    /// The server's own value.
    Server {
        /// The value.
        value: ServerValue,
    },
    /// An override set on the page.
    Override {
        /// The value.
        value: OverrideValue,
        /// The server's own value, which clearing the override returns to.
        server_value: ServerValue,
    },
}

/// One tool a binding's server offers, each setting in force and where it came from. The daemon
/// resolves each from the server's own declaration and the person's override, so a client draws
/// them and works none out: an unset approval mode reads the provider's default in the normalized
/// vocabulary, and an unset interrupted-call class reads `manual_reconcile_only`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpToolReading {
    /// The tool.
    pub tool_name: McpToolName,
    /// Whether it is on.
    pub enabled: McpToolSetting<bool, bool>,
    /// Its approval mode.
    pub approval_mode: McpToolSetting<McpApprovalMode, McpApprovalMode>,
    /// Its interrupted-call class.
    pub idempotency_class: McpToolSetting<McpAssignableIdempotencyClass, McpServerIdempotencyClass>,
}

/// Whether a failure reason sits only on a failed server.
fn is_failure_reason_on_failed(
    status: McpServerStatus,
    failed_reason: Option<&McpServerFailedReason>,
) -> garde::Result {
    if failed_reason.is_none() || status == McpServerStatus::Failed {
        Ok(())
    } else {
        Err(garde::Error::new(
            "failedReason is carried only on a failed server",
        ))
    }
}

/// The schema twin of [`is_failure_reason_on_failed`].
fn add_failure_reason_rule(schema: &mut Schema) {
    push_all_of(
        schema,
        json!({
            "if": {
                "type": "object",
                "properties": { "status": { "not": { "const": "failed" } } },
                "required": ["status"],
            },
            "then": { "type": "object", "properties": { "failedReason": false } },
        }),
    );
}

/// Declares one inventory arm: the binding, what an entry carries whether or not the binding
/// store answered, and the members the caller adds. `status` is the daemon's aggregate over
/// `legs`, and a failure reason sits only on a failed server.
macro_rules! inventory_entry {
    ($(#[$meta:meta])+ pub enum $name:ident { $($extra:tt)* }) => {
        binding_addressed! {
            $(#[$meta])+
            #[garde(custom(Self::keeps_failure_reason_on_failed))]
            #[schemars(transform = add_failure_reason_rule)]
            pub enum $name in every scope {
                /// The redacted declaration.
                config: McpServerConfigView,
                /// The status folded over the legs.
                status: McpServerStatus,
                /// Each live session's observation.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "Vec<McpServerLegStatus>")]
                #[garde(dive)]
                legs: Option<Vec<McpServerLegStatus>>,
                /// When the status was last observed.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "WireInstant")]
                #[garde(dive)]
                observed_at: Option<WireInstant>,
                /// Whether a session refuses to start without the server.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "bool")]
                required_server: Option<bool>,
                /// The project roots in which another binding of this provider and server name
                /// takes this one's place, by the provider's order: a project's `local` binding
                /// over its `project` one, either over the `user` one. Absent where it is used
                /// wherever it applies.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "BoundedVec<McpProjectRoot, 1, { usize::MAX }>")]
                superseded_in: Option<BoundedVec<McpProjectRoot, 1, { usize::MAX }>>,
                /// Why a `failed` server failed, where the daemon knows; only on a failed entry.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "McpServerFailedReason")]
                failed_reason: Option<McpServerFailedReason>,
                $($extra)*
            }
        }

        impl $name {
            /// Whether a failure reason sits only on a failed server.
            fn keeps_failure_reason_on_failed(&self, _: &()) -> garde::Result {
                let (Self::User { status, failed_reason, .. }
                | Self::Project { status, failed_reason, .. }
                | Self::Local { status, failed_reason, .. }
                | Self::Plugin { status, failed_reason, .. }) = self;
                is_failure_reason_on_failed(*status, failed_reason.as_ref())
            }
        }
    };
}

inventory_entry! {
    /// An inventory row whose binding store answered.
    pub enum McpAnsweredInventoryEntry {
        /// Whether the binding is on.
        enabled: bool,
        /// Its server's tools.
        tools: Vec<McpToolReading>,
    }
}

inventory_entry! {
    /// An inventory row while the binding store is unavailable: the members that need the store
    /// are absent, not `false`, `unknown` or an empty list, so no made-up verdict exists.
    pub enum McpStoreUnavailableInventoryEntry {
        /// Always `true`.
        binding_store_unavailable: True,
        /// Whether the binding is on, where known without the store.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "bool")]
        enabled: Option<bool>,
    }
}

/// One inventory row: the binding and what is known about it. A client renders an absent member
/// as unknown.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
pub enum McpServerInventoryEntry {
    /// The binding store answered.
    Answered(#[garde(dive)] McpAnsweredInventoryEntry),
    /// The binding store did not answer.
    StoreUnavailable(#[garde(dive)] McpStoreUnavailableInventoryEntry),
}
