// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The session event envelope: the closed categories, the tolerant envelope every event is stored and sent in, the execution-epoch stamp and the hydrated (envelope plus body) reader shape.

import { type CompiledSchemaCheck, ucs2length } from "../../schema-check.js";
import { type SessionId, validateSessionId } from "../session/id.js";
import { type EventEnvelopeVersion, validateEventEnvelopeVersion } from "./version.js";

/**
 * The largest `sequence` an envelope may carry, not a tunable: `sequence` travels as an
 * IEEE-754 double, which holds integers exactly only up to 2^53 − 1, so above it two events
 * would share an order key.
 */
export const EVENT_ENVELOPE_SEQUENCE_MAX = 9007199254740991 as const;

/** Payload key of the epoch stamp; ingestion writes it and the supersede projection reads it. */
export const SOURCE_EPOCH_PAYLOAD_KEY = "sourceEpoch" as const;

/** Payload key of the position stamp; it moves with the epoch stamp's key. */
export const SOURCE_POSITION_PAYLOAD_KEY = "sourcePosition" as const;

/**
 * The category a session event belongs to; every event type maps to exactly one, so a mismatched
 * pair fails the strict parse. Adding a category is a minor version bump.
 */
export type EventCategory =
  | "runLifecycle"
  | "agentOutput"
  | "toolActivity"
  | "interactiveRequest"
  | "artifactPublication"
  | "sessionLifecycle"
  | "approvalFlow"
  | "usageTelemetry"
  | "recoveryEvents"
  | "securityEvents"
  | "eventMaintenance"
  | "orchestrationAdmission"
  | "mcpGovernance"
  | "workflowLifecycle"
  | "workflowPhaseLifecycle"
  | "workflowParallelCoordination"
  | "workflowGateResolution";
/**
 * An event's type as the envelope stores it: free-form text rather than a known type, so a
 * reader can store and pass on a type a newer producer wrote.
 */
export type EventEnvelopeType = string;
/**
 * When an incoming event occurred: a real date and time with `Z` or an offset, its seconds optional, its fraction holding no non-zero digit past the third.
 */
export type EventOccurredAt = string;
/**
 * The execution epoch a late-appended row is attributed to: `0` before any rollback, advanced
 * by each accepted `agent.run.rolledBack`.
 */
export type SourceEpoch = number;
/**
 * The run position a stamped row occupies within its source epoch, counting the person's
 * messages the run took (a turn's opening or a steer), not turns, so the supersede cutoff
 * (`position > targetPosition`) can rank a late row against its epoch's surviving rows.
 */
export type SourcePosition = number;
/**
 * Why a stored event's body is not available.
 */
export type HydratedContentUnavailableReason = "absent";
/**
 * A stored event's body as a reader receives it beside the event, never merged into its payload.
 */
export type HydratedSessionEventContent =
  | {
      status: "available";
      /**
       * The opened body, whole.
       */
      body: string;
      /**
       * The whole body's UTF-8 byte length, echoed from the stored payload, never recomputed
       * from `body`.
       */
      contentLength?: number;
    }
  | {
      status: "unavailable";
      /**
       * Why.
       */
      reason: HydratedContentUnavailableReason;
    };

/**
 * The message every session event is stored and travels in. Its own members are closed; its
 * `type` and `payload` are kept as written, so an event from a newer producer survives a read
 * and a write unchanged.
 */
export interface EventEnvelope {
  /**
   * The event's id, opaque on the wire; the daemon assigns a UUID v7.
   */
  id: string;
  /**
   * The session the event belongs to.
   */
  sessionId: SessionId;
  /**
   * Daemon-assigned and strictly increasing per session: the order key.
   */
  sequence: number;
  /**
   * When the event occurred; the append path stores it in UTC with millisecond precision.
   */
  occurredAt: EventOccurredAt;
  /**
   * The event's category.
   */
  category: EventCategory;
  /**
   * The event's type, kept as written.
   */
  type: EventEnvelopeType;
  /**
   * A person's or an agent's id; `null` or absent for a system event, never empty.
   */
  actor?: string | null;
  /**
   * The category's own members, every one kept as written but `__proto__`, which a JavaScript
   * reader cannot keep; may carry the epoch stamp.
   */
  payload: {
    [k: string]: unknown | undefined;
  };
  /**
   * The id that ties this event to others of one operation.
   */
  correlationId?: string;
  /**
   * The id of what caused this event.
   */
  causationId?: string;
  /**
   * The producer's version, written at emit time and never rewritten on read, so it is part of
   * the row's durable identity.
   */
  version: EventEnvelopeVersion;
}
/**
 * A stored event paired with its machine-authored body. `event` is the tolerant envelope, byte
 * for byte the stored row, so a reader need not parse it again to ask whether it has a body.
 */
