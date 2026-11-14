// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A passkey's removal: the signed-in account revokes one of its own passkeys, so it can no longer sign in. A passkey of another account, or one already gone, is answered as removed.

import { type CompiledSchemaCheck, type SchemaCheck, ucs2length } from "../../schema-check.js";
import { type EmptyPayload, validateEmptyPayload } from "../method-descriptor.js";

/**
 * A passkey revoke: the passkey's credential id.
 */
export interface WebAuthnCredentialRevokeRequest {
  /**
   * The passkey.
   */
  passkeyId: string;
}

// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern10 = new RegExp("^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$", "u");
/** Checks that a value is a {@link WebAuthnCredentialRevokeRequest}. */
// prettier-ignore
export const validateWebAuthnCredentialRevokeRequest: CompiledSchemaCheck<WebAuthnCredentialRevokeRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WebAuthnCredentialRevokeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWebAuthnCredentialRevokeRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.passkeyId === undefined) && (missing0 = "passkeyId")){validateWebAuthnCredentialRevokeRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "passkeyId")){validateWebAuthnCredentialRevokeRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.passkeyId !== undefined){let data0: any = data.passkeyId;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 1364){validateWebAuthnCredentialRevokeRequest.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/properties/passkeyId/maxLength",keyword:"maxLength",params:{limit: 1364}}];return false;}else {if(func1(data0) < 1){validateWebAuthnCredentialRevokeRequest.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/properties/passkeyId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern10.test(data0)){validateWebAuthnCredentialRevokeRequest.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/properties/passkeyId/pattern",keyword:"pattern",params:{pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$"}}];return false;}}}}else {validateWebAuthnCredentialRevokeRequest.errors = [{instancePath:instancePath+"/passkeyId",schemaPath:"#/properties/passkeyId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validateWebAuthnCredentialRevokeRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWebAuthnCredentialRevokeRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWebAuthnCredentialRevokeRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;

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
  Object.freeze({
    "webauthn.credential.revoke": Object.freeze({
      method: "webauthn.credential.revoke",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateWebAuthnCredentialRevokeRequest,
      responseCheck: validateEmptyPayload,
    }),
  });
