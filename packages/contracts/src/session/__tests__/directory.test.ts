// The session directory: how a reader ages a row's activity, and the rules `session.create` holds a
// new session to (its lead names no account; only a project session is filed in a group).
import { describe, expect, it } from "vitest";

import { SessionCreateRequestSchema, sessionActivityAsOf } from "../directory.js";

const PROJECT_ID = "770e8400-e29b-41d4-a716-446655440002";
const GROUP_ID = "aa0e8400-e29b-41d4-a716-446655440005";
const ACCOUNT_ID = "bb0e8400-e29b-41d4-a716-446655440006";
const IDEMPOTENCY_KEY = "0f2b4d5e-9999-4999-8999-999999999999";
const AT = "2026-09-24T02:00:00.000Z";

describe("reading a row's activity", () => {
  const renewedAt = Date.parse(AT);

  it("believes a running or waiting reading for 45 seconds, then reads it as idle", () => {
    for (const activity of ["running", "waiting"] as const) {
      const entry = { activity, activityRenewedAt: AT };
      expect(sessionActivityAsOf(entry, renewedAt + 45_000)).toBe(activity);
      expect(sessionActivityAsOf(entry, renewedAt + 45_001)).toBe("idle");
    }
  });

  it("never ages a failed session", () => {
    expect(
      sessionActivityAsOf({ activity: "failed", activityRenewedAt: AT }, renewedAt + 3_600_000),
    ).toBe("failed");
  });
});

describe("session.create", () => {
  const lead = { driverName: "claude", modelId: "claude-opus-4-5", effort: "high" };
  const resolvedLead = { ...lead, providerAccountId: ACCOUNT_ID };

  it("accepts a lead in a chat or a project", () => {
    expect(
      SessionCreateRequestSchema.safeParse({
        clientIdempotencyKey: IDEMPOTENCY_KEY,
        binding: { kind: "chat" },
        lead,
      }).success,
    ).toBe(true);
    expect(
      SessionCreateRequestSchema.safeParse({
        clientIdempotencyKey: IDEMPOTENCY_KEY,
        binding: { kind: "project", projectId: PROJECT_ID, executionMode: "bound-root" },
        lead,
      }).success,
    ).toBe(true);
  });

  it("refuses a lead that names an account, which the daemon resolves", () => {
    expect(
      SessionCreateRequestSchema.safeParse({
        clientIdempotencyKey: IDEMPOTENCY_KEY,
        binding: { kind: "chat" },
        lead: resolvedLead,
      }).success,
    ).toBe(false);
  });

  it("files a project session in a group, and refuses a chat in one", () => {
    expect(
      SessionCreateRequestSchema.safeParse({
        clientIdempotencyKey: IDEMPOTENCY_KEY,
        binding: { kind: "project", projectId: PROJECT_ID, executionMode: "bound-root" },
        lead,
        groupId: GROUP_ID,
      }).success,
    ).toBe(true);
    expect(
      SessionCreateRequestSchema.safeParse({
        clientIdempotencyKey: IDEMPOTENCY_KEY,
        binding: { kind: "chat" },
        lead,
        groupId: GROUP_ID,
      }).success,
    ).toBe(false);
  });
});
