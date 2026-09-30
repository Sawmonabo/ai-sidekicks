// The session directory: how a reader ages a row's activity, the rules `session.create` holds a
// new session to (born with its lead; a scratch session is a definition's, in a chat), and its
// reply, which echoes the configuration resolved from a definition.
import { describe, expect, it } from "vitest";

import {
  SessionCreateRequestSchema,
  SessionCreateResponseSchema,
  sessionActivityAsOf,
} from "../session-directory.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const MOUNT_ID = "770e8400-e29b-41d4-a716-446655440002";
const DEFINITION_ID = "990e8400-e29b-41d4-a716-446655440004";
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
  const lead = {
    driverName: "claude",
    modelId: "claude-opus-4-5",
    providerAccountId: null,
    effort: "high",
  };

  it("accepts a lead in a chat or a project, and a definition's scratch chat", () => {
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
        binding: { kind: "project", repoMountId: MOUNT_ID, executionMode: "bound-root" },
        lead,
      }).success,
    ).toBe(true);
    expect(
      SessionCreateRequestSchema.safeParse({
        clientIdempotencyKey: IDEMPOTENCY_KEY,
        binding: { kind: "chat" },
        leadDefinitionId: DEFINITION_ID,
        scratch: true,
      }).success,
    ).toBe(true);
  });

  it("refuses a session with no lead", () => {
    expect(
      SessionCreateRequestSchema.safeParse({
        clientIdempotencyKey: IDEMPOTENCY_KEY,
        binding: { kind: "chat" },
      }).success,
    ).toBe(false);
  });

  it("refuses a scratch session with no definition, or with a repo", () => {
    expect(
      SessionCreateRequestSchema.safeParse({
        clientIdempotencyKey: IDEMPOTENCY_KEY,
        binding: { kind: "chat" },
        lead,
        scratch: true,
      }).success,
    ).toBe(false);
    expect(
      SessionCreateRequestSchema.safeParse({
        clientIdempotencyKey: IDEMPOTENCY_KEY,
        binding: { kind: "project", repoMountId: MOUNT_ID, executionMode: "provisioned-worktree" },
        leadDefinitionId: DEFINITION_ID,
        scratch: true,
      }).success,
    ).toBe(false);
  });

  it("answers with the session's shape, and the configuration its definition resolved", () => {
    expect(
      SessionCreateResponseSchema.safeParse({
        sessionId: SESSION_ID,
        shape: "chat",
        state: "provisioning",
        resolvedConfiguration: {
          resolvedFromDefinitionId: DEFINITION_ID,
          resolvedBinding: lead,
          executionPostureMode: null,
          toolAllowlist: null,
          instructions: "Review the diff.",
          goal: null,
        },
      }).success,
    ).toBe(true);
    expect(
      SessionCreateResponseSchema.safeParse({ sessionId: SESSION_ID, state: "provisioning" })
        .success,
    ).toBe(false);
  });
});
