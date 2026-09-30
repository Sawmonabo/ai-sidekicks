// Voice's boundary with the window: a dictation frame is at most 100 ms of 16 kHz
// 16-bit mono audio (3,200 bytes) in whole samples, voice is on in one session or
// none, and a recording or a call ends with a cause that says what happened. Each
// block also parses the real shapes, so a refusal cannot pass against a schema that
// refuses everything.
import { describe, expect, it } from "vitest";

import {
  VoiceCallFrameSchema,
  VoiceDictationFrameSchema,
  VoiceDictationStopRequestSchema,
  VoiceDictationWriteRequestSchema,
  VoiceStateSchema,
} from "../voice.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

/** Base64 of this many zero bytes. */
function silence(byteCount: number): string {
  return btoa("\0".repeat(byteCount));
}

describe("VoiceDictationWriteRequestSchema", () => {
  it("accepts a full 100 ms frame and a shorter last one", () => {
    const full = { audio: silence(3200) };
    expect(VoiceDictationWriteRequestSchema.safeParse(full).success).toBe(true);
    expect(VoiceDictationWriteRequestSchema.safeParse({ audio: silence(640) }).success).toBe(true);
  });

  it("refuses a frame longer than 100 ms", () => {
    const long = { audio: silence(3202) };
    expect(VoiceDictationWriteRequestSchema.safeParse(long).success).toBe(false);
  });

  it("refuses a frame that ends mid-sample", () => {
    expect(VoiceDictationWriteRequestSchema.safeParse({ audio: silence(641) }).success).toBe(false);
  });

  it("refuses an empty frame and one that is not base64", () => {
    expect(VoiceDictationWriteRequestSchema.safeParse({ audio: "" }).success).toBe(false);
    expect(VoiceDictationWriteRequestSchema.safeParse({ audio: "not base64!" }).success).toBe(
      false,
    );
  });
});

describe("VoiceDictationStopRequestSchema", () => {
  it("accepts a stop and a cancel, and refuses a stop that does not say which", () => {
    expect(VoiceDictationStopRequestSchema.safeParse({ cancel: false }).success).toBe(true);
    expect(VoiceDictationStopRequestSchema.safeParse({ cancel: true }).success).toBe(true);
    expect(VoiceDictationStopRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe("VoiceStateSchema", () => {
  it("accepts one session or none, and refuses a state that names neither", () => {
    expect(VoiceStateSchema.safeParse({ sessionId: SESSION_ID }).success).toBe(true);
    expect(VoiceStateSchema.safeParse({ sessionId: null }).success).toBe(true);
    expect(VoiceStateSchema.safeParse({}).success).toBe(false);
    const two = { sessionId: SESSION_ID, otherSessionId: SESSION_ID };
    expect(VoiceStateSchema.safeParse(two).success).toBe(false);
  });
});

describe("VoiceDictationFrameSchema", () => {
  it("accepts the words so far, a clean end, each failure, and the service's own error", () => {
    const words = { kind: "words", sessionId: SESSION_ID, committed: "run the", inProgress: "te" };
    expect(VoiceDictationFrameSchema.safeParse(words).success).toBe(true);
    const clean = { kind: "ended", sessionId: SESSION_ID, failure: null };
    expect(VoiceDictationFrameSchema.safeParse(clean).success).toBe(true);
    for (const reason of ["no_sound", "no_speech", "not_sent", "sign_in_refused"]) {
      const ended = { kind: "ended", sessionId: SESSION_ID, failure: { reason } };
      expect(VoiceDictationFrameSchema.safeParse(ended).success).toBe(true);
    }
    const serviceError = {
      kind: "ended",
      sessionId: SESSION_ID,
      failure: { reason: "service_error", message: "Audio format not supported" },
    };
    expect(VoiceDictationFrameSchema.safeParse(serviceError).success).toBe(true);
  });

  it("refuses the service's error without its message, and a reason outside the set", () => {
    const bare = { kind: "ended", sessionId: SESSION_ID, failure: { reason: "service_error" } };
    expect(VoiceDictationFrameSchema.safeParse(bare).success).toBe(false);
    const unknown = { kind: "ended", sessionId: SESSION_ID, failure: { reason: "timeout" } };
    expect(VoiceDictationFrameSchema.safeParse(unknown).success).toBe(false);
  });
});

describe("VoiceCallFrameSchema", () => {
  it("accepts a call's start, its words, its reply and each way it ends", () => {
    const frames = [
      { kind: "started", sessionId: SESSION_ID },
      { kind: "userTranscriptDelta", sessionId: SESSION_ID, delta: "run the" },
      { kind: "userTranscriptDone", sessionId: SESSION_ID, text: "run the tests" },
      { kind: "assistantTranscriptDone", sessionId: SESSION_ID, text: "On it." },
      { kind: "ended", sessionId: SESSION_ID, cause: "stopped" },
      { kind: "ended", sessionId: SESSION_ID, cause: "closed", reason: null },
      { kind: "ended", sessionId: SESSION_ID, cause: "error", message: "Connection lost" },
    ];
    for (const frame of frames) {
      expect(VoiceCallFrameSchema.safeParse(frame).success).toBe(true);
    }
  });

  it("refuses an end with no cause, and an error end without Codex's message", () => {
    expect(VoiceCallFrameSchema.safeParse({ kind: "ended", sessionId: SESSION_ID }).success).toBe(
      false,
    );
    const bare = { kind: "ended", sessionId: SESSION_ID, cause: "error" };
    expect(VoiceCallFrameSchema.safeParse(bare).success).toBe(false);
  });
});
