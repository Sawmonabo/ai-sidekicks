// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A session whose history is damaged: its refusals' details and the event `Continue from here` appends.

import type { SchemaCheck } from "../../schema-check.js";
import type { SessionId } from "./id.js";

/**
 * How far a session's history is damaged: after a readable start, or with no readable event;
 * each is a [`DaemonRecoverySessionState`].
 */
export type SessionHistoryDamagedRecovery = "degraded" | "damaged";
/**
 * Why a recovery action was refused: the session's history is not damaged, or no event of it can
 * be read, so there is no point to continue from and only delete applies.
 */
export type SessionRecoveryRefusedReason = "notDamaged" | "noReadableEvent";

/**
 * The `session.history.damaged` refusal's `data.fields`: the session and how far its history is
 * damaged.
 */
export interface SessionHistoryDamagedDetails {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * How far its history is damaged.
   */
  recovery: SessionHistoryDamagedRecovery;
}
/**
 * The `session.rebuilding` refusal's `data.fields`: the session the restart's pass has not rebuilt
 * yet.
 */
export interface SessionRebuildingDetails {
  /**
   * The session.
   */
  sessionId: SessionId;
}
/**
 * The `session.recovery.refused` refusal's `data.fields`.
 */
export interface SessionRecoveryRefusedDetails {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * Why the action was refused.
   */
  reason: SessionRecoveryRefusedReason;
}
/**
 * `session.damagedEvents.skipped`: the session continued from its last good point. Its events
 * from `fromSequence` through `toSequence` are damaged; they stay in the log and every read and
 * rebuild skips them, so the event before `fromSequence` is the session's end until it takes new
 * work.
 */
export interface SessionDamagedEventsSkippedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The first damaged event.
   */
  fromSequence: number;
  /**
   * The last damaged event; at or after `fromSequence`.
   */
  toSequence: number;
}

// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
function validate2059(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionDamagedEventsSkippedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2059.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.fromSequence === undefined) && (missing0 = "fromSequence"))) || ((data.toSequence === undefined) && (missing0 = "toSequence"))){validate2059.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "fromSequence")) || (key0 === "toSequence"))){validate2059.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2059.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2059.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.fromSequence !== undefined){let data1: any = data.fromSequence;const _errs6: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validate2059.errors = [{instancePath:instancePath+"/fromSequence",schemaPath:"#/properties/fromSequence/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs6){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validate2059.errors = [{instancePath:instancePath+"/fromSequence",schemaPath:"#/properties/fromSequence/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 0 || isNaN(data1)){validate2059.errors = [{instancePath:instancePath+"/fromSequence",schemaPath:"#/properties/fromSequence/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.toSequence !== undefined){let data2: any = data.toSequence;const _errs8: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validate2059.errors = [{instancePath:instancePath+"/toSequence",schemaPath:"#/properties/toSequence/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs8){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validate2059.errors = [{instancePath:instancePath+"/toSequence",schemaPath:"#/properties/toSequence/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {const vSchema0: any = data && data.fromSequence;if(vSchema0 !== undefined && ((!((typeof vSchema0 == "number") && (isFinite(vSchema0)))) || (data2 < vSchema0 || isNaN(data2)))){validate2059.errors = [{instancePath:instancePath+"/toSequence",schemaPath:"#/properties/toSequence/minimum",keyword:"minimum",params:{comparison: ">=", limit: vSchema0}}];return false;}}}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}}}}}}else {validate2059.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2059.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2059.errors = null as any[] | null;
// prettier-ignore
validate2059.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionDamagedEventsSkippedPayload}. */
export const validateSessionDamagedEventsSkippedPayload: SchemaCheck<SessionDamagedEventsSkippedPayload> =
  validate2059;
