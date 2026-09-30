// A retention update sets one bound at a time and deletes nothing; the purge
// takes the cutoff its confirm was read against, so it removes exactly what
// the confirm counted.
import { describe, expect, it } from "vitest";

import {
  DaemonRetentionPurgeRequestSchema,
  DaemonRetentionReadResponseSchema,
  DaemonRetentionUpdateRequestSchema,
} from "../daemon-retention.js";

describe("daemon.retentionRead", () => {
  it("accepts the three bounds and the purge's count", () => {
    expect(
      DaemonRetentionReadResponseSchema.safeParse({
        keepDiagnosticLogsDays: 7,
        keepSessionsDays: 90,
        keepRunDataDays: 30,
        purge: { archivedSessionCount: 14, cutoffAt: "2026-07-01T00:00:00.000Z" },
      }).success,
    ).toBe(true);
  });

  it("refuses a reply without the purge's count", () => {
    expect(
      DaemonRetentionReadResponseSchema.safeParse({
        keepDiagnosticLogsDays: 7,
        keepSessionsDays: 90,
        keepRunDataDays: 30,
      }).success,
    ).toBe(false);
  });
});

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

describe("daemon.retentionPurge", () => {
  it("requires the cutoff as a timestamp", () => {
    expect(
      DaemonRetentionPurgeRequestSchema.safeParse({ cutoffAt: "2026-07-01T00:00:00.000Z" }).success,
    ).toBe(true);
    expect(DaemonRetentionPurgeRequestSchema.safeParse({}).success).toBe(false);
    expect(DaemonRetentionPurgeRequestSchema.safeParse({ cutoffAt: "last week" }).success).toBe(
      false,
    );
  });
});
