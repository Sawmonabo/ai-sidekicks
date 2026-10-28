//! The account's trust, as every machine verifies it: the identity and channel keys, who signed,
//! and the append-only chain of signed statements the control plane keeps and serves. Trust is the
//! chain, not the control plane: every machine checks each statement itself and trusts a key only
//! when a path of statements reaches it from its own machine key.

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use strum::VariantArray;

use crate::machine::id::MachineId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::base64::{Base64Array, Base64Text, Base64UrlText};
use crate::wire::instant::WireInstant;
use crate::wire::list::BoundedVec;
use crate::wire::text::{FreeFormText, NON_BLANK_NUL_FREE_PATTERN, pattern_text};
use crate::wire::{self, literal};

ts_constants! {
    /// The longest name a machine or a device carries: the one name every other device shows.
    pub const MACHINE_OR_DEVICE_NAME_MAX_LEN: usize = 256;
    /// The longest platform description, such as `iPhone`, `Chrome on Windows` or `macOS 15.6`.
    pub const PLATFORM_DESCRIPTION_MAX_LEN: usize = 128;
    /// `WebAuthn` caps a credential id at 1,023 bytes, which is 1,364 base64url characters.
    pub const PASSKEY_ID_MAX_LEN: usize = 1364;
    /// The longest device id any wire member carries.
    pub const DEVICE_ID_MAX_LEN: usize = 256;
    /// The algorithms an identity key may use: a phone's Secure Enclave holds only P-256, and a
    /// machine's service key is Ed25519, so every public key carries its tag.
    IDENTITY_KEY_ALGORITHMS = IdentityKeyAlgorithm::VARIANTS;
    /// The kinds of statement in the account's chain, each a fact named subject first and past
    /// tense; the event that announces a statement carries its kind as its name.
    TRUST_STATEMENT_KINDS = TrustStatementKind::VARIANTS;
}

/// The longest encoded signature, `WebAuthn` assertion part or linking proof.
const SIGNATURE_PART_MAX_LEN: usize = 4096;

/// A passkey's `WebAuthn` credential id, base64url as the platform hands it over.
pub type PasskeyId = Base64UrlText<1, PASSKEY_ID_MAX_LEN>;

/// A device's or a machine's name.
pub type TrustName = FreeFormText<MACHINE_OR_DEVICE_NAME_MAX_LEN>;

/// A platform description.
pub type PlatformDescription = FreeFormText<PLATFORM_DESCRIPTION_MAX_LEN>;

pattern_text! {
    /// The id of one of the person's devices: a phone or browser the control plane registers, or
    /// a machine, whose own id is the device of every local connection to its service. Opaque to
    /// every client; not blank, no NUL, and at most `DEVICE_ID_MAX_LEN` code points.
    pub struct DeviceId(NON_BLANK_NUL_FREE_PATTERN, max = DEVICE_ID_MAX_LEN) branded;

    /// The SHA-256 of a statement's canonical bytes (RFC 8785), as 64 lowercase hex characters.
    /// The chain names each statement's predecessor by it, and a channel open exchanges the newest
    /// one as the chain head.
    pub struct TrustStatementHash("^[0-9a-f]{64}$");
}

/// One identity-key algorithm.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, VariantArray,
)]
#[serde(rename_all = "camelCase")]
pub enum IdentityKeyAlgorithm {
    /// NIST P-256, the only curve a phone's Secure Enclave holds.
    P256,
    /// Ed25519, a machine's service key.
    Ed25519,
}

/// The public half of a machine's or a device's identity key, standard base64: an
/// Ed25519 key is 32 bytes, a P-256 key its 65-byte uncompressed point.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "algorithm",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum IdentityPublicKey {
    /// A P-256 key, as `WebCrypto`'s raw export gives it.
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

/// A machine's identity key: the service's Ed25519 key, which signs the machine's statements and
/// certifies its channel key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "algorithm",
    rename_all = "camelCase",
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
    rename_all = "camelCase",
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

