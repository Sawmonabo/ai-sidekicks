// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The manifest the daemon keeps for every artifact in a session, and the closed set of its kinds.

import { type SchemaCheck, ucs2length } from "../../schema-check.js";
import type { WireInstant } from "../internal/wire-scalars.js";
import type { RunId } from "../run/id.js";
import type { SessionId } from "../session/id.js";
import type { DeviceId } from "../trust-statement.js";
import type { ArtifactId } from "./id.js";

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
const schema398: any = {"description":"The kind of an artifact: a file, a diff, a summary, a log, a design, or the output of one\nworkflow phase.","type":"string","enum":["file","diff","summary","log","design","workflowOutput"]};
// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
const pattern5 = new RegExp("^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$", "u");
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
function validate207(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ArtifactManifest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate207.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((((data.id === undefined) && (missing0 = "id")) || ((data.sessionId === undefined) && (missing0 = "sessionId"))) || ((data.artifactType === undefined) && (missing0 = "artifactType"))) || ((data.digest === undefined) && (missing0 = "digest"))) || ((data.size === undefined) && (missing0 = "size"))) || ((data.metadata === undefined) && (missing0 = "metadata"))) || ((data.createdAt === undefined) && (missing0 = "createdAt"))){validate207.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {for(const key0 in data){const _errs1: any = errors;const _errs2: any = errors;const _errs3: any = errors;if("__proto__" !== key0){const err0: any = {};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var valid1: any = _errs3 === errors;if(valid1){const err1: any = {instancePath,schemaPath:"#/propertyNames/not",keyword:"not",params:{},propertyName:key0};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}else {errors = _errs2;if(vErrors !== null){if(_errs2){vErrors.length = _errs2;}else {vErrors = null;}}}var valid0: any = _errs1 === errors;if(!valid0){const err2: any = {instancePath,schemaPath:"#/propertyNames",keyword:"propertyNames",params:{propertyName: key0}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;validate207.errors = vErrors;return false;break;}}if(valid0){if(data.id !== undefined){let data0: any = data.id;const _errs5: any = errors;const _errs6: any = errors;if(errors === _errs6){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate207.errors = [{instancePath:instancePath+"/id",schemaPath:"sidekicks-contracts:artifacts/id#/$defs/ArtifactId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate207.errors = [{instancePath:instancePath+"/id",schemaPath:"sidekicks-contracts:artifacts/id#/$defs/ArtifactId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.sessionId !== undefined){let data1: any = data.sessionId;const _errs9: any = errors;const _errs10: any = errors;if(errors === _errs10){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate207.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate207.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs9 === errors;}else {var valid2: any = true;}if(valid2){if(data.runId !== undefined){let data2: any = data.runId;const _errs13: any = errors;const _errs14: any = errors;if(errors === _errs14){if(typeof data2 === "string"){if(!pattern4.test(data2)){validate207.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate207.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs13 === errors;}else {var valid2: any = true;}if(valid2){if(data.createdBy !== undefined){let data3: any = data.createdBy;const _errs17: any = errors;const _errs18: any = errors;if(errors === _errs18){if(typeof data3 === "string"){if(func1(data3) > 256){validate207.errors = [{instancePath:instancePath+"/createdBy",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(!pattern6.test(data3)){validate207.errors = [{instancePath:instancePath+"/createdBy",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate207.errors = [{instancePath:instancePath+"/createdBy",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs17 === errors;}else {var valid2: any = true;}if(valid2){if(data.artifactType !== undefined){let data4: any = data.artifactType;const _errs21: any = errors;const _errs22: any = errors;let valid7: any = false;const _errs23: any = errors;if(typeof data4 !== "string"){const err3: any = {instancePath:instancePath+"/artifactType",schemaPath:"#/$defs/ArtifactType/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}if(!((((((data4 === "file") || (data4 === "diff")) || (data4 === "summary")) || (data4 === "log")) || (data4 === "design")) || (data4 === "workflowOutput"))){const err4: any = {instancePath:instancePath+"/artifactType",schemaPath:"#/$defs/ArtifactType/enum",keyword:"enum",params:{allowedValues: schema398.enum}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}var _valid0: any = _errs23 === errors;valid7 = valid7 || _valid0;const _errs26: any = errors;if(typeof data4 !== "string"){const err5: any = {instancePath:instancePath+"/artifactType",schemaPath:"#/properties/artifactType/anyOf/1/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}var _valid0: any = _errs26 === errors;valid7 = valid7 || _valid0;if(!valid7){const err6: any = {instancePath:instancePath+"/artifactType",schemaPath:"#/properties/artifactType/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;validate207.errors = vErrors;return false;}else {errors = _errs22;if(vErrors !== null){if(_errs22){vErrors.length = _errs22;}else {vErrors = null;}}}var valid2: any = _errs21 === errors;}else {var valid2: any = true;}if(valid2){if(data.digest !== undefined){let data5: any = data.digest;const _errs28: any = errors;if(errors === _errs28){if(typeof data5 === "string"){if(func1(data5) < 1){validate207.errors = [{instancePath:instancePath+"/digest",schemaPath:"#/properties/digest/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate207.errors = [{instancePath:instancePath+"/digest",schemaPath:"#/properties/digest/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs28 === errors;}else {var valid2: any = true;}if(valid2){if(data.size !== undefined){let data6: any = data.size;const _errs30: any = errors;if(!(((typeof data6 == "number") && (!(data6 % 1) && !isNaN(data6))) && (isFinite(data6)))){validate207.errors = [{instancePath:instancePath+"/size",schemaPath:"#/properties/size/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs30){if((typeof data6 == "number") && (isFinite(data6))){if(data6 > 9007199254740991 || isNaN(data6)){validate207.errors = [{instancePath:instancePath+"/size",schemaPath:"#/properties/size/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data6 < 0 || isNaN(data6)){validate207.errors = [{instancePath:instancePath+"/size",schemaPath:"#/properties/size/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs30 === errors;}else {var valid2: any = true;}if(valid2){if(data.metadata !== undefined){let data7: any = data.metadata;const _errs32: any = errors;if(errors === _errs32){if(data7 && typeof data7 == "object" && !Array.isArray(data7)){for(const key1 in data7){const _errs34: any = errors;const _errs35: any = errors;if(typeof key1 !== "string"){const err7: any = {instancePath:instancePath+"/metadata",schemaPath:"#/properties/metadata/propertyNames/allOf/0/type",keyword:"type",params:{type: "string"},propertyName:key1};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;}var valid10: any = _errs35 === errors;if(valid10){const _errs37: any = errors;const _errs38: any = errors;const _errs39: any = errors;if("__proto__" !== key1){const err8: any = {};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;}var valid11: any = _errs39 === errors;if(valid11){const err9: any = {instancePath:instancePath+"/metadata",schemaPath:"#/properties/metadata/propertyNames/allOf/1/not",keyword:"not",params:{},propertyName:key1};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;}else {errors = _errs38;if(vErrors !== null){if(_errs38){vErrors.length = _errs38;}else {vErrors = null;}}}var valid10: any = _errs37 === errors;}var valid9: any = _errs34 === errors;if(!valid9){const err10: any = {instancePath:instancePath+"/metadata",schemaPath:"#/properties/metadata/propertyNames",keyword:"propertyNames",params:{propertyName: key1}};if(vErrors === null){vErrors = [err10];}else {vErrors.push(err10);}errors++;validate207.errors = vErrors;return false;break;}}if(valid9){for(const key2 in data7){const _errs41: any = errors;var valid12: any = _errs41 === errors;if(!valid12){break;}}}}else {validate207.errors = [{instancePath:instancePath+"/metadata",schemaPath:"#/properties/metadata/type",keyword:"type",params:{type: "object"}}];return false;}}var valid2: any = _errs32 === errors;}else {var valid2: any = true;}if(valid2){if(data.createdAt !== undefined){let data9: any = data.createdAt;const _errs43: any = errors;const _errs44: any = errors;if(errors === _errs44){if(typeof data9 === "string"){if(!pattern5.test(data9)){validate207.errors = [{instancePath:instancePath+"/createdAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate207.errors = [{instancePath:instancePath+"/createdAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs43 === errors;}else {var valid2: any = true;}}}}}}}}}}}}else {validate207.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate207.errors = vErrors;return errors === 0;}
// prettier-ignore
validate207.errors = null as any[] | null;
// prettier-ignore
validate207.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate208(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ArtifactType {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate208.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validate208.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((((data === "file") || (data === "diff")) || (data === "summary")) || (data === "log")) || (data === "design")) || (data === "workflowOutput"))){validate208.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema398.enum}}];return false;}validate208.errors = vErrors;return errors === 0;}
// prettier-ignore
validate208.errors = null as any[] | null;
// prettier-ignore
validate208.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ArtifactManifest}. */
export const validateArtifactManifest: SchemaCheck<ArtifactManifest> = validate207;
/** Checks that a value is a {@link ArtifactType}. */
export const validateArtifactType: SchemaCheck<ArtifactType> = validate208;
