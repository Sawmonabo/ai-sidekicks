// The plan card's cross-field rule: a verdict never mints a session nobody asked for, and a fresh
// session goes only with a handed-off plan.
import { describe, expect, it } from "vitest";

import { PlanResolveRequestSchema, PlanResolveResponseSchema } from "../plan.js";

const FRESH_SESSION_ID = "650e8400-e29b-41d4-a716-446655440000";
const PLAN_ID = "0f2b4d5e-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("PlanResolveRequestSchema", () => {
  it("accepts each verdict, with the session to mint on a fresh one", () => {
    expect(PlanResolveRequestSchema.safeParse({ planId: PLAN_ID, verdict: "keep" }).success).toBe(
      true,
    );
    expect(PlanResolveRequestSchema.safeParse({ planId: PLAN_ID, verdict: "build" }).success).toBe(
      true,
    );
    expect(
      PlanResolveRequestSchema.safeParse({
        planId: PLAN_ID,
        verdict: "fresh",
        fresh: { driverName: "codex", level: "ask" },
      }).success,
    ).toBe(true);
  });

  it("refuses a fresh verdict with no session, and a session on another verdict", () => {
    expect(PlanResolveRequestSchema.safeParse({ planId: PLAN_ID, verdict: "fresh" }).success).toBe(
      false,
    );
    expect(
      PlanResolveRequestSchema.safeParse({
        planId: PLAN_ID,
        verdict: "build",
        fresh: { driverName: "codex", level: "ask" },
      }).success,
    ).toBe(false);
  });
});

describe("PlanResolveResponseSchema", () => {
  it("accepts a handed-off plan naming its fresh session, and a kept plan left open", () => {
    expect(
      PlanResolveResponseSchema.safeParse({
        planId: PLAN_ID,
        state: "handed_off",
        freshSessionId: FRESH_SESSION_ID,
      }).success,
    ).toBe(true);
    expect(PlanResolveResponseSchema.safeParse({ planId: PLAN_ID, state: "open" }).success).toBe(
      true,
    );
  });

  it("ties a fresh session to a handed-off plan and to no accepted plan", () => {
    expect(
      PlanResolveResponseSchema.safeParse({ planId: PLAN_ID, state: "handed_off" }).success,
    ).toBe(false);
    expect(
      PlanResolveResponseSchema.safeParse({
        planId: PLAN_ID,
        state: "accepted",
        freshSessionId: FRESH_SESSION_ID,
      }).success,
    ).toBe(false);
  });
});
