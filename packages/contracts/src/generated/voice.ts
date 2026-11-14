// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Voice, as a window drives it through the daemon: which session voice is on in, and its two mechanisms, dictation into the composer and a spoken call with the provider.

import { type CompiledSchemaCheck, type SchemaCheck, ucs2length } from "../schema-check.js";
import { validateBytes } from "./internal/wire-scalars.js";
import {
  type SubscribeAcknowledgmentResponse,
  validateSubscribeAcknowledgmentResponse,
} from "./jsonrpc/streaming.js";
import { type EmptyPayload, validateEmptyPayload } from "./method-descriptor.js";
import { type ProviderId, validateProviderId } from "./provider/id.js";
import { type SessionId, validateSessionId } from "./session/id.js";

/** The bytes in one 100 ms frame of 16 kHz 16-bit mono audio. */
export const VOICE_DICTATION_FRAME_MAX_BYTES = 3200 as const;

/** Every reason an account is not entitled to voice, for the composer strip's refusal line. */
export const VOICE_ACCOUNT_NOT_ENTITLED_REASONS = ["signInKindNotEntitled"] as const;

/** Every reason a recording can end without its words, for the composer strip's refusal line. */
export const VOICE_DICTATION_FAILURE_REASONS = [
  "noSound",
  "noSpeech",
  "notSent",
  "signInRefused",
] as const;

/**
 * Where a message in the transcript came from when no one typed it: a voice call, heard or
 * spoken. A typed message carries no origin.
 */
export type MessageOrigin = "voice";
/**
 * A kind of voice a provider offers, which its section declares: the composer starts the
 * matching method, `voice.dictation.start` or `voice.call.start`.
 */
export type VoiceKind = "dictation" | "call";
/**
 * Why `voice.accountNotEntitled` refused: the account is signed in, but its provider gives its
 * sign-in kind no voice.
 */
export type VoiceAccountNotEntitledReason = "signInKindNotEntitled";
/**
 * Why a recording ended without its words: only silent samples reached the microphone; sound but
 * no words; the connection failed after its one retry or was refused; the speech service refused
 * the account's sign-in.
 */
export type VoiceDictationFailureReason = "noSound" | "noSpeech" | "notSent" | "signInRefused";
/**
 * A recording's failure, or the speech service's own error in its own words.
 */
export type VoiceDictationFailure =
  | {
      /**
       * Why.
       */
      reason: VoiceDictationFailureReason;
    }
  | {
      /**
       * Always `serviceError`.
       */
      reason: "serviceError";
      /**
       * The service's words.
       */
      message: string;
    };
/**
 * One push of a `voice.dictation.subscribe` stream: `words` carries the settled words and the
 * words still in progress, which the draft shows in that order with a space between; `ended`
 * closes the recording, with its failure or `null`.
 */
export type VoiceDictationFrame =
  | {
      kind: "words";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The settled words.
       */
      committed: string;
      /**
       * The words still in progress.
       */
      inProgress: string;
    }
  | {
      kind: "ended";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * Its failure, or `null`.
       */
      failure: VoiceDictationFailure | null;
    };
/**
 * One push of a `voice.call.subscribe` stream: the call started; the words the call hears from the
 * person as they arrive, then settled; the voice's reply, settled; the call ended, with its cause.
 */
export type VoiceCallFrame =
  | {
      /**
       * The frame's kind.
       */
      kind: "started";
      /**
       * The session.
       */
      sessionId: SessionId;
    }
  | {
      /**
       * The frame's kind.
       */
      kind: "userTranscriptDelta";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The new words.
       */
      delta: string;
    }
  | {
      /**
       * The frame's kind.
       */
      kind: "userTranscriptDone";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The words.
       */
      text: string;
    }
  | {
      /**
       * The frame's kind.
       */
      kind: "agentTranscriptDone";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The words.
       */
      text: string;
    }
  | {
      /**
       * The frame's kind.
       */
      kind: "ended";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * Always `stopped`.
       */
      cause: "stopped";
    }
  | {
      /**
       * The frame's kind.
       */
      kind: "ended";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * Always `closed`.
       */
      cause: "closed";
      /**
       * The provider's reason, or `null`.
       */
      reason: string | null;
    }
  | {
      /**
       * The frame's kind.
       */
      kind: "ended";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * Always `error`.
       */
      cause: "error";
      /**
       * The provider's words.
       */
      message: string;
    };

/**
 * The `voice.accountNotEntitled` refusal's details: why, and the session's provider; the screen
 * draws one sentence naming the account, the same on every provider.
 */
export interface VoiceAccountNotEntitledDetails {
  /**
   * Why.
   */
  reason: VoiceAccountNotEntitledReason;
  /**
   * The session's provider.
   */
  provider: ProviderId;
}
/**
 * The session voice is on in, or `null` when it is off: the request and result of
 * `voice.state.update`, and each delivery of `voice.state.subscribe`, the first of which is the
 * current state.
 */
export interface VoiceState {
  /**
   * The session, or `null`.
   */
  sessionId: SessionId | null;
}
/**
 * `voice.dictation.start`: starts a recording in a session whose voice is dictation.
 */
export interface VoiceDictationStartRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
}
/**
 * `voice.dictation.write`: one frame of the recording's audio, 16 kHz 16-bit mono PCM, at most
 * 100 ms of it, in whole samples.
 */
export interface VoiceDictationWriteRequest {
  /**
   * The frame; an odd length would end mid-sample.
   */
  audio: Uint8Array;
}
/**
 * `voice.dictation.stop`: stops the recording; `cancel` drops it, and its words with it.
 */
export interface VoiceDictationStopRequest {
  /**
   * Whether to drop the recording.
   */
  cancel: boolean;
}
/**
 * `voice.call.start`: starts a call in a session whose voice is a spoken call, with the window's
 * WebRTC offer.
 */
export interface VoiceCallStartRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The window's offer.
   */
  offerSdp: string;
}
/**
 * The provider's WebRTC answer to the window's offer.
 */
export interface VoiceCallStartResponse {
  /**
   * The answer.
   */
  answerSdp: string;
}
/**
 * The voices the provider offers a call, and the one it uses until the person picks another.
 */
