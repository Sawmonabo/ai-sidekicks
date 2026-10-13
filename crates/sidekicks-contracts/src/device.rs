//! The device requests: list, link, rename, revoke, forget, push address, notification switches,
//! and the desktop's control-plane calls through the background service. The keys and statement
//! chain they carry belong to `trust_statement`.
//!
//! Two boundaries meet here, each with its own table. The control plane serves `device.list`,
//! linking, rename, revoke, forget, `device.statementList` and `device.pushAddressSet`; a machine's
//! service serves `device.statementApply`, `device.trustedList`, `device.notificationSettingsSet`
//! and `controlPlane.call`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::VariantArray;

use crate::machine_settings::NotificationKindSwitches;
use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::runtime_node::id::NodeId;
use crate::trust_statement::{
    ChannelPublicKey, DeviceId, DeviceLinkedStatement, DeviceRenamedStatement,
    DeviceRevokedStatement, IdentityPublicKey, MachineIdentityKey, PasskeyId, PlatformDescription,
    TrustName, TrustSigner, TrustStatement, TrustStatementHash, TrustStatementKind,
};
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::web_address::HttpsAddress;
use crate::wire::base64::{Base64Array, Base64UrlText};
use crate::wire::instant::WireInstant;
use crate::wire::list::BoundedVec;
use crate::wire::text::FreeFormText;
use crate::wire::{AnyValue, NullableSchema, named_scalar, nullable};

ts_constants! {
    /// The longest app or service version string.
    pub const APP_VERSION_MAX_LEN: usize = 64;
    /// The longest pairing id the control plane mints for one link.
    pub const PAIRING_ID_MAX_LEN: usize = 256;
    /// The longest push address: an APNs or FCM token, or a Web Push endpoint.
    pub const PUSH_ADDRESS_MAX_LEN: usize = 2048;
    /// Where a device's pushes go.
    PUSH_PLATFORMS = PushPlatform::VARIANTS;
    /// The forwarded procedures, in one closed list.
    CONTROL_PLANE_CALL_PROCEDURES = ControlPlaneCallProcedure::VARIANTS;
}

/// An app or service version.
pub type AppVersion = FreeFormText<APP_VERSION_MAX_LEN>;

/// A single-use pairing's id.
pub type PairingId = FreeFormText<PAIRING_ID_MAX_LEN>;

// device.list: the machines, devices and passkeys, live

/// A machine card's facts. `This machine` is the reader's own comparison of `nodeId`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct MachineEntry {
    /// The machine.
    pub node_id: NodeId,
    /// Its name.
    pub name: TrustName,
    /// Its platform.
    pub platform: PlatformDescription,
    /// Its service's version.
    pub service_version: AppVersion,
    /// Whether the machine holds its relay connection now.
    pub reachable: bool,
    /// The end of its last relay connection; `null` while it has never connected.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<WireInstant>")]
    #[garde(dive)]
    pub last_seen_at: Option<WireInstant>,
}

/// A device card's facts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct DeviceEntry {
    /// The device.
    pub device_id: DeviceId,
    /// Its name.
    pub name: TrustName,
    /// Its platform.
    pub platform: PlatformDescription,
    /// Its app's version.
    pub app_version: AppVersion,
    /// Whether the device holds a relay connection now.
    pub connected: bool,
    /// The end of its last relay connection; `null` while it has never connected.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<WireInstant>")]
    #[garde(dive)]
    pub last_seen_at: Option<WireInstant>,
    /// When it was linked.
    #[garde(dive)]
    pub linked_at: WireInstant,
    /// Whose key linked it, so a device a since-revoked device linked is flagged.
    pub linked_by: TrustSigner,
    /// When it was revoked; `null` while it is trusted. A revoked card sits in `Revoked`.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<WireInstant>")]
    #[garde(dive)]
    pub revoked_at: Option<WireInstant>,
    /// The machines that have not yet fetched its revoke; each drops it when it next connects.
    pub revoke_pending_on_node_ids: Vec<NodeId>,
    /// Its key kept displacing its own connection, so it is in two places at once.
    pub seen_in_two_places: bool,
}

