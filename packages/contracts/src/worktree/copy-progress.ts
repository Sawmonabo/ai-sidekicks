// Worktree copy progress: the copies across volumes a removal or a put-back makes, while they run.
//
// This module imports nothing from `../event/session.js` and nothing whose imports reach it,
// which would close an eager module cycle.
import { z } from "zod";

import { SubscribeAckResponseSchema, type SubscribeAckResponse } from "../jsonrpc/streaming.js";
import { ProjectIdSchema, type ProjectId } from "../project.js";
import { wireFreeFormString, FILE_PATH_MAX_LEN } from "../free-form-string.js";
import {
  RemovedWorktreeIdSchema,
  WorktreeIdSchema,
  type RemovedWorktreeId,
  type WorktreeId,
} from "./lifecycle.js";
import { countSchema } from "../internal/wire-scalars.js";

// A removal or a put-back moves a tree by one rename, which reports nothing. Only where the rename
// would cross a volume does the daemon copy the tree, and only then is there progress to show.

/** `repo.worktreeCopySubscribe`: one project's copies under way, or every project's. */
export interface WorktreeCopySubscribeRequest {
  projectId?: ProjectId | undefined;
}
/** Wire schema for {@link WorktreeCopySubscribeRequest}. */
export const WorktreeCopySubscribeRequestSchema: z.ZodType<
  WorktreeCopySubscribeRequest,
  WorktreeCopySubscribeRequest
> = z.object({ projectId: ProjectIdSchema.optional() }).strict();

/**
 * The row a copy draws on: a worktree being removed, by its `repo.mountList` and
 * `repo.worktreeStatusRead` id, or a kept worktree being put back, by its
 * `repo.removedWorktreeList` id; `name` is the name that row shows.
 */
export type WorktreeCopySubject =
  | { kind: "removing"; worktreeId: WorktreeId; projectId: ProjectId; name: string }
  | {
      kind: "putting_back";
      removedWorktreeId: RemovedWorktreeId;
      projectId: ProjectId;
      name: string;
    };

/**
 * One copy under way: its row, the bytes written so far, the file being copied included, and the
 * bytes of every file it makes.
 */
export type WorktreeCopy = WorktreeCopySubject & { copiedBytes: number; totalBytes: number };

/** One `repo.worktreeCopySubscribe` emission: every copy under way, sent whole on each change. */
export interface WorktreeCopyProgress {
  copies: WorktreeCopy[];
}
/** Wire schema for {@link WorktreeCopyProgress}. */
export const WorktreeCopyProgressSchema: z.ZodType<WorktreeCopyProgress> = z
  .object({
    copies: z.array(
      z.discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("removing"),
            worktreeId: WorktreeIdSchema,
            projectId: ProjectIdSchema,
            name: wireFreeFormString(FILE_PATH_MAX_LEN, "WorktreeCopy.name"),
            copiedBytes: countSchema,
            totalBytes: countSchema,
          })
          .strict(),
        z
          .object({
            kind: z.literal("putting_back"),
            removedWorktreeId: RemovedWorktreeIdSchema,
            projectId: ProjectIdSchema,
            name: wireFreeFormString(FILE_PATH_MAX_LEN, "WorktreeCopy.name"),
            copiedBytes: countSchema,
            totalBytes: countSchema,
          })
          .strict(),
      ]),
    ),
  })
  .strict();

/** The `repo.worktreeCopySubscribe` acknowledgement. */
export type WorktreeCopySubscribeResponse = SubscribeAckResponse;
/** Wire schema for {@link WorktreeCopySubscribeResponse}. */
export const WorktreeCopySubscribeResponseSchema: z.ZodType<WorktreeCopySubscribeResponse> =
  SubscribeAckResponseSchema;
