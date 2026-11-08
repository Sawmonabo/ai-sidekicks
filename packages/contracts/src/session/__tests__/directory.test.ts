// The session directory: how a reader ages a row's activity, and the rules `session.create` holds a
// new session to (its lead names no account; only a project session is filed in a group).
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  SessionActivitySchema,
  SessionCreateRequestSchema,
  sessionActivityAsOf,
} from "../directory.js";

const PROJECT_ID = "770e8400-e29b-41d4-a716-446655440002";
const GROUP_ID = "aa0e8400-e29b-41d4-a716-446655440005";
const ACCOUNT_ID = "bb0e8400-e29b-41d4-a716-446655440006";
const IDEMPOTENCY_KEY = "0f2b4d5e-9999-4999-8999-999999999999";

// The daemon ages a reading by the same table, so a row reads alike on every screen.
const activityCases = z
  .array(
    z
      .object({
        note: z.string(),
        activity: SessionActivitySchema,
        activityRenewedAt: z.string(),
        nowMs: z.int(),
        expected: SessionActivitySchema,
      })
      .strict(),
  )
  .parse(
    JSON.parse(
      readFileSync(
        new URL(
          "../../../../../crates/sidekicks-contracts/tests/fixtures/session/activity.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  );

describe("reading a row's activity", () => {
  it.each(activityCases)("$note", ({ activity, activityRenewedAt, nowMs, expected }) => {
    expect(sessionActivityAsOf({ activity, activityRenewedAt }, nowMs)).toBe(expected);
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
