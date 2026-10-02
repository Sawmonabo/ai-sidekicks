// Kept-worktree contracts: the copies `Discard and remove` keeps, listing them, putting one back
// and deleting one.
//
// This module imports nothing from `./event.js` and nothing whose imports reach it, which would
// close an eager module cycle.
import { z } from "zod";

import { ProjectIdSchema, type ProjectId } from "./project.js";
import { GitObjectIdSchema, type GitObjectId } from "./repo-git-reads.js";
import { wireFreeFormString, wireUncappedFreeFormString, FILE_PATH_MAX_LEN } from "./session.js";
import {
  RemovedWorktreeIdSchema,
  WorktreeIdSchema,
  type RemovedWorktreeId,
  type WorktreeId,
} from "./worktree.js";
import { countSchema, isoDateTimeSchema } from "./internal/wire-scalars.js";

// `Discard and remove` moves the tree whole into its project's kept folder, so nothing it held is
// lost. The copy stays until the person presses `Delete now`; nothing deletes it on its own.

/** `repo.removedWorktreeList`: one project's kept worktrees, or every project's. */
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
 * its size. The size is read once after the discard, so `sizeBytes` and `sizeReadAt` are null until
 * that read has run.
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
 * at `path`; or a worktree named `name` (the tree's `<name>-restored`) already exists.
 */
export type WorktreeRestoreRefusal =
  | { reason: "project_not_attached" }
  | { reason: "repository_missing"; path: string }
  | { reason: "name_taken"; name: string };

/**
 * The `repo.worktreeRestore` result: the tree made again at `path`, on its own branch, or on
 * `<branch>-restored` when its branch has moved since or another worktree holds it (`onNewBranch`);
 * or the refusal. The kept copy stays until it is deleted, whether or not the put-back was refused.
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
          z
            .object({
              reason: z.literal("name_taken"),
              name: wireUncappedFreeFormString("WorktreeRestoreRefusal.name"),
            })
            .strict(),
        ]),
      })
      .strict(),
  ]);
