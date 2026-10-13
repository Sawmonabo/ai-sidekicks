//! The channel's opening frames: the device's profile offer and the machine's answer. A profile is
//! one full Noise protocol name. Both ends put the offer and answer, byte for byte, into the
//! handshake prologue, so a relay that dropped or reordered a profile fails the handshake on both
//! ends rather than settling on another.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::integer::SafeInt;
use crate::wire::list::{BoundedVec, unique_by};
use crate::wire::text::pattern_text;

ts_constants! {
    /// The channel frame format this build speaks.
    pub const CHANNEL_VERSION: u64 = 1;
    /// The profiles this build runs, in order of preference.
    CHANNEL_PROFILES = ChannelProfile::ALL;
}

/// The longest profile: the Noise specification caps a protocol name at 255 bytes.
const NOISE_PROTOCOL_NAME_MAX_LEN: usize = 255;
/// The most profiles an offer names: a device offers only what it runs.
const CHANNEL_OFFER_MAX_PROFILES: usize = 16;

/// One profile this build runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
pub enum ChannelProfile {
    /// Noise KK over X25519, ChaCha20-Poly1305 and SHA-256.
    #[serde(rename = "Noise_KK_25519_ChaChaPoly_SHA256")]
    KkChaChaPolySha256,
}

impl ChannelProfile {
    /// Every profile, in order of preference.
    pub const ALL: &[Self] = &[Self::KkChaChaPolySha256];
}

pattern_text! {
    /// A Noise protocol name, which a device may offer whether or not this build runs it.
    pub struct NoiseProtocolName(
        "^Noise_[A-Za-z0-9+]+_[A-Za-z0-9+]+_[A-Za-z0-9+]+_[A-Za-z0-9+]+$",
        max = NOISE_PROTOCOL_NAME_MAX_LEN
    );
}

/// The connection's first frame: every profile the device runs, in its order of preference, each
/// once. A profile this build does not know is still a valid offer, which an older machine skips.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelOffer {
    /// The channel frame format the device speaks.
    #[garde(skip)]
    pub channel_version: SafeInt<1>,
    /// The profiles, in the device's order of preference.
    #[garde(custom(unique_by(|profile: &NoiseProtocolName| profile.clone())))]
    #[schemars(extend("uniqueItems" = true))]
    pub profiles: BoundedVec<NoiseProtocolName, 1, CHANNEL_OFFER_MAX_PROFILES>,
}

/// The machine's answer: the first offered profile it also runs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ChannelAnswer {
    /// The profile both ends run.
    pub profile: ChannelProfile,
}

/// The TypeScript module of the channel's opening frames.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "channel",
    doc: "The channel's opening frames: the device's profile offer and the machine's answer.",
    definitions: &[
        Definition::read::<ChannelProfile>(),
        Definition::read::<NoiseProtocolName>(),
        Definition::read::<ChannelOffer>(),
        Definition::read::<ChannelAnswer>(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