/// A passkey row's facts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PasskeyEntry {
    /// The passkey.
    pub passkey_id: PasskeyId,
    /// The platform that holds it.
    pub platform: PlatformDescription,
    /// When it was added.
    #[garde(dive)]
    pub added_at: WireInstant,
    /// Whose key added it, so a passkey a since-revoked device added is flagged.
    pub added_by: TrustSigner,
}

/// `device.list` takes nothing: the account is the caller's.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct DeviceListRequest {}

/// The list now, which the live read answers with before its first change.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceListSnapshot {
    /// The machines.
    #[garde(dive)]
    pub machines: Vec<MachineEntry>,
    /// The devices.
    #[garde(dive)]
    pub devices: Vec<DeviceEntry>,
    /// The passkeys.
    #[garde(dive)]
    pub passkeys: Vec<PasskeyEntry>,
}

/// A new statement on the live read, named by its statement's kind, so a reader never meets an
/// event whose name and statement disagree.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceStatementEvent {
    /// The statement's kind.
    #[serde(rename = "type")]
    #[garde(custom(|kind: &TrustStatementKind, (): &()| {
        if *kind == self.statement.kind() {
            Ok(())
        } else {
            Err(garde::Error::new("a statement event is named by its statement's kind"))
        }
    }))]
    pub kind: TrustStatementKind,
    /// The statement.
    #[garde(dive)]
    pub statement: TrustStatement,
}

/// A change on the live read that is not a statement: a revoked device's row forgotten, or a
/// machine's registration refreshed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(tag = "type", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum DeviceListRowEvent {
    /// A revoked device's row was forgotten; its `device.revoked` stays in the chain.
    #[serde(rename = "device.forgotten")]
    DeviceForgotten {
        /// The device.
        #[garde(skip)]
        device_id: DeviceId,
    },
    /// A machine's registration was refreshed.
    #[serde(rename = "runtimenode.registered")]
    RuntimeNodeRegistered {
        /// The machine.
        #[garde(dive)]
        machine: MachineEntry,
    },
}

/// One change on the live read: a new statement under its kind's name, or a row's change. The
/// generated check cannot compare a statement event's name with its statement's kind; the Rust
/// check does.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
pub enum DeviceListEvent {
    /// A new statement.
    Statement(#[garde(dive)] DeviceStatementEvent),
    /// A row's change.
    Row(#[garde(dive)] DeviceListRowEvent),
}

// Linking

/// `device.linkStart` takes nothing: the caller is the linking side.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct DeviceLinkStartRequest {}

/// A single-use pairing, good for 5 minutes from when it was made.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct DeviceLinkStartResponse {
    /// The pairing.
    pub pairing_id: PairingId,
    /// When it ends.
    #[garde(dive)]
    pub expires_at: WireInstant,
}

/// The new device's half of the link: its keys, its name and platform, and a SHA-256 HMAC under
/// the link's secret, which never reaches the control plane.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct DeviceLinkRedeemRequest {
    /// The pairing.
    pub pairing_id: PairingId,
    /// The device's identity key.
    pub identity_key: IdentityPublicKey,
    /// The device's channel key.
    pub channel_key: ChannelPublicKey,
    /// The device's name.
    pub name: TrustName,
    /// The device's platform.
    pub platform: PlatformDescription,
    /// The device's app version.
    pub app_version: AppVersion,
    /// The linking proof, a SHA-256 HMAC: 32 bytes.
    pub mac: Base64Array<32>,
}

/// One machine key the linking side trusts, which the six digits bind.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrustedMachineKey {
    /// The machine.
    pub node_id: NodeId,
    /// Its identity key.
    pub identity_key: MachineIdentityKey,
}

/// What the new device needs to show the six digits: the linking side's name and key, and the
/// machine keys it trusts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceLinkRedeemResponse {
    /// The linking side's name.
    pub linking_name: TrustName,
    /// The linking side's identity key.
    pub linking_key: IdentityPublicKey,
    /// The machine keys it trusts, at least one.
    pub machine_keys: BoundedVec<TrustedMachineKey, 1, { usize::MAX }>,
}

/// `It matches`: the signed `device.linked` statement for this pairing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct DeviceLinkRequest {
    /// The pairing.
    pub pairing_id: PairingId,
    /// The statement.
    #[garde(dive)]
    pub statement: DeviceLinkedStatement,
}

