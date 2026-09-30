// The transcription of the daemon's vocabulary must be total (every disposition has a sentence),
// and the two named codes stay apart from the default and each other.

import { describe, expect, it } from "vitest";

import {
  INGEST_CAPACITY_EXHAUSTED_CODE,
  INGEST_DISPOSITION_COPY,
  INGEST_REFUSAL_DISPOSITIONS,
  INGEST_STREAM_INVALID_CODE,
  ingestRefusalDisposition,
} from "./attachment-policy.js";

describe("attachment policy — the two named codes", () => {
  it("keeps the terminal and the transient refusal apart", () => {
    expect(ingestRefusalDisposition(INGEST_STREAM_INVALID_CODE)).toBe("restart");
    expect(ingestRefusalDisposition(INGEST_CAPACITY_EXHAUSTED_CODE)).toBe("wait-and-retry");
  });

  it("negative control: an unrecognized code takes the retry-safe default, not a restart", () => {
    // Collapsing these would tell a user to re-upload a hundred megabytes over a lost response.
    expect(ingestRefusalDisposition("artifact.not_found")).toBe("retry-in-place");
    for (const disposition of INGEST_REFUSAL_DISPOSITIONS) {
      expect(INGEST_DISPOSITION_COPY[disposition].length).toBeGreaterThan(0);
    }
  });
});