export interface HydratedSessionEvent {
  /**
   * The stored event.
   */
  event: EventEnvelope;
  /**
   * Its body.
   */
  content: HydratedSessionEventContent;
}

// prettier-ignore
const schema360: any = {"description":"The category a session event belongs to; every event type maps to exactly one, so a mismatched\npair fails the strict parse. Adding a category is a minor version bump.","type":"string","enum":["runLifecycle","agentOutput","toolActivity","interactiveRequest","artifactPublication","sessionLifecycle","approvalFlow","usageTelemetry","recoveryEvents","securityEvents","eventMaintenance","orchestrationAdmission","mcpGovernance","workflowLifecycle","workflowPhaseLifecycle","workflowParallelCoordination","workflowGateResolution"]};
/** Checks that a value is a {@link EventCategory}. */
// prettier-ignore
export const validateEventCategory: CompiledSchemaCheck<EventCategory> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is EventCategory {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateEventCategory.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateEventCategory.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((((((((((((((data === "runLifecycle") || (data === "agentOutput")) || (data === "toolActivity")) || (data === "interactiveRequest")) || (data === "artifactPublication")) || (data === "sessionLifecycle")) || (data === "approvalFlow")) || (data === "usageTelemetry")) || (data === "recoveryEvents")) || (data === "securityEvents")) || (data === "eventMaintenance")) || (data === "orchestrationAdmission")) || (data === "mcpGovernance")) || (data === "workflowLifecycle")) || (data === "workflowPhaseLifecycle")) || (data === "workflowParallelCoordination")) || (data === "workflowGateResolution"))){validateEventCategory.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema360.enum}}];return false;}validateEventCategory.errors = vErrors;return errors === 0;};
// prettier-ignore
validateEventCategory.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern5 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
/** Checks that a value is a {@link EventEnvelopeType}. */
// prettier-ignore
export const validateEventEnvelopeType: CompiledSchemaCheck<EventEnvelopeType> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is EventEnvelopeType {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateEventEnvelopeType.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) > 256){validateEventEnvelopeType.errors = [{instancePath,schemaPath:"#/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data) < 1){validateEventEnvelopeType.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data)){validateEventEnvelopeType.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateEventEnvelopeType.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateEventEnvelopeType.errors = vErrors;return errors === 0;};
// prettier-ignore
validateEventEnvelopeType.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern204 = new RegExp("^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9](?:\\.[0-9]{1,3}0*)?)?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$", "u");
/** Checks that a value is a {@link EventOccurredAt}. */
// prettier-ignore
export const validateEventOccurredAt: CompiledSchemaCheck<EventOccurredAt> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is EventOccurredAt {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateEventOccurredAt.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern204.test(data)){validateEventOccurredAt.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9](?:\\.[0-9]{1,3}0*)?)?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$"}}];return false;}}else {validateEventOccurredAt.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateEventOccurredAt.errors = vErrors;return errors === 0;};
// prettier-ignore
validateEventOccurredAt.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema361: any = {"type":"object","additionalProperties":false,"properties":{"id":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The event's id, opaque on the wire; the daemon assigns a UUID v7."},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session the event belongs to."},"sequence":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"Daemon-assigned and strictly increasing per session: the order key."},"occurredAt":{"$ref":"#/$defs/EventOccurredAt","description":"When the event occurred; the append path stores it in UTC with millisecond precision."},"category":{"$ref":"#/$defs/EventCategory","description":"The event's category."},"type":{"$ref":"#/$defs/EventEnvelopeType","description":"The event's type, kept as written."},"actor":{"type":["string","null"],"minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"A person's or an agent's id; `null` or absent for a system event, never empty."},"payload":{"type":"object","additionalProperties":true,"description":"The category's own members, every one kept as written but `__proto__`, which a JavaScript\nreader cannot keep; may carry the epoch stamp.","propertyNames":{"not":{"const":"__proto__"}}},"correlationId":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The id that ties this event to others of one operation."},"causationId":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The id of what caused this event."},"version":{"$ref":"sidekicks-contracts:event/version#/$defs/EventEnvelopeVersion","description":"The producer's version, written at emit time and never rewritten on read, so it is part of\nthe row's durable identity."}},"required":["id","sessionId","sequence","occurredAt","category","type","payload","version"],"description":"The message every session event is stored and travels in. Its own members are closed; its\n`type` and `payload` are kept as written, so an event from a newer producer survives a read\nand a write unchanged."};
// prettier-ignore
const func2 = Object.prototype.hasOwnProperty;
/** Checks that a value is a {@link EventEnvelope}. */
// prettier-ignore
export const validateEventEnvelope: CompiledSchemaCheck<EventEnvelope> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is EventEnvelope {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateEventEnvelope.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((((data.id === undefined) && (missing0 = "id")) || ((data.sessionId === undefined) && (missing0 = "sessionId"))) || ((data.sequence === undefined) && (missing0 = "sequence"))) || ((data.occurredAt === undefined) && (missing0 = "occurredAt"))) || ((data.category === undefined) && (missing0 = "category"))) || ((data.type === undefined) && (missing0 = "type"))) || ((data.payload === undefined) && (missing0 = "payload"))) || ((data.version === undefined) && (missing0 = "version"))){validateEventEnvelope.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(func2.call(schema361.properties, key0))){validateEventEnvelope.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.id !== undefined){let data0: any = data.id;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 256){validateEventEnvelope.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validateEventEnvelope.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data0)){validateEventEnvelope.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateEventEnvelope.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.sessionId !== undefined){const _errs4: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.sequence !== undefined){let data2: any = data.sequence;const _errs5: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validateEventEnvelope.errors = [{instancePath:instancePath+"/sequence",schemaPath:"#/properties/sequence/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs5){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validateEventEnvelope.errors = [{instancePath:instancePath+"/sequence",schemaPath:"#/properties/sequence/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validateEventEnvelope.errors = [{instancePath:instancePath+"/sequence",schemaPath:"#/properties/sequence/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.occurredAt !== undefined){const _errs7: any = errors;if(!(validateEventOccurredAt.call(this, data.occurredAt, {instancePath:instancePath+"/occurredAt",parentData:data,parentDataProperty:"occurredAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateEventOccurredAt.errors : vErrors.concat(validateEventOccurredAt.errors);errors = vErrors.length;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.category !== undefined){const _errs8: any = errors;if(!(validateEventCategory.call(this, data.category, {instancePath:instancePath+"/category",parentData:data,parentDataProperty:"category",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateEventCategory.errors : vErrors.concat(validateEventCategory.errors);errors = vErrors.length;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.type !== undefined){const _errs9: any = errors;if(!(validateEventEnvelopeType.call(this, data.type, {instancePath:instancePath+"/type",parentData:data,parentDataProperty:"type",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateEventEnvelopeType.errors : vErrors.concat(validateEventEnvelopeType.errors);errors = vErrors.length;}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.actor !== undefined){let data6: any = data.actor;const _errs10: any = errors;if((typeof data6 !== "string") && (data6 !== null)){validateEventEnvelope.errors = [{instancePath:instancePath+"/actor",schemaPath:"#/properties/actor/type",keyword:"type",params:{type: schema361.properties.actor.type}}];return false;}if(errors === _errs10){if(typeof data6 === "string"){if(func1(data6) > 256){validateEventEnvelope.errors = [{instancePath:instancePath+"/actor",schemaPath:"#/properties/actor/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data6) < 1){validateEventEnvelope.errors = [{instancePath:instancePath+"/actor",schemaPath:"#/properties/actor/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data6)){validateEventEnvelope.errors = [{instancePath:instancePath+"/actor",schemaPath:"#/properties/actor/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.payload !== undefined){let data7: any = data.payload;const _errs12: any = errors;if(errors === _errs12){if(data7 && typeof data7 == "object" && !Array.isArray(data7)){for(const key1 in data7){const _errs14: any = errors;const _errs15: any = errors;const _errs16: any = errors;if("__proto__" !== key1){const err0: any = {};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var valid2: any = _errs16 === errors;if(valid2){const err1: any = {instancePath:instancePath+"/payload",schemaPath:"#/properties/payload/propertyNames/not",keyword:"not",params:{},propertyName:key1};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}else {errors = _errs15;if(vErrors !== null){if(_errs15){vErrors.length = _errs15;}else {vErrors = null;}}}var valid1: any = _errs14 === errors;if(!valid1){const err2: any = {instancePath:instancePath+"/payload",schemaPath:"#/properties/payload/propertyNames",keyword:"propertyNames",params:{propertyName: key1}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;validateEventEnvelope.errors = vErrors;return false;break;}}}else {validateEventEnvelope.errors = [{instancePath:instancePath+"/payload",schemaPath:"#/properties/payload/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.correlationId !== undefined){let data8: any = data.correlationId;const _errs18: any = errors;if(errors === _errs18){if(typeof data8 === "string"){if(func1(data8) > 256){validateEventEnvelope.errors = [{instancePath:instancePath+"/correlationId",schemaPath:"#/properties/correlationId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data8) < 1){validateEventEnvelope.errors = [{instancePath:instancePath+"/correlationId",schemaPath:"#/properties/correlationId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data8)){validateEventEnvelope.errors = [{instancePath:instancePath+"/correlationId",schemaPath:"#/properties/correlationId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateEventEnvelope.errors = [{instancePath:instancePath+"/correlationId",schemaPath:"#/properties/correlationId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs18 === errors;}else {var valid0: any = true;}if(valid0){if(data.causationId !== undefined){let data9: any = data.causationId;const _errs20: any = errors;if(errors === _errs20){if(typeof data9 === "string"){if(func1(data9) > 256){validateEventEnvelope.errors = [{instancePath:instancePath+"/causationId",schemaPath:"#/properties/causationId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data9) < 1){validateEventEnvelope.errors = [{instancePath:instancePath+"/causationId",schemaPath:"#/properties/causationId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data9)){validateEventEnvelope.errors = [{instancePath:instancePath+"/causationId",schemaPath:"#/properties/causationId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateEventEnvelope.errors = [{instancePath:instancePath+"/causationId",schemaPath:"#/properties/causationId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs20 === errors;}else {var valid0: any = true;}if(valid0){if(data.version !== undefined){const _errs22: any = errors;if(!(validateEventEnvelopeVersion.call(this, data.version, {instancePath:instancePath+"/version",parentData:data,parentDataProperty:"version",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateEventEnvelopeVersion.errors : vErrors.concat(validateEventEnvelopeVersion.errors);errors = vErrors.length;}var valid0: any = _errs22 === errors;}else {var valid0: any = true;}}}}}}}}}}}}}}else {validateEventEnvelope.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateEventEnvelope.errors = vErrors;return errors === 0;};
// prettier-ignore
validateEventEnvelope.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SourceEpoch}. */
// prettier-ignore
export const validateSourceEpoch: CompiledSchemaCheck<SourceEpoch> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SourceEpoch {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSourceEpoch.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(!(((typeof data == "number") && (!(data % 1) && !isNaN(data))) && (isFinite(data)))){validateSourceEpoch.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === 0){if((typeof data == "number") && (isFinite(data))){if(data > 9007199254740991 || isNaN(data)){validateSourceEpoch.errors = [{instancePath,schemaPath:"#/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data < 0 || isNaN(data)){validateSourceEpoch.errors = [{instancePath,schemaPath:"#/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}validateSourceEpoch.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSourceEpoch.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SourcePosition}. */
// prettier-ignore
export const validateSourcePosition: CompiledSchemaCheck<SourcePosition> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SourcePosition {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSourcePosition.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(!(((typeof data == "number") && (!(data % 1) && !isNaN(data))) && (isFinite(data)))){validateSourcePosition.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === 0){if((typeof data == "number") && (isFinite(data))){if(data > 9007199254740991 || isNaN(data)){validateSourcePosition.errors = [{instancePath,schemaPath:"#/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data < 0 || isNaN(data)){validateSourcePosition.errors = [{instancePath,schemaPath:"#/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}validateSourcePosition.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSourcePosition.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1277: any = {"description":"Why a stored event's body is not available.","type":"string","enum":["absent"]};
/** Checks that a value is a {@link HydratedContentUnavailableReason}. */
// prettier-ignore
export const validateHydratedContentUnavailableReason: CompiledSchemaCheck<HydratedContentUnavailableReason> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is HydratedContentUnavailableReason {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateHydratedContentUnavailableReason.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateHydratedContentUnavailableReason.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data === "absent")){validateHydratedContentUnavailableReason.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1277.enum}}];return false;}validateHydratedContentUnavailableReason.errors = vErrors;return errors === 0;};
// prettier-ignore
validateHydratedContentUnavailableReason.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
