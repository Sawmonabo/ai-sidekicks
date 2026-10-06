// An intervention's artifact ids are UUIDs, and its result, which crosses a trust boundary, never
// contradicts itself.
import { describe, expect, it } from "vitest";

import {
  ArtifactIdSchema,
  DriverInterventionResultSchema,
  type DriverInterventionResult,
} from "../intervention.js";

const AN_ARTIFACT_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3302";

describe("DriverInterventionResultSchema — intervention result envelope (trust boundary)", () => {
  it("parses a `degraded` result carrying the text-neutralization refusal code", () => {
    const parsed: DriverInterventionResult = DriverInterventionResultSchema.parse({
      status: "degraded",
      refusalCode: "driver.text_neutralization_failed",
    });
    expect(parsed.refusalCode).toBe("driver.text_neutralization_failed");
    // No fallbackAction: a refusal names no alternative the caller could take.
    expect(parsed.fallbackAction).toBeUndefined();
  });

  it("rejects the refusal code beside status 'applied' (cross-field contradiction)", () => {
    // The code says the user's text was swallowed, which `applied` denies; accepted, the two
    // fields would disagree.
    const result = DriverInterventionResultSchema.safeParse({
      status: "applied",
      refusalCode: "driver.text_neutralization_failed",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("refusalCode");
    }
  });
});

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
