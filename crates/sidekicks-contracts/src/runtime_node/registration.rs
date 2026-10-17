//! A machine's registration with the control plane, and the requests that rename it, remove it and
//! write the DNS challenge record for its wildcard certificate. The registration is only the
//! control plane's admission record; trust is the statement chain's, so rename and remove each
//! carry the statement a trusted key signed.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::device::APP_VERSION_MAX_LEN;
use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::runtime_node::id::NodeId;
use crate::trust_statement::{
    MACHINE_OR_DEVICE_NAME_MAX_LEN, MachineIdentityKey, PLATFORM_DESCRIPTION_MAX_LEN,
    RuntimeNodeRemovedStatement, RuntimeNodeRenamedStatement,
};
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::text::{FreeFormText, pattern_text};

/// The longest DNS name, per RFC 1035.
const DNS_NAME_MAX_LEN: usize = 253;

/// The service's registration at each start: the machine's id, identity key, own name, platform
/// and the service's version. The control plane accepts it only for the key enrolled at sign-in,
/// and refreshes that machine's row.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
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

/// A rename, as the `machine.renamed` statement a trusted key signs.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct RuntimeNodeRenameRequest {
    /// The signed statement.
    #[garde(dive)]
    pub statement: RuntimeNodeRenamedStatement,
}

/// A removal, as the `machine.removed` statement a trusted key signs. The machine comes back
/// only by being linked again, under a new identity key and its same id.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct RuntimeNodeRemoveRequest {
    /// The signed statement.
    #[garde(dive)]
    pub statement: RuntimeNodeRemovedStatement,
}

pattern_text! {
    /// A challenge record's name: `_acme-challenge.` and then a lower-case domain of two labels or
    /// more, within the DNS name bound, so the request can never write any other record.
    pub struct CertificateChallengeName(
        "^_acme-challenge\\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+\
         [a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$",
        max = DNS_NAME_MAX_LEN
    );

    /// A challenge record's value: the 43 base64url characters of a SHA-256 digest.
    pub struct CertificateChallengeValue("^[A-Za-z0-9_-]{43}$");
}

/// The TXT record an ACME DNS challenge asks for: its name, under `_acme-challenge.`, and its
/// value. The relay writes it only for a machine that proves its key, and only for the minutes of
/// the challenge.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct RuntimeNodeCertificateChallengeSetRequest {
    /// The record's name.
    pub name: CertificateChallengeName,
    /// The record's value.
    pub value: CertificateChallengeValue,
}

methods! {
    /// The runtime-node procedures the control plane serves.
    pub const RUNTIMENODE_METHOD_DESCRIPTORS = [
        /// Registers the machine at each start of its service.
        RuntimeNodeRegister = mutation "machine.register" {
            mutating: true,
            params: RuntimeNodeRegisterRequest,
            result: EmptyPayload,
            refusals: [RuntimenodePermissionDenied],
        },
        /// Renames the machine.
        RuntimeNodeRename = mutation "machine.rename" {
            mutating: true,
            params: RuntimeNodeRenameRequest,
            result: EmptyPayload,
            refusals: [RuntimenodePermissionDenied],
        },
        /// Removes the machine.
        RuntimeNodeRemove = mutation "machine.remove" {
            mutating: true,
            params: RuntimeNodeRemoveRequest,
            result: EmptyPayload,
            refusals: [RuntimenodePermissionDenied],
        },
        /// Writes the DNS challenge record for the machine's wildcard certificate.
        RuntimeNodeCertificateChallengeSet = mutation "machine.certificateChallenge.update" {
            mutating: true,
            params: RuntimeNodeCertificateChallengeSetRequest,
            result: EmptyPayload,
            refusals: [RuntimenodePermissionDenied],
        },
    ];
}

/// The module's TypeScript face. The daemon sends these requests and the control plane and the
/// relay read them, all in Rust, so no method table is written and no definition is checked.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "runtime-node/registration",
    doc: "A machine's registration with the control plane, and the requests that rename it, \
          remove it and write the DNS challenge record for its wildcard certificate.",
    definitions: &[
        Definition::read::<RuntimeNodeRegisterRequest>(),
        Definition::read::<RuntimeNodeRenameRequest>(),
        Definition::read::<RuntimeNodeRemoveRequest>(),
        Definition::read::<CertificateChallengeName>(),
        Definition::read::<CertificateChallengeValue>(),
        Definition::read::<RuntimeNodeCertificateChallengeSetRequest>(),
    ],
    constants: &[],
    method_tables: &[],
};

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::RuntimeNodeCertificateChallengeSetRequest;

    const DIGEST: &str = "n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg";
    const NAME: &str = "_acme-challenge.machine.example.com";

    /// Three labels of 63 and one of 45 make a name of exactly 253 code points.
    fn name_of_last_label(last_label_len: usize) -> String {
        let labels = ["a".repeat(63), "b".repeat(63), "c".repeat(63)].join(".");
        format!("_acme-challenge.{labels}.{}", "d".repeat(last_label_len))
    }

    #[rstest]
    #[case::challenge_record(NAME.to_owned(), DIGEST.to_owned(), true)]
    #[case::at_the_dns_bound(name_of_last_label(45), DIGEST.to_owned(), true)]
    #[case::past_the_dns_bound(name_of_last_label(46), DIGEST.to_owned(), false)]
    #[case::bare_domain("machine.example.com".to_owned(), DIGEST.to_owned(), false)]
    #[case::one_label("_acme-challenge.localhost".to_owned(), DIGEST.to_owned(), false)]
    #[case::upper_case(NAME.replace('m', "M"), DIGEST.to_owned(), false)]
    #[case::other_record("_dmarc.example.com".to_owned(), DIGEST.to_owned(), false)]
    #[case::prefix_inside(format!("x{NAME}"), DIGEST.to_owned(), false)]
    #[case::trailing_line(format!("{NAME}\n"), DIGEST.to_owned(), false)]
    #[case::label_over_63(NAME.replace("machine", &"a".repeat(64)), DIGEST.to_owned(), false)]
    #[case::hyphen_edge(NAME.replace("machine", "-machine"), DIGEST.to_owned(), false)]
    #[case::short_value(NAME.to_owned(), DIGEST[1..].to_owned(), false)]
    #[case::padded_value(NAME.to_owned(), format!("{}=", &DIGEST[1..]), false)]
    #[case::standard_alphabet(NAME.to_owned(), DIGEST.replace('-', "+"), false)]
    fn a_challenge_request_writes_only_a_challenge_record(
        #[case] name: String,
        #[case] value: String,
        #[case] is_accepted: bool,
    ) {
        let request = serde_json::json!({ "name": name, "value": value });
        let parsed = serde_json::from_value::<RuntimeNodeCertificateChallengeSetRequest>(request);
        assert_eq!(parsed.is_ok(), is_accepted);
    }
}
