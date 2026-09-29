// The goal's wire contract: what a goal update and clear accept, and which goal
// events parse. The daemon validates requests and its own emissions against these
// schemas, so each refusal here is one the daemon makes.
import { describe, expect, it } from "vitest";

import {
  SESSION_GOAL_MAX_LENGTH,
  SessionGoalClearRequestSchema,
  SessionGoalClearedPayloadSchema,
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
  it("accepts a goal sent to one agent, up to the length bound", () => {
    expect(SessionGoalUpdateRequestSchema.safeParse(goalUpdate("Ship the inspector")).success).toBe(
      true,
    );
    expect(
      SessionGoalUpdateRequestSchema.safeParse(goalUpdate("g".repeat(SESSION_GOAL_MAX_LENGTH)))
        .success,
    ).toBe(true);
  });

  it("keeps the text as typed rather than trimming it", () => {
    const parsed = SessionGoalUpdateRequestSchema.parse(goalUpdate("  ship it  "));
    expect(parsed.goal.text).toBe("  ship it  ");
  });

  it("refuses empty, blank, over-long and NUL-bearing text", () => {
    for (const text of ["", "   ", "g".repeat(SESSION_GOAL_MAX_LENGTH + 1), "ship\u0000it"]) {
      expect(SessionGoalUpdateRequestSchema.safeParse(goalUpdate(text)).success).toBe(false);
    }
  });

  it("refuses an update with no target agent or with an extra member", () => {
    expect(
      SessionGoalUpdateRequestSchema.safeParse({ sessionId: SESSION_ID, goal: { text: "x" } })
        .success,
    ).toBe(false);
    expect(
      SessionGoalUpdateRequestSchema.safeParse({ ...goalUpdate("x"), status: "active" }).success,
    ).toBe(false);
  });
});

describe("session.goalClear request", () => {
  it("accepts a clear addressed to one agent and refuses one carrying a goal", () => {
    expect(
      SessionGoalClearRequestSchema.safeParse({ sessionId: SESSION_ID, agentId: AGENT_ID }).success,
    ).toBe(true);
    expect(SessionGoalClearRequestSchema.safeParse(goalUpdate("x")).success).toBe(false);
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

  it("refuses clearing as a status: a clear is its own event", () => {
    expect(
      SessionGoalUpdatedPayloadSchema.safeParse({ ...updated, status: "cleared" }).success,
    ).toBe(false);
  });
});

describe("session.goal_cleared payload", () => {
  it("names the agent whose goal was removed and carries no goal", () => {
    expect(
      SessionGoalClearedPayloadSchema.safeParse({ sessionId: SESSION_ID, agentId: AGENT_ID })
        .success,
    ).toBe(true);
    expect(
      SessionGoalClearedPayloadSchema.safeParse({
        sessionId: SESSION_ID,
        agentId: AGENT_ID,
        goal: { text: "x" },
      }).success,
    ).toBe(false);
  });
});
