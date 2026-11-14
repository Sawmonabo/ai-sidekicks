// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The manifest the daemon keeps for every artifact in a session, and the closed set of its kinds.

import { type CompiledSchemaCheck, ucs2length } from "../../schema-check.js";
import { type WireInstant, validateWireInstant } from "../internal/wire-scalars.js";
import { type RunId, validateRunId } from "../run/id.js";
import { type SessionId, validateSessionId } from "../session/id.js";
import { type DeviceId, validateDeviceId } from "../trust-statement.js";
import { type ArtifactId, validateArtifactId } from "./id.js";

/**
 * The kind of an artifact: a file, a diff, a summary, a log, a design, or the output of one
 * workflow phase.
 */
export type ArtifactType = "file" | "diff" | "summary" | "log" | "design" | "workflowOutput";

/**
 * One artifact as the daemon records it: `id` names the manifest and `digest` the content, so two
 * manifests can share one payload. `metadata` is the artifact's freeform provenance and holds its
 * file name and media type. A member a newer daemon adds is kept in `rest`.
 */
export interface ArtifactManifest {
  /**
   * The manifest's id.
   */
  id: ArtifactId;
  /**
   * The session the artifact belongs to.
   */
  sessionId: SessionId;
  /**
   * The run that produced the artifact; absent when no run did.
   */
  runId?: RunId;
  /**
   * The device the publishing request came from; absent when the daemon produced it itself.
   */
  createdBy?: DeviceId;
  /**
   * The artifact's kind.
   */
  artifactType: ArtifactType | string;
  /**
   * The payload's SHA-256 digest; a content-addressed manifest always has one.
   */
  digest: string;
  /**
   * The payload's length in bytes, measured by the daemon rather than declared by the caller.
   */
  size: number;
  /**
   * The artifact's freeform provenance.
   */
  metadata: {
    [k: string]: unknown | undefined;
  };
  /**
   * When the manifest was written.
   */
  createdAt: WireInstant;
  [k: string]: unknown | undefined;
}

