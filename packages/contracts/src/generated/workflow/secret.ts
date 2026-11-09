// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Workflow secrets: the records a step's Credential chooser lists and manages, the `secret://<scope>/<name>` reference a node's sensitive parameter stores, the `workflow.secret.*` methods and the refusals a secret answers with.

import { type SchemaCheck, ucs2length } from "../../schema-check.js";
import type { KeychainRefusalCause } from "../keychain.js";
import { type EmptyPayload, validateEmptyPayload } from "../method-descriptor.js";
import type { ProjectId } from "../project.js";

/**
 * Wire members a request-logging transport redacts before writing a record: the value of a
 * secret's create or update.
 */
export const WORKFLOW_SECRET_REDACTED_WIRE_MEMBERS = ["secretValue"] as const;

/**
 * A secret record's id, a UUID the daemon mints.
 */
export type WorkflowSecretId = string & { readonly __brand: "WorkflowSecretId" };
/**
 * A secret's name: lowercase letters, digits and hyphens, starting with a letter or digit, at
 * most 64 characters.
 */
export type WorkflowSecretName = string;
/**
 * Where a secret is visible: the runs that work in one project, or every run on this machine.
 * Never a session.
 */
export type WorkflowSecretScope = "project" | "shared";
/**
 * A string that is exactly one secret reference, secret://shared/<name> or secret://project/<name>.
 */
export type WorkflowSecretReference = string;
/**
 * One secret as the chooser lists it: its place and name, and never its value.
 */
export type WorkflowSecretSummary =
  | {
      scope: "project";
      /**
       * The record's id.
       */
      secretId: WorkflowSecretId;
      /**
       * The secret's name.
       */
      name: WorkflowSecretName;
      /**
       * The project record's id.
       */
      scopeRef: ProjectId;
    }
  | {
      scope: "shared";
      /**
       * The record's id.
       */
      secretId: WorkflowSecretId;
      /**
       * The secret's name.
       */
      name: WorkflowSecretName;
      /**
       * Never present: a shared secret belongs to no project.
       */
      scopeRef?: never;
    };
/**
 * The `workflow.secret.create` input: the daemon seals `secretValue` in the keychain before it
 * writes the record, so a keychain that cannot take it leaves no record. A `name` that breaks
 * the rule is refused with `workflow.secret.nameInvalid`, one the place already holds with
 * `workflow.secret.nameTaken`.
 */
export type WorkflowSecretCreateRequest =
  | {
      scope: "project";
      /**
       * The name asked for, as typed: any text, so a name that breaks the rule reaches the
       * daemon's own refusal.
       */
      name: string;
      /**
       * The value to seal.
       */
      secretValue: string;
      /**
       * The project record's id.
       */
      scopeRef: ProjectId;
    }
  | {
      scope: "shared";
      /**
       * The name asked for, as typed: any text, so a name that breaks the rule reaches the
       * daemon's own refusal.
       */
      name: string;
      /**
       * The value to seal.
       */
      secretValue: string;
      /**
       * Never present: a shared secret belongs to no project.
       */
      scopeRef?: never;
    };
/**
 * Why a secret's name was refused.
 */
export type WorkflowSecretNameInvalidReason = "pattern";
/**
 * The details of `workflow.secret.notFound`: the reference a failed step stored, or the id an
 * update or a delete named, one or the other.
 */
export type WorkflowSecretNotFoundDetails =
  | WorkflowSecretReferenceNotFound
  | WorkflowSecretRecordNotFound;

/**
 * The `workflow.secret.update` input: a new value for one secret, sealed before the record's
 * change is written.
 */
export interface WorkflowSecretUpdateRequest {
  /**
   * The secret.
   */
  secretId: WorkflowSecretId;
  /**
   * The new value.
   */
  secretValue: string;
}
/**
 * The `workflow.secret.delete` input: the daemon records the removal, then removes the keychain
 * entry and the record, so a crash between the two finishes it. A version that still names the
 * secret fails its step with `workflow.secret.notFound`.
 */
