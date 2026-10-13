//! The account's trust, as every machine verifies it: the identity and channel keys, who signed,
//! and the append-only chain of signed statements the control plane keeps and serves. Trust is the
//! chain, not the control plane: every machine checks each statement itself and trusts a key only
//! when a path of statements reaches it from its own machine key.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::runtime_node::id::NodeId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::base64::{Base64Array, Base64Text, Base64UrlText};
use crate::wire::instant::WireInstant;
use crate::wire::list::BoundedVec;
use crate::wire::text::{FreeFormText, branded_text, pattern_text};
use crate::wire::{self, literal};

ts_constants! {
    /// The longest name a machine or a device carries: the one name every other device shows.
    pub const MACHINE_OR_DEVICE_NAME_MAX_LEN: usize = 256;
    /// The longest platform description, such as `iPhone`, `Chrome on Windows` or `macOS 15.6`.
    pub const PLATFORM_DESCRIPTION_MAX_LEN: usize = 128;
    /// WebAuthn caps a credential id at 1,023 bytes, which is 1,364 base64url characters.
    pub const PASSKEY_ID_MAX_LEN: usize = 1364;
    /// The longest device id any wire member carries.
    pub const DEVICE_ID_MAX_LEN: usize = 256;
    /// The algorithms an identity key may use: a phone's Secure Enclave holds only P-256, and a
    /// machine's service key is Ed25519, so every public key carries its tag.
    IDENTITY_KEY_ALGORITHMS = [IdentityKeyAlgorithm::P256, IdentityKeyAlgorithm::Ed25519];
    /// The kinds of statement in the account's chain, each a fact named subject first and past
    /// tense; the event that announces a statement carries its kind as its name.
    TRUST_STATEMENT_KINDS = TrustStatementKind::ALL;
}

/// The longest encoded signature, WebAuthn assertion part or linking proof.
const SIGNATURE_PART_MAX_LEN: usize = 4096;

/// A passkey's WebAuthn credential id, base64url as the platform hands it over.
pub type PasskeyId = Base64UrlText<1, PASSKEY_ID_MAX_LEN>;

/// A device's or a machine's name.
pub type TrustName = FreeFormText<MACHINE_OR_DEVICE_NAME_MAX_LEN>;

/// A platform description.
pub type PlatformDescription = FreeFormText<PLATFORM_DESCRIPTION_MAX_LEN>;

branded_text! {
    /// The id of one of the person's devices: a phone or browser the control plane registers, or
    /// a machine, whose own id is the device of every local connection to its service. Opaque to
    /// every client.
    pub struct DeviceId(1..=DEVICE_ID_MAX_LEN);
}

pattern_text! {
    /// The SHA-256 of a statement's canonical bytes (RFC 8785), as 64 lowercase hex characters.
    /// The chain names each statement's predecessor by it, and a channel open exchanges the newest
    /// one as the chain head.
    pub struct TrustStatementHash("^[0-9a-f]{64}$");
}

/// One identity-key algorithm.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum IdentityKeyAlgorithm {
    /// NIST P-256, the only curve a phone's Secure Enclave holds.
    P256,
    /// Ed25519, a machine's service key.
    Ed25519,
}

/// The public half of a machine's, a device's or a passkey's identity key, standard base64: an
/// Ed25519 key is 32 bytes, a P-256 key its 65-byte uncompressed point.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "algorithm",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum IdentityPublicKey {
    /// A P-256 key, as WebCrypto's raw export gives it.
    P256 {
        /// The 65-byte uncompressed point.
        public_key: Base64Array<65>,
    },
    /// An Ed25519 key.
    Ed25519 {
        /// The 32-byte key.
        public_key: Base64Array<32>,
    },
}

/// A machine's identity key: the service's Ed25519 key, the one key a machine has.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "algorithm",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MachineIdentityKey {
    /// An Ed25519 key.
    Ed25519 {
        /// The 32-byte key.
        public_key: Base64Array<32>,
    },
}

/// The public half of the X25519 key a machine or device runs its encrypted channel with, 32
/// bytes in standard base64. The identity key certifies it in the statement that trusts that
/// identity, so the chain stays the one record of trust.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "algorithm",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ChannelPublicKey {
    /// An X25519 key.
    X25519 {
        /// The 32-byte key.
        public_key: Base64Array<32>,
    },
}

/// The key behind a statement or an entry: a device's, a machine's or a passkey's.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "signer",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum TrustSigner {
    /// A device's key.
    Device {
        /// The device.
        device_id: DeviceId,
    },
    /// A machine's key.
    RuntimeNode {
        /// The machine.
        node_id: NodeId,
    },
    /// A passkey.
    Passkey {
        /// The passkey's credential id.
        passkey_id: PasskeyId,
    },
}

