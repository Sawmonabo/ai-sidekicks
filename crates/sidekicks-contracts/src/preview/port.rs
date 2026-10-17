//! The ports a machine shares with the person's other devices: the shared list, the forward to one
//! port, the web address a browser tab opens it at, and the two refusals that guard them. The
//! machine forwards only listed ports, and only to its own loopback.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::jsonrpc::refusal::RefusalCode;
use crate::jsonrpc::streaming::SubscribeAckResponse;
use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::web_address::HttpsAddress;
use crate::wire::True;
use crate::wire::instant::WireInstant;
use crate::wire::integer::Port;
use crate::wire::text::NonEmptyText;

/// The details both port refusals carry: the port the request named.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewPortRefusalDetails {
    /// The port.
    pub port: Port,
}

/// One shared port with what the machine knows of it: the framework discovery named, `null` where
/// it named none, and whether anything listens on it yet. A port may be shared before its server
/// starts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PreviewSharedPort {
    /// The port.
    pub port: Port,
    /// The framework discovery named.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<NonEmptyText>")]
    pub framework: Option<NonEmptyText>,
    /// Whether anything listens on it.
    pub listening: bool,
    /// When it was shared.
    #[garde(dive)]
    pub added_at: WireInstant,
}

/// One frame of the shared-ports list: every shared port, in the order they were added. The stream
/// sends the newest list once the reader has room, never a queue of the lists between.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewPortShareListFrame {
    /// The shared ports.
    #[garde(dive)]
    pub ports: Vec<PreviewSharedPort>,
}

/// Names one port: share it, stop sharing it, or issue the web address's ticket for it.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PreviewPortRequest {
    /// The port.
    pub port: Port,
}

/// The port now shared, and when.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PreviewPortShareAddResponse {
    /// The port.
    pub port: Port,
    /// When it was shared.
    #[garde(dive)]
    pub added_at: WireInstant,
}

/// The port is no longer shared and every forward open on it is closed. Removing a port that is
/// not shared answers the same.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PreviewPortShareRemoveResponse {
    /// The port.
    pub port: Port,
    /// Always `true`.
    pub removed: True,
}

/// The shared port's own web address for a browser tab, carrying a one-time ticket good for 60
/// seconds that the machine trades for a cookie scoped to the address.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PreviewPortTicketIssueResponse {
    /// The address, always `https:`.
    pub address: HttpsAddress<{ usize::MAX }>,
}

methods! {
    /// The `preview.port*` methods the daemon answers.
    pub const PREVIEW_PORT_METHOD_DESCRIPTORS = [
        /// Streams the machine's shared ports; the list is the machine's, so the request names
        /// nothing.
        PreviewPortShareSubscribe = subscription "preview.portShare.subscribe" {
            mutating: false,
            params: EmptyPayload,
            result: SubscribeAckResponse,
            emission: PreviewPortShareListFrame,
            refusals: [],
        },
        /// Shares a port.
        PreviewPortShareAdd = mutation "preview.portShare.add" {
            mutating: true,
            params: PreviewPortRequest,
            result: PreviewPortShareAddResponse,
            refusals: [PreviewPortShareAlreadyExists],
        },
        /// Stops sharing a port.
        PreviewPortShareRemove = mutation "preview.portShare.remove" {
            mutating: true,
            params: PreviewPortRequest,
            result: PreviewPortShareRemoveResponse,
            refusals: [],
        },
        /// Issues a shared port's web address with its ticket.
        PreviewPortTicketIssue = mutation "preview.portTicket.issue" {
            mutating: true,
            params: PreviewPortRequest,
            result: PreviewPortTicketIssueResponse,
            refusals: [PreviewPortNotShared],
        },
    ];
}

ts_constants! {
    /// A port added to the shared list that is on it already; nothing changes.
    PREVIEW_PORT_SHARE_ALREADY_EXISTS_CODE = RefusalCode::PreviewPortShareAlreadyExists;
    /// A forward or a web ticket asked for a port that is not on the shared list.
    PREVIEW_PORT_NOT_SHARED_CODE = RefusalCode::PreviewPortNotShared;
}

/// The TypeScript module of the shared ports.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "preview/port",
    doc: "The ports a machine shares with the person's other devices, and the `preview.port*` \
          methods.",
    definitions: &[
        Definition::read::<PreviewPortRefusalDetails>().checked(),
        Definition::read::<PreviewSharedPort>(),
        Definition::read::<PreviewPortShareListFrame>().checked(),
        Definition::read::<PreviewPortRequest>().checked(),
        Definition::read::<PreviewPortShareAddResponse>().checked(),
        Definition::read::<PreviewPortShareRemoveResponse>().checked(),
        Definition::read::<PreviewPortTicketIssueResponse>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[&PREVIEW_PORT_METHOD_DESCRIPTORS],
};
