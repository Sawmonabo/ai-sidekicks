//! A passkey's removal: the signed-in account revokes one of its own passkeys, so it can no longer
//! sign in. A passkey of another account, or one already gone, is answered as removed.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::trust_statement::PasskeyId;
use crate::typescript::{Definition, TypeScriptModule};

/// A passkey revoke: the passkey's credential id.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WebAuthnCredentialRevokeRequest {
    /// The passkey.
    pub passkey_id: PasskeyId,
}

methods! {
    /// The passkey removal the control plane serves, one POST at `/<method>`.
    pub const WEBAUTHN_CREDENTIAL_METHOD_DESCRIPTORS = [
        /// Revokes one of the signed-in account's passkeys.
        WebAuthnCredentialRevoke = mutation "webauthn.credential.revoke" {
            mutating: true,
            params: WebAuthnCredentialRevokeRequest,
            result: EmptyPayload,
            refusals: [AuthTokenExpired, AuthTokenInvalid, AuthDpopMismatch],
        },
    ];
}

/// The TypeScript module of a passkey's removal.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "webauthn/credential",
    doc: "A passkey's removal: the signed-in account revokes one of its own passkeys, so it can \
          no longer sign in. A passkey of another account, or one already gone, is answered as \
          removed.",
    definitions: &[Definition::read::<WebAuthnCredentialRevokeRequest>().checked()],
    constants: &[],
    method_tables: &[&WEBAUTHN_CREDENTIAL_METHOD_DESCRIPTORS],
};
