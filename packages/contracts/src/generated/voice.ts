// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Voice, as a window drives it through the daemon: which session voice is on in, and its two mechanisms, dictation into the composer and a spoken call with the provider.

import type { SchemaCheck } from "../schema-check.js";
import { validateSubscribeAcknowledgmentResponse } from "./checks/jsonrpc/streaming.js";
import { validateEmptyPayload } from "./checks/method-descriptor.js";
import {
  validateVoiceCallFrame,
  validateVoiceCallStartRequest,
  validateVoiceCallStartResponse,
  validateVoiceDictationFrame,
  validateVoiceDictationStartRequest,
  validateVoiceDictationStopRequest,
  validateVoiceDictationWriteRequest,
  validateVoiceListResponse,
  validateVoiceState,
} from "./checks/voice.js";
import type { SubscribeAcknowledgmentResponse } from "./jsonrpc/streaming.js";
import type { EmptyPayload } from "./method-descriptor.js";
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

export {
  validateMessageOrigin,
  validateVoiceAccountNotEntitledDetails,
  validateVoiceAccountNotEntitledReason,
  validateVoiceCallFrame,
  validateVoiceCallStartRequest,
  validateVoiceCallStartResponse,
  validateVoiceDictationFailure,
  validateVoiceDictationFailureReason,
  validateVoiceDictationFrame,
  validateVoiceDictationStartRequest,
  validateVoiceDictationStopRequest,
  validateVoiceDictationWriteRequest,
  validateVoiceKind,
  validateVoiceListResponse,
  validateVoiceState,
} from "./checks/voice.js";

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
export const VOICE_METHOD_DESCRIPTORS: VoiceMethodDescriptors = /* @__PURE__ */ Object.freeze({
  "voice.state.update": /* @__PURE__ */ Object.freeze({
    method: "voice.state.update",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateVoiceState,
    responseCheck: validateVoiceState,
  }),
  "voice.state.subscribe": /* @__PURE__ */ Object.freeze({
    method: "voice.state.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validateEmptyPayload,
    responseCheck: validateSubscribeAcknowledgmentResponse,
    emissionCheck: validateVoiceState,
  }),
  "voice.dictation.start": /* @__PURE__ */ Object.freeze({
    method: "voice.dictation.start",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateVoiceDictationStartRequest,
    responseCheck: validateEmptyPayload,
  }),
  "voice.dictation.write": /* @__PURE__ */ Object.freeze({
    method: "voice.dictation.write",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateVoiceDictationWriteRequest,
    responseCheck: validateEmptyPayload,
  }),
  "voice.dictation.stop": /* @__PURE__ */ Object.freeze({
    method: "voice.dictation.stop",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateVoiceDictationStopRequest,
    responseCheck: validateEmptyPayload,
  }),
  "voice.dictation.subscribe": /* @__PURE__ */ Object.freeze({
    method: "voice.dictation.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validateEmptyPayload,
    responseCheck: validateSubscribeAcknowledgmentResponse,
    emissionCheck: validateVoiceDictationFrame,
  }),
  "voice.call.start": /* @__PURE__ */ Object.freeze({
    method: "voice.call.start",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateVoiceCallStartRequest,
    responseCheck: validateVoiceCallStartResponse,
  }),
  "voice.call.stop": /* @__PURE__ */ Object.freeze({
    method: "voice.call.stop",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateEmptyPayload,
    responseCheck: validateEmptyPayload,
  }),
  "voice.call.subscribe": /* @__PURE__ */ Object.freeze({
    method: "voice.call.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validateEmptyPayload,
    responseCheck: validateSubscribeAcknowledgmentResponse,
    emissionCheck: validateVoiceCallFrame,
  }),
  "voice.list": /* @__PURE__ */ Object.freeze({
    method: "voice.list",
    procedureType: "query",
    mutating: false,
    requestCheck: validateEmptyPayload,
    responseCheck: validateVoiceListResponse,
  }),
});
