// Voice, as a window drives it through the daemon: which session voice is on in, dictation into
// the composer on Claude Code, and Codex's own spoken call on Codex. Voice is on in one session
// at a time on this computer, held by the daemon and off after it restarts, and there is one
// recording and one call at a time, so the verbs on the one in progress name no session.
// Dictation audio is 16 kHz 16-bit mono PCM in 100 ms frames; the window is a call's WebRTC peer
// and hands its offer here. No provider credential crosses this surface in either direction.
import { z } from "zod";

import { decodedByteLength } from "./internal/base64.js";
import { SubscribeAckResponseSchema, type SubscribeAckResponse } from "./jsonrpc-streaming.js";
import {
  defineMethodDescriptors,
  type MethodDescriptor,
  type SubscriptionMethodDescriptor,
} from "./method-descriptor.js";
import { SessionIdSchema, type SessionId } from "./session.js";

/** The bytes in one 100 ms frame of 16 kHz 16-bit mono audio. */
export const VOICE_DICTATION_FRAME_MAX_BYTES: number = (16_000 * 2) / 10;

/** A request or result with no members. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface VoiceEmptyPayload {}
/** Parses a {@link VoiceEmptyPayload}; any member is refused. */
export const VoiceEmptyPayloadSchema: z.ZodType<VoiceEmptyPayload, VoiceEmptyPayload> = z
  .object({})
  .strict();

// Refusals

/**
 * Voice is refused on an account its provider gives no voice: on Claude Code, an
 * account that is neither a Claude sign-in nor a pasted Claude token.
 */
export const VOICE_UNAVAILABLE_CODE = "voice.unavailable" as const;
/** The type of {@link VOICE_UNAVAILABLE_CODE}. */
export type VoiceUnavailableCode = typeof VOICE_UNAVAILABLE_CODE;

const VOICE_UNAVAILABLE_REASON_VALUES = ["claude_sign_in_required"] as const;
/** Why {@link VOICE_UNAVAILABLE_CODE} refused. */
export type VoiceUnavailableReason = (typeof VOICE_UNAVAILABLE_REASON_VALUES)[number];
/** Every {@link VoiceUnavailableReason}, as a value. */
export const VOICE_UNAVAILABLE_REASONS: readonly VoiceUnavailableReason[] =
  VOICE_UNAVAILABLE_REASON_VALUES;

/** Codex could not start the call. */
export const VOICE_CALL_START_FAILED_CODE = "voice.call_start_failed" as const;
/** The type of {@link VOICE_CALL_START_FAILED_CODE}. */
export type VoiceCallStartFailedCode = typeof VOICE_CALL_START_FAILED_CODE;

// Which session voice is on in

/** The session voice is on in, or null when it is off. */
export interface VoiceState {
  sessionId: SessionId | null;
}
/**
 * Parses a {@link VoiceState}. It is the request of `voice.stateUpdate`, its result,
 * and each delivery of `voice.stateSubscribe`, the first of which is the current state.
 */
export const VoiceStateSchema: z.ZodType<VoiceState, VoiceState> = z
  .object({ sessionId: SessionIdSchema.nullable() })
  .strict();

// Dictation

/** Starts a recording in a Claude Code session. */
export interface VoiceDictationStartRequest {
  sessionId: SessionId;
}
/** Parses a {@link VoiceDictationStartRequest}. */
export const VoiceDictationStartRequestSchema: z.ZodType<
  VoiceDictationStartRequest,
  VoiceDictationStartRequest
> = z.object({ sessionId: SessionIdSchema }).strict();

/**
 * One frame of the recording's audio: base64 of 16 kHz 16-bit mono PCM, at most
 * 100 ms of it, because the local wire carries JSON and no binary member.
 */
export interface VoiceDictationWriteRequest {
  audio: string;
}
/**
 * Parses a {@link VoiceDictationWriteRequest}; a frame longer than 100 ms or ending
 * mid-sample is refused.
 */
export const VoiceDictationWriteRequestSchema: z.ZodType<
  VoiceDictationWriteRequest,
  VoiceDictationWriteRequest
> = z
  .object({
    audio: z
      .base64()
      .min(1)
      .refine((value) => decodedByteLength(value) <= VOICE_DICTATION_FRAME_MAX_BYTES, {
        message: `audio must decode to at most ${VOICE_DICTATION_FRAME_MAX_BYTES} bytes`,
      })
      .refine((value) => decodedByteLength(value) % 2 === 0, {
        message: "audio must decode to whole 16-bit samples",
      }),
  })
  .strict();

/** Stops the recording. `cancel` drops it, and its words with it. */
export interface VoiceDictationStopRequest {
  cancel: boolean;
}
/** Parses a {@link VoiceDictationStopRequest}. */
export const VoiceDictationStopRequestSchema: z.ZodType<
  VoiceDictationStopRequest,
  VoiceDictationStopRequest
> = z.object({ cancel: z.boolean() }).strict();

