// A goal update names the agent it is for and carries text that is neither empty, blank,
// over-long nor NUL-bearing. A `session.goal_updated` payload carries the judge's reason exactly
// when the goal is impossible, so a surface never shows a verdict without its reason or a stale
// reason beside another status.
import { describe, expect, it } from "vitest";

import {
  SessionGoalUpdateRequestSchema,
  SessionGoalUpdatedPayloadSchema,
} from "../session-goal.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const AGENT_ID = "0190a2b4-7c3d-7e5f-8a1b-2c3d4e5f6a7b";

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
  const updated = { sessionId: SESSION_ID, agentId: AGENT_ID, goal: { text: "Ship it" } };

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
