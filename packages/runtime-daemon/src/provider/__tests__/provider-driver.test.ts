// Guards on the daemon's provider-driver seam that a driver could otherwise break: a failed resume
// carries no binding, the recovery condition is a closed vocabulary, the usage-limit cause is a
// separate axis, the daemon stamps an MCP status's leg, and a websocket transport is
// authenticated. Runtime guards are proven by `.safeParse()`; type guards by `@ts-expect-error`,
// which fails as unused (TS2578) if the guarded shape loosens.
import { DRIVER_CAPABILITY_FLAGS, type RecoveryCondition } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import {
  DriverResumeResultSchema,
  McpServerStatusEmissionSchema,
  type DriverResumeResult,
  type DriverTransportConfig,
  type ProviderUsageLimitSignal,
} from "../provider-driver.js";

type ProviderUsageLimitCause = ProviderUsageLimitSignal["cause"];

// `DriverResumeResult` is a `status`-discriminated union. `failed` carries the recovery condition,
// span classification and failure detail but no `bindingId` or `sessionPosition`; `resumed`
// carries those two and neither failure axis. A failed resume must surface the failure, never
// quietly create a replacement session under the same run.
describe("DriverResumeResult: a failed resume cannot carry a binding", () => {
  it("rejects silent replacement — a `failed` object carrying a bindingId", () => {
    const result = DriverResumeResultSchema.safeParse({
      status: "failed",
      recoveryCondition: "recovery-needed",
      recoverySpanClassification: "irreversible",
      providerFailureDetail: "provider session expired",
      bindingId: "binding-smuggled",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // A `.strict()` rejection is an `unrecognized_keys` issue at the object root with the
      // offending names on `issue.keys`, which pins the cause to the smuggled `bindingId`.
      const unrecognizedKeyIssue = result.error.issues.find(
        (issue) => issue.code === "unrecognized_keys",
      );
      expect(unrecognizedKeyIssue).toBeDefined();
      expect((unrecognizedKeyIssue as { keys?: readonly string[] })?.keys).toContain("bindingId");
    }
  });

  it("forbids accessing `.bindingId` after narrowing to status:'failed' (compile-time)", () => {
    // Parsed through the schema so the static type is the full union; the `@ts-expect-error`
    // lines are then checked against the narrowed `failed` variant.
    const resume: DriverResumeResult = DriverResumeResultSchema.parse({
      status: "failed",
      recoveryCondition: "recovery-needed",
      recoverySpanClassification: "irreversible",
      providerFailureDetail: "provider endpoint returned 410 Gone",
    });

    if (resume.status === "failed") {
      expect(resume.recoveryCondition).toBe("recovery-needed");
      expect(resume.recoverySpanClassification).toBe("irreversible");
      expect(resume.providerFailureDetail).toBe("provider endpoint returned 410 Gone");

      // @ts-expect-error bindingId does not exist on the failed variant
      const leakedBinding = resume.bindingId;
      // A failed resume confirms no position for the daemon to compare.
      // @ts-expect-error sessionPosition does not exist on the failed variant
      const leakedPosition = resume.sessionPosition;
      expect(leakedBinding).toBeUndefined();
      expect(leakedPosition).toBeUndefined();
    } else {
      throw new Error(`expected the failed variant, got status=${resume.status}`);
    }
  });
});

describe("DriverResumeResultSchema — the recovery condition is a closed vocabulary", () => {
  it.each(["recovery-needed", "reauth-required"] as const)(
    "accepts the %s condition on the failed variant",
    (recoveryCondition) => {
      const parsed: DriverResumeResult = DriverResumeResultSchema.parse({
        status: "failed",
        recoveryCondition,
        recoverySpanClassification: "unclassifiable",
        providerFailureDetail: "provider credential expired",
      });
      if (parsed.status === "failed") {
        expect(parsed.recoveryCondition).toBe(recoveryCondition);
      } else {
        throw new Error(`expected the failed variant, got status=${parsed.status}`);
      }
    },
  );

  it("rejects a `failed` object whose recoveryCondition is not a RecoveryCondition member", () => {
    const result = DriverResumeResultSchema.safeParse({
      status: "failed",
      recoveryCondition: "all-good",
      recoverySpanClassification: "irreversible",
      providerFailureDetail: "provider session expired",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // The defect is an off-union value, not a missing field, so assert the issue's path.
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("recoveryCondition");
    }
  });
});

describe("ProviderUsageLimitSignal — a sibling axis, never a RecoveryCondition member", () => {
  it("keeps the two cause vocabularies mutually unassignable in BOTH directions", () => {
    // These lines break the build if either union grows into the other, which would route a
    // self-clearing pause into the queue that waits on the person. A one-way check would pass if
    // `RecoveryCondition` were widened to contain the cause.
    // @ts-expect-error — a usage-limit cause is not a recovery condition.
    const conditionFromCause: RecoveryCondition = "plan-allowance-exhausted";
    // @ts-expect-error — a recovery condition is not a usage-limit cause.
    const causeFromCondition: ProviderUsageLimitCause = "reauth-required";
    void conditionFromCause;
    void causeFromCondition;

    // The value sets are disjoint too, so a consumer switching on one can never fall into the
    // other's arm.
    const recoveryConditions: readonly RecoveryCondition[] = ["recovery-needed", "reauth-required"];
    const usageLimitCauses: readonly ProviderUsageLimitCause[] = ["plan-allowance-exhausted"];
    for (const cause of usageLimitCauses) {
      expect(recoveryConditions).not.toContain(cause as string);
    }
  });

  it("adds no capability flag for it — recognizing a usage limit is every driver's duty", () => {
    // A flag would let a driver declare the obligation away, leaving a run refused for spend in
    // the generic failure path with nothing saying why.
    expect(DRIVER_CAPABILITY_FLAGS).toHaveLength(15);
    for (const flag of DRIVER_CAPABILITY_FLAGS) {
      expect(flag).not.toMatch(/usage|limit|rate/);
    }
  });
});

describe("McpServerStatusEmissionSchema — MCP status producer seam", () => {
  it("rejects a driver-supplied leg identity — the daemon stamps it", () => {
    // A driver that attributes its emission to another leg is rejected outright, not stripped.
    const result = McpServerStatusEmissionSchema.safeParse({
      serverName: "filesystem",
      status: "connected",
      bindingId: "binding-of-another-leg",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const unrecognizedKeyIssue = result.error.issues.find(
        (issue) => issue.code === "unrecognized_keys",
      );
      expect((unrecognizedKeyIssue as { keys?: readonly string[] })?.keys).toContain("bindingId");
    }
  });
});

describe("DriverTransportConfig — the websocket arm is authenticated", () => {
  it("forbids an unauthenticated websocket DriverTransportConfig", () => {
    const stdio: DriverTransportConfig = { transport: "stdio" };
    expect(stdio.transport).toBe("stdio");
    // @ts-expect-error the websocket arm requires a bearerTokenRef
    const unauthenticated: DriverTransportConfig = {
      transport: "websocket",
      endpoint: "ws://127.0.0.1:7000",
    };
    void unauthenticated;
  });
});
