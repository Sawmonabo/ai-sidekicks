// The daemon's vocabulary, checked for totality and for the two distinctions it turns on.
//
// Every value here is `Spec-014`'s rather than this console's, so what a test can prove
// is that the transcription is TOTAL — a disposition with no sentence, or a code
// classified by nothing, is the failure mode — and that the two named codes stay apart
// from the default and from each other.

import { describe, expect, it } from "vitest";

import {
  ATTACHMENT_ALLOWLIST_DEFAULT,
  INGEST_CAPACITY_EXHAUSTED_CODE,
  INGEST_DISPOSITION_COPY,
  INGEST_REFUSAL_DISPOSITIONS,
  INGEST_STREAM_INVALID_CODE,
  ingestRefusalDisposition,
} from "./attachment-policy.js";

describe("attachment policy — the two named codes and the shipped allow-list", () => {
  it("keeps the terminal and the transient refusal apart", () => {
    expect(ingestRefusalDisposition(INGEST_STREAM_INVALID_CODE)).toBe("restart");
    expect(ingestRefusalDisposition(INGEST_CAPACITY_EXHAUSTED_CODE)).toBe("wait-and-retry");
  });

  it("negative control: an unrecognised code takes the retry-safe default, not a restart", () => {
    // Collapsing these would tell a participant to re-upload a hundred megabytes
    // because a response was lost, which is the mistake the distinction exists to stop.
    expect(ingestRefusalDisposition("wire-unregistered")).toBe("retry-in-place");
    for (const disposition of INGEST_REFUSAL_DISPOSITIONS) {
      expect(INGEST_DISPOSITION_COPY[disposition].length).toBeGreaterThan(0);
    }
  });

  it("ships the default allow-list without the one image type that is a document", () => {
    expect(ATTACHMENT_ALLOWLIST_DEFAULT).toContain("image/png");
    expect(ATTACHMENT_ALLOWLIST_DEFAULT).not.toContain("image/svg+xml");
  });
});
