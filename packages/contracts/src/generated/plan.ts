// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The plan record and the one call that answers it.

import { type CompiledSchemaCheck, type SchemaCheck, ucs2length } from "../schema-check.js";
import { type ArtifactId, validateArtifactId } from "./artifacts/id.js";
import { type ProviderId, validateProviderId } from "./provider/id.js";
import { type RunId, validateRunId } from "./run/id.js";
import { type PermissionLevel, validatePermissionLevel } from "./session/controls/methods.js";
import { type SessionId, validateSessionId } from "./session/id.js";
import { type DeviceId, validateDeviceId } from "./trust-statement.js";

/**
 * The daemon-minted id of one plan record, stable across a reload and every device.
 */
export type PlanId = string & { readonly __brand: "PlanId" };
/**
 * Where a plan stands: `waiting` while its card is up, `accepted` after it is built here,
 * `handedOff` after it is built in a fresh session, and `open` after the person keeps planning,
 * which answers the held request and leaves the plan as a record the next plan replaces.
 */
export type PlanState = "waiting" | "accepted" | "handedOff" | "open";
/**
 * Why a plan's hold ended with no verdict: its turn was interrupted, the provider withdrew its
 * request, its run ended (a restart of the background service among the ways a run ends), a newer
 * plan of the same session took its place, or the fresh session it was handed to was archived,
 * closed or purged before its first turn was admitted.
 */
export type PlanHoldEndedReason =
  | "interrupted"
  | "withdrawn"
  | "runEnded"
  | "superseded"
  | "freshSessionGone";
/**
 * A step of a hand-off after the plan reads handed off, in the order they run: the fresh
 * session's birth, its folder's bind, the planning transcript's file, the plan's copy into the
 * fresh session, its activation, and the plan sent as its first message.
 */
export type PlanHandOffStep =
  | "birth"
  | "bind"
  | "transcriptFile"
  | "seedPlan"
  | "activation"
  | "seedMessage";
/**
 * `plan.resolve`: the verdict on one plan, keep planning, build here, or build in a fresh
 * session; only `fresh` names the session to mint.
 */
export type PlanResolveRequest =
  | {
      verdict: "keep";
      /**
       * The plan.
       */
      planId: PlanId;
    }
  | {
      verdict: "build";
      /**
       * The plan.
       */
      planId: PlanId;
    }
  | {
      verdict: "fresh";
      /**
       * The plan.
       */
      planId: PlanId;
      /**
       * The session to mint.
       */
      fresh: PlanFreshSession;
    };
/**
 * The `plan.resolve` result: the plan's state after the verdict, or the state an earlier verdict
 * settled, never `waiting`; only a handed-off plan names its fresh session, so the caller switches
 * to it without another read.
 */
export type PlanResolveResponse =
  | {
      state: "accepted";
      /**
       * The plan.
       */
      planId: PlanId;
    }
  | {
      state: "handedOff";
      /**
       * The plan.
       */
      planId: PlanId;
      /**
       * The fresh session.
       */
      freshSessionId: SessionId;
    }
  | {
      state: "open";
      /**
       * The plan.
       */
      planId: PlanId;
    };

/**
 * `plan.proposed`: the plan as the agent wrote it, never read off the disk, with the daemon's
 * count of its top-level steps and the files it names, and the artifact that keeps it, written
 * before this event. `planFilePath` is present only where the provider wrote the plan as a file;
 * `holdsRequest` says a held provider request waits on the verdict.
 */
export interface PlanProposedPayload {
  /**
   * The plan.
   */
  planId: PlanId;
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run that proposed it.
   */
  runId: RunId;
  /**
   * Its title.
   */
  title: string;
  /**
   * Its text.
   */
  text: string;
  /**
   * How many top-level steps it has.
   */
  stepCount: number;
  /**
   * How many files it names.
   */
  fileCount: number;
  /**
   * The file the provider wrote it to.
   */
  planFilePath?: string;
  /**
   * The artifact that keeps the plan.
   */
  artifactId: ArtifactId;
  /**
   * Whether a held provider request waits on the verdict.
   */
  holdsRequest: boolean;
}
/**
 * `plan.accepted`: the plan is being built in its own session.
 */
export interface PlanAcceptedPayload {
  /**
   * The plan.
   */
  planId: PlanId;
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The device whose verdict it was.
   */
  deviceId: DeviceId;
}
/**
 * `plan.kept`: the person kept planning; the provider went back to planning and the plan stays a
 * record.
 */
