// Worktree event payloads beyond the shared lifecycle payload: worktree created and retired, a
// session swept back to the repository root, and a session's branch changed.
//
// This module imports nothing from `../event/session.js` and nothing whose import closure
// reaches it, for the module-cycle reason in the header of `repo/mount.ts`.
import { z } from "zod";

import {
  buildRepoWorkspaceLifecyclePayloadSchemaWith,
  RepoMountIdSchema,
  type RepoMountId,
} from "../repo/mount.js";
import { wireUncappedFreeFormString } from "../free-form-string.js";
import { SessionIdSchema, type SessionId } from "../session/id.js";
import {
  RemovedWorktreeIdSchema,
  WorktreeIdSchema,
  WorktreeStateSchema,
  type RemovedWorktreeId,
  type WorktreeId,
  type WorktreeLifecyclePayload,
  type WorktreeState,
} from "./lifecycle.js";

/**
 * `worktree.created`'s payload: the shared lifecycle payload, and on a put-back the kept
 * copy the tree came from, so no event type of its own is needed.
 */
export type WorktreeCreatedPayload = WorktreeLifecyclePayload & {
  restoredFrom?: RemovedWorktreeId | undefined;
};
/** Wire schema for {@link WorktreeCreatedPayload}. */
export const WorktreeCreatedPayloadSchema: z.ZodType<WorktreeCreatedPayload> =
  buildRepoWorkspaceLifecyclePayloadSchemaWith<
    WorktreeState,
    { restoredFrom?: RemovedWorktreeId | undefined }
  >(WorktreeStateSchema, { restoredFrom: RemovedWorktreeIdSchema.optional() });

/**
 * `worktree.retired`'s payload: the shared lifecycle payload, and the kept copy when the
 * removal was a discard that kept one.
 */
export type WorktreeRetiredPayload = WorktreeLifecyclePayload & {
  removedWorktreeId?: RemovedWorktreeId | undefined;
};
/** Wire schema for {@link WorktreeRetiredPayload}. */
export const WorktreeRetiredPayloadSchema: z.ZodType<WorktreeRetiredPayload> =
  buildRepoWorkspaceLifecyclePayloadSchemaWith<
    WorktreeState,
    { removedWorktreeId?: RemovedWorktreeId | undefined }
  >(WorktreeStateSchema, { removedWorktreeId: RemovedWorktreeIdSchema.optional() });

/**
 * `session.swept_to_repo_root`'s payload, appended to each session a removal
 * moved back to the repository root. It records a move, not a state change:
 * `worktreeId` names the removed tree, and `pendingMoveCleared` is present only
 * when the same removal cleared a pending working-folder move that pointed at it.
 */
export type SessionSweptToRepoRootPayload = {
  sessionId: SessionId;
  repoMountId: RepoMountId;
  worktreeId: WorktreeId;
  pendingMoveCleared?: true | undefined;
};
/** Wire schema for {@link SessionSweptToRepoRootPayload}. */
export const SessionSweptToRepoRootPayloadSchema: z.ZodType<SessionSweptToRepoRootPayload> = z
  .object({
    sessionId: SessionIdSchema,
    repoMountId: RepoMountIdSchema,
    worktreeId: WorktreeIdSchema,
    pendingMoveCleared: z.literal(true).optional(),
  })
  .strict();

/**
 * `session.branch_changed`'s payload: the branch a session's folder is on
 * changed outside the app, and the daemon wrote it back to the session's
 * record. One is appended to each session standing in that folder. `worktreeId`
 * is null for the repository's own checkout; a branch is null while HEAD is
 * detached.
 */
export type SessionBranchChangedPayload = {
  sessionId: SessionId;
  repoMountId: RepoMountId;
  worktreeId: WorktreeId | null;
  branch: string | null;
  previousBranch: string | null;
};
/** Wire schema for {@link SessionBranchChangedPayload}. */
export const SessionBranchChangedPayloadSchema: z.ZodType<SessionBranchChangedPayload> = z
  .object({
    sessionId: SessionIdSchema,
    repoMountId: RepoMountIdSchema,
    worktreeId: WorktreeIdSchema.nullable(),
    branch: wireUncappedFreeFormString("SessionBranchChangedPayload.branch").nullable(),
    previousBranch: wireUncappedFreeFormString(
      "SessionBranchChangedPayload.previousBranch",
    ).nullable(),
  })
  .strict();
