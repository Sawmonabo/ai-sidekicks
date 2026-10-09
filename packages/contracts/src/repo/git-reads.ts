// Git read contracts for the panes: the branch list both base pickers use, reading a file's lines
// by path or by blob, and the signal that a session's working folder changed.
//
// This module imports nothing from `../event/session.js` and nothing whose imports reach it,
// which would close an eager module cycle.
import { z } from "zod";

import { SubscribeAckResponseSchema, type SubscribeAckResponse } from "../jsonrpc/streaming.js";
import { RepoMountIdSchema, type RepoMountId } from "./mount.js";
import {
  wireFreeFormString,
  wireUncappedFreeFormString,
  FILE_PATH_MAX_LEN,
} from "../free-form-string.js";
import { SessionIdSchema, type SessionId } from "../session/id.js";
import { WorktreeIdSchema, type WorktreeId } from "../worktree/lifecycle.js";
import { countSchema, isoDateTimeSchema } from "../internal/wire-scalars.js";

/**
 * A git object name as git prints it: 40 lowercase hex characters for SHA-1,
 * 64 for SHA-256. Commits and blobs are both named this way.
 */
export type GitObjectId = string & { readonly __brand: "GitObjectId" };
/** Parses a {@link GitObjectId}. */
export const GitObjectIdSchema: z.ZodType<GitObjectId, GitObjectId> = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u, "Expected a git object name")
  .brand<"GitObjectId">() as unknown as z.ZodType<GitObjectId, GitObjectId>;

/** `repo.branchList`: the mount whose branches both base pickers list. */
export interface RepoBranchListRequest {
  repoMountId: RepoMountId;
}
/** Wire schema for {@link RepoBranchListRequest}. */
export const RepoBranchListRequestSchema: z.ZodType<RepoBranchListRequest, RepoBranchListRequest> =
  z.object({ repoMountId: RepoMountIdSchema }).strict();

/**
 * One branch in a base list. `ahead` and `behind` count commits against the
 * branch's upstream and are absent when it has none. `heldBy` names the worktree
 * that has the branch checked out, which the create form's list grays; its
 * `worktreeId` is present only for a tree the app made, so the main checkout and
 * a tree the person made carry a name alone.
 */
export interface RepoBranchListEntry {
  name: string;
  ahead?: number | undefined;
  behind?: number | undefined;
  heldBy?: { worktreeId?: WorktreeId | undefined; name: string } | undefined;
}

/**
 * The `repo.branchList` result, in the daemon's one order: the default branch,
 * then the branches this project's last picks came from, most recent first,
 * then the rest by their newest commit. `countsAsOf` is present when the last
 * background fetch failed, and says when the figures were last true.
 */
export interface RepoBranchListResponse {
  defaultBranch: string;
  branches: RepoBranchListEntry[];
  countsAsOf?: string | undefined;
}
/** Wire schema for {@link RepoBranchListResponse}. */
export const RepoBranchListResponseSchema: z.ZodType<RepoBranchListResponse> = z
  .object({
    defaultBranch: wireUncappedFreeFormString("RepoBranchListResponse.defaultBranch"),
    branches: z.array(
      z
        .object({
          name: wireUncappedFreeFormString("RepoBranchListResponse.branches[].name"),
          ahead: countSchema.optional(),
          behind: countSchema.optional(),
          heldBy: z
            .object({
              worktreeId: WorktreeIdSchema.optional(),
              name: wireFreeFormString(
                FILE_PATH_MAX_LEN,
                "RepoBranchListResponse.branches[].heldBy.name",
              ),
            })
            .strict()
            .optional(),
        })
        .strict(),
    ),
    countsAsOf: isoDateTimeSchema.optional(),
  })
  .strict();

/**
 * Which side of a comparison a gap read is on: a `committed` side is read from
 * git's object store; a `working-tree` side is read from disk, and only while
 * the file there still has the blob id the diff was read at.
 */
export type RepoFileSide = "committed" | "working-tree";

