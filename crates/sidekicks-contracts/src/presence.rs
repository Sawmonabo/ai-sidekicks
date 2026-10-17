//! Presence: which of the person's devices are connected to this machine, and whether an app
//! window is in front on each. Presence belongs to a machine, never to a session. Each device sends
//! a heartbeat on each machine connection it holds; the machine keeps the last one per device in
//! memory and answers `presence.read` and `presence.subscribe` from it. Nothing is persisted.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::jsonrpc::streaming::SubscribeAckResponse;
use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::trust_statement::DeviceId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::text::FreeFormText;

ts_constants! {
    /// The longest device category, such as "desktop" or "mobile", in code points.
    pub const DEVICE_TYPE_MAX_LEN: usize = 64;
}

/// A device's category, such as "desktop" or "mobile".
pub type DeviceType = FreeFormText<DEVICE_TYPE_MAX_LEN>;

/// A device's report to a machine, sent when `appVisible` changes and otherwise every 15 seconds on
/// each machine connection the device holds. It names no device: the machine files it under the
/// device of the connection that carried it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PresenceHeartbeatSendRequest {
    /// The device's category.
    pub device_type: DeviceType,
    /// An app window is in front on this device; a window behind a locked or sleeping screen is
    /// not.
    pub app_visible: bool,
}

/// One device connected to this machine: the last heartbeat the machine holds from it, under the
/// device that sent it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectedDevice {
    /// The device.
    pub device_id: DeviceId,
    /// Its category.
    pub device_type: DeviceType,
    /// Whether an app window is in front on it.
    pub app_visible: bool,
}

/// The devices connected to this machine: `presence.read`'s reply, and each value
/// `presence.subscribe` pushes when a device comes, goes or changes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct MachinePresence {
    /// The devices.
    pub devices: Vec<ConnectedDevice>,
}

methods! {
    /// The `presence.*` methods the daemon answers.
    pub const PRESENCE_METHOD_DESCRIPTORS = [
        /// The devices connected now.
        PresenceRead = query "presence.read" {
            mutating: false,
            params: EmptyPayload,
            result: MachinePresence,
            refusals: [],
        },
        /// A device's heartbeat; not mutating, so a device outside the supported version range
        /// still says whether an app window is in front on it.
        PresenceHeartbeatSend = mutation "presence.heartbeat.send" {
            mutating: false,
            params: PresenceHeartbeatSendRequest,
            result: EmptyPayload,
            refusals: [],
        },
        /// The devices connected, pushed on each change.
        PresenceSubscribe = subscription "presence.subscribe" {
            mutating: false,
            params: EmptyPayload,
            result: SubscribeAckResponse,
            emission: MachinePresence,
            refusals: [],
        },
    ];
}

/// The TypeScript module of presence.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "presence",
    doc: "Presence: which of the person's devices are connected to this machine, and whether an \
          app window is in front on each.",
    definitions: &[
        Definition::read::<PresenceHeartbeatSendRequest>().checked(),
        Definition::read::<ConnectedDevice>(),
        Definition::read::<MachinePresence>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[&PRESENCE_METHOD_DESCRIPTORS],
};
