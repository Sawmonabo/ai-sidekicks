// A completed ingest answers what the daemon derived from the bytes, which is what a caller
// records in place of what it declared.
import { describe, expect, it } from "vitest";

import { AttachmentIngestCompleteResponseSchema } from "../ingest.js";

describe("AttachmentIngestCompleteResponseSchema", () => {
  it("parses the derived facts member for member", () => {
    const reply = {
      artifactId: "0f2b4d5e-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      contentHash: "sha256:2b4c",
      normalizedName: "notes.md",
      derivedMediaType: "text/markdown",
      derivedSizeBytes: 300,
    };
    expect(AttachmentIngestCompleteResponseSchema.parse(reply)).toStrictEqual(reply);
  });
});
