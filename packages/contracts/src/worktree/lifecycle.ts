// Worktree contracts: the worktree state and lifecycle payload, the worktree ids, and the request
// and response pairs of the worktree methods on the `repo.*` namespace. They are daemon JSON-RPC
// only, since worktrees are local filesystem state.
//
// This module must import nothing from `../event/session.js`, directly or through any module
// that reaches it. `event/session.ts` imports this module's payload schema, so a back-import
// closes an eager module-scope Zod cycle that throws `ReferenceError` at import time and that `tsc`
// does not flag. Check a new import's closure before adding it.
import { z } from "zod";

import { brandedUuidIdSchema } from "../internal/branded.js";
import { RunIdSchema, type RunId } from "../run/id.js";
import {
  buildRepoWorkspaceLifecyclePayloadSchema,
  RepoMountIdSchema,
  WorkspaceIdSchema,
  WorkspaceStateSchema,
  type RepoMountId,
  type RepoWorkspaceLifecyclePayloadOf,
  type WorkspaceId,
  type WorkspaceState,
} from "../repo/mount.js";
import {
  wireFreeFormString,
  wireUncappedFreeFormString,
  FILE_PATH_MAX_LEN,
} from "../free-form-string.js";
import { SessionIdSchema, type SessionId } from "../session/id.js";
import { countSchema, isoDateTimeSchema } from "../internal/wire-scalars.js";

/** Brand of a worktree row id (`worktrees.id`), a daemon-minted UUID. */
export type WorktreeId = string & { readonly __brand: "WorktreeId" };
/**
 * Schema for {@link WorktreeId}. The shared lifecycle payload in `repo/mount.ts` keeps `worktreeId`
 * an unbranded UUID string with the same accept set; consumers narrow to the brand where they
 * parse.
 */
export const WorktreeIdSchema: z.ZodType<WorktreeId, WorktreeId> =
  brandedUuidIdSchema<WorktreeId>("WorktreeId");

/** Brand of a branch-context row id (`branch_contexts`), the workspace-anchored branch record. */
export type BranchContextId = string & { readonly __brand: "BranchContextId" };
/** Schema for {@link BranchContextId}. */
export const BranchContextIdSchema: z.ZodType<BranchContextId, BranchContextId> =
  brandedUuidIdSchema<BranchContextId>("BranchContextId");

/**
 * Brand of a worktree removed with `Discard and remove` and kept whole until the person deletes
 * the copy. It is a record apart from the retired worktree row because the copy outlives the
 * tree and a put-back makes a new worktree.
 */
export type RemovedWorktreeId = string & { readonly __brand: "RemovedWorktreeId" };
/** Schema for {@link RemovedWorktreeId}. */
export const RemovedWorktreeIdSchema: z.ZodType<RemovedWorktreeId, RemovedWorktreeId> =
  brandedUuidIdSchema<RemovedWorktreeId>("RemovedWorktreeId");

// The order mirrors the daemon's `worktrees.state` CHECK clause.
const WORKTREE_STATES = ["creating", "ready", "dirty", "merged", "retired", "failed"] as const;

/**
 * A worktree's lifecycle state (`worktrees.state`). `retired` and `failed` are the non-live
 * states, which the active-branch unique index ignores. Moving to `failed` emits no `worktree.*`
 * event (the failure is evented as `workspace.stale`), and failed rows stay readable through
 * `repo.worktreeStatusRead`.
 */
export type WorktreeState = (typeof WORKTREE_STATES)[number];
/** Schema for {@link WorktreeState}. */
export const WorktreeStateSchema: z.ZodType<WorktreeState> = z.enum(WORKTREE_STATES);

/**
 * Payload of the `worktree.*` events: the shared repo and workspace lifecycle payload over
 * `WorktreeState`. It leaves `worktreeId` optional, so the emitter sets it on every `worktree.*`
 * emission. A type alias, because only an object type alias satisfies the event variants'
 * `Record<string, unknown>` payload constraint.
 */
