// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A passkey's removal: the signed-in account revokes one of its own passkeys, so it can no longer sign in. A passkey of another account, or one already gone, is answered as removed.

import type { SchemaCheck } from "../../schema-check.js";
import { validateEmptyPayload } from "../checks/method-descriptor.js";
import { validateWebAuthnCredentialRevokeRequest } from "../checks/webauthn/credential.js";
import type { EmptyPayload } from "../method-descriptor.js";

/**
 * A passkey revoke: the passkey's credential id.
 */
export interface WebAuthnCredentialRevokeRequest {
  /**
   * The passkey.
   */
  passkeyId: string;
}

export { validateWebAuthnCredentialRevokeRequest } from "../checks/webauthn/credential.js";

/** The methods of {@link WEBAUTHN_CREDENTIAL_METHOD_DESCRIPTORS}, each with its checks. */
export interface WebauthnCredentialMethodDescriptors {
  readonly "webauthn.credential.revoke": {
    readonly method: "webauthn.credential.revoke";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WebAuthnCredentialRevokeRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
}
/** The passkey removal the control plane serves, one POST at `/<method>`. */
export const WEBAUTHN_CREDENTIAL_METHOD_DESCRIPTORS: WebauthnCredentialMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "webauthn.credential.revoke": /* @__PURE__ */ Object.freeze({
      method: "webauthn.credential.revoke",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWebAuthnCredentialRevokeRequest,
      responseCheck: validateEmptyPayload,
    }),
  });
