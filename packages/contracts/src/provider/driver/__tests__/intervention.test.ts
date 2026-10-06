// An intervention's result, which crosses a trust boundary, never contradicts itself.
import { describe, expect, it } from "vitest";

import { DriverInterventionResultSchema, type DriverInterventionResult } from "../intervention.js";

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
