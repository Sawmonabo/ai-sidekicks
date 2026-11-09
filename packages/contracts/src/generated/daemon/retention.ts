// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The two retention bounds on Settings › Runtime, and `Delete old data`.

import type { SchemaCheck } from "../../schema-check.js";
import type { WireInstant } from "../internal/wire-scalars.js";
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

// prettier-ignore
function validate362(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonRetentionBounds {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate362.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.keepDiagnosticLogsDays === undefined) && (missing0 = "keepDiagnosticLogsDays")) || ((data.keepSessionsDays === undefined) && (missing0 = "keepSessionsDays"))){validate362.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "keepDiagnosticLogsDays") || (key0 === "keepSessionsDays"))){validate362.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.keepDiagnosticLogsDays !== undefined){let data0: any = data.keepDiagnosticLogsDays;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validate362.errors = [{instancePath:instancePath+"/keepDiagnosticLogsDays",schemaPath:"#/properties/keepDiagnosticLogsDays/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs2){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validate362.errors = [{instancePath:instancePath+"/keepDiagnosticLogsDays",schemaPath:"#/properties/keepDiagnosticLogsDays/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < 1 || isNaN(data0)){validate362.errors = [{instancePath:instancePath+"/keepDiagnosticLogsDays",schemaPath:"#/properties/keepDiagnosticLogsDays/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.keepSessionsDays !== undefined){let data1: any = data.keepSessionsDays;const _errs4: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validate362.errors = [{instancePath:instancePath+"/keepSessionsDays",schemaPath:"#/properties/keepSessionsDays/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validate362.errors = [{instancePath:instancePath+"/keepSessionsDays",schemaPath:"#/properties/keepSessionsDays/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 1 || isNaN(data1)){validate362.errors = [{instancePath:instancePath+"/keepSessionsDays",schemaPath:"#/properties/keepSessionsDays/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validate362.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate362.errors = vErrors;return errors === 0;}
// prettier-ignore
validate362.errors = null as any[] | null;
// prettier-ignore
validate362.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern5 = new RegExp("^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$", "u");
// prettier-ignore
function validate363(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonRetentionPurgeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate363.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.cutoffAt === undefined) && (missing0 = "cutoffAt")){validate363.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "cutoffAt")){validate363.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.cutoffAt !== undefined){let data0: any = data.cutoffAt;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern5.test(data0)){validate363.errors = [{instancePath:instancePath+"/cutoffAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate363.errors = [{instancePath:instancePath+"/cutoffAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate363.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate363.errors = vErrors;return errors === 0;}
// prettier-ignore
validate363.errors = null as any[] | null;
// prettier-ignore
validate363.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate364(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonRetentionPurgeResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate364.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.deletedSessionCount === undefined) && (missing0 = "deletedSessionCount")){validate364.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "deletedSessionCount")){validate364.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.deletedSessionCount !== undefined){let data0: any = data.deletedSessionCount;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validate364.errors = [{instancePath:instancePath+"/deletedSessionCount",schemaPath:"#/properties/deletedSessionCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs2){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validate364.errors = [{instancePath:instancePath+"/deletedSessionCount",schemaPath:"#/properties/deletedSessionCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < 0 || isNaN(data0)){validate364.errors = [{instancePath:instancePath+"/deletedSessionCount",schemaPath:"#/properties/deletedSessionCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}}}}}else {validate364.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate364.errors = vErrors;return errors === 0;}
// prettier-ignore
validate364.errors = null as any[] | null;
// prettier-ignore
validate364.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate366(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate366.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.archivedSessionCount === undefined) && (missing0 = "archivedSessionCount")) || ((data.cutoffAt === undefined) && (missing0 = "cutoffAt"))){validate366.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "archivedSessionCount") || (key0 === "cutoffAt"))){validate366.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.archivedSessionCount !== undefined){let data0: any = data.archivedSessionCount;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validate366.errors = [{instancePath:instancePath+"/archivedSessionCount",schemaPath:"#/properties/archivedSessionCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs2){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validate366.errors = [{instancePath:instancePath+"/archivedSessionCount",schemaPath:"#/properties/archivedSessionCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < 0 || isNaN(data0)){validate366.errors = [{instancePath:instancePath+"/archivedSessionCount",schemaPath:"#/properties/archivedSessionCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.cutoffAt !== undefined){let data1: any = data.cutoffAt;const _errs4: any = errors;const _errs5: any = errors;if(errors === _errs5){if(typeof data1 === "string"){if(!pattern5.test(data1)){validate366.errors = [{instancePath:instancePath+"/cutoffAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate366.errors = [{instancePath:instancePath+"/cutoffAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validate366.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate366.errors = vErrors;return errors === 0;}
// prettier-ignore
validate366.errors = null as any[] | null;
// prettier-ignore
validate366.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate365(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonRetentionReadResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate365.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.keepDiagnosticLogsDays === undefined) && (missing0 = "keepDiagnosticLogsDays")) || ((data.keepSessionsDays === undefined) && (missing0 = "keepSessionsDays"))) || ((data.purge === undefined) && (missing0 = "purge"))){validate365.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "keepDiagnosticLogsDays") || (key0 === "keepSessionsDays")) || (key0 === "purge"))){validate365.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.keepDiagnosticLogsDays !== undefined){let data0: any = data.keepDiagnosticLogsDays;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validate365.errors = [{instancePath:instancePath+"/keepDiagnosticLogsDays",schemaPath:"#/properties/keepDiagnosticLogsDays/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs2){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validate365.errors = [{instancePath:instancePath+"/keepDiagnosticLogsDays",schemaPath:"#/properties/keepDiagnosticLogsDays/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < 1 || isNaN(data0)){validate365.errors = [{instancePath:instancePath+"/keepDiagnosticLogsDays",schemaPath:"#/properties/keepDiagnosticLogsDays/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.keepSessionsDays !== undefined){let data1: any = data.keepSessionsDays;const _errs4: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validate365.errors = [{instancePath:instancePath+"/keepSessionsDays",schemaPath:"#/properties/keepSessionsDays/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validate365.errors = [{instancePath:instancePath+"/keepSessionsDays",schemaPath:"#/properties/keepSessionsDays/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 1 || isNaN(data1)){validate365.errors = [{instancePath:instancePath+"/keepSessionsDays",schemaPath:"#/properties/keepSessionsDays/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.purge !== undefined){const _errs6: any = errors;if(!(validate366.call(this, data.purge, {instancePath:instancePath+"/purge",parentData:data,parentDataProperty:"purge",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate366.errors : vErrors.concat(validate366.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}else {validate365.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate365.errors = vErrors;return errors === 0;}
// prettier-ignore
validate365.errors = null as any[] | null;
// prettier-ignore
validate365.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate368(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonRetentionUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate368.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;let passing0: any = null;const _errs1: any = errors;if(errors === _errs1){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.keepDiagnosticLogsDays === undefined) && (missing0 = "keepDiagnosticLogsDays")){const err0: any = {instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {const _errs3: any = errors;for(const key0 in data){if(!(key0 === "keepDiagnosticLogsDays")){const err1: any = {instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;break;}}if(_errs3 === errors){if(data.keepDiagnosticLogsDays !== undefined){let data0: any = data.keepDiagnosticLogsDays;const _errs4: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){const err2: any = {instancePath:instancePath+"/keepDiagnosticLogsDays",schemaPath:"#/oneOf/0/properties/keepDiagnosticLogsDays/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}if(errors === _errs4){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){const err3: any = {instancePath:instancePath+"/keepDiagnosticLogsDays",schemaPath:"#/oneOf/0/properties/keepDiagnosticLogsDays/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}else {if(data0 < 1 || isNaN(data0)){const err4: any = {instancePath:instancePath+"/keepDiagnosticLogsDays",schemaPath:"#/oneOf/0/properties/keepDiagnosticLogsDays/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}}}}}}}}else {const err5: any = {instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}}var _valid0: any = _errs1 === errors;if(_valid0){valid0 = true;passing0 = 0;var props0: any = true;}const _errs6: any = errors;if(errors === _errs6){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((data.keepSessionsDays === undefined) && (missing1 = "keepSessionsDays")){const err6: any = {instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}else {const _errs8: any = errors;for(const key1 in data){if(!(key1 === "keepSessionsDays")){const err7: any = {instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;break;}}if(_errs8 === errors){if(data.keepSessionsDays !== undefined){let data1: any = data.keepSessionsDays;const _errs9: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){const err8: any = {instancePath:instancePath+"/keepSessionsDays",schemaPath:"#/oneOf/1/properties/keepSessionsDays/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;}if(errors === _errs9){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){const err9: any = {instancePath:instancePath+"/keepSessionsDays",schemaPath:"#/oneOf/1/properties/keepSessionsDays/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;}else {if(data1 < 1 || isNaN(data1)){const err10: any = {instancePath:instancePath+"/keepSessionsDays",schemaPath:"#/oneOf/1/properties/keepSessionsDays/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}};if(vErrors === null){vErrors = [err10];}else {vErrors.push(err10);}errors++;}}}}}}}}else {const err11: any = {instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err11];}else {vErrors.push(err11);}errors++;}}var _valid0: any = _errs6 === errors;if(_valid0 && valid0){valid0 = false;passing0 = [passing0, 1];}else {if(_valid0){valid0 = true;passing0 = 1;if(props0 !== true){props0 = true;}}}if(!valid0){const err12: any = {instancePath,schemaPath:"#/oneOf",keyword:"oneOf",params:{passingSchemas: passing0}};if(vErrors === null){vErrors = [err12];}else {vErrors.push(err12);}errors++;validate368.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validate368.errors = vErrors;evaluated0.props = props0;return errors === 0;}
// prettier-ignore
validate368.errors = null as any[] | null;
// prettier-ignore
validate368.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
/** Checks that a value is a {@link DaemonRetentionBounds}. */
export const validateDaemonRetentionBounds: SchemaCheck<DaemonRetentionBounds> = validate362;
/** Checks that a value is a {@link DaemonRetentionPurgeRequest}. */
export const validateDaemonRetentionPurgeRequest: SchemaCheck<DaemonRetentionPurgeRequest> =
  validate363;
/** Checks that a value is a {@link DaemonRetentionPurgeResponse}. */
export const validateDaemonRetentionPurgeResponse: SchemaCheck<DaemonRetentionPurgeResponse> =
  validate364;
/** Checks that a value is a {@link DaemonRetentionReadResponse}. */
export const validateDaemonRetentionReadResponse: SchemaCheck<DaemonRetentionReadResponse> =
  validate365;
/** Checks that a value is a {@link DaemonRetentionUpdateRequest}. */
export const validateDaemonRetentionUpdateRequest: SchemaCheck<DaemonRetentionUpdateRequest> =
  validate368;

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
