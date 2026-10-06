// An artifact id is a UUID, because it reaches an artifact manifest lookup.
import { describe, expect, it } from "vitest";

import { ArtifactIdSchema } from "../id.js";

const AN_ARTIFACT_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3302";

describe("ArtifactIdSchema — the attachment element brand", () => {
  it("accepts a UUID and brands it", () => {
    expect(ArtifactIdSchema.parse(AN_ARTIFACT_ID)).toBe(AN_ARTIFACT_ID);
  });

  it("REFUSES a non-UUID artifact id", () => {
    // The value reaches an artifact manifest lookup, so a path or store-key fragment must not
    // arrive as one.
    expect(ArtifactIdSchema.safeParse("../../etc/passwd").success).toBe(false);
    expect(ArtifactIdSchema.safeParse("artifact-1").success).toBe(false);
    expect(ArtifactIdSchema.safeParse("").success).toBe(false);
  });
});