/// A COSE algorithm a passkey signs with: `EdDSA`, ES256 or RS256, on the wire as its COSE number.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, VariantArray)]
pub enum CoseAlgorithm {
    /// `EdDSA` over Ed25519, COSE -8.
    EdDsa,
    /// ECDSA over P-256 with SHA-256, COSE -7.
    Es256,
    /// RSASSA-PKCS1-v1_5 with SHA-256, COSE -257.
    Rs256,
}

impl CoseAlgorithm {
    /// The algorithm's COSE number.
    pub const fn number(self) -> i64 {
        match self {
            Self::EdDsa => -8,
            Self::Es256 => -7,
            Self::Rs256 => -257,
        }
    }

    /// The algorithm with COSE number `number`, or `None` for one a passkey here does not use.
    pub fn from_number(number: i64) -> Option<Self> {
        Self::VARIANTS
            .iter()
            .copied()
            .find(|algorithm| algorithm.number() == number)
    }
}

impl Serialize for CoseAlgorithm {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_i64(self.number())
    }
}

impl<'de> Deserialize<'de> for CoseAlgorithm {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let number = i64::deserialize(deserializer)?;
        Self::from_number(number)
            .ok_or_else(|| D::Error::custom("a COSE algorithm other than -8, -7 or -257"))
    }
}

impl JsonSchema for CoseAlgorithm {
    fn schema_name() -> Cow<'static, str> {
        "CoseAlgorithm".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        let numbers: Vec<i64> = Self::VARIANTS
            .iter()
            .map(|algorithm| algorithm.number())
            .collect();
        json_schema!({
            "description": "A COSE algorithm a passkey signs with: EdDSA (-8), ES256 (-7) or RS256 \
                            (-257).",
            "type": "integer",
            "enum": numbers,
        })
    }
}

/// A passkey's public key as its authenticator made it: the COSE key, base64url, and its
/// algorithm, which the machines' verifier reads.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PasskeyPublicKey {
    /// The key's COSE algorithm.
    pub cose_algorithm: CoseAlgorithm,
    /// The COSE key's bytes.
    pub cose_key: Base64UrlText<1, SIGNATURE_PART_MAX_LEN>,
}

/// The 32-byte nonce a passkey-signed statement's challenge was made from, base64url: the
/// challenge is SHA-256 of the nonce and the statement's hash.
pub type ChallengeNonce = Base64UrlText<43, 43>;

/// The key behind a statement or an entry: a device's, a machine's or a passkey's.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "signer",
    rename_all = "camelCase",
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
    Machine {
        /// The machine.
        machine_id: MachineId,
    },
    /// A passkey.
    Passkey {
        /// The passkey's credential id.
        passkey_id: PasskeyId,
    },
}

/// One signature over a statement's canonical bytes without its `signatures`. A device or machine
/// key signs directly; a passkey signs through a `WebAuthn` assertion, whose three parts arrive
/// base64url as the platform returns them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "signer",
    rename_all = "camelCase",
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
    Machine {
        /// The machine.
        machine_id: MachineId,
        /// The signature, standard base64.
        signature: Base64Text<1, SIGNATURE_PART_MAX_LEN>,
    },
    /// A passkey's `WebAuthn` assertion.
    Passkey {
        /// The passkey's credential id.
        passkey_id: PasskeyId,
        /// The assertion's authenticator data.
        authenticator_data: Base64UrlText<1, SIGNATURE_PART_MAX_LEN>,
        /// The assertion's client data.
        client_data_json: Base64UrlText<1, SIGNATURE_PART_MAX_LEN>,
        /// The assertion's signature.
        signature: Base64UrlText<1, SIGNATURE_PART_MAX_LEN>,
        /// The nonce the assertion's challenge was made from with the statement's hash.
        challenge_nonce: ChallengeNonce,
    },
}

