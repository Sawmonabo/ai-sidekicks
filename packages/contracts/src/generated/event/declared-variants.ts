// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The payloads of the session events this module declares itself: event compaction and agent and tool activity.

import { type CompiledSchemaCheck, ucs2length } from "../../schema-check.js";
import { type MachineId, validateMachineId } from "../machine/id.js";
import { type ToolCallId, validateToolCallId } from "../provider/tool-call.js";
import { type RunId, validateRunId } from "../run/id.js";
import { type SessionId, validateSessionId } from "../session/id.js";
import { type TranscriptOmittedPatch, validateTranscriptOmittedPatch } from "../transcript/row.js";
import {
  type EventOccurredAt,
  type SourceEpoch,
  type SourcePosition,
  validateEventOccurredAt,
  validateSourceEpoch,
  validateSourcePosition,
} from "./envelope.js";

/** The payload key carrying the stored body's UTF-8 byte length. */
export const CONTENT_LENGTH_PAYLOAD_KEY = "contentLength" as const;

/** The payload key naming the stored body's encoding, present only on a compressed body. */
export const CONTENT_ENCODING_PAYLOAD_KEY = "contentEncoding" as const;

/**
 * How a stored body's bytes are encoded when they are not its UTF-8 as it is: a body of 1 KiB or
 * more is compressed, and its payload names the encoding so a reader decodes it.
 */
export type ContentEncoding = "zstd";
/**
 * The payload of `agent.message.sent` and `agent.thinking.updated`: a run's row, or a voice
 * call's spoken answer, which alone names no run.
 */
export type AgentOutputPayload =
  | {
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The provider's own id of the message this piece belongs to, the same on every
       * piece, so a reader can rejoin a message the wire delivered in pieces.
       */
      providerMessageId: string;
      /**
       * The body's media type, set by the producer and never by the append path.
       */
      contentType?: string;
      /**
       * The run the row belongs to.
       */
      runId: RunId;
      /**
       * The content block of its provider message the piece belongs to; present on every run's
       * piece.
       */
      providerBlock?: ProviderBlock;
      /**
       * Never present: only a voice call's answer carries an origin.
       */
      origin?: never;
      /**
       * The execution epoch a late row is attributed to; comes with `sourcePosition`.
       */
      sourceEpoch?: SourceEpoch;
      /**
       * The run position the row occupies within its epoch; comes with `sourceEpoch`.
       */
      sourcePosition?: SourcePosition;
      /**
       * The stored body's UTF-8 byte length.
       */
      contentLength?: number;
      /**
       * How the stored body is encoded, present only when it is compressed.
       */
      contentEncoding?: ContentEncoding;
    }
  | {
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The provider's own id of the message this piece belongs to, the same on every
       * piece, so a reader can rejoin a message the wire delivered in pieces.
       */
      providerMessageId: string;
      /**
       * The body's media type, set by the producer and never by the append path.
       */
      contentType?: string;
      /**
       * Always `voice`.
       */
      origin: "voice";
      /**
       * Never present: a voice call's answer comes outside any run.
       */
      runId?: never;
      /**
       * Never present: a spoken answer lands whole.
       */
      providerBlock?: never;
      /**
       * Never present: the stamp is run-local.
       */
      sourceEpoch?: never;
      /**
       * Never present: the stamp is run-local.
       */
      sourcePosition?: never;
      /**
       * The stored body's UTF-8 byte length.
       */
      contentLength?: number;
      /**
       * How the stored body is encoded, present only when it is compressed.
       */
      contentEncoding?: ContentEncoding;
    };
/**
 * Why a tool call ended with no result.
 */
export type ToolCallEndCause = "daemonRestart" | "daemonStop" | "processExit" | "stopped";

/**
 * One session a deletion removed, with the range of its rows the deletion deleted. Each end is a
 * `sequence` value and takes the envelope's ceiling, so it names the row it points at.
 */
export interface SessionEventCompactedRemovedSession {
  /**
   * The session removed.
   */
  sessionId: SessionId;
  /**
   * The first sequence deleted.
   */
  fromSeq: number;
  /**
   * The last sequence deleted; at or after `fromSeq`.
   */
  toSeq: number;
}
/**
 * The `session.event.compacted` payload: one receipt per removed session, committed in the
 * transaction that deletes its rows, naming that session and the range of rows deleted. It is
 * written only when the session had rows. The daemon writes it under its own sentinel session.
 */
export interface SessionEventCompactedPayload {
  /**
   * The machine whose daemon ran the deletion.
   */
  machineId: MachineId;
  /**
   * The deletion's correlation id: opaque, with no fixed format.
   */
  operationId: string;
  /**
   * When the deletion ran; the envelope's own instant, repeated in the payload.
   */
  occurredAt: EventOccurredAt;
  /**
   * Every session removed, with its deleted range.
   *
   * @minItems 1
   */
  removedSessions: [SessionEventCompactedRemovedSession, ...SessionEventCompactedRemovedSession[]];
}
/**
 * Which content block of a provider's message a piece belongs to: a reply sends its text, its
 * reasoning and its tool calls as blocks of one message, and a retried response may reuse the
 * message's id. Pieces join one row only when their message and block are the same.
 */
export interface ProviderBlock {
  /**
   * The block's index within its message, as the provider numbers it.
   */
  index: number;
  /**
   * Which response under the message's id the block belongs to, from 1.
   */
  attempt: number;
}
/**
 * An agent row of a run: every agent row but a voice call's spoken answer. It takes
 * the epoch stamp.
 */
export interface RunAgentOutputPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The provider's own id of the message this piece belongs to, the same on every
   * piece, so a reader can rejoin a message the wire delivered in pieces.
   */
  providerMessageId: string;
  /**
   * The body's media type, set by the producer and never by the append path.
   */
  contentType?: string;
  /**
   * The run the row belongs to.
   */
  runId: RunId;
  /**
   * The content block of its provider message the piece belongs to; present on every run's
   * piece.
   */
  providerBlock?: ProviderBlock;
  /**
   * Never present: only a voice call's answer carries an origin.
   */
  origin?: never;
  /**
   * The execution epoch a late row is attributed to; comes with `sourcePosition`.
   */
  sourceEpoch?: SourceEpoch;
  /**
   * The run position the row occupies within its epoch; comes with `sourceEpoch`.
   */
  sourcePosition?: SourcePosition;
  /**
   * The stored body's UTF-8 byte length.
   */
  contentLength?: number;
  /**
   * How the stored body is encoded, present only when it is compressed.
   */
  contentEncoding?: ContentEncoding;
}
/**
 * A voice call's spoken answer, which comes outside any run, so it names no run and takes no
 * epoch stamp.
 */
export interface VoiceAgentOutputPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The provider's own id of the message this piece belongs to, the same on every
   * piece, so a reader can rejoin a message the wire delivered in pieces.
   */
  providerMessageId: string;
  /**
   * The body's media type, set by the producer and never by the append path.
   */
  contentType?: string;
  /**
   * Always `voice`.
   */
  origin: "voice";
  /**
   * Never present: a voice call's answer comes outside any run.
   */
  runId?: never;
  /**
   * Never present: a spoken answer lands whole.
   */
  providerBlock?: never;
  /**
   * Never present: the stamp is run-local.
   */
  sourceEpoch?: never;
  /**
   * Never present: the stamp is run-local.
   */
  sourcePosition?: never;
  /**
   * The stored body's UTF-8 byte length.
   */
  contentLength?: number;
  /**
   * How the stored body is encoded, present only when it is compressed.
   */
  contentEncoding?: ContentEncoding;
}
/**
 * The payload of `agent.toolCall.invoked` and `agent.toolCall.completed`; the call's
 * arguments or result body is kept apart from it. It takes the epoch stamp.
 */