/// `Cancel`, or `It doesn't match`: the pairing ends and nothing is linked.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct DeviceLinkCancelRequest {
    /// The pairing.
    pub pairing_id: PairingId,
}

// Rename, revoke, forget

/// A rename, as the `device.renamed` statement the renaming device signs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceRenameRequest {
    /// The statement.
    #[garde(dive)]
    pub statement: DeviceRenamedStatement,
}

/// A revoke, as the `device.revoked` statement the revoking device signs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceRevokeRequest {
    /// The statement.
    #[garde(dive)]
    pub statement: DeviceRevokedStatement,
}

/// Removes a revoked device's row; its `device.revoked` stays in the chain.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct DeviceForgetRequest {
    /// The device.
    pub device_id: DeviceId,
}

// The chain, fetched and handed on

/// The chain after a given statement; `null` asks for it from the start.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct DeviceStatementListRequest {
    /// The statement to start after.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<TrustStatementHash>")]
    pub after: Option<TrustStatementHash>,
}

/// Statements in chain order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceStatementListResponse {
    /// The statements.
    #[garde(dive)]
    pub statements: Vec<TrustStatement>,
}

/// Statements a device has seen, handed to a machine, which verifies each against the chain it
/// holds before it keeps it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceStatementApplyRequest {
    /// The statements, at least one.
    #[garde(dive)]
    pub statements: BoundedVec<TrustStatement, 1, { usize::MAX }>,
}

/// `device.trustedList` takes nothing: the view is the answering machine's own.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct DeviceTrustedListRequest {}

/// One device as this machine's verified chain sees it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct TrustedDevice {
    /// The device.
    pub device_id: DeviceId,
    /// Its name.
    pub name: TrustName,
    /// Its platform.
    pub platform: PlatformDescription,
    /// Its identity key.
    pub identity_key: IdentityPublicKey,
    /// Its channel key.
    pub channel_key: ChannelPublicKey,
    /// The statement that trusts it.
    pub trusted_by: TrustStatementHash,
    /// When its key ended; `null` while it is trusted.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<WireInstant>")]
    #[garde(dive)]
    pub revoked_at: Option<WireInstant>,
}

/// A machine's own verified view of the trusted devices.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceTrustedListResponse {
    /// The devices.
    #[garde(dive)]
    pub devices: Vec<TrustedDevice>,
}

// Push address and notification switches

/// Where a device's pushes go.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, VariantArray,
)]
#[serde(rename_all = "camelCase")]
pub enum PushPlatform {
    /// Apple's push service.
    Apns,
    /// Firebase Cloud Messaging.
    Fcm,
    /// A browser's Web Push endpoint.
    WebPush,
}

/// The calling device's push address: its APNs token, its FCM token or its Web Push endpoint. Set
/// at link time and whenever the platform changes it. The control plane posts to a Web Push
/// endpoint, so that one is an `https:` address, never somewhere no push service lives.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "platform",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[garde(allow_unvalidated)]
pub enum DevicePushAddressSetRequest {
    /// An APNs token.
    Apns {
        /// The token.
        address: FreeFormText<PUSH_ADDRESS_MAX_LEN>,
    },
    /// An FCM token.
    Fcm {
        /// The token.
        address: FreeFormText<PUSH_ADDRESS_MAX_LEN>,
    },
    /// A Web Push endpoint.
    WebPush {
        /// The endpoint.
        address: HttpsAddress<PUSH_ADDRESS_MAX_LEN>,
    },
}

/// A Web Push subscription's own keys (RFC 8291), base64url as the browser hands them over.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WebPushKeys {
    /// The subscription's 65-byte P-256 public key, 87 base64url characters.
    pub p256dh: Base64UrlText<87, 87>,
    /// The subscription's 16-byte authentication secret, 22 base64url characters.
    pub auth: Base64UrlText<22, 22>,
}

