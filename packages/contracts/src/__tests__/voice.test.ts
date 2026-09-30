// A dictation frame is at most 100 ms of 16 kHz 16-bit mono audio (3,200 bytes) in whole
// samples, so no 16-bit sample is split across two frames.
import { describe, expect, it } from "vitest";

import { VoiceDictationWriteRequestSchema } from "../voice.js";

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
});
