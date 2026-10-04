// Each machine-wide setting is changed one per press: an update carries exactly one setting, and
// never a fact the service reports.
import { describe, expect, it } from "vitest";

import { DaemonConfigUpdateRequestSchema } from "../daemon-config.js";

describe("daemon.configUpdate", () => {
  it("accepts one setting, a step or its null", () => {
    expect(DaemonConfigUpdateRequestSchema.safeParse({ runTimeLimitMinutes: 240 }).success).toBe(
      true,
    );
    expect(
      DaemonConfigUpdateRequestSchema.safeParse({ workflowChainAskAfterRuns: null }).success,
    ).toBe(true);
  });

  it("refuses no setting, two, or a fact the service reports", () => {
    expect(DaemonConfigUpdateRequestSchema.safeParse({}).success).toBe(false);
    expect(
      DaemonConfigUpdateRequestSchema.safeParse({
        recordTraces: true,
        recordProviderMessages: true,
      }).success,
    ).toBe(false);
    expect(
      DaemonConfigUpdateRequestSchema.safeParse({ toolMemoryCapEnforceable: false }).success,
    ).toBe(false);
  });
});
