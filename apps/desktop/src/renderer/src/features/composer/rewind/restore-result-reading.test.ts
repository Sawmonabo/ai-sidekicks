// The reading is a pure function over the registered result union, so every arm is
// drivable here without a bridge and without a rendered tree.

import { describe, expect, it } from "vitest";
import type { RollbackAppliedResult, RollbackDegradedResult } from "@ai-sidekicks/contracts";

import {
  readAppliedRestore,
  readPartialRestore,
  resendSettlementSentence,
} from "./restore-result-reading.js";

/** Every `applied` arm the contract admits. */
const APPLIED_ARMS: readonly RollbackAppliedResult[] = [
  { disposition: "files-restored" },
  { disposition: "conversation-only" },
];

/** Every `degraded` arm the contract admits. */
const DEGRADED_ARMS: readonly RollbackDegradedResult[] = [
  { disposition: "nothing-applied" },
  { disposition: "resend-unapplied", resendDisposition: "unapplied" },
];

describe("the two settlement classes", () => {
  it("covers every disposition across the two classes", () => {
    // Vacuity guard: every case below iterates one of these two lists.
    expect(APPLIED_ARMS).toHaveLength(2);
    expect(DEGRADED_ARMS).toHaveLength(2);
  });

  it("reads every applied arm as applied and every degraded arm as degraded", () => {
    for (const arm of APPLIED_ARMS) {
      expect(readAppliedRestore(arm).settlementClass).toBe("applied");
    }
    for (const arm of DEGRADED_ARMS) {
      expect(readPartialRestore(arm).settlementClass).toBe("degraded");
    }
  });

  it("renders the disposition verbatim, never a reworded one", () => {
    for (const arm of APPLIED_ARMS) {
      expect(readAppliedRestore(arm).disposition).toBe(arm.disposition);
    }
    for (const arm of DEGRADED_ARMS) {
      expect(readPartialRestore(arm).disposition).toBe(arm.disposition);
    }
  });

  it("negative control: a degraded arm is never reported as a success", () => {
    for (const arm of DEGRADED_ARMS) {
      expect(readPartialRestore(arm).settlementClass).not.toBe("applied");
    }
  });
});

describe("the replacement leg", () => {
  it("says an unapplied replacement stays recoverable", () => {
    expect(resendSettlementSentence("resend-unapplied")).toContain("recoverable");
  });

  it("negative control: any other disposition carries no replacement sentence", () => {
    for (const arm of [...APPLIED_ARMS, ...DEGRADED_ARMS]) {
      if (arm.disposition !== "resend-unapplied") {
        expect(resendSettlementSentence(arm.disposition)).toBeUndefined();
      }
    }
  });
});
