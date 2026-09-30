// A bind names its session and one of the two places explicitly, and a list item exposes the
// workspace's state, its root once it has one, and its last error when one was recorded. The
// execution-mode capabilities read names exactly one scope: a mount (what a workspace there could
// do) or a workspace (what it may do now). With both, a handler picking one would answer a
// pre-bind question with the narrower per-workspace answer.
import { describe, expect, it } from "vitest";

import {
  WorkspaceBindRequestSchema,
  WorkspaceExecutionModeCapabilitiesReadRequestSchema,
  WorkspaceListResponseSchema,
} from "../workspace.js";

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

  it.each([
    ["bound-root", true],
    ["provisioned-worktree", true],
    ["submodule", false],
    ["", false],
  ])("executionMode %s -> %s, driven through the composed request", (executionMode, shouldPass) => {
    expect(parseBindRequest({ executionMode }).success).toBe(shouldPass);
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

const parseCapabilitiesRequest = (request: Record<string, unknown>) =>
  WorkspaceExecutionModeCapabilitiesReadRequestSchema.safeParse(request);

describe("WorkspaceExecutionModeCapabilitiesReadRequestSchema (exactly-one scope refinement)", () => {
  it("accepts a MOUNT-scoped read — what could a workspace on this mount do", () => {
    expect(parseCapabilitiesRequest({ repoMountId: REPO_MOUNT_ID }).success).toBe(true);
  });

  it("REJECTS a request supplying both `repoMountId` and `workspaceId`", () => {
    const result = parseCapabilitiesRequest({
      repoMountId: REPO_MOUNT_ID,
      workspaceId: WORKSPACE_ID,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // Both ids are well formed because Zod skips refinements on an aborted payload: a malformed
      // id would fail on its own error first.
      const messages = result.error.issues.map((issue) => issue.message);
      expect(messages.join("\n")).toContain("MUST carry exactly one of");
    }
  });

  it("REJECTS a request supplying neither id", () => {
    expect(parseCapabilitiesRequest({}).success).toBe(false);
  });

  it("treats an explicit `undefined` as absence, not as presence", () => {
    // JSON cannot carry `undefined`, so the predicate counts defined values; a key-presence test
    // would invert both rows.
    expect(
      parseCapabilitiesRequest({ repoMountId: REPO_MOUNT_ID, workspaceId: undefined }).success,
    ).toBe(true);
    expect(
      parseCapabilitiesRequest({ repoMountId: undefined, workspaceId: undefined }).success,
    ).toBe(false);
  });
});
