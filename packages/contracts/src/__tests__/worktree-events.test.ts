// The worktree records beyond the family payload, the swept-session record and the
// branch-change record.
import { describe, expect, it } from "vitest";

import {
  SessionBranchChangedPayloadSchema,
  SessionSweptToRepoRootPayloadSchema,
  WorktreeCreatedPayloadSchema,
  WorktreeRetiredPayloadSchema,
} from "../worktree-events.js";
import type { WorktreeLifecyclePayload, WorktreeState } from "../worktree.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const REPO_MOUNT_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f10";
const WORKTREE_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f12";
const REMOVED_WORKTREE_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f22";

const buildWorktreePayload = (state: WorktreeState): WorktreeLifecyclePayload => ({
  sessionId: SESSION_ID as WorktreeLifecyclePayload["sessionId"],
  worktreeId: WORKTREE_ID,
  state,
});

describe("worktree records beyond the family", () => {
  it("a created record may name the kept copy it came back from; a retired one the copy it left", () => {
    const base = buildWorktreePayload("ready");
    expect(
      WorktreeCreatedPayloadSchema.safeParse({ ...base, restoredFrom: REMOVED_WORKTREE_ID })
        .success,
    ).toBe(true);
    expect(
      WorktreeCreatedPayloadSchema.safeParse({ ...base, removedWorktreeId: REMOVED_WORKTREE_ID })
        .success,
    ).toBe(false);
    const retired = buildWorktreePayload("retired");
    expect(
      WorktreeRetiredPayloadSchema.safeParse({ ...retired, removedWorktreeId: REMOVED_WORKTREE_ID })
        .success,
    ).toBe(true);
    expect(
      WorktreeRetiredPayloadSchema.safeParse({ ...retired, restoredFrom: REMOVED_WORKTREE_ID })
        .success,
    ).toBe(false);
    expect(WorktreeRetiredPayloadSchema.safeParse({ ...retired, state: "active" }).success).toBe(
      false,
    );
  });

  it("a chat swept back to the repository root says whether its pending move was cleared", () => {
    const swept = { sessionId: SESSION_ID, repoMountId: REPO_MOUNT_ID, worktreeId: WORKTREE_ID };
    expect(SessionSweptToRepoRootPayloadSchema.safeParse(swept).success).toBe(true);
    expect(
      SessionSweptToRepoRootPayloadSchema.safeParse({ ...swept, pendingMoveCleared: true }).success,
    ).toBe(true);
    expect(
      SessionSweptToRepoRootPayloadSchema.safeParse({ ...swept, pendingMoveCleared: false })
        .success,
    ).toBe(false);
  });

  it("a chat's branch change names the new and old branch, null when detached", () => {
    const change = {
      sessionId: SESSION_ID,
      repoMountId: REPO_MOUNT_ID,
      worktreeId: null,
      branch: "fix-login",
      previousBranch: null,
    };
    expect(SessionBranchChangedPayloadSchema.safeParse(change).success).toBe(true);
    expect(
      SessionBranchChangedPayloadSchema.safeParse({ ...change, previousBranch: undefined }).success,
    ).toBe(false);
  });
});
