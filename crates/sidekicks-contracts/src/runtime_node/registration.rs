//! A machine's registration with the control plane, and the requests that rename it, remove it and
//! write the DNS challenge record for its wildcard certificate. The registration is only the
//! control plane's admission record; trust is the statement chain's, so rename and remove each
//! carry the statement a trusted key signed.

use std::borrow::Cow;
use std::sync::LazyLock;

use regex::Regex;
use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};

use crate::device::APP_VERSION_MAX_LEN;
use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::runtime_node::id::NodeId;
use crate::trust_statement::{
    MACHINE_OR_DEVICE_NAME_MAX_LEN, MachineIdentityKey, PLATFORM_DESCRIPTION_MAX_LEN,
    RuntimeNodeRemovedStatement, RuntimeNodeRenamedStatement,
};
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::text::FreeFormText;

/// The longest DNS name, per RFC 1035.
const DNS_NAME_MAX_LEN: usize = 253;

/// A challenge record's name: `_acme-challenge.` and then a lower-case domain of two labels or
/// more. Rust's `regex` and ECMAScript read it alike.
const CHALLENGE_NAME_PATTERN: &str = "^_acme-challenge\\.\
                                      (?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+\
                                      [a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$";

/// A challenge record's value: the 43 base64url characters of a SHA-256 digest.
const CHALLENGE_VALUE_PATTERN: &str = "^[A-Za-z0-9_-]{43}$";

/// [`CHALLENGE_NAME_PATTERN`], compiled once.
static CHALLENGE_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(CHALLENGE_NAME_PATTERN).expect("the challenge name pattern is a valid regex")
});

/// [`CHALLENGE_VALUE_PATTERN`], compiled once.
static CHALLENGE_VALUE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(CHALLENGE_VALUE_PATTERN).expect("the challenge value pattern is a valid regex")
});

/// The service's registration at each start: the machine's id, identity key, own name, platform
/// and the service's version. The control plane accepts it only for the key enrolled at sign-in,
/// and refreshes that machine's row.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeNodeRegisterRequest {
    /// The machine.
    pub node_id: NodeId,
    /// The machine's identity key.
    pub identity_key: MachineIdentityKey,
    /// The machine's own name.
    pub name: FreeFormText<MACHINE_OR_DEVICE_NAME_MAX_LEN>,
    /// The machine's platform, such as `macOS 15.6`.
    pub platform: FreeFormText<PLATFORM_DESCRIPTION_MAX_LEN>,
    /// The service's version.
    pub service_version: FreeFormText<APP_VERSION_MAX_LEN>,
}

/// A rename, as the `runtimenode.renamed` statement a trusted key signs.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeNodeRenameRequest {
    /// The signed statement.
    pub statement: RuntimeNodeRenamedStatement,
}

/// A removal, as the `runtimenode.removed` statement a trusted key signs. The machine comes back
/// only by being linked again, under a new identity key and its same id.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeNodeRemoveRequest {
    /// The signed statement.
    pub statement: RuntimeNodeRemovedStatement,
}

/// A challenge record's name, `_acme-challenge.<domain>`, so the request can never write any other
/// record.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct CertificateChallengeName(String);

impl CertificateChallengeName {
    /// Checks `name`; refuses anything but a challenge name within the DNS name bound.
    pub fn new(name: String) -> Option<Self> {
        (name.chars().count() <= DNS_NAME_MAX_LEN && CHALLENGE_NAME.is_match(&name))
            .then_some(Self(name))
    }

    /// The name.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for CertificateChallengeName {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(String::deserialize(deserializer)?)
            .ok_or_else(|| D::Error::custom("a challenge record is named _acme-challenge.<domain>"))
    }
}

impl JsonSchema for CertificateChallengeName {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "CertificateChallengeName".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "string",
            "maxLength": DNS_NAME_MAX_LEN,
            "pattern": CHALLENGE_NAME_PATTERN,
        })
    }
}

/// A challenge record's value: the 43-character base64url SHA-256 digest.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct CertificateChallengeValue(String);

impl CertificateChallengeValue {
    /// Checks `value`; refuses anything but 43 base64url characters.
    pub fn new(value: String) -> Option<Self> {
        CHALLENGE_VALUE.is_match(&value).then_some(Self(value))
    }

    /// The value.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for CertificateChallengeValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(String::deserialize(deserializer)?)
            .ok_or_else(|| D::Error::custom("a challenge value is 43 base64url characters"))
    }
}

impl JsonSchema for CertificateChallengeValue {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "CertificateChallengeValue".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({ "type": "string", "pattern": CHALLENGE_VALUE_PATTERN })
    }
}

/// The TXT record an ACME DNS challenge asks for: its name, under `_acme-challenge.`, and its
/// value. The relay writes it only for a machine that proves its key, and only for the minutes of
/// the challenge.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeNodeCertificateChallengeSetRequest {
    /// The record's name.
    pub name: CertificateChallengeName,
    /// The record's value.
    pub value: CertificateChallengeValue,
}

methods! {
    /// The runtime-node procedures the control plane serves.
    pub const RUNTIMENODE_PROCEDURE_DESCRIPTORS = [
        /// Registers the machine at each start of its service.
        RuntimeNodeRegister = mutation "runtimenode.register" {
            mutating: true,
            params: RuntimeNodeRegisterRequest,
            result: EmptyPayload,
            refusals: [],
        },
        /// Renames the machine.
        RuntimeNodeRename = mutation "runtimenode.rename" {
            mutating: true,
            params: RuntimeNodeRenameRequest,
            result: EmptyPayload,
            refusals: [],
        },
        /// Removes the machine.
        RuntimeNodeRemove = mutation "runtimenode.remove" {
            mutating: true,
            params: RuntimeNodeRemoveRequest,
            result: EmptyPayload,
            refusals: [],
        },
        /// Writes the DNS challenge record for the machine's wildcard certificate.
        RuntimeNodeCertificateChallengeSet = mutation "runtimenode.certificateChallengeSet" {
            mutating: true,
            params: RuntimeNodeCertificateChallengeSetRequest,
            result: EmptyPayload,
            refusals: [],
        },
    ];
}

/// The module's TypeScript face; the control plane, not a TypeScript client, serves these
/// procedures, so no method table is written.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "runtime-node/registration",
    doc: "A machine's registration with the control plane, and the requests that rename it, \
          remove it and write the DNS challenge record for its wildcard certificate.",
    definitions: &[
        Definition::read::<RuntimeNodeRegisterRequest>(),
        Definition::read::<RuntimeNodeRenameRequest>(),
        Definition::read::<RuntimeNodeRemoveRequest>(),
        Definition::read::<RuntimeNodeCertificateChallengeSetRequest>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};
