// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The two retention bounds on Settings › Runtime, and `Delete old data`.

import type { CompiledSchemaCheck, SchemaCheck } from "../../schema-check.js";
import { type WireInstant, validateWireInstant } from "../internal/wire-scalars.js";
import {
  type SubscribeAcknowledgmentResponse,
  validateSubscribeAcknowledgmentResponse,
} from "../jsonrpc/streaming.js";
import { type EmptyPayload, validateEmptyPayload } from "../method-descriptor.js";

/** `Keep diagnostic logs for` as the app starts out, seven days, in milliseconds. */
export const DEFAULT_KEEP_DIAGNOSTIC_LOGS_MS = 604800000 as const;

/**
 * `daemon.retention.update`: exactly one bound, as `{"<bound>": days}`. Setting a bound deletes
 * nothing.
 */
export type DaemonRetentionUpdateRequest =
  | {
      keepDiagnosticLogsDays: number;
    }
  | {
      keepSessionsDays: number;
    };

/**
 * The two bounds, each in whole days.
 */
export interface DaemonRetentionBounds {
  /**
   * The service's own logs and, in each account home, what the provider writes and never reads
   * back for a session. Any period is taken as set.
   */
  keepDiagnosticLogsDays: number;
  /**
   * How long a finished session stays before it can be deleted.
   */
  keepSessionsDays: number;
}
/**
 * What `Delete old data` would remove if it ran now.
 */
export interface DaemonRetentionPurgePreview {
  /**
   * How many sessions the purge would remove: those archived or closed before the cutoff, and
   * every one a failed purge left marked.
   */
  archivedSessionCount: number;
  /**
   * Sessions archived or closed before this moment are the ones counted.
   */
  cutoffAt: WireInstant;
}
/**
 * The bounds, and the count the purge's confirm names.
 */
export interface DaemonRetentionReadResponse {
  /**
   * `Keep diagnostic logs for`, in whole days.
   */
  keepDiagnosticLogsDays: number;
  /**
   * How long a finished session stays before it can be deleted, in whole days.
   */
  keepSessionsDays: number;
  /**
   * What the purge would remove now.
   */
  purge: DaemonRetentionPurgePreview;
}
/**
 * `daemon.retention.purge`: the cutoff the confirm was read against, so the purge removes exactly
 * what the confirm named and a second press removes nothing more.
 */
export interface DaemonRetentionPurgeRequest {
  /**
   * The cutoff the confirm named.
   */
  cutoffAt: WireInstant;
}
/**
 * How many sessions the purge removed.
 */
export interface DaemonRetentionPurgeResponse {
  /**
   * The sessions removed.
   */
  deletedSessionCount: number;
}