// prettier-ignore
const schema131: any = {"description":"The kind of an artifact: a file, a diff, a summary, a log, a design, or the output of one\nworkflow phase.","type":"string","enum":["file","diff","summary","log","design","workflowOutput"]};
/** Checks that a value is a {@link ArtifactType}. */
// prettier-ignore
export const validateArtifactType: CompiledSchemaCheck<ArtifactType> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ArtifactType {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateArtifactType.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateArtifactType.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((((data === "file") || (data === "diff")) || (data === "summary")) || (data === "log")) || (data === "design")) || (data === "workflowOutput"))){validateArtifactType.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema131.enum}}];return false;}validateArtifactType.errors = vErrors;return errors === 0;};
// prettier-ignore
validateArtifactType.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func1 = ucs2length;
/** Checks that a value is a {@link ArtifactManifest}. */
// prettier-ignore
export const validateArtifactManifest: CompiledSchemaCheck<ArtifactManifest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ArtifactManifest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateArtifactManifest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((((data.id === undefined) && (missing0 = "id")) || ((data.sessionId === undefined) && (missing0 = "sessionId"))) || ((data.artifactType === undefined) && (missing0 = "artifactType"))) || ((data.digest === undefined) && (missing0 = "digest"))) || ((data.size === undefined) && (missing0 = "size"))) || ((data.metadata === undefined) && (missing0 = "metadata"))) || ((data.createdAt === undefined) && (missing0 = "createdAt"))){validateArtifactManifest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {for(const key0 in data){const _errs1: any = errors;const _errs2: any = errors;const _errs3: any = errors;if("__proto__" !== key0){const err0: any = {};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var valid1: any = _errs3 === errors;if(valid1){const err1: any = {instancePath,schemaPath:"#/propertyNames/not",keyword:"not",params:{},propertyName:key0};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}else {errors = _errs2;if(vErrors !== null){if(_errs2){vErrors.length = _errs2;}else {vErrors = null;}}}var valid0: any = _errs1 === errors;if(!valid0){const err2: any = {instancePath,schemaPath:"#/propertyNames",keyword:"propertyNames",params:{propertyName: key0}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;validateArtifactManifest.errors = vErrors;return false;break;}}if(valid0){if(data.id !== undefined){const _errs5: any = errors;if(!(validateArtifactId.call(this, data.id, {instancePath:instancePath+"/id",parentData:data,parentDataProperty:"id",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateArtifactId.errors : vErrors.concat(validateArtifactId.errors);errors = vErrors.length;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.sessionId !== undefined){const _errs6: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid2: any = _errs6 === errors;}else {var valid2: any = true;}if(valid2){if(data.runId !== undefined){const _errs7: any = errors;if(!(validateRunId.call(this, data.runId, {instancePath:instancePath+"/runId",parentData:data,parentDataProperty:"runId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunId.errors : vErrors.concat(validateRunId.errors);errors = vErrors.length;}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.createdBy !== undefined){const _errs8: any = errors;if(!(validateDeviceId.call(this, data.createdBy, {instancePath:instancePath+"/createdBy",parentData:data,parentDataProperty:"createdBy",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceId.errors : vErrors.concat(validateDeviceId.errors);errors = vErrors.length;}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}if(valid2){if(data.artifactType !== undefined){let data4: any = data.artifactType;const _errs9: any = errors;const _errs10: any = errors;let valid3: any = false;const _errs11: any = errors;if(!(validateArtifactType.call(this, data4, {instancePath:instancePath+"/artifactType",parentData:data,parentDataProperty:"artifactType",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateArtifactType.errors : vErrors.concat(validateArtifactType.errors);errors = vErrors.length;}var _valid0: any = _errs11 === errors;valid3 = valid3 || _valid0;const _errs12: any = errors;if(typeof data4 !== "string"){const err3: any = {instancePath:instancePath+"/artifactType",schemaPath:"#/properties/artifactType/anyOf/1/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}var _valid0: any = _errs12 === errors;valid3 = valid3 || _valid0;if(!valid3){const err4: any = {instancePath:instancePath+"/artifactType",schemaPath:"#/properties/artifactType/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;validateArtifactManifest.errors = vErrors;return false;}else {errors = _errs10;if(vErrors !== null){if(_errs10){vErrors.length = _errs10;}else {vErrors = null;}}}var valid2: any = _errs9 === errors;}else {var valid2: any = true;}if(valid2){if(data.digest !== undefined){let data5: any = data.digest;const _errs14: any = errors;if(errors === _errs14){if(typeof data5 === "string"){if(func1(data5) < 1){validateArtifactManifest.errors = [{instancePath:instancePath+"/digest",schemaPath:"#/properties/digest/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateArtifactManifest.errors = [{instancePath:instancePath+"/digest",schemaPath:"#/properties/digest/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs14 === errors;}else {var valid2: any = true;}if(valid2){if(data.size !== undefined){let data6: any = data.size;const _errs16: any = errors;if(!(((typeof data6 == "number") && (!(data6 % 1) && !isNaN(data6))) && (isFinite(data6)))){validateArtifactManifest.errors = [{instancePath:instancePath+"/size",schemaPath:"#/properties/size/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs16){if((typeof data6 == "number") && (isFinite(data6))){if(data6 > 9007199254740991 || isNaN(data6)){validateArtifactManifest.errors = [{instancePath:instancePath+"/size",schemaPath:"#/properties/size/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data6 < 0 || isNaN(data6)){validateArtifactManifest.errors = [{instancePath:instancePath+"/size",schemaPath:"#/properties/size/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs16 === errors;}else {var valid2: any = true;}if(valid2){if(data.metadata !== undefined){let data7: any = data.metadata;const _errs18: any = errors;if(errors === _errs18){if(data7 && typeof data7 == "object" && !Array.isArray(data7)){for(const key1 in data7){const _errs20: any = errors;const _errs21: any = errors;if(typeof key1 !== "string"){const err5: any = {instancePath:instancePath+"/metadata",schemaPath:"#/properties/metadata/propertyNames/allOf/0/type",keyword:"type",params:{type: "string"},propertyName:key1};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}var valid5: any = _errs21 === errors;if(valid5){const _errs23: any = errors;const _errs24: any = errors;const _errs25: any = errors;if("__proto__" !== key1){const err6: any = {};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}var valid6: any = _errs25 === errors;if(valid6){const err7: any = {instancePath:instancePath+"/metadata",schemaPath:"#/properties/metadata/propertyNames/allOf/1/not",keyword:"not",params:{},propertyName:key1};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;}else {errors = _errs24;if(vErrors !== null){if(_errs24){vErrors.length = _errs24;}else {vErrors = null;}}}var valid5: any = _errs23 === errors;}var valid4: any = _errs20 === errors;if(!valid4){const err8: any = {instancePath:instancePath+"/metadata",schemaPath:"#/properties/metadata/propertyNames",keyword:"propertyNames",params:{propertyName: key1}};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;validateArtifactManifest.errors = vErrors;return false;break;}}if(valid4){for(const key2 in data7){const _errs27: any = errors;var valid7: any = _errs27 === errors;if(!valid7){break;}}}}else {validateArtifactManifest.errors = [{instancePath:instancePath+"/metadata",schemaPath:"#/properties/metadata/type",keyword:"type",params:{type: "object"}}];return false;}}var valid2: any = _errs18 === errors;}else {var valid2: any = true;}if(valid2){if(data.createdAt !== undefined){const _errs29: any = errors;if(!(validateWireInstant.call(this, data.createdAt, {instancePath:instancePath+"/createdAt",parentData:data,parentDataProperty:"createdAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid2: any = _errs29 === errors;}else {var valid2: any = true;}}}}}}}}}}}}else {validateArtifactManifest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateArtifactManifest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateArtifactManifest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