/// One signature over a statement's canonical bytes without its `signatures`. A device or machine
/// key signs directly; a passkey signs through a WebAuthn assertion, whose three parts arrive
/// base64url as the platform returns them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "signer",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum TrustStatementSignature {
    /// A device key's signature.
    Device {
        /// The device.
        device_id: DeviceId,
        /// The signature, standard base64.
        signature: Base64Text<1, SIGNATURE_PART_MAX_LEN>,
    },
    /// A machine key's signature.
    RuntimeNode {
        /// The machine.
        node_id: NodeId,
        /// The signature, standard base64.
        signature: Base64Text<1, SIGNATURE_PART_MAX_LEN>,
    },
    /// A passkey's WebAuthn assertion.
    Passkey {
        /// The passkey's credential id.
        passkey_id: PasskeyId,
        /// The assertion's authenticator data.
        authenticator_data: Base64UrlText<1, SIGNATURE_PART_MAX_LEN>,
        /// The assertion's client data.
        client_data_json: Base64UrlText<1, SIGNATURE_PART_MAX_LEN>,
        /// The assertion's signature.
        signature: Base64UrlText<1, SIGNATURE_PART_MAX_LEN>,
    },
}

/// One statement kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
pub enum TrustStatementKind {
    /// A device joins.
    #[serde(rename = "device.linked")]
    DeviceLinked,
    /// A device's name changes.
    #[serde(rename = "device.renamed")]
    DeviceRenamed,
    /// A device's key ends.
    #[serde(rename = "device.revoked")]
    DeviceRevoked,
    /// A passkey joins.
    #[serde(rename = "passkey.added")]
    PasskeyAdded,
    /// A passkey's key ends.
    #[serde(rename = "passkey.removed")]
    PasskeyRemoved,
    /// A machine joins, or comes back under its id with a new key.
    #[serde(rename = "runtimenode.added")]
    RuntimeNodeAdded,
    /// A machine's name changes.
    #[serde(rename = "runtimenode.renamed")]
    RuntimeNodeRenamed,
    /// A machine's key ends.
    #[serde(rename = "runtimenode.removed")]
    RuntimeNodeRemoved,
}

impl TrustStatementKind {
    /// Every kind, in the order TypeScript lists them.
    pub const ALL: [Self; 8] = [
        Self::DeviceLinked,
        Self::DeviceRenamed,
        Self::DeviceRevoked,
        Self::PasskeyAdded,
        Self::PasskeyRemoved,
        Self::RuntimeNodeAdded,
        Self::RuntimeNodeRenamed,
        Self::RuntimeNodeRemoved,
    ];
}

literal! {
    /// The kind of a [`DeviceLinkedStatement`].
    pub enum DeviceLinkedKind = "device.linked";
    /// The kind of a [`DeviceRenamedStatement`].
    pub enum DeviceRenamedKind = "device.renamed";
    /// The kind of a [`DeviceRevokedStatement`].
    pub enum DeviceRevokedKind = "device.revoked";
    /// The kind of a [`PasskeyAddedStatement`].
    pub enum PasskeyAddedKind = "passkey.added";
    /// The kind of a [`PasskeyRemovedStatement`].
    pub enum PasskeyRemovedKind = "passkey.removed";
    /// The kind of a [`RuntimeNodeAddedStatement`].
    pub enum RuntimeNodeAddedKind = "runtimenode.added";
    /// The kind of a [`RuntimeNodeRenamedStatement`].
    pub enum RuntimeNodeRenamedKind = "runtimenode.renamed";
    /// The kind of a [`RuntimeNodeRemovedStatement`].
    pub enum RuntimeNodeRemovedKind = "runtimenode.removed";
}

