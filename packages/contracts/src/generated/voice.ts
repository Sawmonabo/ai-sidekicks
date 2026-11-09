/* eslint-disable */
// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Voice, as a window drives it through the daemon: which session voice is on in, and its two mechanisms, dictation into the composer and a spoken call with the provider.

import { type SchemaCheck, ucs2length } from "../schema-check.js";
import {
  type SubscribeAcknowledgmentResponse,
  validateSubscribeAcknowledgmentResponse,
} from "./jsonrpc/streaming.js";
import { type EmptyPayload, validateEmptyPayload } from "./method-descriptor.js";
import type { ProviderId } from "./provider/id.js";
import type { SessionId } from "./session/id.js";

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
const schema4433: any = {"description":"Where a message in the transcript came from when no one typed it: a voice call, heard or\nspoken. A typed message carries no origin.","type":"string","enum":["voice"]};
// prettier-ignore
function validate2242(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is MessageOrigin {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2242.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validate2242.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data === "voice")){validate2242.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema4433.enum}}];return false;}validate2242.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2242.errors = null as any[] | null;
// prettier-ignore
validate2242.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema4435: any = {"description":"Why `voice.accountNotEntitled` refused: the account is signed in, but its provider gives its\nsign-in kind no voice.","type":"string","enum":["signInKindNotEntitled"]};
// prettier-ignore
const pattern16 = new RegExp("^[a-z][a-z0-9-]{0,31}$", "u");
// prettier-ignore
function validate2243(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is VoiceAccountNotEntitledDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2243.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.reason === undefined) && (missing0 = "reason")) || ((data.provider === undefined) && (missing0 = "provider"))){validate2243.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "reason") || (key0 === "provider"))){validate2243.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.reason !== undefined){let data0: any = data.reason;const _errs2: any = errors;if(typeof data0 !== "string"){validate2243.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/$defs/VoiceAccountNotEntitledReason/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data0 === "signInKindNotEntitled")){validate2243.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/$defs/VoiceAccountNotEntitledReason/enum",keyword:"enum",params:{allowedValues: schema4435.enum}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.provider !== undefined){let data1: any = data.provider;const _errs5: any = errors;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(!pattern16.test(data1)){validate2243.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate2243.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}else {validate2243.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2243.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2243.errors = null as any[] | null;
// prettier-ignore
validate2243.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema4437: any = {"anyOf":[{"type":"object","additionalProperties":false,"properties":{"kind":{"description":"The frame's kind.","type":"string","enum":["started"]},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."}},"required":["kind","sessionId"],"description":"The call started."},{"type":"object","additionalProperties":false,"properties":{"kind":{"description":"The frame's kind.","type":"string","enum":["userTranscriptDelta"]},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"delta":{"type":"string","description":"The new words."}},"required":["kind","sessionId","delta"],"description":"Words heard, as they arrive."},{"type":"object","additionalProperties":false,"properties":{"kind":{"description":"The frame's kind.","type":"string","enum":["userTranscriptDone"]},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"text":{"type":"string","description":"The words."}},"required":["kind","sessionId","text"],"description":"Words heard, settled."},{"type":"object","additionalProperties":false,"properties":{"kind":{"description":"The frame's kind.","type":"string","enum":["agentTranscriptDone"]},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"text":{"type":"string","description":"The words."}},"required":["kind","sessionId","text"],"description":"The reply, settled."},{"type":"object","additionalProperties":false,"properties":{"kind":{"description":"The frame's kind.","type":"string","enum":["ended"]},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"cause":{"description":"Always `stopped`.","type":"string","enum":["stopped"]}},"required":["kind","sessionId","cause"],"description":"The daemon stopped the call."},{"type":"object","additionalProperties":false,"properties":{"kind":{"description":"The frame's kind.","type":"string","enum":["ended"]},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"cause":{"description":"Always `closed`.","type":"string","enum":["closed"]},"reason":{"type":["string","null"],"description":"The provider's reason, or `null`."}},"required":["kind","sessionId","cause","reason"],"description":"The provider closed the call."},{"type":"object","additionalProperties":false,"properties":{"kind":{"description":"The frame's kind.","type":"string","enum":["ended"]},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"cause":{"description":"Always `error`.","type":"string","enum":["error"]},"message":{"type":"string","minLength":1,"description":"The provider's words."}},"required":["kind","sessionId","cause","message"],"description":"The provider reported an error."}],"description":"One push of a `voice.call.subscribe` stream: the call started; the words the call hears from the\nperson as they arrive, then settled; the voice's reply, settled; the call ended, with its cause."};
// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
function validate2244(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is VoiceCallFrame {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2244.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(errors === _errs1){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.kind === undefined) && (missing0 = "kind")) || ((data.sessionId === undefined) && (missing0 = "sessionId"))){const err0: any = {instancePath,schemaPath:"#/anyOf/0/required",keyword:"required",params:{missingProperty: missing0}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {const _errs3: any = errors;for(const key0 in data){if(!((key0 === "kind") || (key0 === "sessionId"))){const err1: any = {instancePath,schemaPath:"#/anyOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;break;}}if(_errs3 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs4: any = errors;if(typeof data0 !== "string"){const err2: any = {instancePath:instancePath+"/kind",schemaPath:"#/anyOf/0/properties/kind/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}if(!(data0 === "started")){const err3: any = {instancePath:instancePath+"/kind",schemaPath:"#/anyOf/0/properties/kind/enum",keyword:"enum",params:{allowedValues: schema4437.anyOf[0].properties.kind.enum}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}var valid1: any = _errs4 === errors;}else {var valid1: any = true;}if(valid1){if(data.sessionId !== undefined){let data1: any = data.sessionId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){const err4: any = {instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}}else {const err5: any = {instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}}var valid1: any = _errs6 === errors;}else {var valid1: any = true;}}}}}else {const err6: any = {instancePath,schemaPath:"#/anyOf/0/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs10: any = errors;if(errors === _errs10){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.kind === undefined) && (missing1 = "kind")) || ((data.sessionId === undefined) && (missing1 = "sessionId"))) || ((data.delta === undefined) && (missing1 = "delta"))){const err7: any = {instancePath,schemaPath:"#/anyOf/1/required",keyword:"required",params:{missingProperty: missing1}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;}else {const _errs12: any = errors;for(const key1 in data){if(!(((key1 === "kind") || (key1 === "sessionId")) || (key1 === "delta"))){const err8: any = {instancePath,schemaPath:"#/anyOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;break;}}if(_errs12 === errors){if(data.kind !== undefined){let data2: any = data.kind;const _errs13: any = errors;if(typeof data2 !== "string"){const err9: any = {instancePath:instancePath+"/kind",schemaPath:"#/anyOf/1/properties/kind/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;}if(!(data2 === "userTranscriptDelta")){const err10: any = {instancePath:instancePath+"/kind",schemaPath:"#/anyOf/1/properties/kind/enum",keyword:"enum",params:{allowedValues: schema4437.anyOf[1].properties.kind.enum}};if(vErrors === null){vErrors = [err10];}else {vErrors.push(err10);}errors++;}var valid3: any = _errs13 === errors;}else {var valid3: any = true;}if(valid3){if(data.sessionId !== undefined){let data3: any = data.sessionId;const _errs15: any = errors;const _errs16: any = errors;if(errors === _errs16){if(typeof data3 === "string"){if(!pattern4.test(data3)){const err11: any = {instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}};if(vErrors === null){vErrors = [err11];}else {vErrors.push(err11);}errors++;}}else {const err12: any = {instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err12];}else {vErrors.push(err12);}errors++;}}var valid3: any = _errs15 === errors;}else {var valid3: any = true;}if(valid3){if(data.delta !== undefined){const _errs19: any = errors;if(typeof data.delta !== "string"){const err13: any = {instancePath:instancePath+"/delta",schemaPath:"#/anyOf/1/properties/delta/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err13];}else {vErrors.push(err13);}errors++;}var valid3: any = _errs19 === errors;}else {var valid3: any = true;}}}}}}else {const err14: any = {instancePath,schemaPath:"#/anyOf/1/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err14];}else {vErrors.push(err14);}errors++;}}var _valid0: any = _errs10 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}const _errs21: any = errors;if(errors === _errs21){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((((data.kind === undefined) && (missing2 = "kind")) || ((data.sessionId === undefined) && (missing2 = "sessionId"))) || ((data.text === undefined) && (missing2 = "text"))){const err15: any = {instancePath,schemaPath:"#/anyOf/2/required",keyword:"required",params:{missingProperty: missing2}};if(vErrors === null){vErrors = [err15];}else {vErrors.push(err15);}errors++;}else {const _errs23: any = errors;for(const key2 in data){if(!(((key2 === "kind") || (key2 === "sessionId")) || (key2 === "text"))){const err16: any = {instancePath,schemaPath:"#/anyOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}};if(vErrors === null){vErrors = [err16];}else {vErrors.push(err16);}errors++;break;}}if(_errs23 === errors){if(data.kind !== undefined){let data5: any = data.kind;const _errs24: any = errors;if(typeof data5 !== "string"){const err17: any = {instancePath:instancePath+"/kind",schemaPath:"#/anyOf/2/properties/kind/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err17];}else {vErrors.push(err17);}errors++;}if(!(data5 === "userTranscriptDone")){const err18: any = {instancePath:instancePath+"/kind",schemaPath:"#/anyOf/2/properties/kind/enum",keyword:"enum",params:{allowedValues: schema4437.anyOf[2].properties.kind.enum}};if(vErrors === null){vErrors = [err18];}else {vErrors.push(err18);}errors++;}var valid5: any = _errs24 === errors;}else {var valid5: any = true;}if(valid5){if(data.sessionId !== undefined){let data6: any = data.sessionId;const _errs26: any = errors;const _errs27: any = errors;if(errors === _errs27){if(typeof data6 === "string"){if(!pattern4.test(data6)){const err19: any = {instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}};if(vErrors === null){vErrors = [err19];}else {vErrors.push(err19);}errors++;}}else {const err20: any = {instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err20];}else {vErrors.push(err20);}errors++;}}var valid5: any = _errs26 === errors;}else {var valid5: any = true;}if(valid5){if(data.text !== undefined){const _errs30: any = errors;if(typeof data.text !== "string"){const err21: any = {instancePath:instancePath+"/text",schemaPath:"#/anyOf/2/properties/text/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err21];}else {vErrors.push(err21);}errors++;}var valid5: any = _errs30 === errors;}else {var valid5: any = true;}}}}}}else {const err22: any = {instancePath,schemaPath:"#/anyOf/2/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err22];}else {vErrors.push(err22);}errors++;}}var _valid0: any = _errs21 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}const _errs32: any = errors;if(errors === _errs32){if(data && typeof data == "object" && !Array.isArray(data)){let missing3: any;if((((data.kind === undefined) && (missing3 = "kind")) || ((data.sessionId === undefined) && (missing3 = "sessionId"))) || ((data.text === undefined) && (missing3 = "text"))){const err23: any = {instancePath,schemaPath:"#/anyOf/3/required",keyword:"required",params:{missingProperty: missing3}};if(vErrors === null){vErrors = [err23];}else {vErrors.push(err23);}errors++;}else {const _errs34: any = errors;for(const key3 in data){if(!(((key3 === "kind") || (key3 === "sessionId")) || (key3 === "text"))){const err24: any = {instancePath,schemaPath:"#/anyOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}};if(vErrors === null){vErrors = [err24];}else {vErrors.push(err24);}errors++;break;}}if(_errs34 === errors){if(data.kind !== undefined){let data8: any = data.kind;const _errs35: any = errors;if(typeof data8 !== "string"){const err25: any = {instancePath:instancePath+"/kind",schemaPath:"#/anyOf/3/properties/kind/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err25];}else {vErrors.push(err25);}errors++;}if(!(data8 === "agentTranscriptDone")){const err26: any = {instancePath:instancePath+"/kind",schemaPath:"#/anyOf/3/properties/kind/enum",keyword:"enum",params:{allowedValues: schema4437.anyOf[3].properties.kind.enum}};if(vErrors === null){vErrors = [err26];}else {vErrors.push(err26);}errors++;}var valid7: any = _errs35 === errors;}else {var valid7: any = true;}if(valid7){if(data.sessionId !== undefined){let data9: any = data.sessionId;const _errs37: any = errors;const _errs38: any = errors;if(errors === _errs38){if(typeof data9 === "string"){if(!pattern4.test(data9)){const err27: any = {instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}};if(vErrors === null){vErrors = [err27];}else {vErrors.push(err27);}errors++;}}else {const err28: any = {instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err28];}else {vErrors.push(err28);}errors++;}}var valid7: any = _errs37 === errors;}else {var valid7: any = true;}if(valid7){if(data.text !== undefined){const _errs41: any = errors;if(typeof data.text !== "string"){const err29: any = {instancePath:instancePath+"/text",schemaPath:"#/anyOf/3/properties/text/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err29];}else {vErrors.push(err29);}errors++;}var valid7: any = _errs41 === errors;}else {var valid7: any = true;}}}}}}else {const err30: any = {instancePath,schemaPath:"#/anyOf/3/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err30];}else {vErrors.push(err30);}errors++;}}var _valid0: any = _errs32 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}const _errs43: any = errors;if(errors === _errs43){if(data && typeof data == "object" && !Array.isArray(data)){let missing4: any;if((((data.kind === undefined) && (missing4 = "kind")) || ((data.sessionId === undefined) && (missing4 = "sessionId"))) || ((data.cause === undefined) && (missing4 = "cause"))){const err31: any = {instancePath,schemaPath:"#/anyOf/4/required",keyword:"required",params:{missingProperty: missing4}};if(vErrors === null){vErrors = [err31];}else {vErrors.push(err31);}errors++;}else {const _errs45: any = errors;for(const key4 in data){if(!(((key4 === "kind") || (key4 === "sessionId")) || (key4 === "cause"))){const err32: any = {instancePath,schemaPath:"#/anyOf/4/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4}};if(vErrors === null){vErrors = [err32];}else {vErrors.push(err32);}errors++;break;}}if(_errs45 === errors){if(data.kind !== undefined){let data11: any = data.kind;const _errs46: any = errors;if(typeof data11 !== "string"){const err33: any = {instancePath:instancePath+"/kind",schemaPath:"#/anyOf/4/properties/kind/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err33];}else {vErrors.push(err33);}errors++;}if(!(data11 === "ended")){const err34: any = {instancePath:instancePath+"/kind",schemaPath:"#/anyOf/4/properties/kind/enum",keyword:"enum",params:{allowedValues: schema4437.anyOf[4].properties.kind.enum}};if(vErrors === null){vErrors = [err34];}else {vErrors.push(err34);}errors++;}var valid9: any = _errs46 === errors;}else {var valid9: any = true;}if(valid9){if(data.sessionId !== undefined){let data12: any = data.sessionId;const _errs48: any = errors;const _errs49: any = errors;if(errors === _errs49){if(typeof data12 === "string"){if(!pattern4.test(data12)){const err35: any = {instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}};if(vErrors === null){vErrors = [err35];}else {vErrors.push(err35);}errors++;}}else {const err36: any = {instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err36];}else {vErrors.push(err36);}errors++;}}var valid9: any = _errs48 === errors;}else {var valid9: any = true;}if(valid9){if(data.cause !== undefined){let data13: any = data.cause;const _errs52: any = errors;if(typeof data13 !== "string"){const err37: any = {instancePath:instancePath+"/cause",schemaPath:"#/anyOf/4/properties/cause/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err37];}else {vErrors.push(err37);}errors++;}if(!(data13 === "stopped")){const err38: any = {instancePath:instancePath+"/cause",schemaPath:"#/anyOf/4/properties/cause/enum",keyword:"enum",params:{allowedValues: schema4437.anyOf[4].properties.cause.enum}};if(vErrors === null){vErrors = [err38];}else {vErrors.push(err38);}errors++;}var valid9: any = _errs52 === errors;}else {var valid9: any = true;}}}}}}else {const err39: any = {instancePath,schemaPath:"#/anyOf/4/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err39];}else {vErrors.push(err39);}errors++;}}var _valid0: any = _errs43 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}const _errs54: any = errors;if(errors === _errs54){if(data && typeof data == "object" && !Array.isArray(data)){let missing5: any;if(((((data.kind === undefined) && (missing5 = "kind")) || ((data.sessionId === undefined) && (missing5 = "sessionId"))) || ((data.cause === undefined) && (missing5 = "cause"))) || ((data.reason === undefined) && (missing5 = "reason"))){const err40: any = {instancePath,schemaPath:"#/anyOf/5/required",keyword:"required",params:{missingProperty: missing5}};if(vErrors === null){vErrors = [err40];}else {vErrors.push(err40);}errors++;}else {const _errs56: any = errors;for(const key5 in data){if(!((((key5 === "kind") || (key5 === "sessionId")) || (key5 === "cause")) || (key5 === "reason"))){const err41: any = {instancePath,schemaPath:"#/anyOf/5/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key5}};if(vErrors === null){vErrors = [err41];}else {vErrors.push(err41);}errors++;break;}}if(_errs56 === errors){if(data.kind !== undefined){let data14: any = data.kind;const _errs57: any = errors;if(typeof data14 !== "string"){const err42: any = {instancePath:instancePath+"/kind",schemaPath:"#/anyOf/5/properties/kind/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err42];}else {vErrors.push(err42);}errors++;}if(!(data14 === "ended")){const err43: any = {instancePath:instancePath+"/kind",schemaPath:"#/anyOf/5/properties/kind/enum",keyword:"enum",params:{allowedValues: schema4437.anyOf[5].properties.kind.enum}};if(vErrors === null){vErrors = [err43];}else {vErrors.push(err43);}errors++;}var valid11: any = _errs57 === errors;}else {var valid11: any = true;}if(valid11){if(data.sessionId !== undefined){let data15: any = data.sessionId;const _errs59: any = errors;const _errs60: any = errors;if(errors === _errs60){if(typeof data15 === "string"){if(!pattern4.test(data15)){const err44: any = {instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}};if(vErrors === null){vErrors = [err44];}else {vErrors.push(err44);}errors++;}}else {const err45: any = {instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err45];}else {vErrors.push(err45);}errors++;}}var valid11: any = _errs59 === errors;}else {var valid11: any = true;}if(valid11){if(data.cause !== undefined){let data16: any = data.cause;const _errs63: any = errors;if(typeof data16 !== "string"){const err46: any = {instancePath:instancePath+"/cause",schemaPath:"#/anyOf/5/properties/cause/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err46];}else {vErrors.push(err46);}errors++;}if(!(data16 === "closed")){const err47: any = {instancePath:instancePath+"/cause",schemaPath:"#/anyOf/5/properties/cause/enum",keyword:"enum",params:{allowedValues: schema4437.anyOf[5].properties.cause.enum}};if(vErrors === null){vErrors = [err47];}else {vErrors.push(err47);}errors++;}var valid11: any = _errs63 === errors;}else {var valid11: any = true;}if(valid11){if(data.reason !== undefined){let data17: any = data.reason;const _errs65: any = errors;if((typeof data17 !== "string") && (data17 !== null)){const err48: any = {instancePath:instancePath+"/reason",schemaPath:"#/anyOf/5/properties/reason/type",keyword:"type",params:{type: schema4437.anyOf[5].properties.reason.type}};if(vErrors === null){vErrors = [err48];}else {vErrors.push(err48);}errors++;}var valid11: any = _errs65 === errors;}else {var valid11: any = true;}}}}}}}else {const err49: any = {instancePath,schemaPath:"#/anyOf/5/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err49];}else {vErrors.push(err49);}errors++;}}var _valid0: any = _errs54 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}const _errs67: any = errors;if(errors === _errs67){if(data && typeof data == "object" && !Array.isArray(data)){let missing6: any;if(((((data.kind === undefined) && (missing6 = "kind")) || ((data.sessionId === undefined) && (missing6 = "sessionId"))) || ((data.cause === undefined) && (missing6 = "cause"))) || ((data.message === undefined) && (missing6 = "message"))){const err50: any = {instancePath,schemaPath:"#/anyOf/6/required",keyword:"required",params:{missingProperty: missing6}};if(vErrors === null){vErrors = [err50];}else {vErrors.push(err50);}errors++;}else {const _errs69: any = errors;for(const key6 in data){if(!((((key6 === "kind") || (key6 === "sessionId")) || (key6 === "cause")) || (key6 === "message"))){const err51: any = {instancePath,schemaPath:"#/anyOf/6/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key6}};if(vErrors === null){vErrors = [err51];}else {vErrors.push(err51);}errors++;break;}}if(_errs69 === errors){if(data.kind !== undefined){let data18: any = data.kind;const _errs70: any = errors;if(typeof data18 !== "string"){const err52: any = {instancePath:instancePath+"/kind",schemaPath:"#/anyOf/6/properties/kind/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err52];}else {vErrors.push(err52);}errors++;}if(!(data18 === "ended")){const err53: any = {instancePath:instancePath+"/kind",schemaPath:"#/anyOf/6/properties/kind/enum",keyword:"enum",params:{allowedValues: schema4437.anyOf[6].properties.kind.enum}};if(vErrors === null){vErrors = [err53];}else {vErrors.push(err53);}errors++;}var valid13: any = _errs70 === errors;}else {var valid13: any = true;}if(valid13){if(data.sessionId !== undefined){let data19: any = data.sessionId;const _errs72: any = errors;const _errs73: any = errors;if(errors === _errs73){if(typeof data19 === "string"){if(!pattern4.test(data19)){const err54: any = {instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}};if(vErrors === null){vErrors = [err54];}else {vErrors.push(err54);}errors++;}}else {const err55: any = {instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err55];}else {vErrors.push(err55);}errors++;}}var valid13: any = _errs72 === errors;}else {var valid13: any = true;}if(valid13){if(data.cause !== undefined){let data20: any = data.cause;const _errs76: any = errors;if(typeof data20 !== "string"){const err56: any = {instancePath:instancePath+"/cause",schemaPath:"#/anyOf/6/properties/cause/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err56];}else {vErrors.push(err56);}errors++;}if(!(data20 === "error")){const err57: any = {instancePath:instancePath+"/cause",schemaPath:"#/anyOf/6/properties/cause/enum",keyword:"enum",params:{allowedValues: schema4437.anyOf[6].properties.cause.enum}};if(vErrors === null){vErrors = [err57];}else {vErrors.push(err57);}errors++;}var valid13: any = _errs76 === errors;}else {var valid13: any = true;}if(valid13){if(data.message !== undefined){let data21: any = data.message;const _errs78: any = errors;if(errors === _errs78){if(typeof data21 === "string"){if(func1(data21) < 1){const err58: any = {instancePath:instancePath+"/message",schemaPath:"#/anyOf/6/properties/message/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err58];}else {vErrors.push(err58);}errors++;}}else {const err59: any = {instancePath:instancePath+"/message",schemaPath:"#/anyOf/6/properties/message/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err59];}else {vErrors.push(err59);}errors++;}}var valid13: any = _errs78 === errors;}else {var valid13: any = true;}}}}}}}else {const err60: any = {instancePath,schemaPath:"#/anyOf/6/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err60];}else {vErrors.push(err60);}errors++;}}var _valid0: any = _errs67 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid0){const err61: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err61];}else {vErrors.push(err61);}errors++;validate2244.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validate2244.errors = vErrors;evaluated0.props = props0;return errors === 0;}
// prettier-ignore
validate2244.errors = null as any[] | null;
// prettier-ignore
validate2244.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
// prettier-ignore
function validate2245(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is VoiceCallStartRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2245.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.offerSdp === undefined) && (missing0 = "offerSdp"))){validate2245.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "offerSdp"))){validate2245.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2245.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2245.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.offerSdp !== undefined){let data1: any = data.offerSdp;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) < 1){validate2245.errors = [{instancePath:instancePath+"/offerSdp",schemaPath:"#/properties/offerSdp/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate2245.errors = [{instancePath:instancePath+"/offerSdp",schemaPath:"#/properties/offerSdp/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate2245.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2245.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2245.errors = null as any[] | null;
// prettier-ignore
validate2245.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2246(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is VoiceCallStartResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2246.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.answerSdp === undefined) && (missing0 = "answerSdp")){validate2246.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "answerSdp")){validate2246.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.answerSdp !== undefined){let data0: any = data.answerSdp;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) < 1){validate2246.errors = [{instancePath:instancePath+"/answerSdp",schemaPath:"#/properties/answerSdp/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate2246.errors = [{instancePath:instancePath+"/answerSdp",schemaPath:"#/properties/answerSdp/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate2246.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2246.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2246.errors = null as any[] | null;
// prettier-ignore
validate2246.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema4451: any = {"anyOf":[{"type":"object","additionalProperties":false,"properties":{"reason":{"$ref":"#/$defs/VoiceDictationFailureReason","description":"Why."}},"required":["reason"],"description":"A known reason."},{"type":"object","additionalProperties":false,"properties":{"reason":{"description":"Always `serviceError`.","type":"string","enum":["serviceError"]},"message":{"type":"string","minLength":1,"description":"The service's words."}},"required":["reason","message"],"description":"The service's own error."}],"description":"A recording's failure, or the speech service's own error in its own words."};
// prettier-ignore
const schema4452: any = {"description":"Why a recording ended without its words: only silent samples reached the microphone; sound but\nno words; the connection failed after its one retry or was refused; the speech service refused\nthe account's sign-in.","type":"string","enum":["noSound","noSpeech","notSent","signInRefused"]};
// prettier-ignore
function validate2248(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2248.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(errors === _errs1){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.reason === undefined) && (missing0 = "reason")){const err0: any = {instancePath,schemaPath:"#/anyOf/0/required",keyword:"required",params:{missingProperty: missing0}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {const _errs3: any = errors;for(const key0 in data){if(!(key0 === "reason")){const err1: any = {instancePath,schemaPath:"#/anyOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;break;}}if(_errs3 === errors){if(data.reason !== undefined){let data0: any = data.reason;if(typeof data0 !== "string"){const err2: any = {instancePath:instancePath+"/reason",schemaPath:"#/$defs/VoiceDictationFailureReason/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}if(!((((data0 === "noSound") || (data0 === "noSpeech")) || (data0 === "notSent")) || (data0 === "signInRefused"))){const err3: any = {instancePath:instancePath+"/reason",schemaPath:"#/$defs/VoiceDictationFailureReason/enum",keyword:"enum",params:{allowedValues: schema4452.enum}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}}}}}else {const err4: any = {instancePath,schemaPath:"#/anyOf/0/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs7: any = errors;if(errors === _errs7){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((data.reason === undefined) && (missing1 = "reason")) || ((data.message === undefined) && (missing1 = "message"))){const err5: any = {instancePath,schemaPath:"#/anyOf/1/required",keyword:"required",params:{missingProperty: missing1}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}else {const _errs9: any = errors;for(const key1 in data){if(!((key1 === "reason") || (key1 === "message"))){const err6: any = {instancePath,schemaPath:"#/anyOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;break;}}if(_errs9 === errors){if(data.reason !== undefined){let data1: any = data.reason;const _errs10: any = errors;if(typeof data1 !== "string"){const err7: any = {instancePath:instancePath+"/reason",schemaPath:"#/anyOf/1/properties/reason/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;}if(!(data1 === "serviceError")){const err8: any = {instancePath:instancePath+"/reason",schemaPath:"#/anyOf/1/properties/reason/enum",keyword:"enum",params:{allowedValues: schema4451.anyOf[1].properties.reason.enum}};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;}var valid3: any = _errs10 === errors;}else {var valid3: any = true;}if(valid3){if(data.message !== undefined){let data2: any = data.message;const _errs12: any = errors;if(errors === _errs12){if(typeof data2 === "string"){if(func1(data2) < 1){const err9: any = {instancePath:instancePath+"/message",schemaPath:"#/anyOf/1/properties/message/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;}}else {const err10: any = {instancePath:instancePath+"/message",schemaPath:"#/anyOf/1/properties/message/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err10];}else {vErrors.push(err10);}errors++;}}var valid3: any = _errs12 === errors;}else {var valid3: any = true;}}}}}else {const err11: any = {instancePath,schemaPath:"#/anyOf/1/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err11];}else {vErrors.push(err11);}errors++;}}var _valid0: any = _errs7 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid0){const err12: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err12];}else {vErrors.push(err12);}errors++;validate2248.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validate2248.errors = vErrors;evaluated0.props = props0;return errors === 0;}
// prettier-ignore
validate2248.errors = null as any[] | null;
// prettier-ignore
validate2248.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
// prettier-ignore
function validate2247(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is VoiceDictationFrame {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2247.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs2: any = errors;for(const key0 in data){validate2247.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key0}}];return false;break;}if(_errs2 === errors){const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "words"){const _errs3: any = errors;if(errors === _errs3){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.kind === undefined) && (missing0 = "kind")) || ((data.sessionId === undefined) && (missing0 = "sessionId"))) || ((data.committed === undefined) && (missing0 = "committed"))) || ((data.inProgress === undefined) && (missing0 = "inProgress"))){validate2247.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs5: any = errors;for(const key1 in data){if(!((((key1 === "kind") || (key1 === "sessionId")) || (key1 === "committed")) || (key1 === "inProgress"))){validate2247.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs5 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs6: any = errors;if(typeof data0 !== "string"){validate2247.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("words" !== data0){validate2247.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "words"}}];return false;}var valid2: any = _errs6 === errors;}else {var valid2: any = true;}if(valid2){if(data.sessionId !== undefined){let data1: any = data.sessionId;const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate2247.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2247.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}if(valid2){if(data.committed !== undefined){const _errs12: any = errors;if(typeof data.committed !== "string"){validate2247.errors = [{instancePath:instancePath+"/committed",schemaPath:"#/oneOf/0/properties/committed/type",keyword:"type",params:{type: "string"}}];return false;}var valid2: any = _errs12 === errors;}else {var valid2: any = true;}if(valid2){if(data.inProgress !== undefined){const _errs14: any = errors;if(typeof data.inProgress !== "string"){validate2247.errors = [{instancePath:instancePath+"/inProgress",schemaPath:"#/oneOf/0/properties/inProgress/type",keyword:"type",params:{type: "string"}}];return false;}var valid2: any = _errs14 === errors;}else {var valid2: any = true;}}}}}}}else {validate2247.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "ended"){const _errs16: any = errors;if(errors === _errs16){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.kind === undefined) && (missing1 = "kind")) || ((data.sessionId === undefined) && (missing1 = "sessionId"))) || ((data.failure === undefined) && (missing1 = "failure"))){validate2247.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs18: any = errors;for(const key2 in data){if(!(((key2 === "kind") || (key2 === "sessionId")) || (key2 === "failure"))){validate2247.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs18 === errors){if(data.kind !== undefined){let data4: any = data.kind;const _errs19: any = errors;if(typeof data4 !== "string"){validate2247.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("ended" !== data4){validate2247.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "ended"}}];return false;}var valid5: any = _errs19 === errors;}else {var valid5: any = true;}if(valid5){if(data.sessionId !== undefined){let data5: any = data.sessionId;const _errs21: any = errors;const _errs22: any = errors;if(errors === _errs22){if(typeof data5 === "string"){if(!pattern4.test(data5)){validate2247.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2247.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs21 === errors;}else {var valid5: any = true;}if(valid5){if(data.failure !== undefined){let data6: any = data.failure;const _errs25: any = errors;const _errs26: any = errors;let valid7: any = false;const _errs27: any = errors;if(!(validate2248.call(this, data6, {instancePath:instancePath+"/failure",parentData:data,parentDataProperty:"failure",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2248.errors : vErrors.concat(validate2248.errors);errors = vErrors.length;}var _valid0: any = _errs27 === errors;valid7 = valid7 || _valid0;const _errs28: any = errors;if(data6 !== null){const err0: any = {instancePath:instancePath+"/failure",schemaPath:"#/oneOf/1/properties/failure/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var _valid0: any = _errs28 === errors;valid7 = valid7 || _valid0;if(!valid7){const err1: any = {instancePath:instancePath+"/failure",schemaPath:"#/oneOf/1/properties/failure/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;validate2247.errors = vErrors;return false;}else {errors = _errs26;if(vErrors !== null){if(_errs26){vErrors.length = _errs26;}else {vErrors = null;}}}var valid5: any = _errs25 === errors;}else {var valid5: any = true;}}}}}}else {validate2247.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}}else {validate2247.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validate2247.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}}}else {validate2247.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2247.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2247.errors = null as any[] | null;
// prettier-ignore
validate2247.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2250(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is VoiceDictationStartRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2250.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validate2250.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "sessionId")){validate2250.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2250.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2250.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate2250.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2250.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2250.errors = null as any[] | null;
// prettier-ignore
validate2250.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2251(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is VoiceDictationStopRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2251.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.cancel === undefined) && (missing0 = "cancel")){validate2251.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "cancel")){validate2251.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.cancel !== undefined){if(typeof data.cancel !== "boolean"){validate2251.errors = [{instancePath:instancePath+"/cancel",schemaPath:"#/properties/cancel/type",keyword:"type",params:{type: "boolean"}}];return false;}}}}}else {validate2251.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2251.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2251.errors = null as any[] | null;
// prettier-ignore
validate2251.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2252(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is VoiceDictationWriteRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2252.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.audio === undefined) && (missing0 = "audio")){validate2252.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "audio")){validate2252.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.audio !== undefined){let data0: any = data.audio;const _errs3: any = errors;if(errors === _errs3){if(data0 && typeof data0 == "object" && !Array.isArray(data0)){let missing1: any;if((data0.$bytes === undefined) && (missing1 = "$bytes")){validate2252.errors = [{instancePath:instancePath+"/audio",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs6: any = errors;for(const key1 in data0){if(!(key1 === "$bytes")){validate2252.errors = [{instancePath:instancePath+"/audio",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs6 === errors){if(data0.$bytes !== undefined){let data1: any = data0.$bytes;const _errs7: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validate2252.errors = [{instancePath:instancePath+"/audio/$bytes",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/properties/%24bytes/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs7){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 4294967295 || isNaN(data1)){validate2252.errors = [{instancePath:instancePath+"/audio/$bytes",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/properties/%24bytes/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295}}];return false;}else {if(data1 < 0 || isNaN(data1)){validate2252.errors = [{instancePath:instancePath+"/audio/$bytes",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/properties/%24bytes/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}}}}}else {validate2252.errors = [{instancePath:instancePath+"/audio",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/Bytes/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs3 === errors;if(valid1){if(!(data0 && typeof data0 == "object" && Number.isInteger(data0.$bytes) && this && Array.isArray(this.attachments) && this.attachments[data0.$bytes] instanceof Uint8Array && this.attachments[data0.$bytes].byteLength >= 1)){validate2252.errors = [{instancePath:instancePath+"/audio",schemaPath:"#/properties/audio/minBytes",keyword:"minBytes",params:{}}];return false;}else {if(!(data0 && typeof data0 == "object" && Number.isInteger(data0.$bytes) && this && Array.isArray(this.attachments) && this.attachments[data0.$bytes] instanceof Uint8Array && this.attachments[data0.$bytes].byteLength <= 3200)){validate2252.errors = [{instancePath:instancePath+"/audio",schemaPath:"#/properties/audio/maxBytes",keyword:"maxBytes",params:{}}];return false;}else {if(!(data0 && typeof data0 == "object" && Number.isInteger(data0.$bytes) && this && Array.isArray(this.attachments) && this.attachments[data0.$bytes] instanceof Uint8Array && this.attachments[data0.$bytes].byteLength % 2 === 0)){validate2252.errors = [{instancePath:instancePath+"/audio",schemaPath:"#/properties/audio/evenBytes",keyword:"evenBytes",params:{}}];return false;}}}}}}}}else {validate2252.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2252.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2252.errors = null as any[] | null;
// prettier-ignore
validate2252.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2253(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is VoiceListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2253.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.voices === undefined) && (missing0 = "voices")) || ((data.defaultVoice === undefined) && (missing0 = "defaultVoice"))){validate2253.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "voices") || (key0 === "defaultVoice"))){validate2253.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.voices !== undefined){let data0: any = data.voices;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){let data1: any = data0[i0];const _errs4: any = errors;if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) < 1){validate2253.errors = [{instancePath:instancePath+"/voices/" + i0,schemaPath:"#/properties/voices/items/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate2253.errors = [{instancePath:instancePath+"/voices/" + i0,schemaPath:"#/properties/voices/items/type",keyword:"type",params:{type: "string"}}];return false;}}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validate2253.errors = [{instancePath:instancePath+"/voices",schemaPath:"#/properties/voices/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.defaultVoice !== undefined){let data2: any = data.defaultVoice;const _errs6: any = errors;if(errors === _errs6){if(typeof data2 === "string"){if(func1(data2) < 1){validate2253.errors = [{instancePath:instancePath+"/defaultVoice",schemaPath:"#/properties/defaultVoice/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate2253.errors = [{instancePath:instancePath+"/defaultVoice",schemaPath:"#/properties/defaultVoice/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate2253.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2253.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2253.errors = null as any[] | null;
// prettier-ignore
validate2253.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2254(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is VoiceState {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2254.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validate2254.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "sessionId")){validate2254.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs3: any = errors;let valid1: any = false;const _errs4: any = errors;const _errs5: any = errors;if(errors === _errs5){if(typeof data0 === "string"){if(!pattern4.test(data0)){const err0: any = {instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}}else {const err1: any = {instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}}var _valid0: any = _errs4 === errors;valid1 = valid1 || _valid0;const _errs8: any = errors;if(data0 !== null){const err2: any = {instancePath:instancePath+"/sessionId",schemaPath:"#/properties/sessionId/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}var _valid0: any = _errs8 === errors;valid1 = valid1 || _valid0;if(!valid1){const err3: any = {instancePath:instancePath+"/sessionId",schemaPath:"#/properties/sessionId/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validate2254.errors = vErrors;return false;}else {errors = _errs3;if(vErrors !== null){if(_errs3){vErrors.length = _errs3;}else {vErrors = null;}}}}}}}else {validate2254.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2254.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2254.errors = null as any[] | null;
// prettier-ignore
validate2254.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link MessageOrigin}. */
export const validateMessageOrigin: SchemaCheck<MessageOrigin> = validate2242;
/** Checks that a value is a {@link VoiceAccountNotEntitledDetails}. */
export const validateVoiceAccountNotEntitledDetails: SchemaCheck<VoiceAccountNotEntitledDetails> =
  validate2243;
/** Checks that a value is a {@link VoiceCallFrame}. */
export const validateVoiceCallFrame: SchemaCheck<VoiceCallFrame> = validate2244;
/** Checks that a value is a {@link VoiceCallStartRequest}. */
export const validateVoiceCallStartRequest: SchemaCheck<VoiceCallStartRequest> = validate2245;
/** Checks that a value is a {@link VoiceCallStartResponse}. */
export const validateVoiceCallStartResponse: SchemaCheck<VoiceCallStartResponse> = validate2246;
/** Checks that a value is a {@link VoiceDictationFrame}. */
export const validateVoiceDictationFrame: SchemaCheck<VoiceDictationFrame> = validate2247;
/** Checks that a value is a {@link VoiceDictationStartRequest}. */
export const validateVoiceDictationStartRequest: SchemaCheck<VoiceDictationStartRequest> =
  validate2250;
/** Checks that a value is a {@link VoiceDictationStopRequest}. */
export const validateVoiceDictationStopRequest: SchemaCheck<VoiceDictationStopRequest> =
  validate2251;
/** Checks that a value is a {@link VoiceDictationWriteRequest}. */
export const validateVoiceDictationWriteRequest: SchemaCheck<VoiceDictationWriteRequest> =
  validate2252;
/** Checks that a value is a {@link VoiceListResponse}. */
export const validateVoiceListResponse: SchemaCheck<VoiceListResponse> = validate2253;
/** Checks that a value is a {@link VoiceState}. */
export const validateVoiceState: SchemaCheck<VoiceState> = validate2254;

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