const VOICE_DICTATION_FAILURE_REASON_VALUES = [
  "no_sound",
  "no_speech",
  "not_sent",
  "sign_in_refused",
] as const;
/**
 * Why a recording ended without its words: only silent samples reached the
 * microphone; sound but no words; the connection failed after its one retry or was
 * refused; the speech service refused the account's sign-in.
 */
export type VoiceDictationFailureReason = (typeof VOICE_DICTATION_FAILURE_REASON_VALUES)[number];
/** Every {@link VoiceDictationFailureReason}, as a value. */
export const VOICE_DICTATION_FAILURE_REASONS: readonly VoiceDictationFailureReason[] =
  VOICE_DICTATION_FAILURE_REASON_VALUES;

/** A recording's failure, or the speech service's own error in its own words. */
export type VoiceDictationFailure =
  | { reason: VoiceDictationFailureReason }
  | { reason: "service_error"; message: string };

/**
 * One push of a `voice.dictationSubscribe` stream. `words` carries the settled words
 * and the words still in progress, which the draft shows in that order with a space
 * between; `ended` closes the recording, with its failure or null.
 */
export type VoiceDictationFrame =
  | { kind: "words"; sessionId: SessionId; committed: string; inProgress: string }
  | { kind: "ended"; sessionId: SessionId; failure: VoiceDictationFailure | null };
/** Parses a {@link VoiceDictationFrame}. */
export const VoiceDictationFrameSchema: z.ZodType<VoiceDictationFrame> = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        kind: z.literal("words"),
        sessionId: SessionIdSchema,
        committed: z.string(),
        inProgress: z.string(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("ended"),
        sessionId: SessionIdSchema,
        failure: z
          .union([
            z.object({ reason: z.enum(VOICE_DICTATION_FAILURE_REASON_VALUES) }).strict(),
            z.object({ reason: z.literal("service_error"), message: z.string().min(1) }).strict(),
          ])
          .nullable(),
      })
      .strict(),
  ],
);

// A Codex call

/** Starts a call in a Codex session with the window's WebRTC offer. */
export interface VoiceCallStartRequest {
  sessionId: SessionId;
  offerSdp: string;
}
/** Parses a {@link VoiceCallStartRequest}. */
export const VoiceCallStartRequestSchema: z.ZodType<VoiceCallStartRequest, VoiceCallStartRequest> =
  z.object({ sessionId: SessionIdSchema, offerSdp: z.string().min(1) }).strict();

/** Codex's WebRTC answer to the window's offer. */
export interface VoiceCallStartResponse {
  answerSdp: string;
}
/** Parses a {@link VoiceCallStartResponse}. */
export const VoiceCallStartResponseSchema: z.ZodType<VoiceCallStartResponse> = z
  .object({ answerSdp: z.string().min(1) })
  .strict();

/**
 * Why a call ended: the daemon stopped it, Codex closed it with its own reason or
 * none, or Codex reported an error in its own words.
 */
export type VoiceCallEndCause =
  | { cause: "stopped" }
  | { cause: "closed"; reason: string | null }
  | { cause: "error"; message: string };

/**
 * One push of a `voice.callSubscribe` stream: the call started; the words the call
 * hears from the person as they arrive, then settled; the voice's reply, settled; the
 * call ended, with its cause.
 */
export type VoiceCallFrame =
  | { kind: "started"; sessionId: SessionId }
  | { kind: "userTranscriptDelta"; sessionId: SessionId; delta: string }
  | { kind: "userTranscriptDone"; sessionId: SessionId; text: string }
  | { kind: "assistantTranscriptDone"; sessionId: SessionId; text: string }
  | ({ kind: "ended"; sessionId: SessionId } & VoiceCallEndCause);
/** Parses a {@link VoiceCallFrame}. */
export const VoiceCallFrameSchema: z.ZodType<VoiceCallFrame> = z.union([
  z.object({ kind: z.literal("started"), sessionId: SessionIdSchema }).strict(),
  z
    .object({
      kind: z.literal("userTranscriptDelta"),
      sessionId: SessionIdSchema,
      delta: z.string(),
    })
    .strict(),
  z
    .object({ kind: z.literal("userTranscriptDone"), sessionId: SessionIdSchema, text: z.string() })
    .strict(),
  z
    .object({
      kind: z.literal("assistantTranscriptDone"),
      sessionId: SessionIdSchema,
      text: z.string(),
    })
    .strict(),
  z
    .object({ kind: z.literal("ended"), sessionId: SessionIdSchema, cause: z.literal("stopped") })
    .strict(),
  z
    .object({
      kind: z.literal("ended"),
      sessionId: SessionIdSchema,
      cause: z.literal("closed"),
      reason: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("ended"),
      sessionId: SessionIdSchema,
      cause: z.literal("error"),
      message: z.string().min(1),
    })
    .strict(),
]);

