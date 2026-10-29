//! What the daemon reports about a binding: one inventory row, each live session's observation of
//! it, and each of its tools' settings in force with where they came from.

use schemars::{JsonSchema, Schema};
use serde::{Deserialize, Serialize};
use serde_json::json;
use strum::{IntoStaticStr, VariantArray};

use crate::mcp::server::config::McpServerConfigView;
use crate::mcp::server::{
    McpApprovalMode, McpServerBindingId, McpServerStatus, McpToolName, binding_addressed,
};
use crate::place::PlacedPath;
use crate::provider::driver::runtime_binding::RuntimeBindingId;
use crate::schema::{push_all_of, required_member};
use crate::session::id::SessionId;
use crate::wire::instant::WireInstant;
use crate::wire::list::UniqueList;
use crate::wire::{Never, True, literal};

/// One live session's observation of one binding, kept per session because two sessions'
/// connections to one binding can disagree, and one verdict would hide a partial outage.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[garde(custom(Self::keeps_failure_reason_on_failed))]
#[schemars(transform = add_failure_reason_rule)]
pub struct McpServerLegStatus {
    /// The session.
    pub session_id: SessionId,
    /// The runtime binding the observation came from.
    pub binding_id: RuntimeBindingId,
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
    /// Why the session saw it fail, where the daemon knows; only on a failed leg.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "McpServerFailedReason")]
    pub failed_reason: Option<McpServerFailedReason>,
}

impl McpServerLegStatus {
    /// Whether a failure reason sits only on a failed leg.
    #[expect(
        clippy::trivially_copy_pass_by_ref,
        reason = "garde passes a check's context by reference"
    )]
    fn keeps_failure_reason_on_failed(&self, (): &()) -> garde::Result {
        is_failure_reason_on_failed(self.status, self.failed_reason.as_ref())
    }
}

/// Why a session saw a server fail, where the daemon knows a reason the person can act on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum McpServerFailedReason {
    /// The command or its arguments name a Windows program, which cannot run in the WSL 2
    /// distribution the session runs in; the leg's session names the distribution.
    CommandNotRunnable,
}

/// The interrupted-call classes a person can assign to a tool. `manualReconcileOnly` is the floor
/// a tool reads with no assignment, so it is cleared to, never set.
#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    Hash,
    Serialize,
    Deserialize,
    JsonSchema,
    IntoStaticStr,
    VariantArray,
)]
#[serde(rename_all = "camelCase")]
#[strum(serialize_all = "camelCase")]
pub enum McpAssignableIdempotencyClass {
    /// Safe to repeat.
    Idempotent,
    /// Undoable.
    Compensable,
}

literal! {
    /// The interrupted-call class a server's own reading holds: the floor.
    pub enum McpServerIdempotencyClass = "manualReconcileOnly";
}

/// One tool's override as `mcp.toolOverride.update` sets it, by facet: at least one facet is
/// present, and an absent facet is left as it stands. What a tool reads in force is its
/// [`McpToolReading`].
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
#[expect(
    clippy::trivially_copy_pass_by_ref,
    reason = "garde passes a check's context by reference"
)]
fn override_sets_a_facet(tool_override: &McpToolOverride, (): &()) -> garde::Result {
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
    let facets: Vec<_> = MCP_TOOL_OVERRIDE_FACETS
        .iter()
        .map(|facet| required_member(facet.as_str()))
        .collect();
    push_all_of(schema, json!({ "anyOf": facets }));
}

/// One facet of a tool override, as `mcp.toolOverride.clear` names the one it clears.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, VariantArray,
)]
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
pub const MCP_TOOL_OVERRIDE_FACETS: &[McpToolOverrideFacet] = McpToolOverrideFacet::VARIANTS;

/// One per-tool value in force, as the daemon resolved it, and where it came from. Under an
/// override it also carries `serverValue`, the server's own value that clearing the override
/// returns to, so a client choosing that value clears the facet rather than setting it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "source",
    rename_all = "camelCase",
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
/// vocabulary, and an unset interrupted-call class reads `manualReconcileOnly`.
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

/// Whether a failure reason sits only on a failed leg.
fn is_failure_reason_on_failed(
    status: McpServerStatus,
    failed_reason: Option<&McpServerFailedReason>,
) -> garde::Result {
    if failed_reason.is_none() || status == McpServerStatus::Failed {
        Ok(())
    } else {
        Err(garde::Error::new(
            "failedReason is carried only on a failed leg",
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
/// `legs`, and a failure reason sits only on a failed leg.
macro_rules! inventory_entry {
    ($(#[$meta:meta])+ pub enum $name:ident { $($extra:tt)* }) => {
        binding_addressed! {
            $(#[$meta])+
            pub enum $name in every scope {
                /// The binding's id, which places a status notice on this row.
                server_binding_id: McpServerBindingId,
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
                /// Where another declaration of this provider takes this one's place, by the
                /// provider's order, each a path with the distribution it is in: a project root
                /// where a project's `local` binding wins over its `project` one, either over the
                /// `user` one, matched by server name, or, on a provider that matches that way, a
                /// plugin's server or a connector that points at the same address or command; or
                /// the settings file, the person's or a project's, whose entry overrides an
                /// administrator layer's server field by field. Absent where it is used wherever it
                /// applies.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "UniqueList<PlacedPath, 1, { usize::MAX }>")]
                #[garde(dive)]
                superseded_in: Option<UniqueList<PlacedPath, 1, { usize::MAX }>>,
                /// The project roots, each with its distribution, where the server is switched off,
                /// by the provider's own per-project list or, on a connector or an organization's
                /// server, by the daemon's per-project switch; it stays out of those projects'
                /// sessions. Absent where no project switched it off.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "UniqueList<PlacedPath, 1, { usize::MAX }>")]
                #[garde(dive)]
                disabled_in: Option<UniqueList<PlacedPath, 1, { usize::MAX }>>,
                /// Whether the account's organization manages the connector's sign-in, as the
                /// provider's own connector list reads it. Present only on a connector whose list
                /// was read; absent on every other row and where the list could not be read, which
                /// a client renders as unknown, never as not managed.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "bool")]
                organization_managed: Option<bool>,
                $($extra)*
            }
        }
    };
}

inventory_entry! {
    /// An inventory row whose binding store answered.
    pub enum McpAnsweredInventoryEntry {
        /// Never present: the store answered.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        binding_store_unavailable: Option<Never>,
        /// Whether the binding is on.
        enabled: bool,
        /// Its server's tools.
        tools: Vec<McpToolReading>,
    }
}

inventory_entry! {
    /// An inventory row while the binding store is unavailable: the members that need the store
    /// are absent, not `false`, `unknown` or an empty list, so no made-up verdict exists. A
    /// binding whose switch the daemon keeps in the store leaves `enabled` out.
    pub enum McpStoreUnavailableInventoryEntry {
        /// Always `true`.
        binding_store_unavailable: True,
        /// Whether the binding is on, as the provider's own config says; absent where the switch
        /// lives in the store.
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
