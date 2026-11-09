/* eslint-disable */
// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The plan record and the one call that answers it.

import { type SchemaCheck, ucs2length } from "../schema-check.js";
import type { ArtifactId } from "./artifacts/id.js";
import type { ProviderId } from "./provider/id.js";
import type { RunId } from "./run/id.js";
import type { PermissionLevel } from "./session/controls/methods.js";
import type { SessionId } from "./session/id.js";
import type { DeviceId } from "./trust-statement.js";

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
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
function validate1249(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PlanAcceptedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1249.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.planId === undefined) && (missing0 = "planId")) || ((data.sessionId === undefined) && (missing0 = "sessionId"))) || ((data.deviceId === undefined) && (missing0 = "deviceId"))){validate1249.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "planId") || (key0 === "sessionId")) || (key0 === "deviceId"))){validate1249.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.planId !== undefined){let data0: any = data.planId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1249.errors = [{instancePath:instancePath+"/planId",schemaPath:"#/$defs/PlanId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1249.errors = [{instancePath:instancePath+"/planId",schemaPath:"#/$defs/PlanId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.sessionId !== undefined){let data1: any = data.sessionId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1249.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1249.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.deviceId !== undefined){let data2: any = data.deviceId;const _errs10: any = errors;const _errs11: any = errors;if(errors === _errs11){if(typeof data2 === "string"){if(func1(data2) > 256){validate1249.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(!pattern6.test(data2)){validate1249.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate1249.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}else {validate1249.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1249.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1249.errors = null as any[] | null;
// prettier-ignore
validate1249.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1019: any = {"description":"A step of a hand-off after the plan reads handed off, in the order they run: the fresh\nsession's birth, its folder's bind, the planning transcript's file, the plan's copy into the\nfresh session, its activation, and the plan sent as its first message.","type":"string","enum":["birth","bind","transcriptFile","seedPlan","activation","seedMessage"]};
// prettier-ignore
function validate1250(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PlanHandOffFailedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1250.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.planId === undefined) && (missing0 = "planId")) || ((data.freshSessionId === undefined) && (missing0 = "freshSessionId"))) || ((data.step === undefined) && (missing0 = "step"))) || ((data.cause === undefined) && (missing0 = "cause"))){validate1250.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "planId") || (key0 === "freshSessionId")) || (key0 === "step")) || (key0 === "cause"))){validate1250.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.planId !== undefined){let data0: any = data.planId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1250.errors = [{instancePath:instancePath+"/planId",schemaPath:"#/$defs/PlanId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1250.errors = [{instancePath:instancePath+"/planId",schemaPath:"#/$defs/PlanId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.freshSessionId !== undefined){let data1: any = data.freshSessionId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1250.errors = [{instancePath:instancePath+"/freshSessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1250.errors = [{instancePath:instancePath+"/freshSessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.step !== undefined){let data2: any = data.step;const _errs10: any = errors;if(typeof data2 !== "string"){validate1250.errors = [{instancePath:instancePath+"/step",schemaPath:"#/$defs/PlanHandOffStep/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((((data2 === "birth") || (data2 === "bind")) || (data2 === "transcriptFile")) || (data2 === "seedPlan")) || (data2 === "activation")) || (data2 === "seedMessage"))){validate1250.errors = [{instancePath:instancePath+"/step",schemaPath:"#/$defs/PlanHandOffStep/enum",keyword:"enum",params:{allowedValues: schema1019.enum}}];return false;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.cause !== undefined){let data3: any = data.cause;const _errs13: any = errors;if(errors === _errs13){if(typeof data3 === "string"){if(func1(data3) > 8192){validate1250.errors = [{instancePath:instancePath+"/cause",schemaPath:"#/properties/cause/maxLength",keyword:"maxLength",params:{limit: 8192}}];return false;}else {if(func1(data3) < 1){validate1250.errors = [{instancePath:instancePath+"/cause",schemaPath:"#/properties/cause/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data3)){validate1250.errors = [{instancePath:instancePath+"/cause",schemaPath:"#/properties/cause/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1250.errors = [{instancePath:instancePath+"/cause",schemaPath:"#/properties/cause/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}}}}}}}else {validate1250.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1250.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1250.errors = null as any[] | null;
// prettier-ignore
validate1250.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1251(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PlanHandedOffPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1251.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.planId === undefined) && (missing0 = "planId")) || ((data.sessionId === undefined) && (missing0 = "sessionId"))) || ((data.freshSessionId === undefined) && (missing0 = "freshSessionId"))) || ((data.deviceId === undefined) && (missing0 = "deviceId"))){validate1251.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "planId") || (key0 === "sessionId")) || (key0 === "freshSessionId")) || (key0 === "deviceId"))){validate1251.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.planId !== undefined){let data0: any = data.planId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1251.errors = [{instancePath:instancePath+"/planId",schemaPath:"#/$defs/PlanId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1251.errors = [{instancePath:instancePath+"/planId",schemaPath:"#/$defs/PlanId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.sessionId !== undefined){let data1: any = data.sessionId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1251.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1251.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.freshSessionId !== undefined){let data2: any = data.freshSessionId;const _errs10: any = errors;const _errs11: any = errors;if(errors === _errs11){if(typeof data2 === "string"){if(!pattern4.test(data2)){validate1251.errors = [{instancePath:instancePath+"/freshSessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1251.errors = [{instancePath:instancePath+"/freshSessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.deviceId !== undefined){let data3: any = data.deviceId;const _errs14: any = errors;const _errs15: any = errors;if(errors === _errs15){if(typeof data3 === "string"){if(func1(data3) > 256){validate1251.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(!pattern6.test(data3)){validate1251.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate1251.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}}}}}}}else {validate1251.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1251.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1251.errors = null as any[] | null;
// prettier-ignore
validate1251.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1015: any = {"description":"Why a plan's hold ended with no verdict: its turn was interrupted, the provider withdrew its\nrequest, its run ended (a restart of the background service among the ways a run ends), a newer\nplan of the same session took its place, or the fresh session it was handed to was archived,\nclosed or purged before its first turn was admitted.","type":"string","enum":["interrupted","withdrawn","runEnded","superseded","freshSessionGone"]};
// prettier-ignore
function validate1252(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PlanHoldEndedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1252.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.planId === undefined) && (missing0 = "planId"))) || ((data.reason === undefined) && (missing0 = "reason"))){validate1252.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "planId")) || (key0 === "reason"))){validate1252.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1252.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1252.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.planId !== undefined){let data1: any = data.planId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1252.errors = [{instancePath:instancePath+"/planId",schemaPath:"#/$defs/PlanId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1252.errors = [{instancePath:instancePath+"/planId",schemaPath:"#/$defs/PlanId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.reason !== undefined){let data2: any = data.reason;const _errs10: any = errors;if(typeof data2 !== "string"){validate1252.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/$defs/PlanHoldEndedReason/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((data2 === "interrupted") || (data2 === "withdrawn")) || (data2 === "runEnded")) || (data2 === "superseded")) || (data2 === "freshSessionGone"))){validate1252.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/$defs/PlanHoldEndedReason/enum",keyword:"enum",params:{allowedValues: schema1015.enum}}];return false;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}else {validate1252.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1252.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1252.errors = null as any[] | null;
// prettier-ignore
validate1252.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1253(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PlanId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1253.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern4.test(data)){validate1253.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1253.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validate1253.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1253.errors = null as any[] | null;
// prettier-ignore
validate1253.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1254(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PlanKeptPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1254.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.planId === undefined) && (missing0 = "planId")) || ((data.sessionId === undefined) && (missing0 = "sessionId"))) || ((data.deviceId === undefined) && (missing0 = "deviceId"))){validate1254.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "planId") || (key0 === "sessionId")) || (key0 === "deviceId"))){validate1254.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.planId !== undefined){let data0: any = data.planId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1254.errors = [{instancePath:instancePath+"/planId",schemaPath:"#/$defs/PlanId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1254.errors = [{instancePath:instancePath+"/planId",schemaPath:"#/$defs/PlanId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.sessionId !== undefined){let data1: any = data.sessionId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1254.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1254.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.deviceId !== undefined){let data2: any = data.deviceId;const _errs10: any = errors;const _errs11: any = errors;if(errors === _errs11){if(typeof data2 === "string"){if(func1(data2) > 256){validate1254.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(!pattern6.test(data2)){validate1254.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate1254.errors = [{instancePath:instancePath+"/deviceId",schemaPath:"sidekicks-contracts:trust-statement#/$defs/DeviceId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}else {validate1254.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1254.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1254.errors = null as any[] | null;
// prettier-ignore
validate1254.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema994: any = {"type":"object","additionalProperties":false,"properties":{"planId":{"$ref":"#/$defs/PlanId","description":"The plan."},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"runId":{"$ref":"sidekicks-contracts:run/id#/$defs/RunId","description":"The run that proposed it."},"title":{"type":"string","description":"Its title."},"text":{"type":"string","description":"Its text."},"stepCount":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"How many top-level steps it has."},"fileCount":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"How many files it names."},"planFilePath":{"type":"string","maxLength":4096,"pattern":"^[^\\x00]*$","minLength":1,"description":"The file the provider wrote it to."},"artifactId":{"$ref":"sidekicks-contracts:artifacts/id#/$defs/ArtifactId","description":"The artifact that keeps the plan."},"holdsRequest":{"type":"boolean","description":"Whether a held provider request waits on the verdict."}},"required":["planId","sessionId","runId","title","text","stepCount","fileCount","artifactId","holdsRequest"],"description":"`plan.proposed`: the plan as the agent wrote it, never read off the disk, with the daemon's\ncount of its top-level steps and the files it names, and the artifact that keeps it, written\nbefore this event. `planFilePath` is present only where the provider wrote the plan as a file;\n`holdsRequest` says a held provider request waits on the verdict."};
// prettier-ignore
const func2 = Object.prototype.hasOwnProperty;
// prettier-ignore
const pattern43 = new RegExp("^[^\\x00]*$", "u");
// prettier-ignore
function validate1255(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PlanProposedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1255.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((((((data.planId === undefined) && (missing0 = "planId")) || ((data.sessionId === undefined) && (missing0 = "sessionId"))) || ((data.runId === undefined) && (missing0 = "runId"))) || ((data.title === undefined) && (missing0 = "title"))) || ((data.text === undefined) && (missing0 = "text"))) || ((data.stepCount === undefined) && (missing0 = "stepCount"))) || ((data.fileCount === undefined) && (missing0 = "fileCount"))) || ((data.artifactId === undefined) && (missing0 = "artifactId"))) || ((data.holdsRequest === undefined) && (missing0 = "holdsRequest"))){validate1255.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(func2.call(schema994.properties, key0))){validate1255.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.planId !== undefined){let data0: any = data.planId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1255.errors = [{instancePath:instancePath+"/planId",schemaPath:"#/$defs/PlanId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1255.errors = [{instancePath:instancePath+"/planId",schemaPath:"#/$defs/PlanId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.sessionId !== undefined){let data1: any = data.sessionId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1255.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1255.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.runId !== undefined){let data2: any = data.runId;const _errs10: any = errors;const _errs11: any = errors;if(errors === _errs11){if(typeof data2 === "string"){if(!pattern4.test(data2)){validate1255.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1255.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.title !== undefined){const _errs14: any = errors;if(typeof data.title !== "string"){validate1255.errors = [{instancePath:instancePath+"/title",schemaPath:"#/properties/title/type",keyword:"type",params:{type: "string"}}];return false;}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}if(valid0){if(data.text !== undefined){const _errs16: any = errors;if(typeof data.text !== "string"){validate1255.errors = [{instancePath:instancePath+"/text",schemaPath:"#/properties/text/type",keyword:"type",params:{type: "string"}}];return false;}var valid0: any = _errs16 === errors;}else {var valid0: any = true;}if(valid0){if(data.stepCount !== undefined){let data5: any = data.stepCount;const _errs18: any = errors;if(!(((typeof data5 == "number") && (!(data5 % 1) && !isNaN(data5))) && (isFinite(data5)))){validate1255.errors = [{instancePath:instancePath+"/stepCount",schemaPath:"#/properties/stepCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs18){if((typeof data5 == "number") && (isFinite(data5))){if(data5 > 9007199254740991 || isNaN(data5)){validate1255.errors = [{instancePath:instancePath+"/stepCount",schemaPath:"#/properties/stepCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data5 < 0 || isNaN(data5)){validate1255.errors = [{instancePath:instancePath+"/stepCount",schemaPath:"#/properties/stepCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs18 === errors;}else {var valid0: any = true;}if(valid0){if(data.fileCount !== undefined){let data6: any = data.fileCount;const _errs20: any = errors;if(!(((typeof data6 == "number") && (!(data6 % 1) && !isNaN(data6))) && (isFinite(data6)))){validate1255.errors = [{instancePath:instancePath+"/fileCount",schemaPath:"#/properties/fileCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs20){if((typeof data6 == "number") && (isFinite(data6))){if(data6 > 9007199254740991 || isNaN(data6)){validate1255.errors = [{instancePath:instancePath+"/fileCount",schemaPath:"#/properties/fileCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data6 < 0 || isNaN(data6)){validate1255.errors = [{instancePath:instancePath+"/fileCount",schemaPath:"#/properties/fileCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs20 === errors;}else {var valid0: any = true;}if(valid0){if(data.planFilePath !== undefined){let data7: any = data.planFilePath;const _errs22: any = errors;if(errors === _errs22){if(typeof data7 === "string"){if(func1(data7) > 4096){validate1255.errors = [{instancePath:instancePath+"/planFilePath",schemaPath:"#/properties/planFilePath/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data7) < 1){validate1255.errors = [{instancePath:instancePath+"/planFilePath",schemaPath:"#/properties/planFilePath/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data7)){validate1255.errors = [{instancePath:instancePath+"/planFilePath",schemaPath:"#/properties/planFilePath/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate1255.errors = [{instancePath:instancePath+"/planFilePath",schemaPath:"#/properties/planFilePath/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs22 === errors;}else {var valid0: any = true;}if(valid0){if(data.artifactId !== undefined){let data8: any = data.artifactId;const _errs24: any = errors;const _errs25: any = errors;if(errors === _errs25){if(typeof data8 === "string"){if(!pattern4.test(data8)){validate1255.errors = [{instancePath:instancePath+"/artifactId",schemaPath:"sidekicks-contracts:artifacts/id#/$defs/ArtifactId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1255.errors = [{instancePath:instancePath+"/artifactId",schemaPath:"sidekicks-contracts:artifacts/id#/$defs/ArtifactId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs24 === errors;}else {var valid0: any = true;}if(valid0){if(data.holdsRequest !== undefined){const _errs28: any = errors;if(typeof data.holdsRequest !== "boolean"){validate1255.errors = [{instancePath:instancePath+"/holdsRequest",schemaPath:"#/properties/holdsRequest/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs28 === errors;}else {var valid0: any = true;}}}}}}}}}}}}}else {validate1255.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1255.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1255.errors = null as any[] | null;
// prettier-ignore
validate1255.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1110: any = {"description":"The five permission levels, most careful first, the same five words on every provider. Only\nthe first three ever ask the person; at `sandboxed` and `yolo` the daemon answers every ask\nitself. Plan is not a level: it is the session's mode.","type":"string","enum":["readonly","ask","reviewed","sandboxed","yolo"]};
// prettier-ignore
const pattern16 = new RegExp("^[a-z][a-z0-9-]{0,31}$", "u");
// prettier-ignore
function validate1257(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1257.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.providerName === undefined) && (missing0 = "providerName")) || ((data.level === undefined) && (missing0 = "level"))){validate1257.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "providerName") || (key0 === "level"))){validate1257.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.providerName !== undefined){let data0: any = data.providerName;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern16.test(data0)){validate1257.errors = [{instancePath:instancePath+"/providerName",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate1257.errors = [{instancePath:instancePath+"/providerName",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.level !== undefined){let data1: any = data.level;const _errs6: any = errors;if(typeof data1 !== "string"){validate1257.errors = [{instancePath:instancePath+"/level",schemaPath:"sidekicks-contracts:session/controls/methods#/$defs/PermissionLevel/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((data1 === "readonly") || (data1 === "ask")) || (data1 === "reviewed")) || (data1 === "sandboxed")) || (data1 === "yolo"))){validate1257.errors = [{instancePath:instancePath+"/level",schemaPath:"sidekicks-contracts:session/controls/methods#/$defs/PermissionLevel/enum",keyword:"enum",params:{allowedValues: schema1110.enum}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1257.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1257.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1257.errors = null as any[] | null;
// prettier-ignore
validate1257.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1256(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PlanResolveRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1256.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs2: any = errors;for(const key0 in data){validate1256.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key0}}];return false;break;}if(_errs2 === errors){const tag0: any = data.verdict;if(typeof tag0 == "string"){if(tag0 === "keep"){const _errs3: any = errors;if(errors === _errs3){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.verdict === undefined) && (missing0 = "verdict")) || ((data.planId === undefined) && (missing0 = "planId"))){validate1256.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs5: any = errors;for(const key1 in data){if(!((key1 === "verdict") || (key1 === "planId"))){validate1256.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs5 === errors){if(data.verdict !== undefined){let data0: any = data.verdict;const _errs6: any = errors;if(typeof data0 !== "string"){validate1256.errors = [{instancePath:instancePath+"/verdict",schemaPath:"#/oneOf/0/properties/verdict/type",keyword:"type",params:{type: "string"}}];return false;}if("keep" !== data0){validate1256.errors = [{instancePath:instancePath+"/verdict",schemaPath:"#/oneOf/0/properties/verdict/const",keyword:"const",params:{allowedValue: "keep"}}];return false;}var valid2: any = _errs6 === errors;}else {var valid2: any = true;}if(valid2){if(data.planId !== undefined){let data1: any = data.planId;const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1256.errors = [{instancePath:instancePath+"/planId",schemaPath:"#/$defs/PlanId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1256.errors = [{instancePath:instancePath+"/planId",schemaPath:"#/$defs/PlanId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}}}}}else {validate1256.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "build"){const _errs12: any = errors;if(errors === _errs12){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((data.verdict === undefined) && (missing1 = "verdict")) || ((data.planId === undefined) && (missing1 = "planId"))){validate1256.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs14: any = errors;for(const key2 in data){if(!((key2 === "verdict") || (key2 === "planId"))){validate1256.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs14 === errors){if(data.verdict !== undefined){let data2: any = data.verdict;const _errs15: any = errors;if(typeof data2 !== "string"){validate1256.errors = [{instancePath:instancePath+"/verdict",schemaPath:"#/oneOf/1/properties/verdict/type",keyword:"type",params:{type: "string"}}];return false;}if("build" !== data2){validate1256.errors = [{instancePath:instancePath+"/verdict",schemaPath:"#/oneOf/1/properties/verdict/const",keyword:"const",params:{allowedValue: "build"}}];return false;}var valid5: any = _errs15 === errors;}else {var valid5: any = true;}if(valid5){if(data.planId !== undefined){let data3: any = data.planId;const _errs17: any = errors;const _errs18: any = errors;if(errors === _errs18){if(typeof data3 === "string"){if(!pattern4.test(data3)){validate1256.errors = [{instancePath:instancePath+"/planId",schemaPath:"#/$defs/PlanId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1256.errors = [{instancePath:instancePath+"/planId",schemaPath:"#/$defs/PlanId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs17 === errors;}else {var valid5: any = true;}}}}}else {validate1256.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "fresh"){const _errs21: any = errors;if(errors === _errs21){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((((data.verdict === undefined) && (missing2 = "verdict")) || ((data.planId === undefined) && (missing2 = "planId"))) || ((data.fresh === undefined) && (missing2 = "fresh"))){validate1256.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs23: any = errors;for(const key3 in data){if(!(((key3 === "verdict") || (key3 === "planId")) || (key3 === "fresh"))){validate1256.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs23 === errors){if(data.verdict !== undefined){let data4: any = data.verdict;const _errs24: any = errors;if(typeof data4 !== "string"){validate1256.errors = [{instancePath:instancePath+"/verdict",schemaPath:"#/oneOf/2/properties/verdict/type",keyword:"type",params:{type: "string"}}];return false;}if("fresh" !== data4){validate1256.errors = [{instancePath:instancePath+"/verdict",schemaPath:"#/oneOf/2/properties/verdict/const",keyword:"const",params:{allowedValue: "fresh"}}];return false;}var valid8: any = _errs24 === errors;}else {var valid8: any = true;}if(valid8){if(data.planId !== undefined){let data5: any = data.planId;const _errs26: any = errors;const _errs27: any = errors;if(errors === _errs27){if(typeof data5 === "string"){if(!pattern4.test(data5)){validate1256.errors = [{instancePath:instancePath+"/planId",schemaPath:"#/$defs/PlanId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1256.errors = [{instancePath:instancePath+"/planId",schemaPath:"#/$defs/PlanId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid8: any = _errs26 === errors;}else {var valid8: any = true;}if(valid8){if(data.fresh !== undefined){const _errs30: any = errors;if(!(validate1257.call(this, data.fresh, {instancePath:instancePath+"/fresh",parentData:data,parentDataProperty:"fresh",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1257.errors : vErrors.concat(validate1257.errors);errors = vErrors.length;}var valid8: any = _errs30 === errors;}else {var valid8: any = true;}}}}}}else {validate1256.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}}else {validate1256.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "verdict", tagValue: tag0}}];return false;}}else {validate1256.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "verdict", tagValue: tag0}}];return false;}}}else {validate1256.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1256.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1256.errors = null as any[] | null;
// prettier-ignore
validate1256.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1259(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PlanResolveResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1259.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs2: any = errors;for(const key0 in data){validate1259.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key0}}];return false;break;}if(_errs2 === errors){const tag0: any = data.state;if(typeof tag0 == "string"){if(tag0 === "accepted"){const _errs3: any = errors;if(errors === _errs3){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.state === undefined) && (missing0 = "state")) || ((data.planId === undefined) && (missing0 = "planId"))){validate1259.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs5: any = errors;for(const key1 in data){if(!((key1 === "state") || (key1 === "planId"))){validate1259.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs5 === errors){if(data.state !== undefined){let data0: any = data.state;const _errs6: any = errors;if(typeof data0 !== "string"){validate1259.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("accepted" !== data0){validate1259.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/properties/state/const",keyword:"const",params:{allowedValue: "accepted"}}];return false;}var valid2: any = _errs6 === errors;}else {var valid2: any = true;}if(valid2){if(data.planId !== undefined){let data1: any = data.planId;const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1259.errors = [{instancePath:instancePath+"/planId",schemaPath:"#/$defs/PlanId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1259.errors = [{instancePath:instancePath+"/planId",schemaPath:"#/$defs/PlanId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}}}}}else {validate1259.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "handedOff"){const _errs12: any = errors;if(errors === _errs12){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.state === undefined) && (missing1 = "state")) || ((data.planId === undefined) && (missing1 = "planId"))) || ((data.freshSessionId === undefined) && (missing1 = "freshSessionId"))){validate1259.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs14: any = errors;for(const key2 in data){if(!(((key2 === "state") || (key2 === "planId")) || (key2 === "freshSessionId"))){validate1259.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs14 === errors){if(data.state !== undefined){let data2: any = data.state;const _errs15: any = errors;if(typeof data2 !== "string"){validate1259.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("handedOff" !== data2){validate1259.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/properties/state/const",keyword:"const",params:{allowedValue: "handedOff"}}];return false;}var valid5: any = _errs15 === errors;}else {var valid5: any = true;}if(valid5){if(data.planId !== undefined){let data3: any = data.planId;const _errs17: any = errors;const _errs18: any = errors;if(errors === _errs18){if(typeof data3 === "string"){if(!pattern4.test(data3)){validate1259.errors = [{instancePath:instancePath+"/planId",schemaPath:"#/$defs/PlanId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1259.errors = [{instancePath:instancePath+"/planId",schemaPath:"#/$defs/PlanId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs17 === errors;}else {var valid5: any = true;}if(valid5){if(data.freshSessionId !== undefined){let data4: any = data.freshSessionId;const _errs21: any = errors;const _errs22: any = errors;if(errors === _errs22){if(typeof data4 === "string"){if(!pattern4.test(data4)){validate1259.errors = [{instancePath:instancePath+"/freshSessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1259.errors = [{instancePath:instancePath+"/freshSessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs21 === errors;}else {var valid5: any = true;}}}}}}else {validate1259.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "open"){const _errs25: any = errors;if(errors === _errs25){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if(((data.state === undefined) && (missing2 = "state")) || ((data.planId === undefined) && (missing2 = "planId"))){validate1259.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs27: any = errors;for(const key3 in data){if(!((key3 === "state") || (key3 === "planId"))){validate1259.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs27 === errors){if(data.state !== undefined){let data5: any = data.state;const _errs28: any = errors;if(typeof data5 !== "string"){validate1259.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/2/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("open" !== data5){validate1259.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/2/properties/state/const",keyword:"const",params:{allowedValue: "open"}}];return false;}var valid9: any = _errs28 === errors;}else {var valid9: any = true;}if(valid9){if(data.planId !== undefined){let data6: any = data.planId;const _errs30: any = errors;const _errs31: any = errors;if(errors === _errs31){if(typeof data6 === "string"){if(!pattern4.test(data6)){validate1259.errors = [{instancePath:instancePath+"/planId",schemaPath:"#/$defs/PlanId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1259.errors = [{instancePath:instancePath+"/planId",schemaPath:"#/$defs/PlanId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid9: any = _errs30 === errors;}else {var valid9: any = true;}}}}}else {validate1259.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}}else {validate1259.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "state", tagValue: tag0}}];return false;}}else {validate1259.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "state", tagValue: tag0}}];return false;}}}else {validate1259.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1259.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1259.errors = null as any[] | null;
// prettier-ignore
validate1259.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PlanAcceptedPayload}. */
export const validatePlanAcceptedPayload: SchemaCheck<PlanAcceptedPayload> = validate1249;
/** Checks that a value is a {@link PlanHandOffFailedPayload}. */
export const validatePlanHandOffFailedPayload: SchemaCheck<PlanHandOffFailedPayload> = validate1250;
/** Checks that a value is a {@link PlanHandedOffPayload}. */
export const validatePlanHandedOffPayload: SchemaCheck<PlanHandedOffPayload> = validate1251;
/** Checks that a value is a {@link PlanHoldEndedPayload}. */
export const validatePlanHoldEndedPayload: SchemaCheck<PlanHoldEndedPayload> = validate1252;
/** Checks that a value is a {@link PlanId}. */
export const validatePlanId: SchemaCheck<PlanId> = validate1253;
/** Checks that a value is a {@link PlanKeptPayload}. */
export const validatePlanKeptPayload: SchemaCheck<PlanKeptPayload> = validate1254;
/** Checks that a value is a {@link PlanProposedPayload}. */
export const validatePlanProposedPayload: SchemaCheck<PlanProposedPayload> = validate1255;
/** Checks that a value is a {@link PlanResolveRequest}. */
export const validatePlanResolveRequest: SchemaCheck<PlanResolveRequest> = validate1256;
/** Checks that a value is a {@link PlanResolveResponse}. */
export const validatePlanResolveResponse: SchemaCheck<PlanResolveResponse> = validate1259;

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
