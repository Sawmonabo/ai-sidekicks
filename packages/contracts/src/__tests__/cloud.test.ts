// A cloud task shows only what its provider reported: Codex's four states, and
// Claude Code's one. These cases hand the task shape a state its provider never
// reports, an error with no message and a message with no error, and hold sending
// and bringing back to Codex's own bound on attempts. Each block also parses the
// real shapes, so a refusal cannot pass against a schema that refuses everything.
import { describe, expect, it } from "vitest";

import {
  CloudTaskApplyResponseSchema,
  CloudTaskSchema,
  CloudTaskStartRequestSchema,
} from "../cloud.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

const CODEX_TASK = {
  taskId: "task_e_68d1f0c2",
  sessionId: SESSION_ID,
  provider: "codex",
  environment: "ai-sidekicks",
  attempts: 2,
  bringBack: null,
  state: "ready",
};

const CLAUDE_TASK = {
  taskId: "session_01ABCDEF",
  sessionId: SESSION_ID,
  provider: "claude",
  state: "submitted",
  url: "https://claude.ai/code/session_01ABCDEF",
};

describe("CloudTaskSchema", () => {
  it("accepts each Codex state, a Codex error with its message, and a Claude Code task", () => {
    for (const state of ["pending", "ready", "applied"]) {
      expect(CloudTaskSchema.safeParse({ ...CODEX_TASK, state }).success).toBe(true);
    }
    const failed = { ...CODEX_TASK, state: "error", errorMessage: "Environment not found" };
    expect(CloudTaskSchema.safeParse(failed).success).toBe(true);
    expect(CloudTaskSchema.safeParse(CLAUDE_TASK).success).toBe(true);
  });

  it("refuses a Claude Code task in any state but submitted, which is all its command line reports", () => {
    for (const state of ["pending", "ready", "applied", "error", "running"]) {
      expect(CloudTaskSchema.safeParse({ ...CLAUDE_TASK, state }).success).toBe(false);
    }
  });

  it("refuses a Codex task that reads submitted, or a state Codex never reports", () => {
    for (const state of ["submitted", "running", "finished"]) {
      expect(CloudTaskSchema.safeParse({ ...CODEX_TASK, state }).success).toBe(false);
    }
  });

  it("refuses a Codex error without Codex's message, and a message on a task that did not fail", () => {
    expect(CloudTaskSchema.safeParse({ ...CODEX_TASK, state: "error" }).success).toBe(false);
    const readyWithMessage = { ...CODEX_TASK, errorMessage: "Environment not found" };
    expect(CloudTaskSchema.safeParse(readyWithMessage).success).toBe(false);
  });

  it("refuses a Claude Code address that is not https", () => {
    const plain = { ...CLAUDE_TASK, url: "http://claude.ai/code/session_01ABCDEF" };
    expect(CloudTaskSchema.safeParse(plain).success).toBe(false);
  });
});

describe("CloudTaskStartRequestSchema", () => {
  const request = { sessionId: SESSION_ID, prompt: "Fix the flaky login test" };

  it("accepts a send with and without Codex's environment and attempts", () => {
    expect(CloudTaskStartRequestSchema.safeParse(request).success).toBe(true);
    const codex = { ...request, environment: "ai-sidekicks", attempts: 4 };
    expect(CloudTaskStartRequestSchema.safeParse(codex).success).toBe(true);
  });

  it("refuses attempts outside Codex's 1 to 4", () => {
    for (const attempts of [0, 5, 1.5]) {
      expect(CloudTaskStartRequestSchema.safeParse({ ...request, attempts }).success).toBe(false);
    }
  });

  it("refuses a blank prompt", () => {
    expect(CloudTaskStartRequestSchema.safeParse({ ...request, prompt: "  " }).success).toBe(false);
  });
});

describe("CloudTaskApplyResponseSchema", () => {
  it("accepts a partial Codex bring-back with its paths, and a Claude Code bring-back's new session", () => {
    const partial = {
      provider: "codex",
      bringBack: { outcome: "partial", skippedPaths: ["a.ts"], conflictingPaths: ["b.ts"] },
    };
    expect(CloudTaskApplyResponseSchema.safeParse(partial).success).toBe(true);
    const claude = { provider: "claude", sessionId: SESSION_ID };
    expect(CloudTaskApplyResponseSchema.safeParse(claude).success).toBe(true);
  });

  it("refuses a partial bring-back that does not list its paths", () => {
    const partial = { provider: "codex", bringBack: { outcome: "partial" } };
    expect(CloudTaskApplyResponseSchema.safeParse(partial).success).toBe(false);
  });
});