export interface WorkflowSecretDeleteRequest {
  /**
   * The secret.
   */
  secretId: WorkflowSecretId;
}
/**
 * The secret an update or a delete acted on.
 */
export interface WorkflowSecretActResponse {
  /**
   * The secret.
   */
  secretId: WorkflowSecretId;
}
/**
 * The `workflow.secret.list` result: every secret by name, shared and each project's, one row
 * each, and no member carries a value. The request names nothing: a workflow belongs to no
 * project, so the chooser lists them all.
 */
export interface WorkflowSecretListResponse {
  /**
   * The secrets.
   */
  secrets: WorkflowSecretSummary[];
}
/**
 * The details of `workflow.secret.nameInvalid`.
 */
export interface WorkflowSecretNameInvalidDetails {
  /**
   * Why.
   */
  reason: WorkflowSecretNameInvalidReason;
}
/**
 * A step's secret the keychain does not hold: only the reference, as the step stored it.
 */
export interface WorkflowSecretReferenceNotFound {
  /**
   * The reference.
   */
  reference: WorkflowSecretReference;
  /**
   * Never present: a step names its secret by reference.
   */
  secretId?: never;
}
/**
 * An update or a delete naming a secret no record holds.
 */
export interface WorkflowSecretRecordNotFound {
  /**
   * Never present: an update or a delete names its secret by id.
   */
  reference?: never;
  /**
   * The id asked for.
   */
  secretId: WorkflowSecretId;
}
/**
 * The details of `workflow.secret.storeUnavailable`: why the keychain could not be used. A create
 * or update is refused, and a step fails and offers `Retry from this step`, never waiting on the
 * keychain or keeping the value anywhere else.
 */
export interface WorkflowSecretStoreUnavailableDetails {
  /**
   * Why.
   */
  cause: KeychainRefusalCause;
}

// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
function validate2935(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowSecretActResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2935.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.secretId === undefined) && (missing0 = "secretId")){validate2935.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "secretId")){validate2935.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.secretId !== undefined){let data0: any = data.secretId;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2935.errors = [{instancePath:instancePath+"/secretId",schemaPath:"#/$defs/WorkflowSecretId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2935.errors = [{instancePath:instancePath+"/secretId",schemaPath:"#/$defs/WorkflowSecretId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate2935.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2935.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2935.errors = null as any[] | null;
// prettier-ignore
validate2935.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
function validate2936(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowSecretCreateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2936.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.scope;if(typeof tag0 == "string"){if(tag0 === "project"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.scope === undefined) && (missing0 = "scope")) || ((data.name === undefined) && (missing0 = "name"))) || ((data.secretValue === undefined) && (missing0 = "secretValue"))) || ((data.scopeRef === undefined) && (missing0 = "scopeRef"))){validate2936.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!((((key0 === "scope") || (key0 === "name")) || (key0 === "secretValue")) || (key0 === "scopeRef"))){validate2936.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.scope !== undefined){let data0: any = data.scope;const _errs5: any = errors;if(typeof data0 !== "string"){validate2936.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/oneOf/0/properties/scope/type",keyword:"type",params:{type: "string"}}];return false;}if("project" !== data0){validate2936.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/oneOf/0/properties/scope/const",keyword:"const",params:{allowedValue: "project"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.name !== undefined){const _errs7: any = errors;if(typeof data.name !== "string"){validate2936.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/0/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.secretValue !== undefined){let data2: any = data.secretValue;const _errs9: any = errors;if(errors === _errs9){if(typeof data2 === "string"){if(func1(data2) < 1){validate2936.errors = [{instancePath:instancePath+"/secretValue",schemaPath:"#/oneOf/0/properties/secretValue/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data2)){validate2936.errors = [{instancePath:instancePath+"/secretValue",schemaPath:"#/oneOf/0/properties/secretValue/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate2936.errors = [{instancePath:instancePath+"/secretValue",schemaPath:"#/oneOf/0/properties/secretValue/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs9 === errors;}else {var valid2: any = true;}if(valid2){if(data.scopeRef !== undefined){let data3: any = data.scopeRef;const _errs11: any = errors;const _errs12: any = errors;if(errors === _errs12){if(typeof data3 === "string"){if(!pattern4.test(data3)){validate2936.errors = [{instancePath:instancePath+"/scopeRef",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2936.errors = [{instancePath:instancePath+"/scopeRef",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs11 === errors;}else {var valid2: any = true;}}}}}}}else {validate2936.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "shared"){const _errs15: any = errors;if(errors === _errs15){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.scope === undefined) && (missing1 = "scope")) || ((data.name === undefined) && (missing1 = "name"))) || ((data.secretValue === undefined) && (missing1 = "secretValue"))){validate2936.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs17: any = errors;for(const key1 in data){if(!((((key1 === "scope") || (key1 === "name")) || (key1 === "secretValue")) || (key1 === "scopeRef"))){validate2936.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs17 === errors){if(data.scope !== undefined){let data4: any = data.scope;const _errs18: any = errors;if(typeof data4 !== "string"){validate2936.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/oneOf/1/properties/scope/type",keyword:"type",params:{type: "string"}}];return false;}if("shared" !== data4){validate2936.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/oneOf/1/properties/scope/const",keyword:"const",params:{allowedValue: "shared"}}];return false;}var valid5: any = _errs18 === errors;}else {var valid5: any = true;}if(valid5){if(data.name !== undefined){const _errs20: any = errors;if(typeof data.name !== "string"){validate2936.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/1/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}var valid5: any = _errs20 === errors;}else {var valid5: any = true;}if(valid5){if(data.secretValue !== undefined){let data6: any = data.secretValue;const _errs22: any = errors;if(errors === _errs22){if(typeof data6 === "string"){if(func1(data6) < 1){validate2936.errors = [{instancePath:instancePath+"/secretValue",schemaPath:"#/oneOf/1/properties/secretValue/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data6)){validate2936.errors = [{instancePath:instancePath+"/secretValue",schemaPath:"#/oneOf/1/properties/secretValue/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate2936.errors = [{instancePath:instancePath+"/secretValue",schemaPath:"#/oneOf/1/properties/secretValue/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs22 === errors;}else {var valid5: any = true;}if(valid5){if(data.scopeRef !== undefined){const _errs24: any = errors;validate2936.errors = [{instancePath:instancePath+"/scopeRef",schemaPath:"#/oneOf/1/properties/scopeRef/not",keyword:"not",params:{}}];return false;var valid5: any = _errs24 === errors;}else {var valid5: any = true;}}}}}}}else {validate2936.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid4: any = _errs15 === errors;if(props0 !== true){props0 = true;}valid0 = valid4;}else {validate2936.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "scope", tagValue: tag0}}];return false;}}else {validate2936.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "scope", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key2 in data){if(!props0 || !props0[key2]){validate2936.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key2}}];return false;break;}}}}}else {validate2936.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2936.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2936.errors = null as any[] | null;
// prettier-ignore
validate2936.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2937(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowSecretDeleteRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2937.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.secretId === undefined) && (missing0 = "secretId")){validate2937.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "secretId")){validate2937.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.secretId !== undefined){let data0: any = data.secretId;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2937.errors = [{instancePath:instancePath+"/secretId",schemaPath:"#/$defs/WorkflowSecretId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2937.errors = [{instancePath:instancePath+"/secretId",schemaPath:"#/$defs/WorkflowSecretId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate2937.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2937.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2937.errors = null as any[] | null;
// prettier-ignore
validate2937.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2938(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowSecretId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2938.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern4.test(data)){validate2938.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2938.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validate2938.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2938.errors = null as any[] | null;
// prettier-ignore
validate2938.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern3682 = new RegExp("^[a-z0-9][a-z0-9-]{0,63}$", "u");
// prettier-ignore
function validate2940(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2940.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.scope;if(typeof tag0 == "string"){if(tag0 === "project"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.scope === undefined) && (missing0 = "scope")) || ((data.secretId === undefined) && (missing0 = "secretId"))) || ((data.name === undefined) && (missing0 = "name"))) || ((data.scopeRef === undefined) && (missing0 = "scopeRef"))){validate2940.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!((((key0 === "scope") || (key0 === "secretId")) || (key0 === "name")) || (key0 === "scopeRef"))){validate2940.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.scope !== undefined){let data0: any = data.scope;const _errs5: any = errors;if(typeof data0 !== "string"){validate2940.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/oneOf/0/properties/scope/type",keyword:"type",params:{type: "string"}}];return false;}if("project" !== data0){validate2940.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/oneOf/0/properties/scope/const",keyword:"const",params:{allowedValue: "project"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.secretId !== undefined){let data1: any = data.secretId;const _errs7: any = errors;const _errs8: any = errors;if(errors === _errs8){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate2940.errors = [{instancePath:instancePath+"/secretId",schemaPath:"#/$defs/WorkflowSecretId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2940.errors = [{instancePath:instancePath+"/secretId",schemaPath:"#/$defs/WorkflowSecretId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.name !== undefined){let data2: any = data.name;const _errs11: any = errors;const _errs12: any = errors;if(errors === _errs12){if(typeof data2 === "string"){if(!pattern3682.test(data2)){validate2940.errors = [{instancePath:instancePath+"/name",schemaPath:"#/$defs/WorkflowSecretName/pattern",keyword:"pattern",params:{pattern: "^[a-z0-9][a-z0-9-]{0,63}$"}}];return false;}}else {validate2940.errors = [{instancePath:instancePath+"/name",schemaPath:"#/$defs/WorkflowSecretName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs11 === errors;}else {var valid2: any = true;}if(valid2){if(data.scopeRef !== undefined){let data3: any = data.scopeRef;const _errs14: any = errors;const _errs15: any = errors;if(errors === _errs15){if(typeof data3 === "string"){if(!pattern4.test(data3)){validate2940.errors = [{instancePath:instancePath+"/scopeRef",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2940.errors = [{instancePath:instancePath+"/scopeRef",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs14 === errors;}else {var valid2: any = true;}}}}}}}else {validate2940.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "shared"){const _errs18: any = errors;if(errors === _errs18){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.scope === undefined) && (missing1 = "scope")) || ((data.secretId === undefined) && (missing1 = "secretId"))) || ((data.name === undefined) && (missing1 = "name"))){validate2940.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs20: any = errors;for(const key1 in data){if(!((((key1 === "scope") || (key1 === "secretId")) || (key1 === "name")) || (key1 === "scopeRef"))){validate2940.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs20 === errors){if(data.scope !== undefined){let data4: any = data.scope;const _errs21: any = errors;if(typeof data4 !== "string"){validate2940.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/oneOf/1/properties/scope/type",keyword:"type",params:{type: "string"}}];return false;}if("shared" !== data4){validate2940.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/oneOf/1/properties/scope/const",keyword:"const",params:{allowedValue: "shared"}}];return false;}var valid7: any = _errs21 === errors;}else {var valid7: any = true;}if(valid7){if(data.secretId !== undefined){let data5: any = data.secretId;const _errs23: any = errors;const _errs24: any = errors;if(errors === _errs24){if(typeof data5 === "string"){if(!pattern4.test(data5)){validate2940.errors = [{instancePath:instancePath+"/secretId",schemaPath:"#/$defs/WorkflowSecretId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2940.errors = [{instancePath:instancePath+"/secretId",schemaPath:"#/$defs/WorkflowSecretId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid7: any = _errs23 === errors;}else {var valid7: any = true;}if(valid7){if(data.name !== undefined){let data6: any = data.name;const _errs27: any = errors;const _errs28: any = errors;if(errors === _errs28){if(typeof data6 === "string"){if(!pattern3682.test(data6)){validate2940.errors = [{instancePath:instancePath+"/name",schemaPath:"#/$defs/WorkflowSecretName/pattern",keyword:"pattern",params:{pattern: "^[a-z0-9][a-z0-9-]{0,63}$"}}];return false;}}else {validate2940.errors = [{instancePath:instancePath+"/name",schemaPath:"#/$defs/WorkflowSecretName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid7: any = _errs27 === errors;}else {var valid7: any = true;}if(valid7){if(data.scopeRef !== undefined){const _errs30: any = errors;validate2940.errors = [{instancePath:instancePath+"/scopeRef",schemaPath:"#/oneOf/1/properties/scopeRef/not",keyword:"not",params:{}}];return false;var valid7: any = _errs30 === errors;}else {var valid7: any = true;}}}}}}}else {validate2940.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid6: any = _errs18 === errors;if(props0 !== true){props0 = true;}valid0 = valid6;}else {validate2940.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "scope", tagValue: tag0}}];return false;}}else {validate2940.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "scope", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key2 in data){if(!props0 || !props0[key2]){validate2940.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key2}}];return false;break;}}}}}else {validate2940.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2940.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2940.errors = null as any[] | null;
// prettier-ignore
validate2940.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2939(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowSecretListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2939.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.secrets === undefined) && (missing0 = "secrets")){validate2939.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "secrets")){validate2939.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.secrets !== undefined){let data0: any = data.secrets;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validate2940.call(this, data0[i0], {instancePath:instancePath+"/secrets/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2940.errors : vErrors.concat(validate2940.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validate2939.errors = [{instancePath:instancePath+"/secrets",schemaPath:"#/properties/secrets/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validate2939.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2939.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2939.errors = null as any[] | null;
// prettier-ignore
validate2939.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema5551: any = {"description":"Why a secret's name was refused.","type":"string","enum":["pattern"]};
// prettier-ignore
function validate2942(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowSecretNameInvalidDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2942.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.reason === undefined) && (missing0 = "reason")){validate2942.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "reason")){validate2942.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.reason !== undefined){let data0: any = data.reason;if(typeof data0 !== "string"){validate2942.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/$defs/WorkflowSecretNameInvalidReason/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data0 === "pattern")){validate2942.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/$defs/WorkflowSecretNameInvalidReason/enum",keyword:"enum",params:{allowedValues: schema5551.enum}}];return false;}}}}}else {validate2942.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2942.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2942.errors = null as any[] | null;
// prettier-ignore
validate2942.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern3686 = new RegExp("^secret://(?:project|shared)/[a-z0-9][a-z0-9-]{0,63}$", "u");
// prettier-ignore
function validate2944(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2944.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.reference === undefined) && (missing0 = "reference")){validate2944.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "reference") || (key0 === "secretId"))){validate2944.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.reference !== undefined){let data0: any = data.reference;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern3686.test(data0)){validate2944.errors = [{instancePath:instancePath+"/reference",schemaPath:"#/$defs/WorkflowSecretReference/pattern",keyword:"pattern",params:{pattern: "^secret://(?:project|shared)/[a-z0-9][a-z0-9-]{0,63}$"}}];return false;}}else {validate2944.errors = [{instancePath:instancePath+"/reference",schemaPath:"#/$defs/WorkflowSecretReference/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.secretId !== undefined){const _errs5: any = errors;validate2944.errors = [{instancePath:instancePath+"/secretId",schemaPath:"#/properties/secretId/not",keyword:"not",params:{}}];return false;var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}else {validate2944.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2944.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2944.errors = null as any[] | null;
// prettier-ignore
validate2944.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2946(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2946.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.secretId === undefined) && (missing0 = "secretId")){validate2946.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "reference") || (key0 === "secretId"))){validate2946.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.reference !== undefined){const _errs2: any = errors;validate2946.errors = [{instancePath:instancePath+"/reference",schemaPath:"#/properties/reference/not",keyword:"not",params:{}}];return false;var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.secretId !== undefined){let data1: any = data.secretId;const _errs5: any = errors;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate2946.errors = [{instancePath:instancePath+"/secretId",schemaPath:"#/$defs/WorkflowSecretId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2946.errors = [{instancePath:instancePath+"/secretId",schemaPath:"#/$defs/WorkflowSecretId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}else {validate2946.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2946.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2946.errors = null as any[] | null;
// prettier-ignore
validate2946.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2943(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowSecretNotFoundDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2943.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(!(validate2944.call(this, data, {instancePath,parentData,parentDataProperty,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2944.errors : vErrors.concat(validate2944.errors);errors = vErrors.length;}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs2: any = errors;if(!(validate2946.call(this, data, {instancePath,parentData,parentDataProperty,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2946.errors : vErrors.concat(validate2946.errors);errors = vErrors.length;}var _valid0: any = _errs2 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid0){const err0: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;validate2943.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validate2943.errors = vErrors;evaluated0.props = props0;return errors === 0;}
// prettier-ignore
validate2943.errors = null as any[] | null;
// prettier-ignore
validate2943.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
// prettier-ignore
const schema444: any = {"description":"Why this machine's keychain could not be used: it is `locked`, or it cannot be used now or at\nall (`unavailable`). A secret that cannot be sealed is refused and stored nowhere else.","type":"string","enum":["locked","unavailable"]};
// prettier-ignore
function validate2948(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowSecretStoreUnavailableDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2948.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.cause === undefined) && (missing0 = "cause")){validate2948.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "cause")){validate2948.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.cause !== undefined){let data0: any = data.cause;if(typeof data0 !== "string"){validate2948.errors = [{instancePath:instancePath+"/cause",schemaPath:"sidekicks-contracts:keychain#/$defs/KeychainRefusalCause/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data0 === "locked") || (data0 === "unavailable"))){validate2948.errors = [{instancePath:instancePath+"/cause",schemaPath:"sidekicks-contracts:keychain#/$defs/KeychainRefusalCause/enum",keyword:"enum",params:{allowedValues: schema444.enum}}];return false;}}}}}else {validate2948.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2948.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2948.errors = null as any[] | null;
// prettier-ignore
validate2948.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2949(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowSecretSummary {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2949.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.scope;if(typeof tag0 == "string"){if(tag0 === "project"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.scope === undefined) && (missing0 = "scope")) || ((data.secretId === undefined) && (missing0 = "secretId"))) || ((data.name === undefined) && (missing0 = "name"))) || ((data.scopeRef === undefined) && (missing0 = "scopeRef"))){validate2949.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!((((key0 === "scope") || (key0 === "secretId")) || (key0 === "name")) || (key0 === "scopeRef"))){validate2949.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.scope !== undefined){let data0: any = data.scope;const _errs5: any = errors;if(typeof data0 !== "string"){validate2949.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/oneOf/0/properties/scope/type",keyword:"type",params:{type: "string"}}];return false;}if("project" !== data0){validate2949.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/oneOf/0/properties/scope/const",keyword:"const",params:{allowedValue: "project"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.secretId !== undefined){let data1: any = data.secretId;const _errs7: any = errors;const _errs8: any = errors;if(errors === _errs8){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate2949.errors = [{instancePath:instancePath+"/secretId",schemaPath:"#/$defs/WorkflowSecretId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2949.errors = [{instancePath:instancePath+"/secretId",schemaPath:"#/$defs/WorkflowSecretId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.name !== undefined){let data2: any = data.name;const _errs11: any = errors;const _errs12: any = errors;if(errors === _errs12){if(typeof data2 === "string"){if(!pattern3682.test(data2)){validate2949.errors = [{instancePath:instancePath+"/name",schemaPath:"#/$defs/WorkflowSecretName/pattern",keyword:"pattern",params:{pattern: "^[a-z0-9][a-z0-9-]{0,63}$"}}];return false;}}else {validate2949.errors = [{instancePath:instancePath+"/name",schemaPath:"#/$defs/WorkflowSecretName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs11 === errors;}else {var valid2: any = true;}if(valid2){if(data.scopeRef !== undefined){let data3: any = data.scopeRef;const _errs14: any = errors;const _errs15: any = errors;if(errors === _errs15){if(typeof data3 === "string"){if(!pattern4.test(data3)){validate2949.errors = [{instancePath:instancePath+"/scopeRef",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2949.errors = [{instancePath:instancePath+"/scopeRef",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs14 === errors;}else {var valid2: any = true;}}}}}}}else {validate2949.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "shared"){const _errs18: any = errors;if(errors === _errs18){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.scope === undefined) && (missing1 = "scope")) || ((data.secretId === undefined) && (missing1 = "secretId"))) || ((data.name === undefined) && (missing1 = "name"))){validate2949.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs20: any = errors;for(const key1 in data){if(!((((key1 === "scope") || (key1 === "secretId")) || (key1 === "name")) || (key1 === "scopeRef"))){validate2949.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs20 === errors){if(data.scope !== undefined){let data4: any = data.scope;const _errs21: any = errors;if(typeof data4 !== "string"){validate2949.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/oneOf/1/properties/scope/type",keyword:"type",params:{type: "string"}}];return false;}if("shared" !== data4){validate2949.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/oneOf/1/properties/scope/const",keyword:"const",params:{allowedValue: "shared"}}];return false;}var valid7: any = _errs21 === errors;}else {var valid7: any = true;}if(valid7){if(data.secretId !== undefined){let data5: any = data.secretId;const _errs23: any = errors;const _errs24: any = errors;if(errors === _errs24){if(typeof data5 === "string"){if(!pattern4.test(data5)){validate2949.errors = [{instancePath:instancePath+"/secretId",schemaPath:"#/$defs/WorkflowSecretId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2949.errors = [{instancePath:instancePath+"/secretId",schemaPath:"#/$defs/WorkflowSecretId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid7: any = _errs23 === errors;}else {var valid7: any = true;}if(valid7){if(data.name !== undefined){let data6: any = data.name;const _errs27: any = errors;const _errs28: any = errors;if(errors === _errs28){if(typeof data6 === "string"){if(!pattern3682.test(data6)){validate2949.errors = [{instancePath:instancePath+"/name",schemaPath:"#/$defs/WorkflowSecretName/pattern",keyword:"pattern",params:{pattern: "^[a-z0-9][a-z0-9-]{0,63}$"}}];return false;}}else {validate2949.errors = [{instancePath:instancePath+"/name",schemaPath:"#/$defs/WorkflowSecretName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid7: any = _errs27 === errors;}else {var valid7: any = true;}if(valid7){if(data.scopeRef !== undefined){const _errs30: any = errors;validate2949.errors = [{instancePath:instancePath+"/scopeRef",schemaPath:"#/oneOf/1/properties/scopeRef/not",keyword:"not",params:{}}];return false;var valid7: any = _errs30 === errors;}else {var valid7: any = true;}}}}}}}else {validate2949.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid6: any = _errs18 === errors;if(props0 !== true){props0 = true;}valid0 = valid6;}else {validate2949.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "scope", tagValue: tag0}}];return false;}}else {validate2949.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "scope", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key2 in data){if(!props0 || !props0[key2]){validate2949.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key2}}];return false;break;}}}}}else {validate2949.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2949.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2949.errors = null as any[] | null;
// prettier-ignore
validate2949.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2950(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowSecretUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2950.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.secretId === undefined) && (missing0 = "secretId")) || ((data.secretValue === undefined) && (missing0 = "secretValue"))){validate2950.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "secretId") || (key0 === "secretValue"))){validate2950.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.secretId !== undefined){let data0: any = data.secretId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2950.errors = [{instancePath:instancePath+"/secretId",schemaPath:"#/$defs/WorkflowSecretId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2950.errors = [{instancePath:instancePath+"/secretId",schemaPath:"#/$defs/WorkflowSecretId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.secretValue !== undefined){let data1: any = data.secretValue;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) < 1){validate2950.errors = [{instancePath:instancePath+"/secretValue",schemaPath:"#/properties/secretValue/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data1)){validate2950.errors = [{instancePath:instancePath+"/secretValue",schemaPath:"#/properties/secretValue/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate2950.errors = [{instancePath:instancePath+"/secretValue",schemaPath:"#/properties/secretValue/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate2950.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2950.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2950.errors = null as any[] | null;
// prettier-ignore
validate2950.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowSecretActResponse}. */
export const validateWorkflowSecretActResponse: SchemaCheck<WorkflowSecretActResponse> =
  validate2935;
/** Checks that a value is a {@link WorkflowSecretCreateRequest}. */
export const validateWorkflowSecretCreateRequest: SchemaCheck<WorkflowSecretCreateRequest> =
  validate2936;
/** Checks that a value is a {@link WorkflowSecretDeleteRequest}. */
export const validateWorkflowSecretDeleteRequest: SchemaCheck<WorkflowSecretDeleteRequest> =
  validate2937;
/** Checks that a value is a {@link WorkflowSecretId}. */
export const validateWorkflowSecretId: SchemaCheck<WorkflowSecretId> = validate2938;
/** Checks that a value is a {@link WorkflowSecretListResponse}. */
export const validateWorkflowSecretListResponse: SchemaCheck<WorkflowSecretListResponse> =
  validate2939;
/** Checks that a value is a {@link WorkflowSecretNameInvalidDetails}. */
export const validateWorkflowSecretNameInvalidDetails: SchemaCheck<WorkflowSecretNameInvalidDetails> =
  validate2942;
/** Checks that a value is a {@link WorkflowSecretNotFoundDetails}. */
export const validateWorkflowSecretNotFoundDetails: SchemaCheck<WorkflowSecretNotFoundDetails> =
  validate2943;
/** Checks that a value is a {@link WorkflowSecretStoreUnavailableDetails}. */
export const validateWorkflowSecretStoreUnavailableDetails: SchemaCheck<WorkflowSecretStoreUnavailableDetails> =
  validate2948;
/** Checks that a value is a {@link WorkflowSecretSummary}. */
export const validateWorkflowSecretSummary: SchemaCheck<WorkflowSecretSummary> = validate2949;
/** Checks that a value is a {@link WorkflowSecretUpdateRequest}. */
export const validateWorkflowSecretUpdateRequest: SchemaCheck<WorkflowSecretUpdateRequest> =
  validate2950;

/** The methods of {@link WORKFLOW_SECRET_METHOD_DESCRIPTORS}, each with its checks. */
export interface WorkflowSecretMethodDescriptors {
  readonly "workflow.secret.create": {
    readonly method: "workflow.secret.create";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WorkflowSecretCreateRequest>;
    readonly responseCheck: SchemaCheck<WorkflowSecretSummary>;
  };
  readonly "workflow.secret.update": {
    readonly method: "workflow.secret.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WorkflowSecretUpdateRequest>;
    readonly responseCheck: SchemaCheck<WorkflowSecretActResponse>;
  };
  readonly "workflow.secret.delete": {
    readonly method: "workflow.secret.delete";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<WorkflowSecretDeleteRequest>;
    readonly responseCheck: SchemaCheck<WorkflowSecretActResponse>;
  };
  readonly "workflow.secret.list": {
    readonly method: "workflow.secret.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<WorkflowSecretListResponse>;
  };
}
/** The workflow secrets' method table. */
export const WORKFLOW_SECRET_METHOD_DESCRIPTORS: WorkflowSecretMethodDescriptors = Object.freeze({
  "workflow.secret.create": Object.freeze({
    method: "workflow.secret.create",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateWorkflowSecretCreateRequest,
    responseCheck: validateWorkflowSecretSummary,
  }),
  "workflow.secret.update": Object.freeze({
    method: "workflow.secret.update",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateWorkflowSecretUpdateRequest,
    responseCheck: validateWorkflowSecretActResponse,
  }),
  "workflow.secret.delete": Object.freeze({
    method: "workflow.secret.delete",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateWorkflowSecretDeleteRequest,
    responseCheck: validateWorkflowSecretActResponse,
  }),
  "workflow.secret.list": Object.freeze({
    method: "workflow.secret.list",
    procedureType: "query",
    mutating: false,
    requestCheck: validateEmptyPayload,
    responseCheck: validateWorkflowSecretListResponse,
  }),
});
