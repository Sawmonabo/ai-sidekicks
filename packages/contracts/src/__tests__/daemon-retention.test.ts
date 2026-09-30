// A retention update sets exactly one bound at a time.
import { describe, expect, it } from "vitest";

import { DaemonRetentionUpdateRequestSchema } from "../daemon-retention.js";

describe("daemon.retentionUpdate", () => {
  it("accepts one bound, logs above thirty days included", () => {
    expect(
      DaemonRetentionUpdateRequestSchema.safeParse({ keepDiagnosticLogsDays: 45 }).success,
    ).toBe(true);
  });

  it("refuses no bound, two bounds, or a bound that is not a whole day count", () => {
    expect(DaemonRetentionUpdateRequestSchema.safeParse({}).success).toBe(false);
    expect(
      DaemonRetentionUpdateRequestSchema.safeParse({ keepSessionsDays: 90, keepRunDataDays: 30 })
        .success,
    ).toBe(false);
    expect(DaemonRetentionUpdateRequestSchema.safeParse({ keepRunDataDays: 0 }).success).toBe(
      false,
    );
    expect(DaemonRetentionUpdateRequestSchema.safeParse({ keepRunDataDays: 1.5 }).success).toBe(
      false,
    );
  });
});