export interface ToolActivityPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run the call belongs to.
   */
  runId: RunId;
  /**
   * The tool's name; required, since a row with no name cannot be attributed and
   * the append path cannot add it.
   */
  toolName: string;
  /**
   * The provider's id of the call.
   */
  toolCallId?: ToolCallId;
  /**
   * How long the call took, in milliseconds.
   */
  durationMs?: number;
  /**
   * On a completion whose body holds its file patches, every file in the body's
   * order with its patch's UTF-8 size, so a row whose body is too large to travel
   * still names them; set by the producer. A body naming files is stored in bounded
   * parts of each file, which the patch read pages; an empty list names none, and
   * its body is stored as any other.
   */
  omittedPatches?: TranscriptOmittedPatch[];
  /**
   * The execution epoch a late row is attributed to; comes with `sourcePosition`.
   */
  sourceEpoch?: SourceEpoch;
  /**
   * The run position the row occupies within its epoch; comes with `sourceEpoch`.
   */
  sourcePosition?: SourcePosition;
  /**
   * The stored body's UTF-8 byte length.
   */
  contentLength?: number;
  /**
   * How the stored body is encoded, present only when it is compressed.
   */
  contentEncoding?: ContentEncoding;
}
/**
 * The payload of `agent.toolCall.failed`, whose error body is kept apart from it; `endCause`
 * is present only when the call ended with no result, and names why. A row with no body reads
 * its cause's label (`Stopped`, `Process exited`, `Service restarted`, `Service stopped`); any
 * body is the provider's own reason, never the task's name.
 */
export interface ToolCallFailedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run the call belongs to.
   */
  runId: RunId;
  /**
   * The tool's name; required, since a row with no name cannot be attributed and
   * the append path cannot add it.
   */
  toolName: string;
  /**
   * The provider's id of the call.
   */
  toolCallId?: ToolCallId;
  /**
   * How long the call took, in milliseconds.
   */
  durationMs?: number;
  /**
   * On a completion whose body holds its file patches, every file in the body's
   * order with its patch's UTF-8 size, so a row whose body is too large to travel
   * still names them; set by the producer. A body naming files is stored in bounded
   * parts of each file, which the patch read pages; an empty list names none, and
   * its body is stored as any other.
   */
  omittedPatches?: TranscriptOmittedPatch[];
  /**
   * Why the call ended with no result; absent when the call failed with a result.
   */
  endCause?: ToolCallEndCause;
  /**
   * The execution epoch a late row is attributed to; comes with `sourcePosition`.
   */
  sourceEpoch?: SourceEpoch;
  /**
   * The run position the row occupies within its epoch; comes with `sourceEpoch`.
   */
  sourcePosition?: SourcePosition;
  /**
   * The stored body's UTF-8 byte length.
   */
  contentLength?: number;
  /**
   * How the stored body is encoded, present only when it is compressed.
   */
  contentEncoding?: ContentEncoding;
}
/**
 * The payload of `agent.toolCall.backgrounded`: the provider moved the call to the background
 * and answered the model with a stand-in naming its task, which is the row's body.
 */
export interface ToolCallBackgroundedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run the call belongs to.
   */
  runId: RunId;
  /**
   * The tool's name; required, since a row with no name cannot be attributed and
   * the append path cannot add it.
   */
  toolName: string;
  /**
   * The provider's id of the call.
   */
  toolCallId: ToolCallId;
  /**
   * The provider's id of the background task the call became.
   */
  taskId: string;
  /**
   * Whether the task outlives a restart of the background service.
   */
  survivesRestart: boolean;
  /**
   * The execution epoch a late row is attributed to; comes with `sourcePosition`.
   */
  sourceEpoch?: SourceEpoch;
  /**
   * The run position the row occupies within its epoch; comes with `sourceEpoch`.
   */
  sourcePosition?: SourcePosition;
  /**
   * The stored body's UTF-8 byte length.
   */
  contentLength?: number;
  /**
   * How the stored body is encoded, present only when it is compressed.
   */
  contentEncoding?: ContentEncoding;
}