export interface PlanKeptPayload {
  /**
   * The plan.
   */
  planId: PlanId;
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The device whose verdict it was.
   */
  deviceId: DeviceId;
}
/**
 * `plan.hold.ended`: the plan's hold ended with no verdict. The plan settles `open`, its card
 * closing on every device and the plan staying readable, except after `freshSessionGone`, where it
 * waits again with its card up.
 */
export interface PlanHoldEndedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The plan.
   */
  planId: PlanId;
  /**
   * Why the hold ended.
   */
  reason: PlanHoldEndedReason;
}
/**
 * `plan.handedOff`: the plan seeded a fresh session, which the system message opens.
 */
export interface PlanHandedOffPayload {
  /**
   * The plan.
   */
  planId: PlanId;
  /**
   * The planning session.
   */
  sessionId: SessionId;
  /**
   * The session it seeded.
   */
  freshSessionId: SessionId;
  /**
   * The device whose verdict it was.
   */
  deviceId: DeviceId;
}
/**
 * `plan.handOff.failed`: a hand-off step did not finish; the plan stays handed off, and the next
 * `fresh` verdict runs the unfinished steps again.
 */
export interface PlanHandOffFailedPayload {
  /**
   * The plan.
   */
  planId: PlanId;
  /**
   * The fresh session.
   */
  freshSessionId: SessionId;
  /**
   * The step that did not finish.
   */
  step: PlanHandOffStep;
  /**
   * Why the step did not finish, in the words of its failure.
   */
  cause: string;
}
/**
 * The details a `plan.handOffUnfinished` refusal carries: the fresh session and the step that did
 * not finish.
 */
export interface PlanHandOffUnfinishedDetails {
  /**
   * The fresh session.
   */
  freshSessionId: SessionId;
  /**
   * The step that did not finish.
   */
  step: PlanHandOffStep;
}
/**
 * The session a `fresh` verdict mints: the provider it runs and the level it starts at, the
 * planning session's level or, where that provider cannot give it, one of that provider's levels
 * the person picks. The rest is the planning session's: the same project and worktree, the
 * provider's current account, and the plan as the seed.
 */
export interface PlanFreshSession {
  /**
   * The provider.
   */
  providerName: ProviderId;
  /**
   * The level.
   */
  level: PermissionLevel;
}