/// Declares the statements of the account's chain from one table: [`TrustStatementKind`], each
/// statement's own type with its kind as a literal, and [`TrustStatement`], told apart by `kind`,
/// so each kind is spelled once. Every statement carries the hash of the one before it, when it
/// was signed and at least one signature, then its own members.
macro_rules! statements {
    ($(
        $(#[doc = $doc:literal])+
        $arm:ident = $kind:literal {
            statement: $name:ident,
            kind: $kind_type:ident,
            $(#[$previous_hash_attribute:meta])*
            previous_hash: $previous_hash:ty,
            $($(#[doc = $member_doc:literal])+ $member:ident: $member_type:ty,)*
        }
    )+) => {
        /// One statement kind.
        #[derive(
            Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema,
            VariantArray,
        )]
        pub enum TrustStatementKind {$(
            $(#[doc = $doc])+
            #[serde(rename = $kind)]
            $arm,
        )+}

        $(
            const _: () = assert!(
                crate::wire::name::is_wire_name($kind),
                concat!("not a wire name: ", $kind),
            );

            literal! {
                /// The kind one statement carries.
                pub enum $kind_type = $kind;
            }

            $(#[doc = $doc])+
            #[derive(
                Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate,
            )]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            #[garde(allow_unvalidated)]
            pub struct $name {
                /// The statement's kind.
                pub kind: $kind_type,
                /// The hash of the statement before this one.
                $(#[$previous_hash_attribute])*
                pub previous_hash: $previous_hash,
                /// When the statement was signed.
                #[garde(dive)]
                pub issued_at: WireInstant,
                /// The signatures over the statement's canonical bytes without this member.
                pub signatures: BoundedVec<TrustStatementSignature, 1, { usize::MAX }>,
                $($(#[doc = $member_doc])+ pub $member: $member_type,)*
            }
        )+

        /// One statement of the account's chain, told apart by its `kind`.
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
        #[serde(tag = "kind", rename_all_fields = "camelCase", deny_unknown_fields)]
        #[garde(allow_unvalidated)]
        pub enum TrustStatement {$(
            $(#[doc = $doc])+
            #[serde(rename = $kind)]
            $arm {
                /// The hash of the statement before this one.
                $(#[$previous_hash_attribute])*
                previous_hash: $previous_hash,
                /// When the statement was signed.
                #[garde(dive)]
                issued_at: WireInstant,
                /// The signatures over the statement's canonical bytes without this member.
                signatures: BoundedVec<TrustStatementSignature, 1, { usize::MAX }>,
                $($(#[doc = $member_doc])+ $member: $member_type,)*
            },
        )+}

        impl TrustStatement {
            /// The statement's kind.
            pub const fn kind(&self) -> TrustStatementKind {
                match self {
                    $(Self::$arm { .. } => TrustStatementKind::$arm,)+
                }
            }
        }
    };
}

statements! {
    /// A device joins: its identity key, its channel key, its name and its platform.
    DeviceLinked = "device.linked" {
        statement: DeviceLinkedStatement,
        kind: DeviceLinkedKind,
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
    DeviceRenamed = "device.renamed" {
        statement: DeviceRenamedStatement,
        kind: DeviceRenamedKind,
        previous_hash: TrustStatementHash,
        /// The device.
        device_id: DeviceId,
        /// The device's new name.
        name: TrustName,
    }
    /// A device's key ends here; what it signed before stands.
    DeviceRevoked = "device.revoked" {
        statement: DeviceRevokedStatement,
        kind: DeviceRevokedKind,
        previous_hash: TrustStatementHash,
        /// The device.
        device_id: DeviceId,
    }
    /// A passkey joins, with the platform that holds it.
    AccountPasskeyAdded = "account.passkey.added" {
        statement: AccountPasskeyAddedStatement,
        kind: AccountPasskeyAddedKind,
        previous_hash: TrustStatementHash,
        /// The passkey's credential id.
        passkey_id: PasskeyId,
        /// The passkey's public key.
        public_key: PasskeyPublicKey,
        /// The platform that holds the passkey.
        platform: PlatformDescription,
    }
    /// A passkey's key ends here.
    AccountPasskeyRemoved = "account.passkey.removed" {
        statement: AccountPasskeyRemovedStatement,
        kind: AccountPasskeyRemovedKind,
        previous_hash: TrustStatementHash,
        /// The passkey's credential id.
        passkey_id: PasskeyId,
    }
    /// A machine joins, or a removed machine comes back under its same id with a new key. The
    /// person's first machine opens the chain with this statement, so here alone `previousHash`
    /// is `null`; the key is still required.
    MachineAdded = "machine.added" {
        statement: MachineAddedStatement,
        kind: MachineAddedKind,
        #[serde(deserialize_with = "wire::nullable")]
        #[schemars(with = "wire::NullableSchema<TrustStatementHash>")]
        previous_hash: Option<TrustStatementHash>,
        /// The machine.
        machine_id: MachineId,
        /// The machine's identity key.
        identity_key: MachineIdentityKey,
        /// The machine's channel key.
        channel_key: ChannelPublicKey,
        /// The machine's one name.
        name: TrustName,
    }
    /// A machine's one name changes.
    MachineRenamed = "machine.renamed" {
        statement: MachineRenamedStatement,
        kind: MachineRenamedKind,
        previous_hash: TrustStatementHash,
        /// The machine.
        machine_id: MachineId,
        /// The machine's new name.
        name: TrustName,
    }
    /// A machine's key ends here; its store, sessions and id stay.
    MachineRemoved = "machine.removed" {
        statement: MachineRemovedStatement,
        kind: MachineRemovedKind,
        previous_hash: TrustStatementHash,
        /// The machine.
        machine_id: MachineId,
    }
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
        Definition::read::<CoseAlgorithm>(),
        Definition::read::<PasskeyPublicKey>().checked(),
        Definition::read::<TrustSigner>(),
        Definition::read::<TrustStatementSignature>().checked(),
        Definition::read::<TrustStatementKind>(),
        Definition::read::<DeviceLinkedStatement>(),
        Definition::read::<DeviceRenamedStatement>().checked(),
        Definition::read::<DeviceRevokedStatement>(),
        Definition::read::<AccountPasskeyAddedStatement>(),
        Definition::read::<AccountPasskeyRemovedStatement>(),
        Definition::read::<MachineAddedStatement>(),
        Definition::read::<MachineRenamedStatement>(),
        Definition::read::<MachineRemovedStatement>(),
        Definition::read::<TrustStatement>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::{Value, json};

    use super::{MachineAddedStatement, TrustStatement};

    /// A chain-opening `machine.added` statement, with `previousHash` set to `previous_hash`
    /// or left out when it is `None`.
    fn opening_statement(previous_hash: Option<Value>) -> Value {
        let mut statement = json!({
            "kind": "machine.added",
            "issuedAt": "2026-01-01T00:00:00.000Z",
            "signatures": [{ "signer": "machine", "machineId": "machine-1", "signature": "AAAA" }],
            "machineId": "machine-1",
            "identityKey": {
                "algorithm": "ed25519",
                "publicKey": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            },
            "channelKey": {
                "algorithm": "x25519",
                "publicKey": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            },
            "name": "Studio",
        });
        if let (Some(previous_hash), Value::Object(members)) = (previous_hash, &mut statement) {
            members.insert("previousHash".to_owned(), previous_hash);
        }
        statement
    }

    #[rstest]
    #[case::null(Some(Value::Null), true)]
    #[case::hash(Some(json!("0".repeat(64))), true)]
    #[case::missing(None, false)]
    fn the_chain_opening_statement_requires_its_previous_hash_key(
        #[case] previous_hash: Option<Value>,
        #[case] is_read: bool,
    ) {
        let statement = opening_statement(previous_hash);
        let standalone = serde_json::from_value::<MachineAddedStatement>(statement.clone());
        assert_eq!(standalone.is_ok(), is_read, "standalone: {standalone:?}");
        let in_chain = serde_json::from_value::<TrustStatement>(statement.clone());
        assert_eq!(in_chain.is_ok(), is_read, "in the chain: {in_chain:?}");
        if let Ok(read) = in_chain {
            let written = serde_json::to_value(read).expect("the statement writes");
            assert_eq!(written, statement, "the statement writes back unchanged");
        }
    }
}