// prettier-ignore
const schema214: any = {"description":"How a stored body's bytes are encoded when they are not its UTF-8 as it is: a body of 1 KiB or\nmore is compressed, and its payload names the encoding so a reader decodes it.","type":"string","enum":["zstd"]};
/** Checks that a value is a {@link ContentEncoding}. */
// prettier-ignore
export const validateContentEncoding: CompiledSchemaCheck<ContentEncoding> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ContentEncoding {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateContentEncoding.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateContentEncoding.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data === "zstd")){validateContentEncoding.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema214.enum}}];return false;}validateContentEncoding.errors = vErrors;return errors === 0;};
// prettier-ignore
validateContentEncoding.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionEventCompactedRemovedSession}. */
// prettier-ignore
export const validateSessionEventCompactedRemovedSession: CompiledSchemaCheck<SessionEventCompactedRemovedSession> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionEventCompactedRemovedSession {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionEventCompactedRemovedSession.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.fromSeq === undefined) && (missing0 = "fromSeq"))) || ((data.toSeq === undefined) && (missing0 = "toSeq"))){validateSessionEventCompactedRemovedSession.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "fromSeq")) || (key0 === "toSeq"))){validateSessionEventCompactedRemovedSession.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.fromSeq !== undefined){let data1: any = data.fromSeq;const _errs3: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validateSessionEventCompactedRemovedSession.errors = [{instancePath:instancePath+"/fromSeq",schemaPath:"#/properties/fromSeq/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs3){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validateSessionEventCompactedRemovedSession.errors = [{instancePath:instancePath+"/fromSeq",schemaPath:"#/properties/fromSeq/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 0 || isNaN(data1)){validateSessionEventCompactedRemovedSession.errors = [{instancePath:instancePath+"/fromSeq",schemaPath:"#/properties/fromSeq/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.toSeq !== undefined){let data2: any = data.toSeq;const _errs5: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validateSessionEventCompactedRemovedSession.errors = [{instancePath:instancePath+"/toSeq",schemaPath:"#/properties/toSeq/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs5){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validateSessionEventCompactedRemovedSession.errors = [{instancePath:instancePath+"/toSeq",schemaPath:"#/properties/toSeq/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {const vSchema0: any = data && data.fromSeq;if(vSchema0 !== undefined && ((!((typeof vSchema0 == "number") && (isFinite(vSchema0)))) || (data2 < vSchema0 || isNaN(data2)))){validateSessionEventCompactedRemovedSession.errors = [{instancePath:instancePath+"/toSeq",schemaPath:"#/properties/toSeq/minimum",keyword:"minimum",params:{comparison: ">=", limit: vSchema0}}];return false;}}}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}else {validateSessionEventCompactedRemovedSession.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionEventCompactedRemovedSession.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionEventCompactedRemovedSession.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern5 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
/** Checks that a value is a {@link SessionEventCompactedPayload}. */
// prettier-ignore
export const validateSessionEventCompactedPayload: CompiledSchemaCheck<SessionEventCompactedPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionEventCompactedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionEventCompactedPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.machineId === undefined) && (missing0 = "machineId")) || ((data.operationId === undefined) && (missing0 = "operationId"))) || ((data.occurredAt === undefined) && (missing0 = "occurredAt"))) || ((data.removedSessions === undefined) && (missing0 = "removedSessions"))){validateSessionEventCompactedPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "machineId") || (key0 === "operationId")) || (key0 === "occurredAt")) || (key0 === "removedSessions"))){validateSessionEventCompactedPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.machineId !== undefined){const _errs2: any = errors;if(!(validateMachineId.call(this, data.machineId, {instancePath:instancePath+"/machineId",parentData:data,parentDataProperty:"machineId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateMachineId.errors : vErrors.concat(validateMachineId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.operationId !== undefined){let data1: any = data.operationId;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 256){validateSessionEventCompactedPayload.errors = [{instancePath:instancePath+"/operationId",schemaPath:"#/properties/operationId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validateSessionEventCompactedPayload.errors = [{instancePath:instancePath+"/operationId",schemaPath:"#/properties/operationId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data1)){validateSessionEventCompactedPayload.errors = [{instancePath:instancePath+"/operationId",schemaPath:"#/properties/operationId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateSessionEventCompactedPayload.errors = [{instancePath:instancePath+"/operationId",schemaPath:"#/properties/operationId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.occurredAt !== undefined){const _errs5: any = errors;if(!(validateEventOccurredAt.call(this, data.occurredAt, {instancePath:instancePath+"/occurredAt",parentData:data,parentDataProperty:"occurredAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateEventOccurredAt.errors : vErrors.concat(validateEventOccurredAt.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.removedSessions !== undefined){let data3: any = data.removedSessions;const _errs6: any = errors;if(errors === _errs6){if(Array.isArray(data3)){if(data3.length < 1){validateSessionEventCompactedPayload.errors = [{instancePath:instancePath+"/removedSessions",schemaPath:"#/properties/removedSessions/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid1: any = true;const len0: any = data3.length;for(let i0=0; i0<len0; i0++){const _errs8: any = errors;if(!(validateSessionEventCompactedRemovedSession.call(this, data3[i0], {instancePath:instancePath+"/removedSessions/" + i0,parentData:data3,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionEventCompactedRemovedSession.errors : vErrors.concat(validateSessionEventCompactedRemovedSession.errors);errors = vErrors.length;}var valid1: any = _errs8 === errors;if(!valid1){break;}}}}else {validateSessionEventCompactedPayload.errors = [{instancePath:instancePath+"/removedSessions",schemaPath:"#/properties/removedSessions/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}}else {validateSessionEventCompactedPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionEventCompactedPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionEventCompactedPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProviderBlock}. */
// prettier-ignore
export const validateProviderBlock: CompiledSchemaCheck<ProviderBlock> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderBlock {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateProviderBlock.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.index === undefined) && (missing0 = "index")) || ((data.attempt === undefined) && (missing0 = "attempt"))){validateProviderBlock.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "index") || (key0 === "attempt"))){validateProviderBlock.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.index !== undefined){let data0: any = data.index;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validateProviderBlock.errors = [{instancePath:instancePath+"/index",schemaPath:"#/properties/index/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs2){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validateProviderBlock.errors = [{instancePath:instancePath+"/index",schemaPath:"#/properties/index/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < 0 || isNaN(data0)){validateProviderBlock.errors = [{instancePath:instancePath+"/index",schemaPath:"#/properties/index/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.attempt !== undefined){let data1: any = data.attempt;const _errs4: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validateProviderBlock.errors = [{instancePath:instancePath+"/attempt",schemaPath:"#/properties/attempt/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validateProviderBlock.errors = [{instancePath:instancePath+"/attempt",schemaPath:"#/properties/attempt/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 1 || isNaN(data1)){validateProviderBlock.errors = [{instancePath:instancePath+"/attempt",schemaPath:"#/properties/attempt/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validateProviderBlock.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateProviderBlock.errors = vErrors;return errors === 0;};
// prettier-ignore
validateProviderBlock.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema350: any = {"anyOf":[{"type":"object","additionalProperties":false,"properties":{"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"providerMessageId":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The provider's own id of the message this piece belongs to, the same on every\npiece, so a reader can rejoin a message the wire delivered in pieces."},"contentType":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The body's media type, set by the producer and never by the append path."},"runId":{"$ref":"sidekicks-contracts:run/id#/$defs/RunId","description":"The run the row belongs to."},"providerBlock":{"$ref":"#/$defs/ProviderBlock","description":"The content block of its provider message the piece belongs to; present on every run's\npiece."},"origin":{"not":{},"tsType":"never","description":"Never present: only a voice call's answer carries an origin."},"sourceEpoch":{"$ref":"sidekicks-contracts:event/envelope#/$defs/SourceEpoch","description":"The execution epoch a late row is attributed to; comes with `sourcePosition`."},"sourcePosition":{"$ref":"sidekicks-contracts:event/envelope#/$defs/SourcePosition","description":"The run position the row occupies within its epoch; comes with `sourceEpoch`."},"contentLength":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"The stored body's UTF-8 byte length."},"contentEncoding":{"$ref":"#/$defs/ContentEncoding","description":"How the stored body is encoded, present only when it is compressed."}},"required":["sessionId","providerMessageId","runId"],"description":"A run's row.","dependentRequired":{"sourceEpoch":["sourcePosition","runId"],"sourcePosition":["sourceEpoch","runId"]}},{"type":"object","additionalProperties":false,"properties":{"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"providerMessageId":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The provider's own id of the message this piece belongs to, the same on every\npiece, so a reader can rejoin a message the wire delivered in pieces."},"contentType":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The body's media type, set by the producer and never by the append path."},"origin":{"description":"Always `voice`.","type":"string","enum":["voice"]},"runId":{"not":{},"tsType":"never","description":"Never present: a voice call's answer comes outside any run."},"providerBlock":{"not":{},"tsType":"never","description":"Never present: a spoken answer lands whole."},"sourceEpoch":{"not":{},"tsType":"never","description":"Never present: the stamp is run-local."},"sourcePosition":{"not":{},"tsType":"never","description":"Never present: the stamp is run-local."},"contentLength":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"The stored body's UTF-8 byte length."},"contentEncoding":{"$ref":"#/$defs/ContentEncoding","description":"How the stored body is encoded, present only when it is compressed."}},"required":["sessionId","providerMessageId","origin"],"description":"A voice call's spoken answer."}],"description":"The payload of `agent.message.sent` and `agent.thinking.updated`: a run's row, or a voice\ncall's spoken answer, which alone names no run."};
// prettier-ignore
const func2 = Object.prototype.hasOwnProperty;
/** Checks that a value is a {@link AgentOutputPayload}. */
// prettier-ignore
export const validateAgentOutputPayload: CompiledSchemaCheck<AgentOutputPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentOutputPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAgentOutputPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(errors === _errs1){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.providerMessageId === undefined) && (missing0 = "providerMessageId"))) || ((data.runId === undefined) && (missing0 = "runId"))){const err0: any = {instancePath,schemaPath:"#/anyOf/0/required",keyword:"required",params:{missingProperty: missing0}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {const _errs3: any = errors;for(const key0 in data){if(!(func2.call(schema350.anyOf[0].properties, key0))){const err1: any = {instancePath,schemaPath:"#/anyOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;break;}}if(_errs3 === errors){if(data.sessionId !== undefined){const _errs4: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;}else {var valid1: any = true;}if(valid1){if(data.providerMessageId !== undefined){let data1: any = data.providerMessageId;const _errs5: any = errors;if(errors === _errs5){if(typeof data1 === "string"){if(func1(data1) > 256){const err2: any = {instancePath:instancePath+"/providerMessageId",schemaPath:"#/anyOf/0/properties/providerMessageId/maxLength",keyword:"maxLength",params:{limit: 256}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}else {if(func1(data1) < 1){const err3: any = {instancePath:instancePath+"/providerMessageId",schemaPath:"#/anyOf/0/properties/providerMessageId/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}else {if(!pattern5.test(data1)){const err4: any = {instancePath:instancePath+"/providerMessageId",schemaPath:"#/anyOf/0/properties/providerMessageId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}}}}else {const err5: any = {instancePath:instancePath+"/providerMessageId",schemaPath:"#/anyOf/0/properties/providerMessageId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}}var valid1: any = _errs5 === errors;}else {var valid1: any = true;}if(valid1){if(data.contentType !== undefined){let data2: any = data.contentType;const _errs7: any = errors;if(errors === _errs7){if(typeof data2 === "string"){if(func1(data2) > 256){const err6: any = {instancePath:instancePath+"/contentType",schemaPath:"#/anyOf/0/properties/contentType/maxLength",keyword:"maxLength",params:{limit: 256}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}else {if(func1(data2) < 1){const err7: any = {instancePath:instancePath+"/contentType",schemaPath:"#/anyOf/0/properties/contentType/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;}else {if(!pattern5.test(data2)){const err8: any = {instancePath:instancePath+"/contentType",schemaPath:"#/anyOf/0/properties/contentType/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;}}}}else {const err9: any = {instancePath:instancePath+"/contentType",schemaPath:"#/anyOf/0/properties/contentType/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;}}var valid1: any = _errs7 === errors;}else {var valid1: any = true;}if(valid1){if(data.runId !== undefined){const _errs9: any = errors;if(!(validateRunId.call(this, data.runId, {instancePath:instancePath+"/runId",parentData:data,parentDataProperty:"runId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunId.errors : vErrors.concat(validateRunId.errors);errors = vErrors.length;}var valid1: any = _errs9 === errors;}else {var valid1: any = true;}if(valid1){if(data.providerBlock !== undefined){const _errs10: any = errors;if(!(validateProviderBlock.call(this, data.providerBlock, {instancePath:instancePath+"/providerBlock",parentData:data,parentDataProperty:"providerBlock",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderBlock.errors : vErrors.concat(validateProviderBlock.errors);errors = vErrors.length;}var valid1: any = _errs10 === errors;}else {var valid1: any = true;}if(valid1){if(data.origin !== undefined){const _errs11: any = errors;const err10: any = {instancePath:instancePath+"/origin",schemaPath:"#/anyOf/0/properties/origin/not",keyword:"not",params:{}};if(vErrors === null){vErrors = [err10];}else {vErrors.push(err10);}errors++;var valid1: any = _errs11 === errors;}else {var valid1: any = true;}if(valid1){if(data.sourceEpoch !== undefined){const _errs14: any = errors;if(!(validateSourceEpoch.call(this, data.sourceEpoch, {instancePath:instancePath+"/sourceEpoch",parentData:data,parentDataProperty:"sourceEpoch",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSourceEpoch.errors : vErrors.concat(validateSourceEpoch.errors);errors = vErrors.length;}var valid1: any = _errs14 === errors;}else {var valid1: any = true;}if(valid1){if(data.sourcePosition !== undefined){const _errs15: any = errors;if(!(validateSourcePosition.call(this, data.sourcePosition, {instancePath:instancePath+"/sourcePosition",parentData:data,parentDataProperty:"sourcePosition",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSourcePosition.errors : vErrors.concat(validateSourcePosition.errors);errors = vErrors.length;}var valid1: any = _errs15 === errors;}else {var valid1: any = true;}if(valid1){if(data.contentLength !== undefined){let data8: any = data.contentLength;const _errs16: any = errors;if(!(((typeof data8 == "number") && (!(data8 % 1) && !isNaN(data8))) && (isFinite(data8)))){const err11: any = {instancePath:instancePath+"/contentLength",schemaPath:"#/anyOf/0/properties/contentLength/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err11];}else {vErrors.push(err11);}errors++;}if(errors === _errs16){if((typeof data8 == "number") && (isFinite(data8))){if(data8 > 9007199254740991 || isNaN(data8)){const err12: any = {instancePath:instancePath+"/contentLength",schemaPath:"#/anyOf/0/properties/contentLength/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}};if(vErrors === null){vErrors = [err12];}else {vErrors.push(err12);}errors++;}else {if(data8 < 0 || isNaN(data8)){const err13: any = {instancePath:instancePath+"/contentLength",schemaPath:"#/anyOf/0/properties/contentLength/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}};if(vErrors === null){vErrors = [err13];}else {vErrors.push(err13);}errors++;}}}}var valid1: any = _errs16 === errors;}else {var valid1: any = true;}if(valid1){if(data.contentEncoding !== undefined){const _errs18: any = errors;if(!(validateContentEncoding.call(this, data.contentEncoding, {instancePath:instancePath+"/contentEncoding",parentData:data,parentDataProperty:"contentEncoding",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateContentEncoding.errors : vErrors.concat(validateContentEncoding.errors);errors = vErrors.length;}var valid1: any = _errs18 === errors;}else {var valid1: any = true;}if(valid1){let missing1: any;if(data.sourceEpoch !== undefined && (((data.sourcePosition === undefined) && (missing1 = "sourcePosition")) || ((data.runId === undefined) && (missing1 = "runId")))){const err14: any = {instancePath,schemaPath:"#/anyOf/0/dependentRequired",keyword:"dependentRequired",params:{property: "sourceEpoch",
    missingProperty: missing1,
    depsCount: 2,
    deps: "sourcePosition, runId"}};if(vErrors === null){vErrors = [err14];}else {vErrors.push(err14);}errors++;}else {if(data.sourcePosition !== undefined && (((data.sourceEpoch === undefined) && (missing1 = "sourceEpoch")) || ((data.runId === undefined) && (missing1 = "runId")))){const err15: any = {instancePath,schemaPath:"#/anyOf/0/dependentRequired",keyword:"dependentRequired",params:{property: "sourcePosition",
    missingProperty: missing1,
    depsCount: 2,
    deps: "sourceEpoch, runId"}};if(vErrors === null){vErrors = [err15];}else {vErrors.push(err15);}errors++;}}}}}}}}}}}}}}}else {const err16: any = {instancePath,schemaPath:"#/anyOf/0/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err16];}else {vErrors.push(err16);}errors++;}}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs19: any = errors;if(errors === _errs19){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((((data.sessionId === undefined) && (missing2 = "sessionId")) || ((data.providerMessageId === undefined) && (missing2 = "providerMessageId"))) || ((data.origin === undefined) && (missing2 = "origin"))){const err17: any = {instancePath,schemaPath:"#/anyOf/1/required",keyword:"required",params:{missingProperty: missing2}};if(vErrors === null){vErrors = [err17];}else {vErrors.push(err17);}errors++;}else {const _errs21: any = errors;for(const key1 in data){if(!(func2.call(schema350.anyOf[1].properties, key1))){const err18: any = {instancePath,schemaPath:"#/anyOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}};if(vErrors === null){vErrors = [err18];}else {vErrors.push(err18);}errors++;break;}}if(_errs21 === errors){if(data.sessionId !== undefined){const _errs22: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid2: any = _errs22 === errors;}else {var valid2: any = true;}if(valid2){if(data.providerMessageId !== undefined){let data11: any = data.providerMessageId;const _errs23: any = errors;if(errors === _errs23){if(typeof data11 === "string"){if(func1(data11) > 256){const err19: any = {instancePath:instancePath+"/providerMessageId",schemaPath:"#/anyOf/1/properties/providerMessageId/maxLength",keyword:"maxLength",params:{limit: 256}};if(vErrors === null){vErrors = [err19];}else {vErrors.push(err19);}errors++;}else {if(func1(data11) < 1){const err20: any = {instancePath:instancePath+"/providerMessageId",schemaPath:"#/anyOf/1/properties/providerMessageId/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err20];}else {vErrors.push(err20);}errors++;}else {if(!pattern5.test(data11)){const err21: any = {instancePath:instancePath+"/providerMessageId",schemaPath:"#/anyOf/1/properties/providerMessageId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err21];}else {vErrors.push(err21);}errors++;}}}}else {const err22: any = {instancePath:instancePath+"/providerMessageId",schemaPath:"#/anyOf/1/properties/providerMessageId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err22];}else {vErrors.push(err22);}errors++;}}var valid2: any = _errs23 === errors;}else {var valid2: any = true;}if(valid2){if(data.contentType !== undefined){let data12: any = data.contentType;const _errs25: any = errors;if(errors === _errs25){if(typeof data12 === "string"){if(func1(data12) > 256){const err23: any = {instancePath:instancePath+"/contentType",schemaPath:"#/anyOf/1/properties/contentType/maxLength",keyword:"maxLength",params:{limit: 256}};if(vErrors === null){vErrors = [err23];}else {vErrors.push(err23);}errors++;}else {if(func1(data12) < 1){const err24: any = {instancePath:instancePath+"/contentType",schemaPath:"#/anyOf/1/properties/contentType/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err24];}else {vErrors.push(err24);}errors++;}else {if(!pattern5.test(data12)){const err25: any = {instancePath:instancePath+"/contentType",schemaPath:"#/anyOf/1/properties/contentType/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err25];}else {vErrors.push(err25);}errors++;}}}}else {const err26: any = {instancePath:instancePath+"/contentType",schemaPath:"#/anyOf/1/properties/contentType/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err26];}else {vErrors.push(err26);}errors++;}}var valid2: any = _errs25 === errors;}else {var valid2: any = true;}if(valid2){if(data.origin !== undefined){let data13: any = data.origin;const _errs27: any = errors;if(typeof data13 !== "string"){const err27: any = {instancePath:instancePath+"/origin",schemaPath:"#/anyOf/1/properties/origin/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err27];}else {vErrors.push(err27);}errors++;}if(!(data13 === "voice")){const err28: any = {instancePath:instancePath+"/origin",schemaPath:"#/anyOf/1/properties/origin/enum",keyword:"enum",params:{allowedValues: schema350.anyOf[1].properties.origin.enum}};if(vErrors === null){vErrors = [err28];}else {vErrors.push(err28);}errors++;}var valid2: any = _errs27 === errors;}else {var valid2: any = true;}if(valid2){if(data.runId !== undefined){const _errs29: any = errors;const err29: any = {instancePath:instancePath+"/runId",schemaPath:"#/anyOf/1/properties/runId/not",keyword:"not",params:{}};if(vErrors === null){vErrors = [err29];}else {vErrors.push(err29);}errors++;var valid2: any = _errs29 === errors;}else {var valid2: any = true;}if(valid2){if(data.providerBlock !== undefined){const _errs32: any = errors;const err30: any = {instancePath:instancePath+"/providerBlock",schemaPath:"#/anyOf/1/properties/providerBlock/not",keyword:"not",params:{}};if(vErrors === null){vErrors = [err30];}else {vErrors.push(err30);}errors++;var valid2: any = _errs32 === errors;}else {var valid2: any = true;}if(valid2){if(data.sourceEpoch !== undefined){const _errs35: any = errors;const err31: any = {instancePath:instancePath+"/sourceEpoch",schemaPath:"#/anyOf/1/properties/sourceEpoch/not",keyword:"not",params:{}};if(vErrors === null){vErrors = [err31];}else {vErrors.push(err31);}errors++;var valid2: any = _errs35 === errors;}else {var valid2: any = true;}if(valid2){if(data.sourcePosition !== undefined){const _errs38: any = errors;const err32: any = {instancePath:instancePath+"/sourcePosition",schemaPath:"#/anyOf/1/properties/sourcePosition/not",keyword:"not",params:{}};if(vErrors === null){vErrors = [err32];}else {vErrors.push(err32);}errors++;var valid2: any = _errs38 === errors;}else {var valid2: any = true;}if(valid2){if(data.contentLength !== undefined){let data18: any = data.contentLength;const _errs41: any = errors;if(!(((typeof data18 == "number") && (!(data18 % 1) && !isNaN(data18))) && (isFinite(data18)))){const err33: any = {instancePath:instancePath+"/contentLength",schemaPath:"#/anyOf/1/properties/contentLength/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err33];}else {vErrors.push(err33);}errors++;}if(errors === _errs41){if((typeof data18 == "number") && (isFinite(data18))){if(data18 > 9007199254740991 || isNaN(data18)){const err34: any = {instancePath:instancePath+"/contentLength",schemaPath:"#/anyOf/1/properties/contentLength/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}};if(vErrors === null){vErrors = [err34];}else {vErrors.push(err34);}errors++;}else {if(data18 < 0 || isNaN(data18)){const err35: any = {instancePath:instancePath+"/contentLength",schemaPath:"#/anyOf/1/properties/contentLength/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}};if(vErrors === null){vErrors = [err35];}else {vErrors.push(err35);}errors++;}}}}var valid2: any = _errs41 === errors;}else {var valid2: any = true;}if(valid2){if(data.contentEncoding !== undefined){const _errs43: any = errors;if(!(validateContentEncoding.call(this, data.contentEncoding, {instancePath:instancePath+"/contentEncoding",parentData:data,parentDataProperty:"contentEncoding",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateContentEncoding.errors : vErrors.concat(validateContentEncoding.errors);errors = vErrors.length;}var valid2: any = _errs43 === errors;}else {var valid2: any = true;}}}}}}}}}}}}}else {const err36: any = {instancePath,schemaPath:"#/anyOf/1/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err36];}else {vErrors.push(err36);}errors++;}}var _valid0: any = _errs19 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid0){const err37: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err37];}else {vErrors.push(err37);}errors++;validateAgentOutputPayload.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validateAgentOutputPayload.errors = vErrors;evaluated0.props = props0;return errors === 0;};
// prettier-ignore
validateAgentOutputPayload.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
// prettier-ignore
const schema355: any = {"type":"object","additionalProperties":false,"properties":{"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"runId":{"$ref":"sidekicks-contracts:run/id#/$defs/RunId","description":"The run the call belongs to."},"toolName":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The tool's name; required, since a row with no name cannot be attributed and\nthe append path cannot add it."},"toolCallId":{"$ref":"sidekicks-contracts:provider/tool-call#/$defs/ToolCallId","description":"The provider's id of the call."},"durationMs":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"How long the call took, in milliseconds."},"omittedPatches":{"type":"array","items":{"$ref":"sidekicks-contracts:transcript/row#/$defs/TranscriptOmittedPatch"},"description":"On a completion whose body holds its file patches, every file in the body's\norder with its patch's UTF-8 size, so a row whose body is too large to travel\nstill names them; set by the producer. A body naming files is stored in bounded\nparts of each file, which the patch read pages; an empty list names none, and\nits body is stored as any other."},"sourceEpoch":{"$ref":"sidekicks-contracts:event/envelope#/$defs/SourceEpoch","description":"The execution epoch a late row is attributed to; comes with `sourcePosition`."},"sourcePosition":{"$ref":"sidekicks-contracts:event/envelope#/$defs/SourcePosition","description":"The run position the row occupies within its epoch; comes with `sourceEpoch`."},"contentLength":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"The stored body's UTF-8 byte length."},"contentEncoding":{"$ref":"#/$defs/ContentEncoding","description":"How the stored body is encoded, present only when it is compressed."}},"required":["sessionId","runId","toolName"],"description":"The payload of `agent.toolCall.invoked` and `agent.toolCall.completed`; the call's\narguments or result body is kept apart from it. It takes the epoch stamp.","dependentRequired":{"sourceEpoch":["sourcePosition","runId"],"sourcePosition":["sourceEpoch","runId"]}};
/** Checks that a value is a {@link ToolActivityPayload}. */
// prettier-ignore
export const validateToolActivityPayload: CompiledSchemaCheck<ToolActivityPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ToolActivityPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateToolActivityPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.runId === undefined) && (missing0 = "runId"))) || ((data.toolName === undefined) && (missing0 = "toolName"))){validateToolActivityPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(func2.call(schema355.properties, key0))){validateToolActivityPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.runId !== undefined){const _errs3: any = errors;if(!(validateRunId.call(this, data.runId, {instancePath:instancePath+"/runId",parentData:data,parentDataProperty:"runId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunId.errors : vErrors.concat(validateRunId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.toolName !== undefined){let data2: any = data.toolName;const _errs4: any = errors;if(errors === _errs4){if(typeof data2 === "string"){if(func1(data2) > 256){validateToolActivityPayload.errors = [{instancePath:instancePath+"/toolName",schemaPath:"#/properties/toolName/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data2) < 1){validateToolActivityPayload.errors = [{instancePath:instancePath+"/toolName",schemaPath:"#/properties/toolName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data2)){validateToolActivityPayload.errors = [{instancePath:instancePath+"/toolName",schemaPath:"#/properties/toolName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateToolActivityPayload.errors = [{instancePath:instancePath+"/toolName",schemaPath:"#/properties/toolName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.toolCallId !== undefined){const _errs6: any = errors;if(!(validateToolCallId.call(this, data.toolCallId, {instancePath:instancePath+"/toolCallId",parentData:data,parentDataProperty:"toolCallId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateToolCallId.errors : vErrors.concat(validateToolCallId.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.durationMs !== undefined){let data4: any = data.durationMs;const _errs7: any = errors;if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){validateToolActivityPayload.errors = [{instancePath:instancePath+"/durationMs",schemaPath:"#/properties/durationMs/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs7){if((typeof data4 == "number") && (isFinite(data4))){if(data4 > 9007199254740991 || isNaN(data4)){validateToolActivityPayload.errors = [{instancePath:instancePath+"/durationMs",schemaPath:"#/properties/durationMs/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data4 < 0 || isNaN(data4)){validateToolActivityPayload.errors = [{instancePath:instancePath+"/durationMs",schemaPath:"#/properties/durationMs/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.omittedPatches !== undefined){let data5: any = data.omittedPatches;const _errs9: any = errors;if(errors === _errs9){if(Array.isArray(data5)){var valid1: any = true;const len0: any = data5.length;for(let i0=0; i0<len0; i0++){const _errs11: any = errors;if(!(validateTranscriptOmittedPatch.call(this, data5[i0], {instancePath:instancePath+"/omittedPatches/" + i0,parentData:data5,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTranscriptOmittedPatch.errors : vErrors.concat(validateTranscriptOmittedPatch.errors);errors = vErrors.length;}var valid1: any = _errs11 === errors;if(!valid1){break;}}}else {validateToolActivityPayload.errors = [{instancePath:instancePath+"/omittedPatches",schemaPath:"#/properties/omittedPatches/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.sourceEpoch !== undefined){const _errs12: any = errors;if(!(validateSourceEpoch.call(this, data.sourceEpoch, {instancePath:instancePath+"/sourceEpoch",parentData:data,parentDataProperty:"sourceEpoch",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSourceEpoch.errors : vErrors.concat(validateSourceEpoch.errors);errors = vErrors.length;}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.sourcePosition !== undefined){const _errs13: any = errors;if(!(validateSourcePosition.call(this, data.sourcePosition, {instancePath:instancePath+"/sourcePosition",parentData:data,parentDataProperty:"sourcePosition",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSourcePosition.errors : vErrors.concat(validateSourcePosition.errors);errors = vErrors.length;}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}if(valid0){if(data.contentLength !== undefined){let data9: any = data.contentLength;const _errs14: any = errors;if(!(((typeof data9 == "number") && (!(data9 % 1) && !isNaN(data9))) && (isFinite(data9)))){validateToolActivityPayload.errors = [{instancePath:instancePath+"/contentLength",schemaPath:"#/properties/contentLength/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs14){if((typeof data9 == "number") && (isFinite(data9))){if(data9 > 9007199254740991 || isNaN(data9)){validateToolActivityPayload.errors = [{instancePath:instancePath+"/contentLength",schemaPath:"#/properties/contentLength/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data9 < 0 || isNaN(data9)){validateToolActivityPayload.errors = [{instancePath:instancePath+"/contentLength",schemaPath:"#/properties/contentLength/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}if(valid0){if(data.contentEncoding !== undefined){const _errs16: any = errors;if(!(validateContentEncoding.call(this, data.contentEncoding, {instancePath:instancePath+"/contentEncoding",parentData:data,parentDataProperty:"contentEncoding",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateContentEncoding.errors : vErrors.concat(validateContentEncoding.errors);errors = vErrors.length;}var valid0: any = _errs16 === errors;}else {var valid0: any = true;}if(valid0){let missing1: any;if(data.sourceEpoch !== undefined && (((data.sourcePosition === undefined) && (missing1 = "sourcePosition")) || ((data.runId === undefined) && (missing1 = "runId")))){validateToolActivityPayload.errors = [{instancePath,schemaPath:"#/dependentRequired",keyword:"dependentRequired",params:{property: "sourceEpoch",
    missingProperty: missing1,
    depsCount: 2,
    deps: "sourcePosition, runId"}}];return false;}else {if(data.sourcePosition !== undefined && (((data.sourceEpoch === undefined) && (missing1 = "sourceEpoch")) || ((data.runId === undefined) && (missing1 = "runId")))){validateToolActivityPayload.errors = [{instancePath,schemaPath:"#/dependentRequired",keyword:"dependentRequired",params:{property: "sourcePosition",
    missingProperty: missing1,
    depsCount: 2,
    deps: "sourceEpoch, runId"}}];return false;}}}}}}}}}}}}}}}else {validateToolActivityPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateToolActivityPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateToolActivityPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema359: any = {"description":"Why a tool call ended with no result.","type":"string","enum":["daemonRestart","daemonStop","processExit","stopped"]};
/** Checks that a value is a {@link ToolCallEndCause}. */
// prettier-ignore
export const validateToolCallEndCause: CompiledSchemaCheck<ToolCallEndCause> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ToolCallEndCause {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateToolCallEndCause.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateToolCallEndCause.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((data === "daemonRestart") || (data === "daemonStop")) || (data === "processExit")) || (data === "stopped"))){validateToolCallEndCause.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema359.enum}}];return false;}validateToolCallEndCause.errors = vErrors;return errors === 0;};
// prettier-ignore
validateToolCallEndCause.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema358: any = {"type":"object","additionalProperties":false,"properties":{"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"runId":{"$ref":"sidekicks-contracts:run/id#/$defs/RunId","description":"The run the call belongs to."},"toolName":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The tool's name; required, since a row with no name cannot be attributed and\nthe append path cannot add it."},"toolCallId":{"$ref":"sidekicks-contracts:provider/tool-call#/$defs/ToolCallId","description":"The provider's id of the call."},"durationMs":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"How long the call took, in milliseconds."},"omittedPatches":{"type":"array","items":{"$ref":"sidekicks-contracts:transcript/row#/$defs/TranscriptOmittedPatch"},"description":"On a completion whose body holds its file patches, every file in the body's\norder with its patch's UTF-8 size, so a row whose body is too large to travel\nstill names them; set by the producer. A body naming files is stored in bounded\nparts of each file, which the patch read pages; an empty list names none, and\nits body is stored as any other."},"endCause":{"$ref":"#/$defs/ToolCallEndCause","description":"Why the call ended with no result; absent when the call failed with a result."},"sourceEpoch":{"$ref":"sidekicks-contracts:event/envelope#/$defs/SourceEpoch","description":"The execution epoch a late row is attributed to; comes with `sourcePosition`."},"sourcePosition":{"$ref":"sidekicks-contracts:event/envelope#/$defs/SourcePosition","description":"The run position the row occupies within its epoch; comes with `sourceEpoch`."},"contentLength":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"The stored body's UTF-8 byte length."},"contentEncoding":{"$ref":"#/$defs/ContentEncoding","description":"How the stored body is encoded, present only when it is compressed."}},"required":["sessionId","runId","toolName"],"description":"The payload of `agent.toolCall.failed`, whose error body is kept apart from it; `endCause`\nis present only when the call ended with no result, and names why. A row with no body reads\nits cause's label (`Stopped`, `Process exited`, `Service restarted`, `Service stopped`); any\nbody is the provider's own reason, never the task's name.","dependentRequired":{"sourceEpoch":["sourcePosition","runId"],"sourcePosition":["sourceEpoch","runId"]}};
/** Checks that a value is a {@link ToolCallFailedPayload}. */
// prettier-ignore
export const validateToolCallFailedPayload: CompiledSchemaCheck<ToolCallFailedPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ToolCallFailedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateToolCallFailedPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.runId === undefined) && (missing0 = "runId"))) || ((data.toolName === undefined) && (missing0 = "toolName"))){validateToolCallFailedPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(func2.call(schema358.properties, key0))){validateToolCallFailedPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.runId !== undefined){const _errs3: any = errors;if(!(validateRunId.call(this, data.runId, {instancePath:instancePath+"/runId",parentData:data,parentDataProperty:"runId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunId.errors : vErrors.concat(validateRunId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.toolName !== undefined){let data2: any = data.toolName;const _errs4: any = errors;if(errors === _errs4){if(typeof data2 === "string"){if(func1(data2) > 256){validateToolCallFailedPayload.errors = [{instancePath:instancePath+"/toolName",schemaPath:"#/properties/toolName/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data2) < 1){validateToolCallFailedPayload.errors = [{instancePath:instancePath+"/toolName",schemaPath:"#/properties/toolName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data2)){validateToolCallFailedPayload.errors = [{instancePath:instancePath+"/toolName",schemaPath:"#/properties/toolName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateToolCallFailedPayload.errors = [{instancePath:instancePath+"/toolName",schemaPath:"#/properties/toolName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.toolCallId !== undefined){const _errs6: any = errors;if(!(validateToolCallId.call(this, data.toolCallId, {instancePath:instancePath+"/toolCallId",parentData:data,parentDataProperty:"toolCallId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateToolCallId.errors : vErrors.concat(validateToolCallId.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.durationMs !== undefined){let data4: any = data.durationMs;const _errs7: any = errors;if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){validateToolCallFailedPayload.errors = [{instancePath:instancePath+"/durationMs",schemaPath:"#/properties/durationMs/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs7){if((typeof data4 == "number") && (isFinite(data4))){if(data4 > 9007199254740991 || isNaN(data4)){validateToolCallFailedPayload.errors = [{instancePath:instancePath+"/durationMs",schemaPath:"#/properties/durationMs/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data4 < 0 || isNaN(data4)){validateToolCallFailedPayload.errors = [{instancePath:instancePath+"/durationMs",schemaPath:"#/properties/durationMs/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.omittedPatches !== undefined){let data5: any = data.omittedPatches;const _errs9: any = errors;if(errors === _errs9){if(Array.isArray(data5)){var valid1: any = true;const len0: any = data5.length;for(let i0=0; i0<len0; i0++){const _errs11: any = errors;if(!(validateTranscriptOmittedPatch.call(this, data5[i0], {instancePath:instancePath+"/omittedPatches/" + i0,parentData:data5,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTranscriptOmittedPatch.errors : vErrors.concat(validateTranscriptOmittedPatch.errors);errors = vErrors.length;}var valid1: any = _errs11 === errors;if(!valid1){break;}}}else {validateToolCallFailedPayload.errors = [{instancePath:instancePath+"/omittedPatches",schemaPath:"#/properties/omittedPatches/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.endCause !== undefined){const _errs12: any = errors;if(!(validateToolCallEndCause.call(this, data.endCause, {instancePath:instancePath+"/endCause",parentData:data,parentDataProperty:"endCause",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateToolCallEndCause.errors : vErrors.concat(validateToolCallEndCause.errors);errors = vErrors.length;}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.sourceEpoch !== undefined){const _errs13: any = errors;if(!(validateSourceEpoch.call(this, data.sourceEpoch, {instancePath:instancePath+"/sourceEpoch",parentData:data,parentDataProperty:"sourceEpoch",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSourceEpoch.errors : vErrors.concat(validateSourceEpoch.errors);errors = vErrors.length;}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}if(valid0){if(data.sourcePosition !== undefined){const _errs14: any = errors;if(!(validateSourcePosition.call(this, data.sourcePosition, {instancePath:instancePath+"/sourcePosition",parentData:data,parentDataProperty:"sourcePosition",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSourcePosition.errors : vErrors.concat(validateSourcePosition.errors);errors = vErrors.length;}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}if(valid0){if(data.contentLength !== undefined){let data10: any = data.contentLength;const _errs15: any = errors;if(!(((typeof data10 == "number") && (!(data10 % 1) && !isNaN(data10))) && (isFinite(data10)))){validateToolCallFailedPayload.errors = [{instancePath:instancePath+"/contentLength",schemaPath:"#/properties/contentLength/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs15){if((typeof data10 == "number") && (isFinite(data10))){if(data10 > 9007199254740991 || isNaN(data10)){validateToolCallFailedPayload.errors = [{instancePath:instancePath+"/contentLength",schemaPath:"#/properties/contentLength/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data10 < 0 || isNaN(data10)){validateToolCallFailedPayload.errors = [{instancePath:instancePath+"/contentLength",schemaPath:"#/properties/contentLength/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs15 === errors;}else {var valid0: any = true;}if(valid0){if(data.contentEncoding !== undefined){const _errs17: any = errors;if(!(validateContentEncoding.call(this, data.contentEncoding, {instancePath:instancePath+"/contentEncoding",parentData:data,parentDataProperty:"contentEncoding",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateContentEncoding.errors : vErrors.concat(validateContentEncoding.errors);errors = vErrors.length;}var valid0: any = _errs17 === errors;}else {var valid0: any = true;}if(valid0){let missing1: any;if(data.sourceEpoch !== undefined && (((data.sourcePosition === undefined) && (missing1 = "sourcePosition")) || ((data.runId === undefined) && (missing1 = "runId")))){validateToolCallFailedPayload.errors = [{instancePath,schemaPath:"#/dependentRequired",keyword:"dependentRequired",params:{property: "sourceEpoch",
    missingProperty: missing1,
    depsCount: 2,
    deps: "sourcePosition, runId"}}];return false;}else {if(data.sourcePosition !== undefined && (((data.sourceEpoch === undefined) && (missing1 = "sourceEpoch")) || ((data.runId === undefined) && (missing1 = "runId")))){validateToolCallFailedPayload.errors = [{instancePath,schemaPath:"#/dependentRequired",keyword:"dependentRequired",params:{property: "sourcePosition",
    missingProperty: missing1,
    depsCount: 2,
    deps: "sourceEpoch, runId"}}];return false;}}}}}}}}}}}}}}}}else {validateToolCallFailedPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateToolCallFailedPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateToolCallFailedPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema357: any = {"type":"object","additionalProperties":false,"properties":{"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"runId":{"$ref":"sidekicks-contracts:run/id#/$defs/RunId","description":"The run the call belongs to."},"toolName":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The tool's name; required, since a row with no name cannot be attributed and\nthe append path cannot add it."},"toolCallId":{"$ref":"sidekicks-contracts:provider/tool-call#/$defs/ToolCallId","description":"The provider's id of the call."},"taskId":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The provider's id of the background task the call became."},"survivesRestart":{"type":"boolean","description":"Whether the task outlives a restart of the background service."},"sourceEpoch":{"$ref":"sidekicks-contracts:event/envelope#/$defs/SourceEpoch","description":"The execution epoch a late row is attributed to; comes with `sourcePosition`."},"sourcePosition":{"$ref":"sidekicks-contracts:event/envelope#/$defs/SourcePosition","description":"The run position the row occupies within its epoch; comes with `sourceEpoch`."},"contentLength":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"The stored body's UTF-8 byte length."},"contentEncoding":{"$ref":"#/$defs/ContentEncoding","description":"How the stored body is encoded, present only when it is compressed."}},"required":["sessionId","runId","toolName","toolCallId","taskId","survivesRestart"],"description":"The payload of `agent.toolCall.backgrounded`: the provider moved the call to the background\nand answered the model with a stand-in naming its task, which is the row's body.","dependentRequired":{"sourceEpoch":["sourcePosition","runId"],"sourcePosition":["sourceEpoch","runId"]}};
/** Checks that a value is a {@link ToolCallBackgroundedPayload}. */
// prettier-ignore
export const validateToolCallBackgroundedPayload: CompiledSchemaCheck<ToolCallBackgroundedPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ToolCallBackgroundedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateToolCallBackgroundedPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.runId === undefined) && (missing0 = "runId"))) || ((data.toolName === undefined) && (missing0 = "toolName"))) || ((data.toolCallId === undefined) && (missing0 = "toolCallId"))) || ((data.taskId === undefined) && (missing0 = "taskId"))) || ((data.survivesRestart === undefined) && (missing0 = "survivesRestart"))){validateToolCallBackgroundedPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(func2.call(schema357.properties, key0))){validateToolCallBackgroundedPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.runId !== undefined){const _errs3: any = errors;if(!(validateRunId.call(this, data.runId, {instancePath:instancePath+"/runId",parentData:data,parentDataProperty:"runId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunId.errors : vErrors.concat(validateRunId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.toolName !== undefined){let data2: any = data.toolName;const _errs4: any = errors;if(errors === _errs4){if(typeof data2 === "string"){if(func1(data2) > 256){validateToolCallBackgroundedPayload.errors = [{instancePath:instancePath+"/toolName",schemaPath:"#/properties/toolName/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data2) < 1){validateToolCallBackgroundedPayload.errors = [{instancePath:instancePath+"/toolName",schemaPath:"#/properties/toolName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data2)){validateToolCallBackgroundedPayload.errors = [{instancePath:instancePath+"/toolName",schemaPath:"#/properties/toolName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateToolCallBackgroundedPayload.errors = [{instancePath:instancePath+"/toolName",schemaPath:"#/properties/toolName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.toolCallId !== undefined){const _errs6: any = errors;if(!(validateToolCallId.call(this, data.toolCallId, {instancePath:instancePath+"/toolCallId",parentData:data,parentDataProperty:"toolCallId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateToolCallId.errors : vErrors.concat(validateToolCallId.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.taskId !== undefined){let data4: any = data.taskId;const _errs7: any = errors;if(errors === _errs7){if(typeof data4 === "string"){if(func1(data4) > 256){validateToolCallBackgroundedPayload.errors = [{instancePath:instancePath+"/taskId",schemaPath:"#/properties/taskId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data4) < 1){validateToolCallBackgroundedPayload.errors = [{instancePath:instancePath+"/taskId",schemaPath:"#/properties/taskId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data4)){validateToolCallBackgroundedPayload.errors = [{instancePath:instancePath+"/taskId",schemaPath:"#/properties/taskId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateToolCallBackgroundedPayload.errors = [{instancePath:instancePath+"/taskId",schemaPath:"#/properties/taskId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.survivesRestart !== undefined){const _errs9: any = errors;if(typeof data.survivesRestart !== "boolean"){validateToolCallBackgroundedPayload.errors = [{instancePath:instancePath+"/survivesRestart",schemaPath:"#/properties/survivesRestart/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.sourceEpoch !== undefined){const _errs11: any = errors;if(!(validateSourceEpoch.call(this, data.sourceEpoch, {instancePath:instancePath+"/sourceEpoch",parentData:data,parentDataProperty:"sourceEpoch",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSourceEpoch.errors : vErrors.concat(validateSourceEpoch.errors);errors = vErrors.length;}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}if(valid0){if(data.sourcePosition !== undefined){const _errs12: any = errors;if(!(validateSourcePosition.call(this, data.sourcePosition, {instancePath:instancePath+"/sourcePosition",parentData:data,parentDataProperty:"sourcePosition",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSourcePosition.errors : vErrors.concat(validateSourcePosition.errors);errors = vErrors.length;}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.contentLength !== undefined){let data8: any = data.contentLength;const _errs13: any = errors;if(!(((typeof data8 == "number") && (!(data8 % 1) && !isNaN(data8))) && (isFinite(data8)))){validateToolCallBackgroundedPayload.errors = [{instancePath:instancePath+"/contentLength",schemaPath:"#/properties/contentLength/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs13){if((typeof data8 == "number") && (isFinite(data8))){if(data8 > 9007199254740991 || isNaN(data8)){validateToolCallBackgroundedPayload.errors = [{instancePath:instancePath+"/contentLength",schemaPath:"#/properties/contentLength/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data8 < 0 || isNaN(data8)){validateToolCallBackgroundedPayload.errors = [{instancePath:instancePath+"/contentLength",schemaPath:"#/properties/contentLength/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}if(valid0){if(data.contentEncoding !== undefined){const _errs15: any = errors;if(!(validateContentEncoding.call(this, data.contentEncoding, {instancePath:instancePath+"/contentEncoding",parentData:data,parentDataProperty:"contentEncoding",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateContentEncoding.errors : vErrors.concat(validateContentEncoding.errors);errors = vErrors.length;}var valid0: any = _errs15 === errors;}else {var valid0: any = true;}if(valid0){let missing1: any;if(data.sourceEpoch !== undefined && (((data.sourcePosition === undefined) && (missing1 = "sourcePosition")) || ((data.runId === undefined) && (missing1 = "runId")))){validateToolCallBackgroundedPayload.errors = [{instancePath,schemaPath:"#/dependentRequired",keyword:"dependentRequired",params:{property: "sourceEpoch",
    missingProperty: missing1,
    depsCount: 2,
    deps: "sourcePosition, runId"}}];return false;}else {if(data.sourcePosition !== undefined && (((data.sourceEpoch === undefined) && (missing1 = "sourceEpoch")) || ((data.runId === undefined) && (missing1 = "runId")))){validateToolCallBackgroundedPayload.errors = [{instancePath,schemaPath:"#/dependentRequired",keyword:"dependentRequired",params:{property: "sourcePosition",
    missingProperty: missing1,
    depsCount: 2,
    deps: "sourceEpoch, runId"}}];return false;}}}}}}}}}}}}}}}else {validateToolCallBackgroundedPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateToolCallBackgroundedPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateToolCallBackgroundedPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
