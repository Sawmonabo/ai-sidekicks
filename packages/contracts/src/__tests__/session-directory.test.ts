// The session directory's wire shapes: each accepts what the console sends or the daemon
// answers, and refuses the cases the daemon must never act on or emit.
import { describe, expect, it } from "vitest";

import {
  SessionForkResponseSchema,
  SessionListAckSchema,
  SessionListChangeSchema,
  SessionListEntrySchema,
  SessionSetWorkingFolderRequestSchema,
  SessionCreateRequestSchema,
  SessionCreateResponseSchema,
  sessionActivityAsOf,
} from "../session-directory.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const PEER_SESSION_ID = "550e8400-e29b-41d4-a716-446655440009";
const MOUNT_ID = "770e8400-e29b-41d4-a716-446655440002";
const WORKTREE_ID = "880e8400-e29b-41d4-a716-446655440003";
const DEFINITION_ID = "990e8400-e29b-41d4-a716-446655440004";
const SUBSCRIPTION_ID = "aa0e8400-e29b-41d4-a716-446655440005";
const IDEMPOTENCY_KEY = "0f2b4d5e-9999-4999-8999-999999999999";
const AT = "2026-09-24T02:00:00.000Z";

const projectEntry = {
  sessionId: SESSION_ID,
  shape: "project",
  repoMountId: MOUNT_ID,
  branch: "sidekicks/1a2b3c4d/fix-the-login-redirect",
  name: "Fix the login redirect",
  state: "active",
  activity: "waiting",
  pinnedAt: AT,
  muted: true,
  exchange: { peerSessionId: PEER_SESSION_ID, peerName: "builder", messageCount: 14 },
  activityRenewedAt: AT,
  lastActivityAt: AT,
};
const chatEntry = {
  sessionId: SESSION_ID,
  shape: "chat",
  documentCount: 0,
  firstMessagePreview: "what does this stack trace mean",
  state: "archived",
  activity: "done",
  muted: false,
  activityRenewedAt: AT,
  lastActivityAt: AT,
};

describe("session.list entries", () => {
  it("accept a project row and a chat row, each carrying its own place", () => {
    expect(SessionListEntrySchema.safeParse(projectEntry).success).toBe(true);
    expect(SessionListEntrySchema.safeParse(chatEntry).success).toBe(true);
  });

  it("refuse a chat carrying a project's key, and a project without one", () => {
    expect(SessionListEntrySchema.safeParse({ ...chatEntry, repoMountId: MOUNT_ID }).success).toBe(
      false,
    );
    const { repoMountId: _repoMountId, ...projectWithoutMount } = projectEntry;
    expect(SessionListEntrySchema.safeParse(projectWithoutMount).success).toBe(false);
  });

  it("refuse a sixth activity word and a row without its mute", () => {
    expect(SessionListEntrySchema.safeParse({ ...projectEntry, activity: "paused" }).success).toBe(
      false,
    );
    const { muted: _muted, ...withoutMute } = chatEntry;
    expect(SessionListEntrySchema.safeParse(withoutMute).success).toBe(false);
  });

  it("refuse an exchange with no messages traded", () => {
    expect(
      SessionListEntrySchema.safeParse({
        ...projectEntry,
        exchange: { ...projectEntry.exchange, messageCount: 0 },
      }).success,
    ).toBe(false);
  });

  it("carry the whole list on the ack, then one upsert or removal per change", () => {
    expect(
      SessionListAckSchema.safeParse({
        subscriptionId: SUBSCRIPTION_ID,
        sessions: [projectEntry, chatEntry],
      }).success,
    ).toBe(true);
    expect(SessionListChangeSchema.safeParse({ kind: "upsert", entry: chatEntry }).success).toBe(
      true,
    );
    expect(
      SessionListChangeSchema.safeParse({ kind: "remove", sessionId: SESSION_ID }).success,
    ).toBe(true);
    expect(SessionListChangeSchema.safeParse({ kind: "remove", entry: chatEntry }).success).toBe(
      false,
    );
  });
});

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

  it("accepts a chat or a project with its lead's binding", () => {
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
  });

  it("refuses a session with no lead", () => {
    expect(
      SessionCreateRequestSchema.safeParse({
        clientIdempotencyKey: IDEMPOTENCY_KEY,
        binding: { kind: "chat" },
      }).success,
    ).toBe(false);
  });

  it("refuses a project binding with an execution mode outside the two", () => {
    expect(
      SessionCreateRequestSchema.safeParse({
        clientIdempotencyKey: IDEMPOTENCY_KEY,
        binding: { kind: "project", repoMountId: MOUNT_ID, executionMode: "read-only" },
        lead,
      }).success,
    ).toBe(false);
  });

  it("accepts a scratch session led by a definition in a chat", () => {
    expect(
      SessionCreateRequestSchema.safeParse({
        clientIdempotencyKey: IDEMPOTENCY_KEY,
        binding: { kind: "chat" },
        leadDefinitionId: DEFINITION_ID,
        scratch: true,
      }).success,
    ).toBe(true);
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

  it("refuses a request without an idempotency key", () => {
    expect(SessionCreateRequestSchema.safeParse({ binding: { kind: "chat" }, lead }).success).toBe(
      false,
    );
  });

  it("answers with the session's shape, and the resolved configuration when a definition led", () => {
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

describe("session.fork", () => {
  it("names the new worktree on a project fork and none on a chat fork", () => {
    expect(
      SessionForkResponseSchema.safeParse({
        sessionId: SESSION_ID,
        shape: "project",
        worktreeId: WORKTREE_ID,
      }).success,
    ).toBe(true);
    expect(
      SessionForkResponseSchema.safeParse({ sessionId: SESSION_ID, shape: "chat" }).success,
    ).toBe(true);
  });

  it("refuses a project fork without its worktree and a chat fork with one", () => {
    expect(
      SessionForkResponseSchema.safeParse({ sessionId: SESSION_ID, shape: "project" }).success,
    ).toBe(false);
    expect(
      SessionForkResponseSchema.safeParse({
        sessionId: SESSION_ID,
        shape: "chat",
        worktreeId: WORKTREE_ID,
      }).success,
    ).toBe(false);
  });
});

describe("session.setWorkingFolder", () => {
  it("accepts a worktree, and null for the project's checkout, but not an absent target", () => {
    expect(
      SessionSetWorkingFolderRequestSchema.safeParse({
        sessionId: SESSION_ID,
        worktreeId: WORKTREE_ID,
      }).success,
    ).toBe(true);
    expect(
      SessionSetWorkingFolderRequestSchema.safeParse({ sessionId: SESSION_ID, worktreeId: null })
        .success,
    ).toBe(true);
    expect(SessionSetWorkingFolderRequestSchema.safeParse({ sessionId: SESSION_ID }).success).toBe(
      false,
    );
  });
});