// prettier-ignore
const pattern3 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
/** Checks that a value is a {@link PlanId}. */
// prettier-ignore
export const validatePlanId: CompiledSchemaCheck<PlanId> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PlanId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePlanId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern3.test(data)){validatePlanId.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validatePlanId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validatePlanId.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePlanId.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema136: any = {"description":"Where a plan stands: `waiting` while its card is up, `accepted` after it is built here,\n`handedOff` after it is built in a fresh session, and `open` after the person keeps planning,\nwhich answers the held request and leaves the plan as a record the next plan replaces.","type":"string","enum":["waiting","accepted","handedOff","open"]};
/** Checks that a value is a {@link PlanState}. */
// prettier-ignore
export const validatePlanState: CompiledSchemaCheck<PlanState> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PlanState {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePlanState.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validatePlanState.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((data === "waiting") || (data === "accepted")) || (data === "handedOff")) || (data === "open"))){validatePlanState.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema136.enum}}];return false;}validatePlanState.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePlanState.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema397: any = {"type":"object","additionalProperties":false,"properties":{"planId":{"$ref":"#/$defs/PlanId","description":"The plan."},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"runId":{"$ref":"sidekicks-contracts:run/id#/$defs/RunId","description":"The run that proposed it."},"title":{"type":"string","description":"Its title."},"text":{"type":"string","description":"Its text."},"stepCount":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"How many top-level steps it has."},"fileCount":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"How many files it names."},"planFilePath":{"type":"string","maxLength":4096,"pattern":"^[^\\x00]*$","minLength":1,"description":"The file the provider wrote it to."},"artifactId":{"$ref":"sidekicks-contracts:artifacts/id#/$defs/ArtifactId","description":"The artifact that keeps the plan."},"holdsRequest":{"type":"boolean","description":"Whether a held provider request waits on the verdict."}},"required":["planId","sessionId","runId","title","text","stepCount","fileCount","artifactId","holdsRequest"],"description":"`plan.proposed`: the plan as the agent wrote it, never read off the disk, with the daemon's\ncount of its top-level steps and the files it names, and the artifact that keeps it, written\nbefore this event. `planFilePath` is present only where the provider wrote the plan as a file;\n`holdsRequest` says a held provider request waits on the verdict."};
// prettier-ignore
const func2 = Object.prototype.hasOwnProperty;
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern33 = new RegExp("^[^\\x00]*$", "u");
/** Checks that a value is a {@link PlanProposedPayload}. */
// prettier-ignore
export const validatePlanProposedPayload: CompiledSchemaCheck<PlanProposedPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PlanProposedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePlanProposedPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((((((data.planId === undefined) && (missing0 = "planId")) || ((data.sessionId === undefined) && (missing0 = "sessionId"))) || ((data.runId === undefined) && (missing0 = "runId"))) || ((data.title === undefined) && (missing0 = "title"))) || ((data.text === undefined) && (missing0 = "text"))) || ((data.stepCount === undefined) && (missing0 = "stepCount"))) || ((data.fileCount === undefined) && (missing0 = "fileCount"))) || ((data.artifactId === undefined) && (missing0 = "artifactId"))) || ((data.holdsRequest === undefined) && (missing0 = "holdsRequest"))){validatePlanProposedPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(func2.call(schema397.properties, key0))){validatePlanProposedPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.planId !== undefined){const _errs2: any = errors;if(!(validatePlanId.call(this, data.planId, {instancePath:instancePath+"/planId",parentData:data,parentDataProperty:"planId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePlanId.errors : vErrors.concat(validatePlanId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.sessionId !== undefined){const _errs3: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.runId !== undefined){const _errs4: any = errors;if(!(validateRunId.call(this, data.runId, {instancePath:instancePath+"/runId",parentData:data,parentDataProperty:"runId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunId.errors : vErrors.concat(validateRunId.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.title !== undefined){const _errs5: any = errors;if(typeof data.title !== "string"){validatePlanProposedPayload.errors = [{instancePath:instancePath+"/title",schemaPath:"#/properties/title/type",keyword:"type",params:{type: "string"}}];return false;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.text !== undefined){const _errs7: any = errors;if(typeof data.text !== "string"){validatePlanProposedPayload.errors = [{instancePath:instancePath+"/text",schemaPath:"#/properties/text/type",keyword:"type",params:{type: "string"}}];return false;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.stepCount !== undefined){let data5: any = data.stepCount;const _errs9: any = errors;if(!(((typeof data5 == "number") && (!(data5 % 1) && !isNaN(data5))) && (isFinite(data5)))){validatePlanProposedPayload.errors = [{instancePath:instancePath+"/stepCount",schemaPath:"#/properties/stepCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs9){if((typeof data5 == "number") && (isFinite(data5))){if(data5 > 9007199254740991 || isNaN(data5)){validatePlanProposedPayload.errors = [{instancePath:instancePath+"/stepCount",schemaPath:"#/properties/stepCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data5 < 0 || isNaN(data5)){validatePlanProposedPayload.errors = [{instancePath:instancePath+"/stepCount",schemaPath:"#/properties/stepCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.fileCount !== undefined){let data6: any = data.fileCount;const _errs11: any = errors;if(!(((typeof data6 == "number") && (!(data6 % 1) && !isNaN(data6))) && (isFinite(data6)))){validatePlanProposedPayload.errors = [{instancePath:instancePath+"/fileCount",schemaPath:"#/properties/fileCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs11){if((typeof data6 == "number") && (isFinite(data6))){if(data6 > 9007199254740991 || isNaN(data6)){validatePlanProposedPayload.errors = [{instancePath:instancePath+"/fileCount",schemaPath:"#/properties/fileCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data6 < 0 || isNaN(data6)){validatePlanProposedPayload.errors = [{instancePath:instancePath+"/fileCount",schemaPath:"#/properties/fileCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}if(valid0){if(data.planFilePath !== undefined){let data7: any = data.planFilePath;const _errs13: any = errors;if(errors === _errs13){if(typeof data7 === "string"){if(func1(data7) > 4096){validatePlanProposedPayload.errors = [{instancePath:instancePath+"/planFilePath",schemaPath:"#/properties/planFilePath/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data7) < 1){validatePlanProposedPayload.errors = [{instancePath:instancePath+"/planFilePath",schemaPath:"#/properties/planFilePath/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern33.test(data7)){validatePlanProposedPayload.errors = [{instancePath:instancePath+"/planFilePath",schemaPath:"#/properties/planFilePath/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validatePlanProposedPayload.errors = [{instancePath:instancePath+"/planFilePath",schemaPath:"#/properties/planFilePath/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}if(valid0){if(data.artifactId !== undefined){const _errs15: any = errors;if(!(validateArtifactId.call(this, data.artifactId, {instancePath:instancePath+"/artifactId",parentData:data,parentDataProperty:"artifactId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateArtifactId.errors : vErrors.concat(validateArtifactId.errors);errors = vErrors.length;}var valid0: any = _errs15 === errors;}else {var valid0: any = true;}if(valid0){if(data.holdsRequest !== undefined){const _errs16: any = errors;if(typeof data.holdsRequest !== "boolean"){validatePlanProposedPayload.errors = [{instancePath:instancePath+"/holdsRequest",schemaPath:"#/properties/holdsRequest/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs16 === errors;}else {var valid0: any = true;}}}}}}}}}}}}}else {validatePlanProposedPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePlanProposedPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePlanProposedPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern5 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
/** Checks that a value is a {@link PlanAcceptedPayload}. */
// prettier-ignore
export const validatePlanAcceptedPayload: CompiledSchemaCheck<PlanAcceptedPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PlanAcceptedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePlanAcceptedPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.planId === undefined) && (missing0 = "planId")) || ((data.sessionId === undefined) && (missing0 = "sessionId"))) || ((data.deviceId === undefined) && (missing0 = "deviceId"))){validatePlanAcceptedPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "planId") || (key0 === "sessionId")) || (key0 === "deviceId"))){validatePlanAcceptedPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.planId !== undefined){const _errs2: any = errors;if(!(validatePlanId.call(this, data.planId, {instancePath:instancePath+"/planId",parentData:data,parentDataProperty:"planId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePlanId.errors : vErrors.concat(validatePlanId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.sessionId !== undefined){const _errs3: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.deviceId !== undefined){const _errs4: any = errors;if(!(validateDeviceId.call(this, data.deviceId, {instancePath:instancePath+"/deviceId",parentData:data,parentDataProperty:"deviceId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceId.errors : vErrors.concat(validateDeviceId.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validatePlanAcceptedPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePlanAcceptedPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePlanAcceptedPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PlanKeptPayload}. */
// prettier-ignore
export const validatePlanKeptPayload: CompiledSchemaCheck<PlanKeptPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PlanKeptPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePlanKeptPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.planId === undefined) && (missing0 = "planId")) || ((data.sessionId === undefined) && (missing0 = "sessionId"))) || ((data.deviceId === undefined) && (missing0 = "deviceId"))){validatePlanKeptPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "planId") || (key0 === "sessionId")) || (key0 === "deviceId"))){validatePlanKeptPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.planId !== undefined){const _errs2: any = errors;if(!(validatePlanId.call(this, data.planId, {instancePath:instancePath+"/planId",parentData:data,parentDataProperty:"planId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePlanId.errors : vErrors.concat(validatePlanId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.sessionId !== undefined){const _errs3: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.deviceId !== undefined){const _errs4: any = errors;if(!(validateDeviceId.call(this, data.deviceId, {instancePath:instancePath+"/deviceId",parentData:data,parentDataProperty:"deviceId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceId.errors : vErrors.concat(validateDeviceId.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validatePlanKeptPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePlanKeptPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePlanKeptPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema402: any = {"description":"Why a plan's hold ended with no verdict: its turn was interrupted, the provider withdrew its\nrequest, its run ended (a restart of the background service among the ways a run ends), a newer\nplan of the same session took its place, or the fresh session it was handed to was archived,\nclosed or purged before its first turn was admitted.","type":"string","enum":["interrupted","withdrawn","runEnded","superseded","freshSessionGone"]};
/** Checks that a value is a {@link PlanHoldEndedReason}. */
// prettier-ignore
export const validatePlanHoldEndedReason: CompiledSchemaCheck<PlanHoldEndedReason> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PlanHoldEndedReason {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePlanHoldEndedReason.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validatePlanHoldEndedReason.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((data === "interrupted") || (data === "withdrawn")) || (data === "runEnded")) || (data === "superseded")) || (data === "freshSessionGone"))){validatePlanHoldEndedReason.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema402.enum}}];return false;}validatePlanHoldEndedReason.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePlanHoldEndedReason.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PlanHoldEndedPayload}. */
// prettier-ignore
export const validatePlanHoldEndedPayload: CompiledSchemaCheck<PlanHoldEndedPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PlanHoldEndedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePlanHoldEndedPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.planId === undefined) && (missing0 = "planId"))) || ((data.reason === undefined) && (missing0 = "reason"))){validatePlanHoldEndedPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "planId")) || (key0 === "reason"))){validatePlanHoldEndedPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.planId !== undefined){const _errs3: any = errors;if(!(validatePlanId.call(this, data.planId, {instancePath:instancePath+"/planId",parentData:data,parentDataProperty:"planId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePlanId.errors : vErrors.concat(validatePlanId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.reason !== undefined){const _errs4: any = errors;if(!(validatePlanHoldEndedReason.call(this, data.reason, {instancePath:instancePath+"/reason",parentData:data,parentDataProperty:"reason",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePlanHoldEndedReason.errors : vErrors.concat(validatePlanHoldEndedReason.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validatePlanHoldEndedPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePlanHoldEndedPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePlanHoldEndedPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PlanHandedOffPayload}. */
// prettier-ignore
export const validatePlanHandedOffPayload: CompiledSchemaCheck<PlanHandedOffPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PlanHandedOffPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePlanHandedOffPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.planId === undefined) && (missing0 = "planId")) || ((data.sessionId === undefined) && (missing0 = "sessionId"))) || ((data.freshSessionId === undefined) && (missing0 = "freshSessionId"))) || ((data.deviceId === undefined) && (missing0 = "deviceId"))){validatePlanHandedOffPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "planId") || (key0 === "sessionId")) || (key0 === "freshSessionId")) || (key0 === "deviceId"))){validatePlanHandedOffPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.planId !== undefined){const _errs2: any = errors;if(!(validatePlanId.call(this, data.planId, {instancePath:instancePath+"/planId",parentData:data,parentDataProperty:"planId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePlanId.errors : vErrors.concat(validatePlanId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.sessionId !== undefined){const _errs3: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.freshSessionId !== undefined){const _errs4: any = errors;if(!(validateSessionId.call(this, data.freshSessionId, {instancePath:instancePath+"/freshSessionId",parentData:data,parentDataProperty:"freshSessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.deviceId !== undefined){const _errs5: any = errors;if(!(validateDeviceId.call(this, data.deviceId, {instancePath:instancePath+"/deviceId",parentData:data,parentDataProperty:"deviceId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDeviceId.errors : vErrors.concat(validateDeviceId.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}}else {validatePlanHandedOffPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePlanHandedOffPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePlanHandedOffPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema404: any = {"description":"A step of a hand-off after the plan reads handed off, in the order they run: the fresh\nsession's birth, its folder's bind, the planning transcript's file, the plan's copy into the\nfresh session, its activation, and the plan sent as its first message.","type":"string","enum":["birth","bind","transcriptFile","seedPlan","activation","seedMessage"]};
/** Checks that a value is a {@link PlanHandOffStep}. */
// prettier-ignore
export const validatePlanHandOffStep: CompiledSchemaCheck<PlanHandOffStep> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PlanHandOffStep {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePlanHandOffStep.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validatePlanHandOffStep.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((((data === "birth") || (data === "bind")) || (data === "transcriptFile")) || (data === "seedPlan")) || (data === "activation")) || (data === "seedMessage"))){validatePlanHandOffStep.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema404.enum}}];return false;}validatePlanHandOffStep.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePlanHandOffStep.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PlanHandOffFailedPayload}. */
// prettier-ignore
export const validatePlanHandOffFailedPayload: CompiledSchemaCheck<PlanHandOffFailedPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PlanHandOffFailedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePlanHandOffFailedPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.planId === undefined) && (missing0 = "planId")) || ((data.freshSessionId === undefined) && (missing0 = "freshSessionId"))) || ((data.step === undefined) && (missing0 = "step"))) || ((data.cause === undefined) && (missing0 = "cause"))){validatePlanHandOffFailedPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "planId") || (key0 === "freshSessionId")) || (key0 === "step")) || (key0 === "cause"))){validatePlanHandOffFailedPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.planId !== undefined){const _errs2: any = errors;if(!(validatePlanId.call(this, data.planId, {instancePath:instancePath+"/planId",parentData:data,parentDataProperty:"planId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePlanId.errors : vErrors.concat(validatePlanId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.freshSessionId !== undefined){const _errs3: any = errors;if(!(validateSessionId.call(this, data.freshSessionId, {instancePath:instancePath+"/freshSessionId",parentData:data,parentDataProperty:"freshSessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.step !== undefined){const _errs4: any = errors;if(!(validatePlanHandOffStep.call(this, data.step, {instancePath:instancePath+"/step",parentData:data,parentDataProperty:"step",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePlanHandOffStep.errors : vErrors.concat(validatePlanHandOffStep.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.cause !== undefined){let data3: any = data.cause;const _errs5: any = errors;if(errors === _errs5){if(typeof data3 === "string"){if(func1(data3) > 8192){validatePlanHandOffFailedPayload.errors = [{instancePath:instancePath+"/cause",schemaPath:"#/properties/cause/maxLength",keyword:"maxLength",params:{limit: 8192}}];return false;}else {if(func1(data3) < 1){validatePlanHandOffFailedPayload.errors = [{instancePath:instancePath+"/cause",schemaPath:"#/properties/cause/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data3)){validatePlanHandOffFailedPayload.errors = [{instancePath:instancePath+"/cause",schemaPath:"#/properties/cause/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validatePlanHandOffFailedPayload.errors = [{instancePath:instancePath+"/cause",schemaPath:"#/properties/cause/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}}else {validatePlanHandOffFailedPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePlanHandOffFailedPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePlanHandOffFailedPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PlanFreshSession}. */
// prettier-ignore
export const validatePlanFreshSession: CompiledSchemaCheck<PlanFreshSession> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PlanFreshSession {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePlanFreshSession.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.providerName === undefined) && (missing0 = "providerName")) || ((data.level === undefined) && (missing0 = "level"))){validatePlanFreshSession.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "providerName") || (key0 === "level"))){validatePlanFreshSession.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.providerName !== undefined){const _errs2: any = errors;if(!(validateProviderId.call(this, data.providerName, {instancePath:instancePath+"/providerName",parentData:data,parentDataProperty:"providerName",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderId.errors : vErrors.concat(validateProviderId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.level !== undefined){const _errs3: any = errors;if(!(validatePermissionLevel.call(this, data.level, {instancePath:instancePath+"/level",parentData:data,parentDataProperty:"level",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePermissionLevel.errors : vErrors.concat(validatePermissionLevel.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validatePlanFreshSession.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePlanFreshSession.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePlanFreshSession.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PlanResolveRequest}. */
// prettier-ignore
export const validatePlanResolveRequest: CompiledSchemaCheck<PlanResolveRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PlanResolveRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePlanResolveRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.verdict;if(typeof tag0 == "string"){if(tag0 === "keep"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.verdict === undefined) && (missing0 = "verdict")) || ((data.planId === undefined) && (missing0 = "planId"))){validatePlanResolveRequest.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!((key0 === "verdict") || (key0 === "planId"))){validatePlanResolveRequest.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.verdict !== undefined){let data0: any = data.verdict;const _errs5: any = errors;if(typeof data0 !== "string"){validatePlanResolveRequest.errors = [{instancePath:instancePath+"/verdict",schemaPath:"#/oneOf/0/properties/verdict/type",keyword:"type",params:{type: "string"}}];return false;}if("keep" !== data0){validatePlanResolveRequest.errors = [{instancePath:instancePath+"/verdict",schemaPath:"#/oneOf/0/properties/verdict/const",keyword:"const",params:{allowedValue: "keep"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.planId !== undefined){const _errs7: any = errors;if(!(validatePlanId.call(this, data.planId, {instancePath:instancePath+"/planId",parentData:data,parentDataProperty:"planId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePlanId.errors : vErrors.concat(validatePlanId.errors);errors = vErrors.length;}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}}}}}else {validatePlanResolveRequest.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "build"){const _errs8: any = errors;if(errors === _errs8){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((data.verdict === undefined) && (missing1 = "verdict")) || ((data.planId === undefined) && (missing1 = "planId"))){validatePlanResolveRequest.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs10: any = errors;for(const key1 in data){if(!((key1 === "verdict") || (key1 === "planId"))){validatePlanResolveRequest.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs10 === errors){if(data.verdict !== undefined){let data2: any = data.verdict;const _errs11: any = errors;if(typeof data2 !== "string"){validatePlanResolveRequest.errors = [{instancePath:instancePath+"/verdict",schemaPath:"#/oneOf/1/properties/verdict/type",keyword:"type",params:{type: "string"}}];return false;}if("build" !== data2){validatePlanResolveRequest.errors = [{instancePath:instancePath+"/verdict",schemaPath:"#/oneOf/1/properties/verdict/const",keyword:"const",params:{allowedValue: "build"}}];return false;}var valid4: any = _errs11 === errors;}else {var valid4: any = true;}if(valid4){if(data.planId !== undefined){const _errs13: any = errors;if(!(validatePlanId.call(this, data.planId, {instancePath:instancePath+"/planId",parentData:data,parentDataProperty:"planId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePlanId.errors : vErrors.concat(validatePlanId.errors);errors = vErrors.length;}var valid4: any = _errs13 === errors;}else {var valid4: any = true;}}}}}else {validatePlanResolveRequest.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs8 === errors;if(props0 !== true){props0 = true;}valid0 = valid3;}else if(tag0 === "fresh"){const _errs14: any = errors;if(errors === _errs14){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((((data.verdict === undefined) && (missing2 = "verdict")) || ((data.planId === undefined) && (missing2 = "planId"))) || ((data.fresh === undefined) && (missing2 = "fresh"))){validatePlanResolveRequest.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs16: any = errors;for(const key2 in data){if(!(((key2 === "verdict") || (key2 === "planId")) || (key2 === "fresh"))){validatePlanResolveRequest.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs16 === errors){if(data.verdict !== undefined){let data4: any = data.verdict;const _errs17: any = errors;if(typeof data4 !== "string"){validatePlanResolveRequest.errors = [{instancePath:instancePath+"/verdict",schemaPath:"#/oneOf/2/properties/verdict/type",keyword:"type",params:{type: "string"}}];return false;}if("fresh" !== data4){validatePlanResolveRequest.errors = [{instancePath:instancePath+"/verdict",schemaPath:"#/oneOf/2/properties/verdict/const",keyword:"const",params:{allowedValue: "fresh"}}];return false;}var valid6: any = _errs17 === errors;}else {var valid6: any = true;}if(valid6){if(data.planId !== undefined){const _errs19: any = errors;if(!(validatePlanId.call(this, data.planId, {instancePath:instancePath+"/planId",parentData:data,parentDataProperty:"planId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePlanId.errors : vErrors.concat(validatePlanId.errors);errors = vErrors.length;}var valid6: any = _errs19 === errors;}else {var valid6: any = true;}if(valid6){if(data.fresh !== undefined){const _errs20: any = errors;if(!(validatePlanFreshSession.call(this, data.fresh, {instancePath:instancePath+"/fresh",parentData:data,parentDataProperty:"fresh",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePlanFreshSession.errors : vErrors.concat(validatePlanFreshSession.errors);errors = vErrors.length;}var valid6: any = _errs20 === errors;}else {var valid6: any = true;}}}}}}else {validatePlanResolveRequest.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid5: any = _errs14 === errors;if(props0 !== true){props0 = true;}valid0 = valid5;}else {validatePlanResolveRequest.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "verdict", tagValue: tag0}}];return false;}}else {validatePlanResolveRequest.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "verdict", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key3 in data){if(!props0 || !props0[key3]){validatePlanResolveRequest.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key3}}];return false;break;}}}}}else {validatePlanResolveRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePlanResolveRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePlanResolveRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PlanResolveResponse}. */
// prettier-ignore
export const validatePlanResolveResponse: CompiledSchemaCheck<PlanResolveResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PlanResolveResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePlanResolveResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.state;if(typeof tag0 == "string"){if(tag0 === "accepted"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.state === undefined) && (missing0 = "state")) || ((data.planId === undefined) && (missing0 = "planId"))){validatePlanResolveResponse.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!((key0 === "state") || (key0 === "planId"))){validatePlanResolveResponse.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.state !== undefined){let data0: any = data.state;const _errs5: any = errors;if(typeof data0 !== "string"){validatePlanResolveResponse.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("accepted" !== data0){validatePlanResolveResponse.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/properties/state/const",keyword:"const",params:{allowedValue: "accepted"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.planId !== undefined){const _errs7: any = errors;if(!(validatePlanId.call(this, data.planId, {instancePath:instancePath+"/planId",parentData:data,parentDataProperty:"planId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePlanId.errors : vErrors.concat(validatePlanId.errors);errors = vErrors.length;}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}}}}}else {validatePlanResolveResponse.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "handedOff"){const _errs8: any = errors;if(errors === _errs8){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.state === undefined) && (missing1 = "state")) || ((data.planId === undefined) && (missing1 = "planId"))) || ((data.freshSessionId === undefined) && (missing1 = "freshSessionId"))){validatePlanResolveResponse.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs10: any = errors;for(const key1 in data){if(!(((key1 === "state") || (key1 === "planId")) || (key1 === "freshSessionId"))){validatePlanResolveResponse.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs10 === errors){if(data.state !== undefined){let data2: any = data.state;const _errs11: any = errors;if(typeof data2 !== "string"){validatePlanResolveResponse.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("handedOff" !== data2){validatePlanResolveResponse.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/properties/state/const",keyword:"const",params:{allowedValue: "handedOff"}}];return false;}var valid4: any = _errs11 === errors;}else {var valid4: any = true;}if(valid4){if(data.planId !== undefined){const _errs13: any = errors;if(!(validatePlanId.call(this, data.planId, {instancePath:instancePath+"/planId",parentData:data,parentDataProperty:"planId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePlanId.errors : vErrors.concat(validatePlanId.errors);errors = vErrors.length;}var valid4: any = _errs13 === errors;}else {var valid4: any = true;}if(valid4){if(data.freshSessionId !== undefined){const _errs14: any = errors;if(!(validateSessionId.call(this, data.freshSessionId, {instancePath:instancePath+"/freshSessionId",parentData:data,parentDataProperty:"freshSessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid4: any = _errs14 === errors;}else {var valid4: any = true;}}}}}}else {validatePlanResolveResponse.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs8 === errors;if(props0 !== true){props0 = true;}valid0 = valid3;}else if(tag0 === "open"){const _errs15: any = errors;if(errors === _errs15){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if(((data.state === undefined) && (missing2 = "state")) || ((data.planId === undefined) && (missing2 = "planId"))){validatePlanResolveResponse.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs17: any = errors;for(const key2 in data){if(!((key2 === "state") || (key2 === "planId"))){validatePlanResolveResponse.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs17 === errors){if(data.state !== undefined){let data5: any = data.state;const _errs18: any = errors;if(typeof data5 !== "string"){validatePlanResolveResponse.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/2/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("open" !== data5){validatePlanResolveResponse.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/2/properties/state/const",keyword:"const",params:{allowedValue: "open"}}];return false;}var valid6: any = _errs18 === errors;}else {var valid6: any = true;}if(valid6){if(data.planId !== undefined){const _errs20: any = errors;if(!(validatePlanId.call(this, data.planId, {instancePath:instancePath+"/planId",parentData:data,parentDataProperty:"planId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePlanId.errors : vErrors.concat(validatePlanId.errors);errors = vErrors.length;}var valid6: any = _errs20 === errors;}else {var valid6: any = true;}}}}}else {validatePlanResolveResponse.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid5: any = _errs15 === errors;if(props0 !== true){props0 = true;}valid0 = valid5;}else {validatePlanResolveResponse.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "state", tagValue: tag0}}];return false;}}else {validatePlanResolveResponse.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "state", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key3 in data){if(!props0 || !props0[key3]){validatePlanResolveResponse.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key3}}];return false;break;}}}}}else {validatePlanResolveResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePlanResolveResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePlanResolveResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;

/** The methods of {@link PLAN_METHOD_DESCRIPTORS}, each with its checks. */
export interface PlanMethodDescriptors {
  readonly "plan.resolve": {
    readonly method: "plan.resolve";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<PlanResolveRequest>;
    readonly responseCheck: SchemaCheck<PlanResolveResponse>;
  };
}
/** The `plan.*` methods a client calls. */
export const PLAN_METHOD_DESCRIPTORS: PlanMethodDescriptors = Object.freeze({
  "plan.resolve": Object.freeze({
    method: "plan.resolve",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validatePlanResolveRequest,
    responseCheck: validatePlanResolveResponse,
  }),
});