/**
 * `repo.fileRead`: a file in the session's working folder, or the lines inside a
 * collapsed gap of a diff.
 *
 * A file the diff does not hold is read by `path` alone, from the working tree.
 * A gap is read by `path`, the `blobId` the diff gave that side, and the `side`,
 * so its line numbers match the diff the reader is looking at. `lines` narrows
 * the read to `count` lines from line `from`, counted from 1.
 */
export interface RepoFileReadRequest {
  sessionId: SessionId;
  path: string;
  blobId?: GitObjectId | undefined;
  side?: RepoFileSide | undefined;
  lines?: { from: number; count: number } | undefined;
}
/** Wire schema for {@link RepoFileReadRequest}; a gap read names its blob and its side together. */
export const RepoFileReadRequestSchema: z.ZodType<RepoFileReadRequest, RepoFileReadRequest> = z
  .object({
    sessionId: SessionIdSchema,
    path: wireFreeFormString(FILE_PATH_MAX_LEN, "RepoFileReadRequest.path"),
    blobId: GitObjectIdSchema.optional(),
    side: z.enum(["committed", "working-tree"]).optional(),
    lines: z
      .object({
        from: z.number().int().positive(),
        count: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((request) => (request.blobId === undefined) === (request.side === undefined), {
    message: "RepoFileReadRequest names `blobId` and `side` together, or neither.",
  });

/**
 * The `repo.fileRead` result.
 *
 * - `lines`: the lines read, starting at `firstLine`, with the file's
 *   `totalLines`.
 * - `stale`: the working-tree side no longer holds the blob the diff was read
 *   at, so the pane shows its reload mark instead of lines that do not match.
 * - `binary`: the file is not text.
 */
export type RepoFileReadResponse =
  | { outcome: "lines"; path: string; lines: string[]; firstLine: number; totalLines: number }
  | { outcome: "stale" }
  | { outcome: "binary" };
/** Wire schema for {@link RepoFileReadResponse}. */
export const RepoFileReadResponseSchema: z.ZodType<RepoFileReadResponse> = z.discriminatedUnion(
  "outcome",
  [
    z
      .object({
        outcome: z.literal("lines"),
        path: wireFreeFormString(FILE_PATH_MAX_LEN, "RepoFileReadResponse.path"),
        lines: z.array(z.string()),
        firstLine: z.number().int().positive(),
        totalLines: countSchema,
      })
      .strict(),
    z.object({ outcome: z.literal("stale") }).strict(),
    z.object({ outcome: z.literal("binary") }).strict(),
  ],
);

/** `repo.workingTreeSubscribe`: the session whose working folder the daemon watches. */
export interface WorkingTreeSubscribeRequest {
  sessionId: SessionId;
}
/** Wire schema for {@link WorkingTreeSubscribeRequest}. */
export const WorkingTreeSubscribeRequestSchema: z.ZodType<
  WorkingTreeSubscribeRequest,
  WorkingTreeSubscribeRequest
> = z.object({ sessionId: SessionIdSchema }).strict();

/** The `repo.workingTreeSubscribe` acknowledgement. */
export type WorkingTreeSubscribeResponse = SubscribeAckResponse;
/** Wire schema for {@link WorkingTreeSubscribeResponse}. */
export const WorkingTreeSubscribeResponseSchema: z.ZodType<WorkingTreeSubscribeResponse> =
  SubscribeAckResponseSchema;

/**
 * One `repo.workingTreeSubscribe` emission: the working folder changed at
 * `changedAt`. `mode` says how the daemon noticed: a file watch, or a slow
 * tick for a folder too large for the machine's watch limit, so a late mark is
 * never read as a tree that did not change.
 */
export interface WorkingTreeChange {
  sessionId: SessionId;
  changedAt: string;
  mode: "watch" | "slow_tick";
}
/** Wire schema for {@link WorkingTreeChange}. */
export const WorkingTreeChangeSchema: z.ZodType<WorkingTreeChange> = z
  .object({
    sessionId: SessionIdSchema,
    changedAt: isoDateTimeSchema,
    mode: z.enum(["watch", "slow_tick"]),
  })
  .strict();
