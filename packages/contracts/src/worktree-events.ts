// Worktree event payloads — the records the daemon writes when a worktree is
// made or removed beyond the family payload, when a session is swept back to
// the repository root, and when a session's branch changes. `event.ts`
// registers them; this module never imports it.
//
// IMPORT DIRECTION IS ONE-WAY: this module imports nothing from `./event.js`
// and nothing whose import closure reaches it (the transitive rule repo.ts's
// header documents). Every module imported below is closure-clean.
import { z } from "zod";

import {
  buildRepoWorkspaceLifecyclePayloadSchemaWith,
  RepoMountIdSchema,
  type RepoMountId,
} from "./repo.js";
import { SessionIdSchema, wireFreeFormString, type SessionId } from "./session.js";
import {
  RemovedWorktreeIdSchema,
  WORKTREE_GIT_REF_MAX_LEN,
  WorktreeIdSchema,
  WorktreeStateSchema,
  type RemovedWorktreeId,
  type WorktreeId,
  type WorktreeLifecyclePayload,
  type WorktreeState,
} from "./worktree.js";

// ==========================================================================
// Event payloads the worktree records carry beyond the family.
// ==========================================================================

/**
 * `worktree.created`'s payload: the family payload, and on a put-back the kept
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
 * `worktree.retired`'s payload: the family payload, and the kept copy when the
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
 * changed outside the console, and the daemon wrote it back to the session's
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
    branch: wireFreeFormString(
      WORKTREE_GIT_REF_MAX_LEN,
      "SessionBranchChangedPayload.branch",
    ).nullable(),
    previousBranch: wireFreeFormString(
      WORKTREE_GIT_REF_MAX_LEN,
      "SessionBranchChangedPayload.previousBranch",
    ).nullable(),
  })
  .strict();