export type WorktreeLifecyclePayload = RepoWorkspaceLifecyclePayloadOf<WorktreeState>;
/**
 * Schema for {@link WorktreeLifecyclePayload}, built by the shared lifecycle factory so each
 * payload keeps its own state vocabulary: a worktree payload claiming `attached` fails to parse.
 * `failed` parses, though no `worktree.*` event carries it.
 */
export const WorktreeLifecyclePayloadSchema: z.ZodType<WorktreeLifecyclePayload> =
  buildRepoWorkspaceLifecyclePayloadSchema(WorktreeStateSchema);

// No schema here refines across fields: each conditional field is an obligation on the emitter,
// and some depend on state a schema cannot see.

/**
 * The `repo.executionRootPrepare` input: the workspace and its branch, which makes the root for
 * the workspace's execution mode before a run starts. It carries no `runId`: the daemon supplies
 * it, so a caller cannot forge run provenance.
 */
export interface ExecutionRootPrepareRequest {
  workspaceId: WorkspaceId;
  branchName?: string | undefined;
  baseRef?: string | undefined;
  carryUncommitted?: boolean | undefined;
}
/** Wire schema for {@link ExecutionRootPrepareRequest}. */
export const ExecutionRootPrepareRequestSchema: z.ZodType<
  ExecutionRootPrepareRequest,
  ExecutionRootPrepareRequest
> = z
  .object({
    workspaceId: WorkspaceIdSchema,
    // Optional in the schema, required in practice: omitting it draws the
    // `workspace.branch_name_required` refusal before any git call.
    branchName: wireUncappedFreeFormString("ExecutionRootPrepareRequest.branchName").optional(),
    // Omitted means the mount's current HEAD branch; a detached HEAD with no base is refused.
    // Git reads a leading dash as an option, so the daemon refuses such a value before git.
    baseRef: wireUncappedFreeFormString("ExecutionRootPrepareRequest.baseRef").optional(),
    // Carries the session's uncommitted work, untracked files included, onto
    // the new tree. The daemon refuses it unless the new base is the branch
    // the work sits on; absence means nothing is carried.
    carryUncommitted: z.boolean().optional(),
  })
  .strict();

/** The `repo.executionRootPrepare` result: the prepared root and the rows it names. */
export interface ExecutionRootPrepareResponse {
  executionRoot: string;
  state: WorkspaceState;
  worktreeId?: WorktreeId | undefined;
  branchContextId: BranchContextId;
}
/** Wire schema for {@link ExecutionRootPrepareResponse}. */
export const ExecutionRootPrepareResponseSchema: z.ZodType<ExecutionRootPrepareResponse> = z
  .object({
    // Prepare resolves a root or refuses; there is no partial success.
    executionRoot: wireFreeFormString(
      FILE_PATH_MAX_LEN,
      "ExecutionRootPrepareResponse.executionRoot",
    ),
    state: WorkspaceStateSchema,
    // Present for a `provisioned-worktree` prepare only. Every prepare writes or refreshes a
    // branch context, so `branchContextId` is always present.
    worktreeId: WorktreeIdSchema.optional(),
    branchContextId: BranchContextIdSchema,
  })
  .strict();

/**
 * The `repo.worktreeRetire` input. `discard: false` is the ordinary removal: it
 * removes nothing the confirm did not show, and is refused with the current
 * risks when the tree changed since they were read. `discard: true` is sent only
 * from the discard confirm; the daemon then keeps the tree whole instead of
 * deleting it.
 */
export interface WorktreeRetireRequest {
  worktreeId: WorktreeId;
  discard: boolean;
}
/** Wire schema for {@link WorktreeRetireRequest}. */
export const WorktreeRetireRequestSchema: z.ZodType<WorktreeRetireRequest, WorktreeRetireRequest> =
  z
    .object({
      worktreeId: WorktreeIdSchema,
      discard: z.boolean(),
    })
    .strict();

/**
 * The `repo.worktreeRetire` result: the worktree, now `retired`, and the kept
 * copy when a discard kept one.
 */
