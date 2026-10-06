// A bind names its session and place explicitly.
import { describe, expect, it } from "vitest";

import { WorkspaceBindRequestSchema, WorkspaceListResponseSchema } from "../workspace.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const REPO_MOUNT_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f10";
const WORKSPACE_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f11";

// Not the mount's canonical root: a worktree's root lives under the daemon's execution-roots
// directory.
const WORKSPACE_FS_ROOT = "/Users/dev/.ai-sidekicks/execution-roots/wt-0190f8a0";
const WORKSPACE_LAST_ERROR = "fatal: could not create work tree dir: Permission denied";

const buildBindRequest = () => ({
  sessionId: SESSION_ID,
  repoMountId: REPO_MOUNT_ID,
  executionMode: "provisioned-worktree" as const,
  directory: "packages/contracts",
});
const buildWorkspaceListItem = () => ({
  id: WORKSPACE_ID,
  repoMountId: REPO_MOUNT_ID,
  executionMode: "provisioned-worktree" as const,
  state: "ready" as const,
  fsRoot: WORKSPACE_FS_ROOT,
});

const parseBindRequest = (overrides: Record<string, unknown> = {}) =>
  WorkspaceBindRequestSchema.safeParse({ ...buildBindRequest(), ...overrides });
const parseWorkspaceListItem = (overrides: Record<string, unknown> = {}) =>
  WorkspaceListResponseSchema.safeParse({
    workspaces: [{ ...buildWorkspaceListItem(), ...overrides }],
  });

describe("WorkspaceBindRequestSchema (session + mount + explicit mode)", () => {
  // An omitted mode must not stand in for a chosen one, so there is no default.
  it.each(["sessionId", "executionMode"])(
    "rejects a bind request missing the required field %s",
    (field) => {
      const broken = { ...buildBindRequest() } as Record<string, unknown>;
      delete broken[field];
      expect(WorkspaceBindRequestSchema.safeParse(broken).success).toBe(false);
    },
  );

  it("rejects an execution mode outside the two places", () => {
    expect(parseBindRequest({ executionMode: "submodule" }).success).toBe(false);
  });
});

describe("WorkspaceListResponseSchema (health + binding state)", () => {
  it("exposes binding state: `executionMode` from the canonical set plus optional `fsRoot`", () => {
    expect(parseWorkspaceListItem({ executionMode: "bound-root" }).success).toBe(true);
    expect(parseWorkspaceListItem({ executionMode: "submodule" }).success).toBe(false);
    // `fsRoot` is optional because a `preparing` workspace has no execution root yet.
    const preparing = { ...buildWorkspaceListItem() } as Record<string, unknown>;
    delete preparing["fsRoot"];
    preparing["state"] = "preparing";
    expect(WorkspaceListResponseSchema.safeParse({ workspaces: [preparing] }).success).toBe(true);
  });

  it("exposes an optional `lastError`, present or absent independently of `state`", () => {
    // A stale workspace may carry a failure detail or, when its path simply vanished, none.
    expect(
      parseWorkspaceListItem({ state: "stale", lastError: WORKSPACE_LAST_ERROR }).success,
    ).toBe(true);
    expect(parseWorkspaceListItem({ state: "stale" }).success).toBe(true);
  });
});
