//! The push contract: a machine hands the control plane one sealed notice for one of the person's
//! devices, and the control plane delivers it through the person's own APNs or VAPID
//! credentials. The machine seals every notice to the device's own push key before it leaves, so
//! the control plane and the push services carry bytes they cannot open, and the control plane
//! stores nothing about a notice.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::VariantArray;

use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::trust_statement::DeviceId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::base64::Base64Bytes;
use crate::wire::instant::WireInstant;
use crate::wire::text::pattern_text;

ts_constants! {
    /// The most sealed bytes one push carries: every platform's 4 KB payload limit.
    pub const PUSH_SEALED_NOTICE_MAX_BYTES: usize = 4096;
    /// Every [`PushUrgency`].
    PUSH_URGENCIES = PushUrgency::VARIANTS;
}

/// How soon the push service delivers a notice: `Waiting on you` and a workflow's Notify step go
/// at `high`; `Finished` and `Failed` at `normal`.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, VariantArray,
)]
#[serde(rename_all = "lowercase")]
pub enum PushUrgency {
    /// Delivered at once.
    High,
    /// Delivered when the device is ready.
    Normal,
}

pattern_text! {
    /// The id a later notice for the same moment replaces an earlier one under: 1 to 32 base64url
    /// characters, which fits Web Push's `Topic` header, the tightest of the three platforms.
    pub struct PushCollapseId("^[A-Za-z0-9_-]{1,32}$");
}

/// One sealed push. Every push expires 24 hours after its moment.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PushSendRequest {
    /// The device the notice is for.
    pub device_id: DeviceId,
    /// The notice, sealed to the device's push key.
    pub sealed: Base64Bytes<PUSH_SEALED_NOTICE_MAX_BYTES>,
    /// Derived from the moment's stable id.
    pub collapse_id: PushCollapseId,
    /// How soon to deliver it.
    pub urgency: PushUrgency,
    /// When the push services drop it undelivered.
    #[garde(dive)]
    pub expires_at: WireInstant,
}

methods! {
    /// The push procedure the control plane serves.
    pub const PUSH_METHOD_DESCRIPTORS = [
        /// Delivers one sealed notice to one of the person's devices.
        PushSend = mutation "push.send" {
            mutating: true,
            params: PushSendRequest,
            result: EmptyPayload,
            refusals: [],
        },
    ];
}

/// The TypeScript module of the push contract.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "push",
    doc: "The push contract: a machine hands the control plane one sealed notice for one of the \
          person's devices, sealed to the device's own push key.",
    definitions: &[
        Definition::read::<PushUrgency>(),
        Definition::read::<PushCollapseId>(),
        Definition::read::<PushSendRequest>(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[&PUSH_METHOD_DESCRIPTORS],
};