/// A device's own switches and push keys, handed to a machine on every connection and whenever one
/// changes. The machine keeps the copy only to decide before it sends, and never edits it.
/// `pushKey` is the 1,216-byte X-Wing public key a push is sealed to, standard base64.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct DeviceNotificationSettingsSetRequest {
    /// `Notify me outside the app`.
    pub notify_outside_the_app: bool,
    /// `Show a count on the app icon`.
    pub count_on_app_icon: bool,
    /// The kinds a notification is shown for.
    pub kinds: NotificationKindSwitches,
    /// The X-Wing public key a push is sealed to.
    pub push_key: Base64Array<1216>,
    /// A browser's Web Push keys.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WebPushKeys")]
    pub web_push_keys: Option<WebPushKeys>,
}

methods! {
    /// The device procedures the control plane serves.
    pub const DEVICE_CONTROL_PLANE_METHOD_DESCRIPTORS = [
        /// The machines, devices and passkeys, live.
        DeviceList = subscription "device.list" {
            mutating: false,
            params: DeviceListRequest,
            result: DeviceListSnapshot,
            emission: DeviceListEvent,
            refusals: [],
        },
        /// Opens a single-use pairing.
        DeviceLinkStart = mutation "device.linkStart" {
            mutating: true,
            params: DeviceLinkStartRequest,
            result: DeviceLinkStartResponse,
            refusals: [],
        },
        /// The new device's half of the link.
        DeviceLinkRedeem = mutation "device.linkRedeem" {
            mutating: true,
            params: DeviceLinkRedeemRequest,
            result: DeviceLinkRedeemResponse,
            refusals: [],
        },
        /// `It matches`.
        DeviceLink = mutation "device.link" {
            mutating: true,
            params: DeviceLinkRequest,
            result: EmptyPayload,
            refusals: [],
        },
        /// Ends a pairing with nothing linked.
        DeviceLinkCancel = mutation "device.linkCancel" {
            mutating: true,
            params: DeviceLinkCancelRequest,
            result: EmptyPayload,
            refusals: [],
        },
        /// Renames a device.
        DeviceRename = mutation "device.rename" {
            mutating: true,
            params: DeviceRenameRequest,
            result: EmptyPayload,
            refusals: [],
        },
        /// Revokes a device.
        DeviceRevoke = mutation "device.revoke" {
            mutating: true,
            params: DeviceRevokeRequest,
            result: EmptyPayload,
            refusals: [],
        },
        /// Forgets a revoked device's row.
        DeviceForget = mutation "device.forget" {
            mutating: true,
            params: DeviceForgetRequest,
            result: EmptyPayload,
            refusals: [],
        },
        /// The chain after a statement.
        DeviceStatementList = query "device.statementList" {
            mutating: false,
            params: DeviceStatementListRequest,
            result: DeviceStatementListResponse,
            refusals: [],
        },
        /// Sets the calling device's push address.
        DevicePushAddressSet = mutation "device.pushAddressSet" {
            mutating: true,
            params: DevicePushAddressSetRequest,
            result: EmptyPayload,
            refusals: [],
        },
    ];
}

methods! {
    /// The device methods a machine's service answers over the channel.
    pub const DEVICE_METHOD_DESCRIPTORS = [
        /// Statements a device has seen, verified before they are kept.
        DeviceStatementApply = mutation "device.statementApply" {
            mutating: true,
            params: DeviceStatementApplyRequest,
            result: EmptyPayload,
            refusals: [],
        },
        /// This machine's verified view of the trusted devices.
        DeviceTrustedList = query "device.trustedList" {
            mutating: false,
            params: DeviceTrustedListRequest,
            result: DeviceTrustedListResponse,
            refusals: [],
        },
        /// A device's own switches and push keys.
        DeviceNotificationSettingsSet = mutation "device.notificationSettingsSet" {
            mutating: true,
            params: DeviceNotificationSettingsSetRequest,
            result: EmptyPayload,
            refusals: [],
        },
    ];
}

// controlPlane.call: the desktop's control-plane calls, through the service