/** The voices Codex offers a call, and the one it uses until the person picks another. */
export interface VoiceListResponse {
  voices: string[];
  defaultVoice: string;
}
/** Parses a {@link VoiceListResponse}. */
export const VoiceListResponseSchema: z.ZodType<VoiceListResponse> = z
  .object({ voices: z.array(z.string().min(1)), defaultVoice: z.string().min(1) })
  .strict();

// Methods

/** The `voice.*` methods, keyed by name. */
export interface VoiceMethodDescriptors {
  readonly "voice.stateUpdate": MethodDescriptor<"voice.stateUpdate", VoiceState, VoiceState>;
  readonly "voice.stateSubscribe": SubscriptionMethodDescriptor<
    "voice.stateSubscribe",
    VoiceEmptyPayload,
    SubscribeAckResponse,
    VoiceState
  >;
  readonly "voice.dictationStart": MethodDescriptor<
    "voice.dictationStart",
    VoiceDictationStartRequest,
    VoiceEmptyPayload
  >;
  readonly "voice.dictationWrite": MethodDescriptor<
    "voice.dictationWrite",
    VoiceDictationWriteRequest,
    VoiceEmptyPayload
  >;
  readonly "voice.dictationStop": MethodDescriptor<
    "voice.dictationStop",
    VoiceDictationStopRequest,
    VoiceEmptyPayload
  >;
  readonly "voice.dictationSubscribe": SubscriptionMethodDescriptor<
    "voice.dictationSubscribe",
    VoiceEmptyPayload,
    SubscribeAckResponse,
    VoiceDictationFrame
  >;
  readonly "voice.callStart": MethodDescriptor<
    "voice.callStart",
    VoiceCallStartRequest,
    VoiceCallStartResponse
  >;
  readonly "voice.callStop": MethodDescriptor<
    "voice.callStop",
    VoiceEmptyPayload,
    VoiceEmptyPayload
  >;
  readonly "voice.callSubscribe": SubscriptionMethodDescriptor<
    "voice.callSubscribe",
    VoiceEmptyPayload,
    SubscribeAckResponse,
    VoiceCallFrame
  >;
  readonly "voice.voiceList": MethodDescriptor<
    "voice.voiceList",
    VoiceEmptyPayload,
    VoiceListResponse
  >;
}

/** The `voice.*` method table. */
export const VOICE_METHOD_DESCRIPTORS: VoiceMethodDescriptors = defineMethodDescriptors({
  "voice.stateUpdate": {
    method: "voice.stateUpdate",
    procedureType: "mutation",
    mutating: true,
    requestSchema: VoiceStateSchema,
    responseSchema: VoiceStateSchema,
  },
  "voice.stateSubscribe": {
    method: "voice.stateSubscribe",
    procedureType: "subscription",
    mutating: false,
    requestSchema: VoiceEmptyPayloadSchema,
    responseSchema: SubscribeAckResponseSchema,
    emissionSchema: VoiceStateSchema,
  },
  "voice.dictationStart": {
    method: "voice.dictationStart",
    procedureType: "mutation",
    mutating: true,
    requestSchema: VoiceDictationStartRequestSchema,
    responseSchema: VoiceEmptyPayloadSchema,
  },
  "voice.dictationWrite": {
    method: "voice.dictationWrite",
    procedureType: "mutation",
    mutating: true,
    requestSchema: VoiceDictationWriteRequestSchema,
    responseSchema: VoiceEmptyPayloadSchema,
  },
  "voice.dictationStop": {
    method: "voice.dictationStop",
    procedureType: "mutation",
    mutating: true,
    requestSchema: VoiceDictationStopRequestSchema,
    responseSchema: VoiceEmptyPayloadSchema,
  },
  "voice.dictationSubscribe": {
    method: "voice.dictationSubscribe",
    procedureType: "subscription",
    mutating: false,
    requestSchema: VoiceEmptyPayloadSchema,
    responseSchema: SubscribeAckResponseSchema,
    emissionSchema: VoiceDictationFrameSchema,
  },
  "voice.callStart": {
    method: "voice.callStart",
    procedureType: "mutation",
    mutating: true,
    requestSchema: VoiceCallStartRequestSchema,
    responseSchema: VoiceCallStartResponseSchema,
  },
  "voice.callStop": {
    method: "voice.callStop",
    procedureType: "mutation",
    mutating: true,
    requestSchema: VoiceEmptyPayloadSchema,
    responseSchema: VoiceEmptyPayloadSchema,
  },
  "voice.callSubscribe": {
    method: "voice.callSubscribe",
    procedureType: "subscription",
    mutating: false,
    requestSchema: VoiceEmptyPayloadSchema,
    responseSchema: SubscribeAckResponseSchema,
    emissionSchema: VoiceCallFrameSchema,
  },
  "voice.voiceList": {
    method: "voice.voiceList",
    procedureType: "query",
    mutating: false,
    requestSchema: VoiceEmptyPayloadSchema,
    responseSchema: VoiceListResponseSchema,
  },
});