/// Declares one statement: its kind, the members every statement carries (the hash of the one
/// before it, when it was signed and at least one signature), then its own.
macro_rules! statement {
    ($(
        $(#[doc = $doc:literal])+
        pub struct $name:ident: $kind:ty {
            previous_hash: $previous_hash:ty,
            $($(#[doc = $member_doc:literal])+ $member:ident: $member_type:ty,)*
        }
    )+) => {$(
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[garde(allow_unvalidated)]
        pub struct $name {
            /// The statement's kind.
            pub kind: $kind,
            /// The hash of the statement before this one.
            pub previous_hash: $previous_hash,
            /// When the statement was signed.
            #[garde(dive)]
            pub issued_at: WireInstant,
            /// The signatures over the statement's canonical bytes without this member.
            pub signatures: BoundedVec<TrustStatementSignature, 1, { usize::MAX }>,
            $($(#[doc = $member_doc])+ pub $member: $member_type,)*
        }
    )+};
}

statement! {
    /// A device joins: its identity key, its channel key, its name and its platform.
    pub struct DeviceLinkedStatement: DeviceLinkedKind {
        previous_hash: TrustStatementHash,
        /// The device.
        device_id: DeviceId,
        /// The device's identity key.
        identity_key: IdentityPublicKey,
        /// The device's channel key.
        channel_key: ChannelPublicKey,
        /// The device's one name.
        name: TrustName,
        /// The device's platform.
        platform: PlatformDescription,
    }
    /// A device's one name changes.
    pub struct DeviceRenamedStatement: DeviceRenamedKind {
        previous_hash: TrustStatementHash,
        /// The device.
        device_id: DeviceId,
        /// The device's new name.
        name: TrustName,
    }
    /// A device's key ends here; what it signed before stands.
    pub struct DeviceRevokedStatement: DeviceRevokedKind {
        previous_hash: TrustStatementHash,
        /// The device.
        device_id: DeviceId,
    }
    /// A passkey joins, with the platform that holds it.
    pub struct PasskeyAddedStatement: PasskeyAddedKind {
        previous_hash: TrustStatementHash,
        /// The passkey's credential id.
        passkey_id: PasskeyId,
        /// The passkey's public key.
        public_key: IdentityPublicKey,
        /// The platform that holds the passkey.
        platform: PlatformDescription,
    }
    /// A passkey's key ends here.
    pub struct PasskeyRemovedStatement: PasskeyRemovedKind {
        previous_hash: TrustStatementHash,
        /// The passkey's credential id.
        passkey_id: PasskeyId,
    }
    /// A machine joins, or a removed machine comes back under its same id with a new key. The
    /// person's first machine opens the chain with this statement, so here alone `previousHash`
    /// is `null`.
    pub struct RuntimeNodeAddedStatement: RuntimeNodeAddedKind {
        previous_hash: NullableHash,
        /// The machine.
        node_id: NodeId,
        /// The machine's identity key.
        identity_key: MachineIdentityKey,
        /// The machine's channel key.
        channel_key: ChannelPublicKey,
        /// The machine's one name.
        name: TrustName,
    }
    /// A machine's one name changes.
    pub struct RuntimeNodeRenamedStatement: RuntimeNodeRenamedKind {
        previous_hash: TrustStatementHash,
        /// The machine.
        node_id: NodeId,
        /// The machine's new name.
        name: TrustName,
    }
    /// A machine's key ends here; its store, sessions and id stay.
    pub struct RuntimeNodeRemovedStatement: RuntimeNodeRemovedKind {
        previous_hash: TrustStatementHash,
        /// The machine.
        node_id: NodeId,
    }
}

/// The predecessor of the chain's first statement: a hash, or `null` where the chain opens.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(transparent)]
pub struct NullableHash(
    #[serde(deserialize_with = "wire::nullable")]
    #[schemars(with = "wire::NullableSchema<TrustStatementHash>")]
    pub Option<TrustStatementHash>,
);

/// One statement of the account's chain, told apart by its `kind`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
pub enum TrustStatement {
    /// A device joins.
    DeviceLinked(#[garde(dive)] DeviceLinkedStatement),
    /// A device's name changes.
    DeviceRenamed(#[garde(dive)] DeviceRenamedStatement),
    /// A device's key ends.
    DeviceRevoked(#[garde(dive)] DeviceRevokedStatement),
    /// A passkey joins.
    PasskeyAdded(#[garde(dive)] PasskeyAddedStatement),
    /// A passkey's key ends.
    PasskeyRemoved(#[garde(dive)] PasskeyRemovedStatement),
    /// A machine joins.
    RuntimeNodeAdded(#[garde(dive)] RuntimeNodeAddedStatement),
    /// A machine's name changes.
    RuntimeNodeRenamed(#[garde(dive)] RuntimeNodeRenamedStatement),
    /// A machine's key ends.
    RuntimeNodeRemoved(#[garde(dive)] RuntimeNodeRemovedStatement),
}

/// The TypeScript module of the trust chain's types.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "trust-statement",
    doc: "The account's trust, as every machine verifies it: the identity and channel keys, who \
          signed, and the append-only chain of signed statements the control plane keeps and \
          serves.\n\nTrust is the chain, not the control plane. Every machine checks each \
          statement itself and trusts a key only when a path of statements reaches it from its \
          own machine key, so every request that changes who is trusted carries a statement \
          signed by one of the person's own keys rather than asking the control plane to decide.",
    definitions: &[
        Definition::read::<DeviceId>().checked(),
        Definition::read::<TrustStatementHash>().checked(),
        Definition::read::<IdentityKeyAlgorithm>(),
        Definition::read::<IdentityPublicKey>().checked(),
        Definition::read::<MachineIdentityKey>().checked(),
        Definition::read::<ChannelPublicKey>().checked(),
        Definition::read::<TrustSigner>(),
        Definition::read::<TrustStatementSignature>().checked(),
        Definition::read::<TrustStatementKind>(),
        Definition::read::<DeviceLinkedStatement>(),
        Definition::read::<DeviceRenamedStatement>().checked(),
        Definition::read::<DeviceRevokedStatement>(),
        Definition::read::<PasskeyAddedStatement>(),
        Definition::read::<PasskeyRemovedStatement>(),
        Definition::read::<RuntimeNodeAddedStatement>(),
        Definition::read::<RuntimeNodeRenamedStatement>(),
        Definition::read::<RuntimeNodeRemovedStatement>(),
        Definition::read::<NullableHash>(),
        Definition::read::<TrustStatement>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