export interface WorktreeRetireResponse {
  worktreeId: WorktreeId;
  state: Extract<WorktreeState, "retired">;
  kept?: { removedWorktreeId: RemovedWorktreeId } | undefined;
}
/** Wire schema for {@link WorktreeRetireResponse}. */
export const WorktreeRetireResponseSchema: z.ZodType<WorktreeRetireResponse> = z
  .object({
    worktreeId: WorktreeIdSchema,
    // A refusal is the `worktree.retire_conflict` error, never a reply with the unchanged state.
    state: z.literal("retired"),
    kept: z.object({ removedWorktreeId: RemovedWorktreeIdSchema }).strict().optional(),
  })
  .strict();

/**
 * The code `repo.worktreeRetire` refuses with when a plain removal would lose something the
 * confirm did not show, or an agent runs in the tree.
 */
export const WORKTREE_RETIRE_CONFLICT_CODE = "worktree.retire_conflict" as const;
/** The type of {@link WORKTREE_RETIRE_CONFLICT_CODE}. */
export type WorktreeRetireConflictCode = typeof WORKTREE_RETIRE_CONFLICT_CODE;

/**
 * Why a removal was refused: `root_busy` (an agent runs in the tree, naming the workspace that
 * holds it) or `has_changes` (the tree has something to lose, ignored files included, and the
 * details carry the current risks so the confirm redraws them).
 */
export const WORKTREE_RETIRE_CONFLICT_REASONS = ["root_busy", "has_changes"] as const;
/**
 * One of {@link WORKTREE_RETIRE_CONFLICT_REASONS}.
 *
 * @consumedBy the handler that returns the `worktree.retire_conflict` error
 */
export type WorktreeRetireConflictReason = (typeof WORKTREE_RETIRE_CONFLICT_REASONS)[number];

/**
 * What removing a tree would lose, each named in the confirm: uncommitted files,
 * ignored files (an `.env`, say) that would be destroyed, commits no
 * remote-tracking branch of the folder reaches, and the sessions standing in it.
 */
export interface WorktreeRemovalRisks {
  uncommittedFileCount: number;
  ignoredFileCount: number;
  unpushedCommitCount: number;
  occupyingSessionIds: SessionId[];
}
/** Wire schema for {@link WorktreeRemovalRisks}. */
export const WorktreeRemovalRisksSchema: z.ZodType<WorktreeRemovalRisks> = z
  .object({
    uncommittedFileCount: countSchema,
    ignoredFileCount: countSchema,
    unpushedCommitCount: countSchema,
    occupyingSessionIds: z.array(SessionIdSchema),
  })
  .strict();

/** The details a `worktree.retire_conflict` refusal carries, by its reason. */
export type WorktreeRetireConflictDetails =
  | { worktreeId: WorktreeId; reason: "root_busy"; holdingWorkspaceId: WorkspaceId }
  | { worktreeId: WorktreeId; reason: "has_changes"; risks: WorktreeRemovalRisks };
/**
 * Wire schema for {@link WorktreeRetireConflictDetails}.
 *
 * @consumedBy the handler that returns the `worktree.retire_conflict` error
 */
export const WorktreeRetireConflictDetailsSchema: z.ZodType<WorktreeRetireConflictDetails> =
  z.discriminatedUnion("reason", [
    z
      .object({
        worktreeId: WorktreeIdSchema,
        reason: z.literal("root_busy"),
        holdingWorkspaceId: WorkspaceIdSchema,
      })
      .strict(),
    z
      .object({
        worktreeId: WorktreeIdSchema,
        reason: z.literal("has_changes"),
        risks: WorktreeRemovalRisksSchema,
      })
      .strict(),
  ]);

/** The state of a listed worktree: every state but `retired`. */
export type ListedWorktreeState = Exclude<WorktreeState, "retired">;

/**
 * One listed worktree, with every figure its switcher row draws. `ahead` and `behind` count
 * commits against the branch's upstream as of the daemon's last fetch, absent when it has none;
 * `runningSessionId` names the session whose agent runs in the tree, which locks its removal.
 */