export interface VoiceListResponse {
  /**
   * The voices.
   */
  voices: string[];
  /**
   * The voice used until the person picks another.
   */
  defaultVoice: string;
}

// prettier-ignore
const schema1367: any = {"description":"Where a message in the transcript came from when no one typed it: a voice call, heard or\nspoken. A typed message carries no origin.","type":"string","enum":["voice"]};
/** Checks that a value is a {@link MessageOrigin}. */
// prettier-ignore
export const validateMessageOrigin: CompiledSchemaCheck<MessageOrigin> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is MessageOrigin {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateMessageOrigin.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateMessageOrigin.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data === "voice")){validateMessageOrigin.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1367.enum}}];return false;}validateMessageOrigin.errors = vErrors;return errors === 0;};
// prettier-ignore
validateMessageOrigin.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1014: any = {"description":"A kind of voice a provider offers, which its section declares: the composer starts the\nmatching method, `voice.dictation.start` or `voice.call.start`.","type":"string","enum":["dictation","call"]};
/** Checks that a value is a {@link VoiceKind}. */
// prettier-ignore
export const validateVoiceKind: CompiledSchemaCheck<VoiceKind> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is VoiceKind {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateVoiceKind.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateVoiceKind.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data === "dictation") || (data === "call"))){validateVoiceKind.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1014.enum}}];return false;}validateVoiceKind.errors = vErrors;return errors === 0;};
// prettier-ignore
validateVoiceKind.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1369: any = {"description":"Why `voice.accountNotEntitled` refused: the account is signed in, but its provider gives its\nsign-in kind no voice.","type":"string","enum":["signInKindNotEntitled"]};
/** Checks that a value is a {@link VoiceAccountNotEntitledReason}. */
// prettier-ignore
export const validateVoiceAccountNotEntitledReason: CompiledSchemaCheck<VoiceAccountNotEntitledReason> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is VoiceAccountNotEntitledReason {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateVoiceAccountNotEntitledReason.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateVoiceAccountNotEntitledReason.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data === "signInKindNotEntitled")){validateVoiceAccountNotEntitledReason.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1369.enum}}];return false;}validateVoiceAccountNotEntitledReason.errors = vErrors;return errors === 0;};
// prettier-ignore
validateVoiceAccountNotEntitledReason.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link VoiceAccountNotEntitledDetails}. */
// prettier-ignore
export const validateVoiceAccountNotEntitledDetails: CompiledSchemaCheck<VoiceAccountNotEntitledDetails> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is VoiceAccountNotEntitledDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateVoiceAccountNotEntitledDetails.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.reason === undefined) && (missing0 = "reason")) || ((data.provider === undefined) && (missing0 = "provider"))){validateVoiceAccountNotEntitledDetails.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "reason") || (key0 === "provider"))){validateVoiceAccountNotEntitledDetails.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.reason !== undefined){const _errs2: any = errors;if(!(validateVoiceAccountNotEntitledReason.call(this, data.reason, {instancePath:instancePath+"/reason",parentData:data,parentDataProperty:"reason",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateVoiceAccountNotEntitledReason.errors : vErrors.concat(validateVoiceAccountNotEntitledReason.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.provider !== undefined){const _errs3: any = errors;if(!(validateProviderId.call(this, data.provider, {instancePath:instancePath+"/provider",parentData:data,parentDataProperty:"provider",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderId.errors : vErrors.concat(validateProviderId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateVoiceAccountNotEntitledDetails.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateVoiceAccountNotEntitledDetails.errors = vErrors;return errors === 0;};
// prettier-ignore
validateVoiceAccountNotEntitledDetails.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link VoiceState}. */
// prettier-ignore
export const validateVoiceState: CompiledSchemaCheck<VoiceState> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is VoiceState {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateVoiceState.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validateVoiceState.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "sessionId")){validateVoiceState.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs3: any = errors;let valid1: any = false;const _errs4: any = errors;if(!(validateSessionId.call(this, data0, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var _valid0: any = _errs4 === errors;valid1 = valid1 || _valid0;const _errs5: any = errors;if(data0 !== null){const err0: any = {instancePath:instancePath+"/sessionId",schemaPath:"#/properties/sessionId/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var _valid0: any = _errs5 === errors;valid1 = valid1 || _valid0;if(!valid1){const err1: any = {instancePath:instancePath+"/sessionId",schemaPath:"#/properties/sessionId/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;validateVoiceState.errors = vErrors;return false;}else {errors = _errs3;if(vErrors !== null){if(_errs3){vErrors.length = _errs3;}else {vErrors = null;}}}}}}}else {validateVoiceState.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateVoiceState.errors = vErrors;return errors === 0;};
// prettier-ignore
validateVoiceState.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link VoiceDictationStartRequest}. */
// prettier-ignore
export const validateVoiceDictationStartRequest: CompiledSchemaCheck<VoiceDictationStartRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is VoiceDictationStartRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateVoiceDictationStartRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validateVoiceDictationStartRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "sessionId")){validateVoiceDictationStartRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}}}}}else {validateVoiceDictationStartRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateVoiceDictationStartRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateVoiceDictationStartRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link VoiceDictationWriteRequest}. */
// prettier-ignore
export const validateVoiceDictationWriteRequest: CompiledSchemaCheck<VoiceDictationWriteRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is VoiceDictationWriteRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateVoiceDictationWriteRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.audio === undefined) && (missing0 = "audio")){validateVoiceDictationWriteRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "audio")){validateVoiceDictationWriteRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.audio !== undefined){let data0: any = data.audio;if(!(validateBytes.call(this, data0, {instancePath:instancePath+"/audio",parentData:data,parentDataProperty:"audio",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateBytes.errors : vErrors.concat(validateBytes.errors);errors = vErrors.length;}else {if(!(data0 && typeof data0 == "object" && Number.isInteger(data0.$bytes) && this && Array.isArray(this.attachments) && this.attachments[data0.$bytes] instanceof Uint8Array && this.attachments[data0.$bytes].byteLength >= 1)){validateVoiceDictationWriteRequest.errors = [{instancePath:instancePath+"/audio",schemaPath:"#/properties/audio/minBytes",keyword:"minBytes",params:{}}];return false;}else {if(!(data0 && typeof data0 == "object" && Number.isInteger(data0.$bytes) && this && Array.isArray(this.attachments) && this.attachments[data0.$bytes] instanceof Uint8Array && this.attachments[data0.$bytes].byteLength <= 3200)){validateVoiceDictationWriteRequest.errors = [{instancePath:instancePath+"/audio",schemaPath:"#/properties/audio/maxBytes",keyword:"maxBytes",params:{}}];return false;}else {if(!(data0 && typeof data0 == "object" && Number.isInteger(data0.$bytes) && this && Array.isArray(this.attachments) && this.attachments[data0.$bytes] instanceof Uint8Array && this.attachments[data0.$bytes].byteLength % 2 === 0)){validateVoiceDictationWriteRequest.errors = [{instancePath:instancePath+"/audio",schemaPath:"#/properties/audio/evenBytes",keyword:"evenBytes",params:{}}];return false;}}}}}}}}else {validateVoiceDictationWriteRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateVoiceDictationWriteRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateVoiceDictationWriteRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link VoiceDictationStopRequest}. */
// prettier-ignore
export const validateVoiceDictationStopRequest: CompiledSchemaCheck<VoiceDictationStopRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is VoiceDictationStopRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateVoiceDictationStopRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.cancel === undefined) && (missing0 = "cancel")){validateVoiceDictationStopRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "cancel")){validateVoiceDictationStopRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.cancel !== undefined){if(typeof data.cancel !== "boolean"){validateVoiceDictationStopRequest.errors = [{instancePath:instancePath+"/cancel",schemaPath:"#/properties/cancel/type",keyword:"type",params:{type: "boolean"}}];return false;}}}}}else {validateVoiceDictationStopRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateVoiceDictationStopRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateVoiceDictationStopRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1375: any = {"description":"Why a recording ended without its words: only silent samples reached the microphone; sound but\nno words; the connection failed after its one retry or was refused; the speech service refused\nthe account's sign-in.","type":"string","enum":["noSound","noSpeech","notSent","signInRefused"]};
/** Checks that a value is a {@link VoiceDictationFailureReason}. */
// prettier-ignore
export const validateVoiceDictationFailureReason: CompiledSchemaCheck<VoiceDictationFailureReason> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is VoiceDictationFailureReason {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateVoiceDictationFailureReason.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateVoiceDictationFailureReason.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((data === "noSound") || (data === "noSpeech")) || (data === "notSent")) || (data === "signInRefused"))){validateVoiceDictationFailureReason.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1375.enum}}];return false;}validateVoiceDictationFailureReason.errors = vErrors;return errors === 0;};
// prettier-ignore
validateVoiceDictationFailureReason.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1374: any = {"anyOf":[{"type":"object","additionalProperties":false,"properties":{"reason":{"$ref":"#/$defs/VoiceDictationFailureReason","description":"Why."}},"required":["reason"],"description":"A known reason."},{"type":"object","additionalProperties":false,"properties":{"reason":{"description":"Always `serviceError`.","type":"string","enum":["serviceError"]},"message":{"type":"string","minLength":1,"description":"The service's words."}},"required":["reason","message"],"description":"The service's own error."}],"description":"A recording's failure, or the speech service's own error in its own words."};
// prettier-ignore
const func1 = ucs2length;
/** Checks that a value is a {@link VoiceDictationFailure}. */
// prettier-ignore
export const validateVoiceDictationFailure: CompiledSchemaCheck<VoiceDictationFailure> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is VoiceDictationFailure {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateVoiceDictationFailure.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(errors === _errs1){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.reason === undefined) && (missing0 = "reason")){const err0: any = {instancePath,schemaPath:"#/anyOf/0/required",keyword:"required",params:{missingProperty: missing0}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {const _errs3: any = errors;for(const key0 in data){if(!(key0 === "reason")){const err1: any = {instancePath,schemaPath:"#/anyOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;break;}}if(_errs3 === errors){if(data.reason !== undefined){if(!(validateVoiceDictationFailureReason.call(this, data.reason, {instancePath:instancePath+"/reason",parentData:data,parentDataProperty:"reason",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateVoiceDictationFailureReason.errors : vErrors.concat(validateVoiceDictationFailureReason.errors);errors = vErrors.length;}}}}}else {const err2: any = {instancePath,schemaPath:"#/anyOf/0/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs5: any = errors;if(errors === _errs5){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((data.reason === undefined) && (missing1 = "reason")) || ((data.message === undefined) && (missing1 = "message"))){const err3: any = {instancePath,schemaPath:"#/anyOf/1/required",keyword:"required",params:{missingProperty: missing1}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}else {const _errs7: any = errors;for(const key1 in data){if(!((key1 === "reason") || (key1 === "message"))){const err4: any = {instancePath,schemaPath:"#/anyOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;break;}}if(_errs7 === errors){if(data.reason !== undefined){let data1: any = data.reason;const _errs8: any = errors;if(typeof data1 !== "string"){const err5: any = {instancePath:instancePath+"/reason",schemaPath:"#/anyOf/1/properties/reason/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}if(!(data1 === "serviceError")){const err6: any = {instancePath:instancePath+"/reason",schemaPath:"#/anyOf/1/properties/reason/enum",keyword:"enum",params:{allowedValues: schema1374.anyOf[1].properties.reason.enum}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}if(valid2){if(data.message !== undefined){let data2: any = data.message;const _errs10: any = errors;if(errors === _errs10){if(typeof data2 === "string"){if(func1(data2) < 1){const err7: any = {instancePath:instancePath+"/message",schemaPath:"#/anyOf/1/properties/message/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;}}else {const err8: any = {instancePath:instancePath+"/message",schemaPath:"#/anyOf/1/properties/message/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;}}var valid2: any = _errs10 === errors;}else {var valid2: any = true;}}}}}else {const err9: any = {instancePath,schemaPath:"#/anyOf/1/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;}}var _valid0: any = _errs5 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid0){const err10: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err10];}else {vErrors.push(err10);}errors++;validateVoiceDictationFailure.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validateVoiceDictationFailure.errors = vErrors;evaluated0.props = props0;return errors === 0;};
// prettier-ignore
validateVoiceDictationFailure.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
/** Checks that a value is a {@link VoiceDictationFrame}. */
// prettier-ignore
export const validateVoiceDictationFrame: CompiledSchemaCheck<VoiceDictationFrame> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is VoiceDictationFrame {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateVoiceDictationFrame.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "words"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.kind === undefined) && (missing0 = "kind")) || ((data.sessionId === undefined) && (missing0 = "sessionId"))) || ((data.committed === undefined) && (missing0 = "committed"))) || ((data.inProgress === undefined) && (missing0 = "inProgress"))){validateVoiceDictationFrame.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!((((key0 === "kind") || (key0 === "sessionId")) || (key0 === "committed")) || (key0 === "inProgress"))){validateVoiceDictationFrame.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs5: any = errors;if(typeof data0 !== "string"){validateVoiceDictationFrame.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("words" !== data0){validateVoiceDictationFrame.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "words"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.sessionId !== undefined){const _errs7: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.committed !== undefined){const _errs8: any = errors;if(typeof data.committed !== "string"){validateVoiceDictationFrame.errors = [{instancePath:instancePath+"/committed",schemaPath:"#/oneOf/0/properties/committed/type",keyword:"type",params:{type: "string"}}];return false;}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}if(valid2){if(data.inProgress !== undefined){const _errs10: any = errors;if(typeof data.inProgress !== "string"){validateVoiceDictationFrame.errors = [{instancePath:instancePath+"/inProgress",schemaPath:"#/oneOf/0/properties/inProgress/type",keyword:"type",params:{type: "string"}}];return false;}var valid2: any = _errs10 === errors;}else {var valid2: any = true;}}}}}}}else {validateVoiceDictationFrame.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "ended"){const _errs12: any = errors;if(errors === _errs12){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.kind === undefined) && (missing1 = "kind")) || ((data.sessionId === undefined) && (missing1 = "sessionId"))) || ((data.failure === undefined) && (missing1 = "failure"))){validateVoiceDictationFrame.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs14: any = errors;for(const key1 in data){if(!(((key1 === "kind") || (key1 === "sessionId")) || (key1 === "failure"))){validateVoiceDictationFrame.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs14 === errors){if(data.kind !== undefined){let data4: any = data.kind;const _errs15: any = errors;if(typeof data4 !== "string"){validateVoiceDictationFrame.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("ended" !== data4){validateVoiceDictationFrame.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "ended"}}];return false;}var valid4: any = _errs15 === errors;}else {var valid4: any = true;}if(valid4){if(data.sessionId !== undefined){const _errs17: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid4: any = _errs17 === errors;}else {var valid4: any = true;}if(valid4){if(data.failure !== undefined){let data6: any = data.failure;const _errs18: any = errors;const _errs19: any = errors;let valid5: any = false;const _errs20: any = errors;if(!(validateVoiceDictationFailure.call(this, data6, {instancePath:instancePath+"/failure",parentData:data,parentDataProperty:"failure",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateVoiceDictationFailure.errors : vErrors.concat(validateVoiceDictationFailure.errors);errors = vErrors.length;}var _valid0: any = _errs20 === errors;valid5 = valid5 || _valid0;const _errs21: any = errors;if(data6 !== null){const err0: any = {instancePath:instancePath+"/failure",schemaPath:"#/oneOf/1/properties/failure/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var _valid0: any = _errs21 === errors;valid5 = valid5 || _valid0;if(!valid5){const err1: any = {instancePath:instancePath+"/failure",schemaPath:"#/oneOf/1/properties/failure/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;validateVoiceDictationFrame.errors = vErrors;return false;}else {errors = _errs19;if(vErrors !== null){if(_errs19){vErrors.length = _errs19;}else {vErrors = null;}}}var valid4: any = _errs18 === errors;}else {var valid4: any = true;}}}}}}else {validateVoiceDictationFrame.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs12 === errors;if(props0 !== true){props0 = true;}valid0 = valid3;}else {validateVoiceDictationFrame.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validateVoiceDictationFrame.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key2 in data){if(!props0 || !props0[key2]){validateVoiceDictationFrame.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key2}}];return false;break;}}}}}else {validateVoiceDictationFrame.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateVoiceDictationFrame.errors = vErrors;return errors === 0;};
// prettier-ignore
validateVoiceDictationFrame.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link VoiceCallStartRequest}. */
// prettier-ignore
export const validateVoiceCallStartRequest: CompiledSchemaCheck<VoiceCallStartRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is VoiceCallStartRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateVoiceCallStartRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.offerSdp === undefined) && (missing0 = "offerSdp"))){validateVoiceCallStartRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "offerSdp"))){validateVoiceCallStartRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.offerSdp !== undefined){let data1: any = data.offerSdp;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) < 1){validateVoiceCallStartRequest.errors = [{instancePath:instancePath+"/offerSdp",schemaPath:"#/properties/offerSdp/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateVoiceCallStartRequest.errors = [{instancePath:instancePath+"/offerSdp",schemaPath:"#/properties/offerSdp/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateVoiceCallStartRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateVoiceCallStartRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateVoiceCallStartRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link VoiceCallStartResponse}. */
// prettier-ignore
export const validateVoiceCallStartResponse: CompiledSchemaCheck<VoiceCallStartResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is VoiceCallStartResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateVoiceCallStartResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.answerSdp === undefined) && (missing0 = "answerSdp")){validateVoiceCallStartResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "answerSdp")){validateVoiceCallStartResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.answerSdp !== undefined){let data0: any = data.answerSdp;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) < 1){validateVoiceCallStartResponse.errors = [{instancePath:instancePath+"/answerSdp",schemaPath:"#/properties/answerSdp/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateVoiceCallStartResponse.errors = [{instancePath:instancePath+"/answerSdp",schemaPath:"#/properties/answerSdp/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validateVoiceCallStartResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateVoiceCallStartResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateVoiceCallStartResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1370: any = {"anyOf":[{"type":"object","additionalProperties":false,"properties":{"kind":{"description":"The frame's kind.","type":"string","enum":["started"]},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."}},"required":["kind","sessionId"],"description":"The call started."},{"type":"object","additionalProperties":false,"properties":{"kind":{"description":"The frame's kind.","type":"string","enum":["userTranscriptDelta"]},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"delta":{"type":"string","description":"The new words."}},"required":["kind","sessionId","delta"],"description":"Words heard, as they arrive."},{"type":"object","additionalProperties":false,"properties":{"kind":{"description":"The frame's kind.","type":"string","enum":["userTranscriptDone"]},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"text":{"type":"string","description":"The words."}},"required":["kind","sessionId","text"],"description":"Words heard, settled."},{"type":"object","additionalProperties":false,"properties":{"kind":{"description":"The frame's kind.","type":"string","enum":["agentTranscriptDone"]},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"text":{"type":"string","description":"The words."}},"required":["kind","sessionId","text"],"description":"The reply, settled."},{"type":"object","additionalProperties":false,"properties":{"kind":{"description":"The frame's kind.","type":"string","enum":["ended"]},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"cause":{"description":"Always `stopped`.","type":"string","enum":["stopped"]}},"required":["kind","sessionId","cause"],"description":"The daemon stopped the call."},{"type":"object","additionalProperties":false,"properties":{"kind":{"description":"The frame's kind.","type":"string","enum":["ended"]},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"cause":{"description":"Always `closed`.","type":"string","enum":["closed"]},"reason":{"type":["string","null"],"description":"The provider's reason, or `null`."}},"required":["kind","sessionId","cause","reason"],"description":"The provider closed the call."},{"type":"object","additionalProperties":false,"properties":{"kind":{"description":"The frame's kind.","type":"string","enum":["ended"]},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"cause":{"description":"Always `error`.","type":"string","enum":["error"]},"message":{"type":"string","minLength":1,"description":"The provider's words."}},"required":["kind","sessionId","cause","message"],"description":"The provider reported an error."}],"description":"One push of a `voice.call.subscribe` stream: the call started; the words the call hears from the\nperson as they arrive, then settled; the voice's reply, settled; the call ended, with its cause."};
/** Checks that a value is a {@link VoiceCallFrame}. */
// prettier-ignore
export const validateVoiceCallFrame: CompiledSchemaCheck<VoiceCallFrame> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is VoiceCallFrame {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateVoiceCallFrame.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(errors === _errs1){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.kind === undefined) && (missing0 = "kind")) || ((data.sessionId === undefined) && (missing0 = "sessionId"))){const err0: any = {instancePath,schemaPath:"#/anyOf/0/required",keyword:"required",params:{missingProperty: missing0}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {const _errs3: any = errors;for(const key0 in data){if(!((key0 === "kind") || (key0 === "sessionId"))){const err1: any = {instancePath,schemaPath:"#/anyOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;break;}}if(_errs3 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs4: any = errors;if(typeof data0 !== "string"){const err2: any = {instancePath:instancePath+"/kind",schemaPath:"#/anyOf/0/properties/kind/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}if(!(data0 === "started")){const err3: any = {instancePath:instancePath+"/kind",schemaPath:"#/anyOf/0/properties/kind/enum",keyword:"enum",params:{allowedValues: schema1370.anyOf[0].properties.kind.enum}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}var valid1: any = _errs4 === errors;}else {var valid1: any = true;}if(valid1){if(data.sessionId !== undefined){const _errs6: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid1: any = _errs6 === errors;}else {var valid1: any = true;}}}}}else {const err4: any = {instancePath,schemaPath:"#/anyOf/0/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs7: any = errors;if(errors === _errs7){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.kind === undefined) && (missing1 = "kind")) || ((data.sessionId === undefined) && (missing1 = "sessionId"))) || ((data.delta === undefined) && (missing1 = "delta"))){const err5: any = {instancePath,schemaPath:"#/anyOf/1/required",keyword:"required",params:{missingProperty: missing1}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}else {const _errs9: any = errors;for(const key1 in data){if(!(((key1 === "kind") || (key1 === "sessionId")) || (key1 === "delta"))){const err6: any = {instancePath,schemaPath:"#/anyOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;break;}}if(_errs9 === errors){if(data.kind !== undefined){let data2: any = data.kind;const _errs10: any = errors;if(typeof data2 !== "string"){const err7: any = {instancePath:instancePath+"/kind",schemaPath:"#/anyOf/1/properties/kind/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;}if(!(data2 === "userTranscriptDelta")){const err8: any = {instancePath:instancePath+"/kind",schemaPath:"#/anyOf/1/properties/kind/enum",keyword:"enum",params:{allowedValues: schema1370.anyOf[1].properties.kind.enum}};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;}var valid2: any = _errs10 === errors;}else {var valid2: any = true;}if(valid2){if(data.sessionId !== undefined){const _errs12: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid2: any = _errs12 === errors;}else {var valid2: any = true;}if(valid2){if(data.delta !== undefined){const _errs13: any = errors;if(typeof data.delta !== "string"){const err9: any = {instancePath:instancePath+"/delta",schemaPath:"#/anyOf/1/properties/delta/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;}var valid2: any = _errs13 === errors;}else {var valid2: any = true;}}}}}}else {const err10: any = {instancePath,schemaPath:"#/anyOf/1/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err10];}else {vErrors.push(err10);}errors++;}}var _valid0: any = _errs7 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}const _errs15: any = errors;if(errors === _errs15){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((((data.kind === undefined) && (missing2 = "kind")) || ((data.sessionId === undefined) && (missing2 = "sessionId"))) || ((data.text === undefined) && (missing2 = "text"))){const err11: any = {instancePath,schemaPath:"#/anyOf/2/required",keyword:"required",params:{missingProperty: missing2}};if(vErrors === null){vErrors = [err11];}else {vErrors.push(err11);}errors++;}else {const _errs17: any = errors;for(const key2 in data){if(!(((key2 === "kind") || (key2 === "sessionId")) || (key2 === "text"))){const err12: any = {instancePath,schemaPath:"#/anyOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}};if(vErrors === null){vErrors = [err12];}else {vErrors.push(err12);}errors++;break;}}if(_errs17 === errors){if(data.kind !== undefined){let data5: any = data.kind;const _errs18: any = errors;if(typeof data5 !== "string"){const err13: any = {instancePath:instancePath+"/kind",schemaPath:"#/anyOf/2/properties/kind/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err13];}else {vErrors.push(err13);}errors++;}if(!(data5 === "userTranscriptDone")){const err14: any = {instancePath:instancePath+"/kind",schemaPath:"#/anyOf/2/properties/kind/enum",keyword:"enum",params:{allowedValues: schema1370.anyOf[2].properties.kind.enum}};if(vErrors === null){vErrors = [err14];}else {vErrors.push(err14);}errors++;}var valid3: any = _errs18 === errors;}else {var valid3: any = true;}if(valid3){if(data.sessionId !== undefined){const _errs20: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid3: any = _errs20 === errors;}else {var valid3: any = true;}if(valid3){if(data.text !== undefined){const _errs21: any = errors;if(typeof data.text !== "string"){const err15: any = {instancePath:instancePath+"/text",schemaPath:"#/anyOf/2/properties/text/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err15];}else {vErrors.push(err15);}errors++;}var valid3: any = _errs21 === errors;}else {var valid3: any = true;}}}}}}else {const err16: any = {instancePath,schemaPath:"#/anyOf/2/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err16];}else {vErrors.push(err16);}errors++;}}var _valid0: any = _errs15 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}const _errs23: any = errors;if(errors === _errs23){if(data && typeof data == "object" && !Array.isArray(data)){let missing3: any;if((((data.kind === undefined) && (missing3 = "kind")) || ((data.sessionId === undefined) && (missing3 = "sessionId"))) || ((data.text === undefined) && (missing3 = "text"))){const err17: any = {instancePath,schemaPath:"#/anyOf/3/required",keyword:"required",params:{missingProperty: missing3}};if(vErrors === null){vErrors = [err17];}else {vErrors.push(err17);}errors++;}else {const _errs25: any = errors;for(const key3 in data){if(!(((key3 === "kind") || (key3 === "sessionId")) || (key3 === "text"))){const err18: any = {instancePath,schemaPath:"#/anyOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}};if(vErrors === null){vErrors = [err18];}else {vErrors.push(err18);}errors++;break;}}if(_errs25 === errors){if(data.kind !== undefined){let data8: any = data.kind;const _errs26: any = errors;if(typeof data8 !== "string"){const err19: any = {instancePath:instancePath+"/kind",schemaPath:"#/anyOf/3/properties/kind/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err19];}else {vErrors.push(err19);}errors++;}if(!(data8 === "agentTranscriptDone")){const err20: any = {instancePath:instancePath+"/kind",schemaPath:"#/anyOf/3/properties/kind/enum",keyword:"enum",params:{allowedValues: schema1370.anyOf[3].properties.kind.enum}};if(vErrors === null){vErrors = [err20];}else {vErrors.push(err20);}errors++;}var valid4: any = _errs26 === errors;}else {var valid4: any = true;}if(valid4){if(data.sessionId !== undefined){const _errs28: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid4: any = _errs28 === errors;}else {var valid4: any = true;}if(valid4){if(data.text !== undefined){const _errs29: any = errors;if(typeof data.text !== "string"){const err21: any = {instancePath:instancePath+"/text",schemaPath:"#/anyOf/3/properties/text/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err21];}else {vErrors.push(err21);}errors++;}var valid4: any = _errs29 === errors;}else {var valid4: any = true;}}}}}}else {const err22: any = {instancePath,schemaPath:"#/anyOf/3/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err22];}else {vErrors.push(err22);}errors++;}}var _valid0: any = _errs23 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}const _errs31: any = errors;if(errors === _errs31){if(data && typeof data == "object" && !Array.isArray(data)){let missing4: any;if((((data.kind === undefined) && (missing4 = "kind")) || ((data.sessionId === undefined) && (missing4 = "sessionId"))) || ((data.cause === undefined) && (missing4 = "cause"))){const err23: any = {instancePath,schemaPath:"#/anyOf/4/required",keyword:"required",params:{missingProperty: missing4}};if(vErrors === null){vErrors = [err23];}else {vErrors.push(err23);}errors++;}else {const _errs33: any = errors;for(const key4 in data){if(!(((key4 === "kind") || (key4 === "sessionId")) || (key4 === "cause"))){const err24: any = {instancePath,schemaPath:"#/anyOf/4/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4}};if(vErrors === null){vErrors = [err24];}else {vErrors.push(err24);}errors++;break;}}if(_errs33 === errors){if(data.kind !== undefined){let data11: any = data.kind;const _errs34: any = errors;if(typeof data11 !== "string"){const err25: any = {instancePath:instancePath+"/kind",schemaPath:"#/anyOf/4/properties/kind/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err25];}else {vErrors.push(err25);}errors++;}if(!(data11 === "ended")){const err26: any = {instancePath:instancePath+"/kind",schemaPath:"#/anyOf/4/properties/kind/enum",keyword:"enum",params:{allowedValues: schema1370.anyOf[4].properties.kind.enum}};if(vErrors === null){vErrors = [err26];}else {vErrors.push(err26);}errors++;}var valid5: any = _errs34 === errors;}else {var valid5: any = true;}if(valid5){if(data.sessionId !== undefined){const _errs36: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid5: any = _errs36 === errors;}else {var valid5: any = true;}if(valid5){if(data.cause !== undefined){let data13: any = data.cause;const _errs37: any = errors;if(typeof data13 !== "string"){const err27: any = {instancePath:instancePath+"/cause",schemaPath:"#/anyOf/4/properties/cause/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err27];}else {vErrors.push(err27);}errors++;}if(!(data13 === "stopped")){const err28: any = {instancePath:instancePath+"/cause",schemaPath:"#/anyOf/4/properties/cause/enum",keyword:"enum",params:{allowedValues: schema1370.anyOf[4].properties.cause.enum}};if(vErrors === null){vErrors = [err28];}else {vErrors.push(err28);}errors++;}var valid5: any = _errs37 === errors;}else {var valid5: any = true;}}}}}}else {const err29: any = {instancePath,schemaPath:"#/anyOf/4/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err29];}else {vErrors.push(err29);}errors++;}}var _valid0: any = _errs31 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}const _errs39: any = errors;if(errors === _errs39){if(data && typeof data == "object" && !Array.isArray(data)){let missing5: any;if(((((data.kind === undefined) && (missing5 = "kind")) || ((data.sessionId === undefined) && (missing5 = "sessionId"))) || ((data.cause === undefined) && (missing5 = "cause"))) || ((data.reason === undefined) && (missing5 = "reason"))){const err30: any = {instancePath,schemaPath:"#/anyOf/5/required",keyword:"required",params:{missingProperty: missing5}};if(vErrors === null){vErrors = [err30];}else {vErrors.push(err30);}errors++;}else {const _errs41: any = errors;for(const key5 in data){if(!((((key5 === "kind") || (key5 === "sessionId")) || (key5 === "cause")) || (key5 === "reason"))){const err31: any = {instancePath,schemaPath:"#/anyOf/5/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key5}};if(vErrors === null){vErrors = [err31];}else {vErrors.push(err31);}errors++;break;}}if(_errs41 === errors){if(data.kind !== undefined){let data14: any = data.kind;const _errs42: any = errors;if(typeof data14 !== "string"){const err32: any = {instancePath:instancePath+"/kind",schemaPath:"#/anyOf/5/properties/kind/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err32];}else {vErrors.push(err32);}errors++;}if(!(data14 === "ended")){const err33: any = {instancePath:instancePath+"/kind",schemaPath:"#/anyOf/5/properties/kind/enum",keyword:"enum",params:{allowedValues: schema1370.anyOf[5].properties.kind.enum}};if(vErrors === null){vErrors = [err33];}else {vErrors.push(err33);}errors++;}var valid6: any = _errs42 === errors;}else {var valid6: any = true;}if(valid6){if(data.sessionId !== undefined){const _errs44: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid6: any = _errs44 === errors;}else {var valid6: any = true;}if(valid6){if(data.cause !== undefined){let data16: any = data.cause;const _errs45: any = errors;if(typeof data16 !== "string"){const err34: any = {instancePath:instancePath+"/cause",schemaPath:"#/anyOf/5/properties/cause/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err34];}else {vErrors.push(err34);}errors++;}if(!(data16 === "closed")){const err35: any = {instancePath:instancePath+"/cause",schemaPath:"#/anyOf/5/properties/cause/enum",keyword:"enum",params:{allowedValues: schema1370.anyOf[5].properties.cause.enum}};if(vErrors === null){vErrors = [err35];}else {vErrors.push(err35);}errors++;}var valid6: any = _errs45 === errors;}else {var valid6: any = true;}if(valid6){if(data.reason !== undefined){let data17: any = data.reason;const _errs47: any = errors;if((typeof data17 !== "string") && (data17 !== null)){const err36: any = {instancePath:instancePath+"/reason",schemaPath:"#/anyOf/5/properties/reason/type",keyword:"type",params:{type: schema1370.anyOf[5].properties.reason.type}};if(vErrors === null){vErrors = [err36];}else {vErrors.push(err36);}errors++;}var valid6: any = _errs47 === errors;}else {var valid6: any = true;}}}}}}}else {const err37: any = {instancePath,schemaPath:"#/anyOf/5/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err37];}else {vErrors.push(err37);}errors++;}}var _valid0: any = _errs39 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}const _errs49: any = errors;if(errors === _errs49){if(data && typeof data == "object" && !Array.isArray(data)){let missing6: any;if(((((data.kind === undefined) && (missing6 = "kind")) || ((data.sessionId === undefined) && (missing6 = "sessionId"))) || ((data.cause === undefined) && (missing6 = "cause"))) || ((data.message === undefined) && (missing6 = "message"))){const err38: any = {instancePath,schemaPath:"#/anyOf/6/required",keyword:"required",params:{missingProperty: missing6}};if(vErrors === null){vErrors = [err38];}else {vErrors.push(err38);}errors++;}else {const _errs51: any = errors;for(const key6 in data){if(!((((key6 === "kind") || (key6 === "sessionId")) || (key6 === "cause")) || (key6 === "message"))){const err39: any = {instancePath,schemaPath:"#/anyOf/6/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key6}};if(vErrors === null){vErrors = [err39];}else {vErrors.push(err39);}errors++;break;}}if(_errs51 === errors){if(data.kind !== undefined){let data18: any = data.kind;const _errs52: any = errors;if(typeof data18 !== "string"){const err40: any = {instancePath:instancePath+"/kind",schemaPath:"#/anyOf/6/properties/kind/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err40];}else {vErrors.push(err40);}errors++;}if(!(data18 === "ended")){const err41: any = {instancePath:instancePath+"/kind",schemaPath:"#/anyOf/6/properties/kind/enum",keyword:"enum",params:{allowedValues: schema1370.anyOf[6].properties.kind.enum}};if(vErrors === null){vErrors = [err41];}else {vErrors.push(err41);}errors++;}var valid7: any = _errs52 === errors;}else {var valid7: any = true;}if(valid7){if(data.sessionId !== undefined){const _errs54: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid7: any = _errs54 === errors;}else {var valid7: any = true;}if(valid7){if(data.cause !== undefined){let data20: any = data.cause;const _errs55: any = errors;if(typeof data20 !== "string"){const err42: any = {instancePath:instancePath+"/cause",schemaPath:"#/anyOf/6/properties/cause/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err42];}else {vErrors.push(err42);}errors++;}if(!(data20 === "error")){const err43: any = {instancePath:instancePath+"/cause",schemaPath:"#/anyOf/6/properties/cause/enum",keyword:"enum",params:{allowedValues: schema1370.anyOf[6].properties.cause.enum}};if(vErrors === null){vErrors = [err43];}else {vErrors.push(err43);}errors++;}var valid7: any = _errs55 === errors;}else {var valid7: any = true;}if(valid7){if(data.message !== undefined){let data21: any = data.message;const _errs57: any = errors;if(errors === _errs57){if(typeof data21 === "string"){if(func1(data21) < 1){const err44: any = {instancePath:instancePath+"/message",schemaPath:"#/anyOf/6/properties/message/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err44];}else {vErrors.push(err44);}errors++;}}else {const err45: any = {instancePath:instancePath+"/message",schemaPath:"#/anyOf/6/properties/message/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err45];}else {vErrors.push(err45);}errors++;}}var valid7: any = _errs57 === errors;}else {var valid7: any = true;}}}}}}}else {const err46: any = {instancePath,schemaPath:"#/anyOf/6/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err46];}else {vErrors.push(err46);}errors++;}}var _valid0: any = _errs49 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid0){const err47: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err47];}else {vErrors.push(err47);}errors++;validateVoiceCallFrame.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validateVoiceCallFrame.errors = vErrors;evaluated0.props = props0;return errors === 0;};
// prettier-ignore
validateVoiceCallFrame.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
/** Checks that a value is a {@link VoiceListResponse}. */
// prettier-ignore
export const validateVoiceListResponse: CompiledSchemaCheck<VoiceListResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is VoiceListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateVoiceListResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.voices === undefined) && (missing0 = "voices")) || ((data.defaultVoice === undefined) && (missing0 = "defaultVoice"))){validateVoiceListResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "voices") || (key0 === "defaultVoice"))){validateVoiceListResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.voices !== undefined){let data0: any = data.voices;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){let data1: any = data0[i0];const _errs4: any = errors;if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) < 1){validateVoiceListResponse.errors = [{instancePath:instancePath+"/voices/" + i0,schemaPath:"#/properties/voices/items/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateVoiceListResponse.errors = [{instancePath:instancePath+"/voices/" + i0,schemaPath:"#/properties/voices/items/type",keyword:"type",params:{type: "string"}}];return false;}}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validateVoiceListResponse.errors = [{instancePath:instancePath+"/voices",schemaPath:"#/properties/voices/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.defaultVoice !== undefined){let data2: any = data.defaultVoice;const _errs6: any = errors;if(errors === _errs6){if(typeof data2 === "string"){if(func1(data2) < 1){validateVoiceListResponse.errors = [{instancePath:instancePath+"/defaultVoice",schemaPath:"#/properties/defaultVoice/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateVoiceListResponse.errors = [{instancePath:instancePath+"/defaultVoice",schemaPath:"#/properties/defaultVoice/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validateVoiceListResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateVoiceListResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateVoiceListResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;

/** The methods of {@link VOICE_METHOD_DESCRIPTORS}, each with its checks. */
export interface VoiceMethodDescriptors {
  readonly "voice.state.update": {
    readonly method: "voice.state.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<VoiceState>;
    readonly responseCheck: SchemaCheck<VoiceState>;
  };
  readonly "voice.state.subscribe": {
    readonly method: "voice.state.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<VoiceState>;
  };
  readonly "voice.dictation.start": {
    readonly method: "voice.dictation.start";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<VoiceDictationStartRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "voice.dictation.write": {
    readonly method: "voice.dictation.write";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<VoiceDictationWriteRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "voice.dictation.stop": {
    readonly method: "voice.dictation.stop";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<VoiceDictationStopRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "voice.dictation.subscribe": {
    readonly method: "voice.dictation.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<VoiceDictationFrame>;
  };
  readonly "voice.call.start": {
    readonly method: "voice.call.start";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<VoiceCallStartRequest>;
    readonly responseCheck: SchemaCheck<VoiceCallStartResponse>;
  };
  readonly "voice.call.stop": {
    readonly method: "voice.call.stop";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "voice.call.subscribe": {
    readonly method: "voice.call.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<VoiceCallFrame>;
  };
  readonly "voice.list": {
    readonly method: "voice.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<VoiceListResponse>;
  };
}
/** The `voice.*` methods. */
export const VOICE_METHOD_DESCRIPTORS: VoiceMethodDescriptors = Object.freeze({
  "voice.state.update": Object.freeze({
    method: "voice.state.update",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateVoiceState,
    responseCheck: validateVoiceState,
  }),
  "voice.state.subscribe": Object.freeze({
    method: "voice.state.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validateEmptyPayload,
    responseCheck: validateSubscribeAcknowledgmentResponse,
    emissionCheck: validateVoiceState,
  }),
  "voice.dictation.start": Object.freeze({
    method: "voice.dictation.start",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateVoiceDictationStartRequest,
    responseCheck: validateEmptyPayload,
  }),
  "voice.dictation.write": Object.freeze({
    method: "voice.dictation.write",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateVoiceDictationWriteRequest,
    responseCheck: validateEmptyPayload,
  }),
  "voice.dictation.stop": Object.freeze({
    method: "voice.dictation.stop",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateVoiceDictationStopRequest,
    responseCheck: validateEmptyPayload,
  }),
  "voice.dictation.subscribe": Object.freeze({
    method: "voice.dictation.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validateEmptyPayload,
    responseCheck: validateSubscribeAcknowledgmentResponse,
    emissionCheck: validateVoiceDictationFrame,
  }),
  "voice.call.start": Object.freeze({
    method: "voice.call.start",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateVoiceCallStartRequest,
    responseCheck: validateVoiceCallStartResponse,
  }),
  "voice.call.stop": Object.freeze({
    method: "voice.call.stop",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateEmptyPayload,
    responseCheck: validateEmptyPayload,
  }),
  "voice.call.subscribe": Object.freeze({
    method: "voice.call.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validateEmptyPayload,
    responseCheck: validateSubscribeAcknowledgmentResponse,
    emissionCheck: validateVoiceCallFrame,
  }),
  "voice.list": Object.freeze({
    method: "voice.list",
    procedureType: "query",
    mutating: false,
    requestCheck: validateEmptyPayload,
    responseCheck: validateVoiceListResponse,
  }),
});