/** Checks that a value is a {@link DaemonRetentionBounds}. */
// prettier-ignore
export const validateDaemonRetentionBounds: CompiledSchemaCheck<DaemonRetentionBounds> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonRetentionBounds {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDaemonRetentionBounds.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.keepDiagnosticLogsDays === undefined) && (missing0 = "keepDiagnosticLogsDays")) || ((data.keepSessionsDays === undefined) && (missing0 = "keepSessionsDays"))){validateDaemonRetentionBounds.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "keepDiagnosticLogsDays") || (key0 === "keepSessionsDays"))){validateDaemonRetentionBounds.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.keepDiagnosticLogsDays !== undefined){let data0: any = data.keepDiagnosticLogsDays;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validateDaemonRetentionBounds.errors = [{instancePath:instancePath+"/keepDiagnosticLogsDays",schemaPath:"#/properties/keepDiagnosticLogsDays/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs2){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validateDaemonRetentionBounds.errors = [{instancePath:instancePath+"/keepDiagnosticLogsDays",schemaPath:"#/properties/keepDiagnosticLogsDays/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < 1 || isNaN(data0)){validateDaemonRetentionBounds.errors = [{instancePath:instancePath+"/keepDiagnosticLogsDays",schemaPath:"#/properties/keepDiagnosticLogsDays/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.keepSessionsDays !== undefined){let data1: any = data.keepSessionsDays;const _errs4: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validateDaemonRetentionBounds.errors = [{instancePath:instancePath+"/keepSessionsDays",schemaPath:"#/properties/keepSessionsDays/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validateDaemonRetentionBounds.errors = [{instancePath:instancePath+"/keepSessionsDays",schemaPath:"#/properties/keepSessionsDays/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 1 || isNaN(data1)){validateDaemonRetentionBounds.errors = [{instancePath:instancePath+"/keepSessionsDays",schemaPath:"#/properties/keepSessionsDays/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validateDaemonRetentionBounds.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDaemonRetentionBounds.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDaemonRetentionBounds.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link DaemonRetentionPurgePreview}. */
// prettier-ignore
export const validateDaemonRetentionPurgePreview: CompiledSchemaCheck<DaemonRetentionPurgePreview> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonRetentionPurgePreview {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDaemonRetentionPurgePreview.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.archivedSessionCount === undefined) && (missing0 = "archivedSessionCount")) || ((data.cutoffAt === undefined) && (missing0 = "cutoffAt"))){validateDaemonRetentionPurgePreview.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "archivedSessionCount") || (key0 === "cutoffAt"))){validateDaemonRetentionPurgePreview.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.archivedSessionCount !== undefined){let data0: any = data.archivedSessionCount;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validateDaemonRetentionPurgePreview.errors = [{instancePath:instancePath+"/archivedSessionCount",schemaPath:"#/properties/archivedSessionCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs2){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validateDaemonRetentionPurgePreview.errors = [{instancePath:instancePath+"/archivedSessionCount",schemaPath:"#/properties/archivedSessionCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < 0 || isNaN(data0)){validateDaemonRetentionPurgePreview.errors = [{instancePath:instancePath+"/archivedSessionCount",schemaPath:"#/properties/archivedSessionCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.cutoffAt !== undefined){const _errs4: any = errors;if(!(validateWireInstant.call(this, data.cutoffAt, {instancePath:instancePath+"/cutoffAt",parentData:data,parentDataProperty:"cutoffAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validateDaemonRetentionPurgePreview.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDaemonRetentionPurgePreview.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDaemonRetentionPurgePreview.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link DaemonRetentionReadResponse}. */
// prettier-ignore
export const validateDaemonRetentionReadResponse: CompiledSchemaCheck<DaemonRetentionReadResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonRetentionReadResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDaemonRetentionReadResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.keepDiagnosticLogsDays === undefined) && (missing0 = "keepDiagnosticLogsDays")) || ((data.keepSessionsDays === undefined) && (missing0 = "keepSessionsDays"))) || ((data.purge === undefined) && (missing0 = "purge"))){validateDaemonRetentionReadResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "keepDiagnosticLogsDays") || (key0 === "keepSessionsDays")) || (key0 === "purge"))){validateDaemonRetentionReadResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.keepDiagnosticLogsDays !== undefined){let data0: any = data.keepDiagnosticLogsDays;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validateDaemonRetentionReadResponse.errors = [{instancePath:instancePath+"/keepDiagnosticLogsDays",schemaPath:"#/properties/keepDiagnosticLogsDays/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs2){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validateDaemonRetentionReadResponse.errors = [{instancePath:instancePath+"/keepDiagnosticLogsDays",schemaPath:"#/properties/keepDiagnosticLogsDays/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < 1 || isNaN(data0)){validateDaemonRetentionReadResponse.errors = [{instancePath:instancePath+"/keepDiagnosticLogsDays",schemaPath:"#/properties/keepDiagnosticLogsDays/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.keepSessionsDays !== undefined){let data1: any = data.keepSessionsDays;const _errs4: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validateDaemonRetentionReadResponse.errors = [{instancePath:instancePath+"/keepSessionsDays",schemaPath:"#/properties/keepSessionsDays/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validateDaemonRetentionReadResponse.errors = [{instancePath:instancePath+"/keepSessionsDays",schemaPath:"#/properties/keepSessionsDays/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 1 || isNaN(data1)){validateDaemonRetentionReadResponse.errors = [{instancePath:instancePath+"/keepSessionsDays",schemaPath:"#/properties/keepSessionsDays/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.purge !== undefined){const _errs6: any = errors;if(!(validateDaemonRetentionPurgePreview.call(this, data.purge, {instancePath:instancePath+"/purge",parentData:data,parentDataProperty:"purge",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDaemonRetentionPurgePreview.errors : vErrors.concat(validateDaemonRetentionPurgePreview.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}else {validateDaemonRetentionReadResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDaemonRetentionReadResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDaemonRetentionReadResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link DaemonRetentionUpdateRequest}. */
// prettier-ignore
export const validateDaemonRetentionUpdateRequest: CompiledSchemaCheck<DaemonRetentionUpdateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonRetentionUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDaemonRetentionUpdateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;let passing0: any = null;const _errs1: any = errors;if(errors === _errs1){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.keepDiagnosticLogsDays === undefined) && (missing0 = "keepDiagnosticLogsDays")){const err0: any = {instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {const _errs3: any = errors;for(const key0 in data){if(!(key0 === "keepDiagnosticLogsDays")){const err1: any = {instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;break;}}if(_errs3 === errors){if(data.keepDiagnosticLogsDays !== undefined){let data0: any = data.keepDiagnosticLogsDays;const _errs4: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){const err2: any = {instancePath:instancePath+"/keepDiagnosticLogsDays",schemaPath:"#/oneOf/0/properties/keepDiagnosticLogsDays/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}if(errors === _errs4){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){const err3: any = {instancePath:instancePath+"/keepDiagnosticLogsDays",schemaPath:"#/oneOf/0/properties/keepDiagnosticLogsDays/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}else {if(data0 < 1 || isNaN(data0)){const err4: any = {instancePath:instancePath+"/keepDiagnosticLogsDays",schemaPath:"#/oneOf/0/properties/keepDiagnosticLogsDays/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}}}}}}}}else {const err5: any = {instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}}var _valid0: any = _errs1 === errors;if(_valid0){valid0 = true;passing0 = 0;var props0: any = true;}const _errs6: any = errors;if(errors === _errs6){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((data.keepSessionsDays === undefined) && (missing1 = "keepSessionsDays")){const err6: any = {instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}else {const _errs8: any = errors;for(const key1 in data){if(!(key1 === "keepSessionsDays")){const err7: any = {instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;break;}}if(_errs8 === errors){if(data.keepSessionsDays !== undefined){let data1: any = data.keepSessionsDays;const _errs9: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){const err8: any = {instancePath:instancePath+"/keepSessionsDays",schemaPath:"#/oneOf/1/properties/keepSessionsDays/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;}if(errors === _errs9){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){const err9: any = {instancePath:instancePath+"/keepSessionsDays",schemaPath:"#/oneOf/1/properties/keepSessionsDays/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;}else {if(data1 < 1 || isNaN(data1)){const err10: any = {instancePath:instancePath+"/keepSessionsDays",schemaPath:"#/oneOf/1/properties/keepSessionsDays/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}};if(vErrors === null){vErrors = [err10];}else {vErrors.push(err10);}errors++;}}}}}}}}else {const err11: any = {instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err11];}else {vErrors.push(err11);}errors++;}}var _valid0: any = _errs6 === errors;if(_valid0 && valid0){valid0 = false;passing0 = [passing0, 1];}else {if(_valid0){valid0 = true;passing0 = 1;if(props0 !== true){props0 = true;}}}if(!valid0){const err12: any = {instancePath,schemaPath:"#/oneOf",keyword:"oneOf",params:{passingSchemas: passing0}};if(vErrors === null){vErrors = [err12];}else {vErrors.push(err12);}errors++;validateDaemonRetentionUpdateRequest.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validateDaemonRetentionUpdateRequest.errors = vErrors;evaluated0.props = props0;return errors === 0;};
// prettier-ignore
validateDaemonRetentionUpdateRequest.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
/** Checks that a value is a {@link DaemonRetentionPurgeRequest}. */
// prettier-ignore
export const validateDaemonRetentionPurgeRequest: CompiledSchemaCheck<DaemonRetentionPurgeRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonRetentionPurgeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDaemonRetentionPurgeRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.cutoffAt === undefined) && (missing0 = "cutoffAt")){validateDaemonRetentionPurgeRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "cutoffAt")){validateDaemonRetentionPurgeRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.cutoffAt !== undefined){if(!(validateWireInstant.call(this, data.cutoffAt, {instancePath:instancePath+"/cutoffAt",parentData:data,parentDataProperty:"cutoffAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}}}}}else {validateDaemonRetentionPurgeRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDaemonRetentionPurgeRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDaemonRetentionPurgeRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link DaemonRetentionPurgeResponse}. */
// prettier-ignore
export const validateDaemonRetentionPurgeResponse: CompiledSchemaCheck<DaemonRetentionPurgeResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonRetentionPurgeResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDaemonRetentionPurgeResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.deletedSessionCount === undefined) && (missing0 = "deletedSessionCount")){validateDaemonRetentionPurgeResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "deletedSessionCount")){validateDaemonRetentionPurgeResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.deletedSessionCount !== undefined){let data0: any = data.deletedSessionCount;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validateDaemonRetentionPurgeResponse.errors = [{instancePath:instancePath+"/deletedSessionCount",schemaPath:"#/properties/deletedSessionCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs2){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validateDaemonRetentionPurgeResponse.errors = [{instancePath:instancePath+"/deletedSessionCount",schemaPath:"#/properties/deletedSessionCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < 0 || isNaN(data0)){validateDaemonRetentionPurgeResponse.errors = [{instancePath:instancePath+"/deletedSessionCount",schemaPath:"#/properties/deletedSessionCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}}}}}else {validateDaemonRetentionPurgeResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDaemonRetentionPurgeResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDaemonRetentionPurgeResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;

/** The methods of {@link DAEMON_RETENTION_METHOD_DESCRIPTORS}, each with its checks. */
export interface DaemonRetentionMethodDescriptors {
  readonly "daemon.retention.read": {
    readonly method: "daemon.retention.read";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<DaemonRetentionReadResponse>;
  };
  readonly "daemon.retention.update": {
    readonly method: "daemon.retention.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<DaemonRetentionUpdateRequest>;
    readonly responseCheck: SchemaCheck<DaemonRetentionBounds>;
  };
  readonly "daemon.retention.purge": {
    readonly method: "daemon.retention.purge";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<DaemonRetentionPurgeRequest>;
    readonly responseCheck: SchemaCheck<DaemonRetentionPurgeResponse>;
  };
  readonly "daemon.retention.subscribe": {
    readonly method: "daemon.retention.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<DaemonRetentionBounds>;
  };
}
/** The retention methods. */
export const DAEMON_RETENTION_METHOD_DESCRIPTORS: DaemonRetentionMethodDescriptors = Object.freeze({
  "daemon.retention.read": Object.freeze({
    method: "daemon.retention.read",
    procedureType: "query",
    mutating: false,
    requestCheck: validateEmptyPayload,
    responseCheck: validateDaemonRetentionReadResponse,
  }),
  "daemon.retention.update": Object.freeze({
    method: "daemon.retention.update",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateDaemonRetentionUpdateRequest,
    responseCheck: validateDaemonRetentionBounds,
  }),
  "daemon.retention.purge": Object.freeze({
    method: "daemon.retention.purge",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateDaemonRetentionPurgeRequest,
    responseCheck: validateDaemonRetentionPurgeResponse,
  }),
  "daemon.retention.subscribe": Object.freeze({
    method: "daemon.retention.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validateEmptyPayload,
    responseCheck: validateSubscribeAcknowledgmentResponse,
    emissionCheck: validateDaemonRetentionBounds,
  }),
});