export interface WorktreeStatusRecord {
  worktreeId: WorktreeId;
  repoMountId: RepoMountId;
  name: string;
  branchName: string;
  baseBranchName: string;
  fsRoot: string;
  state: ListedWorktreeState;
  ahead?: number | undefined;
  behind?: number | undefined;
  uncommittedFileCount: number;
  unpushedCommitCount: number;
  occupyingSessionIds: SessionId[];
  runningSessionId: SessionId | null;
  createdBySessionId: SessionId;
  createdByRunId?: RunId | undefined;
  createdAt: string;
  updatedAt: string;
}
const worktreeStatusRecordSchema: z.ZodType<WorktreeStatusRecord> = z
  .object({
    worktreeId: WorktreeIdSchema,
    repoMountId: RepoMountIdSchema,
    name: wireFreeFormString(FILE_PATH_MAX_LEN, "WorktreeStatusRecord.name"),
    branchName: wireUncappedFreeFormString("WorktreeStatusRecord.branchName"),
    baseBranchName: wireUncappedFreeFormString("WorktreeStatusRecord.baseBranchName"),
    // A root under the daemon's worktrees folder, never a path inside the
    // attached checkout.
    fsRoot: wireFreeFormString(FILE_PATH_MAX_LEN, "WorktreeStatusRecord.fsRoot"),
    state: WorktreeStateSchema.refine(
      (state): state is ListedWorktreeState => state !== "retired",
      "A retired worktree is not listed",
    ),
    ahead: countSchema.optional(),
    behind: countSchema.optional(),
    uncommittedFileCount: countSchema,
    unpushedCommitCount: countSchema,
    occupyingSessionIds: z.array(SessionIdSchema),
    runningSessionId: SessionIdSchema.nullable(),
    createdBySessionId: SessionIdSchema,
    // Absent for a tree prepared before any run, which has no run to attribute.
    createdByRunId: RunIdSchema.optional(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

/**
 * `repo.worktreeStatusRead`: the project's folder whose worktrees are listed, and
 * the session asking, when one is. A session's switcher names itself, so the read
 * also answers the new-worktree form's suggestion for it.
 */
export interface WorktreeStatusReadRequest {
  repoMountId: RepoMountId;
  sessionId?: SessionId | undefined;
}
/** Wire schema for {@link WorktreeStatusReadRequest}. */
export const WorktreeStatusReadRequestSchema: z.ZodType<
  WorktreeStatusReadRequest,
  WorktreeStatusReadRequest
> = z
  .object({
    repoMountId: RepoMountIdSchema,
    sessionId: SessionIdSchema.optional(),
  })
  .strict();

/**
 * What the new-worktree form opens with, from the daemon function that names and creates the
 * tree: the name's fixed part from the branch pattern, a tail suggested from the session title,
 * and the folder up to that tail, so the form copies none of the daemon's naming.
 */
export interface NewWorktreeSuggestion {
  fixedPart: string;
  suggestedTail: string;
  folderBefore: string;
}

/**
 * The `repo.worktreeStatusRead` result: the project's own checkout and its standing trees from one
 * read, so no row shows a tree free that another read calls occupied. `countsAsOf` says when the
 * ahead and behind figures were last true if the last fetch failed.
 */
export interface WorktreeStatusReadResponse {
  repoRoot: { path: string; branchName: string };
  worktrees: WorktreeStatusRecord[];
  countsAsOf?: string | undefined;
  newWorktree?: NewWorktreeSuggestion | undefined;
}
/** Wire schema for {@link WorktreeStatusReadResponse}. */
export const WorktreeStatusReadResponseSchema: z.ZodType<WorktreeStatusReadResponse> = z
  .object({
    repoRoot: z
      .object({
        path: wireFreeFormString(FILE_PATH_MAX_LEN, "WorktreeStatusReadResponse.repoRoot.path"),
        branchName: wireUncappedFreeFormString("WorktreeStatusReadResponse.repoRoot.branchName"),
      })
      .strict(),
    worktrees: z.array(worktreeStatusRecordSchema),
    countsAsOf: isoDateTimeSchema.optional(),
    newWorktree: z
      .object({
        fixedPart: z.string(),
        suggestedTail: wireUncappedFreeFormString(
          "WorktreeStatusReadResponse.newWorktree.suggestedTail",
        ),
        folderBefore: wireFreeFormString(
          FILE_PATH_MAX_LEN,
          "WorktreeStatusReadResponse.newWorktree.folderBefore",
        ),
      })
      .strict()
      .optional(),
  })
  .strict();