/// The control-plane procedures the desktop's screens call. The window holds no credential, so
/// each rides the background service, which attaches the account's access token and signs the
/// request's proof of possession. Relay negotiation and every procedure not listed are refused.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, VariantArray,
)]
pub enum ControlPlaneCallProcedure {
    /// `device.list`.
    #[serde(rename = "device.list")]
    DeviceList,
    /// `device.linkStart`.
    #[serde(rename = "device.linkStart")]
    DeviceLinkStart,
    /// `device.linkRedeem`.
    #[serde(rename = "device.linkRedeem")]
    DeviceLinkRedeem,
    /// `device.link`.
    #[serde(rename = "device.link")]
    DeviceLink,
    /// `device.linkCancel`.
    #[serde(rename = "device.linkCancel")]
    DeviceLinkCancel,
    /// `device.rename`.
    #[serde(rename = "device.rename")]
    DeviceRename,
    /// `device.revoke`.
    #[serde(rename = "device.revoke")]
    DeviceRevoke,
    /// `device.forget`.
    #[serde(rename = "device.forget")]
    DeviceForget,
    /// `device.statementList`.
    #[serde(rename = "device.statementList")]
    DeviceStatementList,
    /// `device.pushAddressSet`.
    #[serde(rename = "device.pushAddressSet")]
    DevicePushAddressSet,
    /// `runtimenode.rename`.
    #[serde(rename = "runtimenode.rename")]
    RuntimeNodeRename,
    /// `runtimenode.remove`.
    #[serde(rename = "runtimenode.remove")]
    RuntimeNodeRemove,
}

/// One forwarded call. `input` is the procedure's own request, which the control plane's
/// descriptor for that procedure parses, and the reply is that procedure's own result.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ControlPlaneCallRequest {
    /// The procedure, from the closed list.
    pub procedure: ControlPlaneCallProcedure,
    /// The procedure's own request.
    pub input: AnyValue,
}

named_scalar! {
    /// The forwarded procedure's own result.
    ControlPlaneCallResponse(AnyValue) unordered
}

methods! {
    /// The one method the service answers for the window's control-plane calls.
    pub const CONTROL_PLANE_METHOD_DESCRIPTORS = [
        /// Forwards one call to the control plane.
        ControlPlaneCall = mutation "controlPlane.call" {
            mutating: true,
            params: ControlPlaneCallRequest,
            result: ControlPlaneCallResponse,
            refusals: [],
        },
    ];
}

/// The TypeScript module of the device requests.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "device",
    doc: "The device requests: list, link, rename, revoke, forget, push address, notification \
          switches, and the desktop's control-plane calls through the background service.",
    definitions: &[
        Definition::read::<MachineEntry>(),
        Definition::read::<DeviceEntry>(),
        Definition::read::<PasskeyEntry>(),
        Definition::read::<DeviceListRequest>(),
        Definition::read::<DeviceListSnapshot>(),
        Definition::read::<DeviceStatementEvent>(),
        Definition::read::<DeviceListRowEvent>(),
        Definition::read::<DeviceListEvent>().checked(),
        Definition::read::<DeviceLinkStartRequest>(),
        Definition::read::<DeviceLinkStartResponse>(),
        Definition::read::<TrustedMachineKey>(),
        Definition::read::<DeviceLinkRedeemResponse>(),
        Definition::read::<DeviceLinkRequest>(),
        Definition::read::<DeviceLinkCancelRequest>(),
        Definition::read::<DeviceRenameRequest>(),
        Definition::read::<DeviceRevokeRequest>(),
        Definition::read::<DeviceForgetRequest>(),
        Definition::read::<DeviceStatementListRequest>(),
        Definition::read::<DeviceStatementListResponse>(),
        Definition::read::<DeviceStatementApplyRequest>(),
        Definition::read::<DeviceTrustedListRequest>(),
        Definition::read::<TrustedDevice>(),
        Definition::read::<DeviceTrustedListResponse>(),
        Definition::read::<ControlPlaneCallResponse>(),
        Definition::read::<PushPlatform>(),
        Definition::read::<WebPushKeys>(),
        Definition::read::<ControlPlaneCallProcedure>(),
        Definition::read::<ControlPlaneCallRequest>().checked(),
        Definition::read::<DeviceLinkRedeemRequest>().checked(),
        Definition::read::<DeviceNotificationSettingsSetRequest>().checked(),
        Definition::read::<DevicePushAddressSetRequest>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[
        &DEVICE_CONTROL_PLANE_METHOD_DESCRIPTORS,
        &DEVICE_METHOD_DESCRIPTORS,
        &CONTROL_PLANE_METHOD_DESCRIPTORS,
    ],
};
