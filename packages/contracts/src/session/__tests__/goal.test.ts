// A goal update names the agent it is for and carries text that is neither empty, blank,
// over-long nor NUL-bearing. A `session.goal_updated` payload carries the judge's reason exactly
// when the goal is impossible, so a surface never shows a verdict without its reason or a stale
// reason beside another status.
import { describe, expect, it } from "vitest";

import { SessionGoalUpdateRequestSchema, SessionGoalUpdatedPayloadSchema } from "../goal.js";
import { AGENT_ID, GOAL_UPDATED_PAYLOAD_BASE, SESSION_ID } from "./goal.test-support.js";

const goalUpdate = (text: string) => ({
  sessionId: SESSION_ID,
  agentId: AGENT_ID,
  goal: { text },
});

describe("session.goalUpdate request", () => {
  it("refuses empty, blank and NUL-bearing text", () => {
    for (const text of ["", "   ", "ship\u0000it"]) {
      expect(SessionGoalUpdateRequestSchema.safeParse(goalUpdate(text)).success).toBe(false);
    }
  });

  it("refuses an update with no target agent", () => {
    expect(
      SessionGoalUpdateRequestSchema.safeParse({ sessionId: SESSION_ID, goal: { text: "x" } })
        .success,
    ).toBe(false);
  });
});

describe("session.goal_updated payload", () => {
  const updated = GOAL_UPDATED_PAYLOAD_BASE;

  it("accepts a status with no reason, and impossible with the judge's reason", () => {
    expect(
      SessionGoalUpdatedPayloadSchema.safeParse({ ...updated, status: "usage-limited" }).success,
    ).toBe(true);
    expect(
      SessionGoalUpdatedPayloadSchema.safeParse({
        ...updated,
        status: "impossible",
        reason: "The repository has no test suite to make pass.",
      }).success,
    ).toBe(true);
  });

  it("refuses impossible without a reason, and a reason on any other status", () => {
    expect(
      SessionGoalUpdatedPayloadSchema.safeParse({ ...updated, status: "impossible" }).success,
    ).toBe(false);
    expect(
      SessionGoalUpdatedPayloadSchema.safeParse({ ...updated, status: "blocked", reason: "x" })
        .success,
    ).toBe(false);
  });
});
