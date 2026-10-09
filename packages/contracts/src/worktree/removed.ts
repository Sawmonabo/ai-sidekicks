// Removed-worktree contracts: the copies `Discard and remove` keeps, listing them, putting one back
// and deleting one.
//
// This module imports nothing from `../event/session.js` and nothing whose imports reach it,
// which would close an eager module cycle.
import { z } from "zod";

import { ProjectIdSchema, type ProjectId } from "../project.js";
import { GitObjectIdSchema, type GitObjectId } from "../repo/git-reads.js";
import {
  wireFreeFormString,
  wireUncappedFreeFormString,
  FILE_PATH_MAX_LEN,
} from "../free-form-string.js";
import {
  RemovedWorktreeIdSchema,
  WorktreeIdSchema,
  type RemovedWorktreeId,
  type WorktreeId,
} from "./lifecycle.js";
import { countSchema, isoDateTimeSchema } from "../internal/wire-scalars.js";

// `Discard and remove` moves the tree whole into its project's kept folder, so nothing it held is
// lost. The copy stays until the person presses `Delete now`; nothing deletes it on its own.

/**
 * `repo.removedWorktreeList`: one project's kept worktrees, or every project's, plus what is left
 * of a copy put back while it is the one source to rebuild a live tree put back git cannot read.
 */
export interface RemovedWorktreeListRequest {
  projectId?: ProjectId | undefined;
}
/** Wire schema for {@link RemovedWorktreeListRequest}. */
export const RemovedWorktreeListRequestSchema: z.ZodType<
  RemovedWorktreeListRequest,
  RemovedWorktreeListRequest
> = z.object({ projectId: ProjectIdSchema.optional() }).strict();

/**
 * One kept worktree: the tree's name and branch, the commit it stood on, when it was removed, and
 * its size, read once after the discard, so `sizeBytes` and `sizeReadAt` are null until that read
 * has run. `unreadablePutBackFolder` names the folder of the live tree put back from this copy
 * that git cannot read, the one case a copy put back is listed, and is null otherwise.
 */
export interface RemovedWorktree {
  removedWorktreeId: RemovedWorktreeId;
  projectId: ProjectId;
  name: string;
  branch: string;
  headCommit: GitObjectId;
  removedAt: string;
  sizeBytes: number | null;
  sizeReadAt: string | null;
  unreadablePutBackFolder: string | null;
}

/** The `repo.removedWorktreeList` result. */
export interface RemovedWorktreeListResponse {
  removedWorktrees: RemovedWorktree[];
}
/** Wire schema for {@link RemovedWorktreeListResponse}. */
export const RemovedWorktreeListResponseSchema: z.ZodType<RemovedWorktreeListResponse> = z
  .object({
    removedWorktrees: z.array(
      z
        .object({
          removedWorktreeId: RemovedWorktreeIdSchema,
          projectId: ProjectIdSchema,
          name: wireFreeFormString(FILE_PATH_MAX_LEN, "RemovedWorktree.name"),
          branch: wireUncappedFreeFormString("RemovedWorktree.branch"),
          headCommit: GitObjectIdSchema,
          removedAt: isoDateTimeSchema,
          sizeBytes: countSchema.nullable(),
          sizeReadAt: isoDateTimeSchema.nullable(),
          unreadablePutBackFolder: wireFreeFormString(
            FILE_PATH_MAX_LEN,
            "RemovedWorktree.unreadablePutBackFolder",
          ).nullable(),
        })
        .strict(),
    ),
  })
  .strict();

/** The kept worktree `repo.worktreeRestore` puts back or `repo.removedWorktreeDelete` deletes. */
export interface RemovedWorktreeRequest {
  removedWorktreeId: RemovedWorktreeId;
}
/** Wire schema for {@link RemovedWorktreeRequest}. */
export const RemovedWorktreeRequestSchema: z.ZodType<
  RemovedWorktreeRequest,
  RemovedWorktreeRequest
> = z.object({ removedWorktreeId: RemovedWorktreeIdSchema }).strict();

/**
 * Why a put-back was refused: the project is no longer attached; the repository is no longer
 * at `path`; or the kept folder no longer holds the tree, so only `Delete now` is left for it.
 */
export type WorktreeRestoreRefusal =
  | { reason: "project_not_attached" }
  | { reason: "repository_missing"; path: string }
  | { reason: "kept_tree_missing" };

/**
 * The `repo.worktreeRestore` result: the tree made again at `path`, its own folder or the first
 * free numbered `<name>-restored` (`-restored-2` and on), on its own branch, or on the new
 * `<branch>-restored` of the same number, named in `branch`, when its branch has moved since or
 * another worktree holds it (`onNewBranch`); or the refusal. A refused put-back keeps the copy.
 */
export type WorktreeRestoreResponse =
  | {
      outcome: "restored";
      worktreeId: WorktreeId;
      path: string;
      branch: string;
      onNewBranch: boolean;
    }
  | { outcome: "refused"; refusal: WorktreeRestoreRefusal };
/** Wire schema for {@link WorktreeRestoreResponse}. */
export const WorktreeRestoreResponseSchema: z.ZodType<WorktreeRestoreResponse> =
  z.discriminatedUnion("outcome", [
    z
      .object({
        outcome: z.literal("restored"),
        worktreeId: WorktreeIdSchema,
        path: wireFreeFormString(FILE_PATH_MAX_LEN, "WorktreeRestoreResponse.path"),
        branch: wireUncappedFreeFormString("WorktreeRestoreResponse.branch"),
        onNewBranch: z.boolean(),
      })
      .strict(),
    z
      .object({
        outcome: z.literal("refused"),
        refusal: z.discriminatedUnion("reason", [
          z.object({ reason: z.literal("project_not_attached") }).strict(),
          z
            .object({
              reason: z.literal("repository_missing"),
              path: wireFreeFormString(FILE_PATH_MAX_LEN, "WorktreeRestoreRefusal.path"),
            })
            .strict(),
          z.object({ reason: z.literal("kept_tree_missing") }).strict(),
        ]),
      })
      .strict(),
  ]);
