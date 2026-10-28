//! The MCP governance stream: the stored events of the `mcpGovernance` category, the live notices
//! of an edit to a binding and of a status change, and the `mcp.subscribe` method that carries
//! them.

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::event::envelope::{EventCategory, EventEnvelope};
use crate::jsonrpc::streaming::SubscribeAcknowledgmentResponse;
use crate::mcp::governance::McpServerStatusChangedNotice;
use crate::mcp::server::McpServerConfigChangedNotice;
use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::schema::push_all_of;
use crate::typescript::{Definition, TypeScriptModule};

/// Refuses an envelope of any category but `mcpGovernance`.
#[expect(
    clippy::trivially_copy_pass_by_ref,
    reason = "garde passes a check's context by reference"
)]
fn is_mcp_governance(envelope: &EventEnvelope, (): &()) -> garde::Result {
    if envelope.category == EventCategory::McpGovernance {
        Ok(())
    } else {
        Err(garde::Error::new(
            "an MCP governance event is of the mcpGovernance category",
        ))
    }
}

/// A stored session event of the `mcpGovernance` category: the event envelope, its `category`
/// held to `mcpGovernance` by its check, and its `type` and `payload` kept as written.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, garde::Validate)]
#[serde(transparent)]
#[garde(transparent)]
pub struct McpGovernanceEvent(#[garde(dive, custom(is_mcp_governance))] EventEnvelope);

impl McpGovernanceEvent {
    /// `envelope` when its category is `mcpGovernance`, else `None`.
    pub fn new(envelope: EventEnvelope) -> Option<Self> {
        is_mcp_governance(&envelope, &())
            .is_ok()
            .then_some(Self(envelope))
    }

    /// The event's envelope.
    pub fn as_envelope(&self) -> &EventEnvelope {
        &self.0
    }
}

impl JsonSchema for McpGovernanceEvent {
    fn schema_name() -> Cow<'static, str> {
        "McpGovernanceEvent".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let mut schema = json_schema!({
            "description": "A stored session event of the `mcpGovernance` category: the event \
                            envelope, its `category` held to `mcpGovernance`, and its `type` and \
                            `payload` kept as written.",
        });
        push_all_of(
            &mut schema,
            generator.subschema_for::<EventEnvelope>().into(),
        );
        push_all_of(
            &mut schema,
            json!({
                "type": "object",
                "properties": {
                    "category": { "const": EventCategory::McpGovernance.as_str() },
                },
            }),
        );
        schema
    }
}

/// One `mcp.subscribe` frame: the live notice of an edit to a binding or of a status change, or a
/// governance event. The stream reads governance events from the sentinel session's log at the
/// subscriber's place and sends each notice's newest value per binding and source (a session's
/// leg, the machine probe, an edit), so it keeps no queue, no cursor and no dropped mark.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
#[garde(allow_unvalidated)]
pub enum McpSubscribeEmission {
    /// An edit to a binding, from any client.
    ConfigChanged(#[garde(dive)] McpServerConfigChangedNotice),
    /// A status change of a binding.
    StatusChanged(McpServerStatusChangedNotice),
    /// A stored governance event.
    GovernanceEvent(#[garde(dive)] McpGovernanceEvent),
}

methods! {
    /// `mcp.subscribe`, the MCP governance stream, opened before `mcp.server.list` is read so
    /// nothing falls between the two. It reads governance events from the sentinel session's log at
    /// the subscriber's place and sends each notice's newest value per binding and source (a
    /// session's leg, the machine probe, an edit): no cursor, no dropped mark.
    pub const MCP_EVENT_METHOD_DESCRIPTORS = [
        /// Follows the governance events and the live notices.
        McpSubscribe = subscription "mcp.subscribe" {
            mutating: false,
            params: EmptyPayload,
            result: SubscribeAcknowledgmentResponse,
            emission: McpSubscribeEmission,
            refusals: [],
        },
    ];
}

/// The TypeScript module of the MCP governance stream.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "mcp/event",
    doc: "The MCP governance stream: the stored events of the `mcpGovernance` category, the live \
          notices of an edit to a binding and of a status change, and the `mcp.subscribe` method \
          that carries them.",
    definitions: &[
        Definition::read::<McpGovernanceEvent>().checked(),
        Definition::read::<McpSubscribeEmission>().checked(),
    ],
    constants: &[],
    method_tables: &[&MCP_EVENT_METHOD_DESCRIPTORS],
};
