// Worktree contracts: the worktree state and lifecycle payload, the branded `WorktreeId`,
// `BranchContextId` and `RemovedWorktreeId`, and the request and response pairs of the five
// worktree methods on the `repo.*` namespace. `WorktreeState` mirrors the daemon's
// `worktrees.state` CHECK clause; a conformance test in the daemon package compares them.
//
// This module must import nothing from `./event.js`, directly or through any module that
// reaches it. `event.ts` imports this module's payload schema, so a back-import closes an
// eager module-scope Zod cycle that throws `ReferenceError` at import time and that `tsc`
// does not flag. Check a new import's closure before adding it.
import { z } from "zod";

import { brandedUuidIdSchema } from "./internal/branded.js";
import { RunIdSchema, type RunId } from "./provider-driver.js";
import {
  buildRepoWorkspaceLifecyclePayloadSchema,
  ExecutionModeSchema,
  RepoMountIdSchema,
  WorkspaceIdSchema,
  WorkspaceStateSchema,
  type ExecutionMode,
  type RepoMountId,
  type RepoWorkspaceLifecyclePayloadOf,
  type WorkspaceId,
  type WorkspaceState,
} from "./repo.js";
import {
  SessionIdSchema,
  wireFreeFormString,
  type SessionId,
  FILE_PATH_MAX_LEN,
} from "./session.js";

// Re-exported so this module's surface carries the execution-mode taxonomy that `repo.ts` owns.
// The type and the schema value are separate statements because `verbatimModuleSyntax` forbids
// an erased re-export on the value form; the select request and response need the schema.
export type { ExecutionMode } from "./repo.js";
export { ExecutionModeSchema } from "./repo.js";

// Each id is a daemon-minted UUID (`worktrees.id`, `branch_contexts.id`) built with
// `brandedUuidIdSchema`, which supplies the double-T annotation tRPC v11 needs for input inference.

/** Brand of a worktree row id (`worktrees.id`). */
export type WorktreeId = string & { readonly __brand: "WorktreeId" };
/**
 * Schema for {@link WorktreeId}. The family payload in `repo.ts` keeps `worktreeId` an unbranded
 * UUID string with the same accept set; consumers narrow to the brand where they parse.
 */
export const WorktreeIdSchema: z.ZodType<WorktreeId, WorktreeId> =
  brandedUuidIdSchema<WorktreeId>("WorktreeId");

/** Brand of a branch-context row id (`branch_contexts`), the workspace-anchored carrier row. */
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

// Declaration order mirrors the `worktrees.state` CHECK clause and is asserted by tests, so a
// reorder here needs the DDL re-synced.

/**
 * The six worktree lifecycle states (`worktrees.state`). `retired` and `failed` are the two
 * non-live states: the active-branch unique index ignores them. Moving to `failed` emits no
 * `worktree.*` event (the failure is evented as `workspace.stale`), and failed rows stay
 * readable through `repo.worktreeStatusRead`.
 */
export type WorktreeState = "creating" | "ready" | "dirty" | "merged" | "retired" | "failed";
/** Schema for {@link WorktreeState}. */
export const WorktreeStateSchema: z.ZodType<WorktreeState> = z.enum([
  "creating",
  "ready",
  "dirty",
  "merged",
  "retired",
  "failed",
]);

/**
 * Payload of the five `worktree.*` events: the repo and workspace lifecycle family payload over
 * `WorktreeState`. The shape leaves `worktreeId` optional, so the emitter must set it on every
 * `worktree.*` emission. A type alias, not an interface, because only an object type alias
 * satisfies the `Record<string, unknown>` payload constraint of the event variants.
 */
export type WorktreeLifecyclePayload = RepoWorkspaceLifecyclePayloadOf<WorktreeState>;
/**
 * Schema for {@link WorktreeLifecyclePayload}, built by the family factory so each family
 * member keeps its own state vocabulary: a worktree payload claiming `attached`, or a workspace
 * payload claiming `merged`, fails to parse. `failed` parses but no `worktree.*` event carries
 * it. Single-T and strict: an event payload built daemon-side and checked with `.parse()`.
 */
export const WorktreeLifecyclePayloadSchema: z.ZodType<WorktreeLifecyclePayload> =
  buildRepoWorkspaceLifecyclePayloadSchema(WorktreeStateSchema);

// Wire surfaces: the five worktree request and response pairs of the `repo.*` namespace.
//
// They are daemon JSON-RPC only, since worktrees are node-local filesystem state. Requests are
// double-T `z.ZodType<T, T>` so tRPC v11 can infer their input; responses are single-T. Only
// `ExecutionModeSelectRequestSchema` needs the `as unknown as` bridge, because the single-T
// `ExecutionModeSchema` leaves the composed object's Input slot `unknown`.
//
// The daemon derives branch names (slug rule, collision suffix) and a client never computes
// them; a caller-supplied `branchName` is accepted on the way in.
//
// No schema here refines across fields. Each conditional field is an obligation on the emitter,
// checked when the daemon parses its own response, and some depend on state a schema cannot see.

/**
 * Maximum length of a git ref name on the wire, for `branchName` and `baseRef` alike. It is the
 * 256 identifier class, not the path class: every branch name a response carries came in through
 * this cap or from the daemon's slug rule, and a suffixed name that would outgrow it is refused
 * at the write. A pre-existing branch longer than 256 characters cannot be probed through
 * `repo.worktreeReuseCheck` or named as a `baseRef`; it fails loudly at the wire.
 */
export const WORKTREE_GIT_REF_MAX_LEN = 256;

/**
 * Maximum length of the reuse check's `reason`, a short authored summary rather than captured
 * git output. Kept apart from the same-valued `EXECUTION_MODE_RESTRICTION_REASON_MAX_LEN` so
 * neither contract owes the other an equality.
 */
export const WORKTREE_REUSE_REASON_MAX_LEN = 512;

// Selecting only records the mode and moves the workspace to `preparing`; the root is
// materialized by `repo.executionRootPrepare`. A client sends one selection per explicit switch.

/** The `repo.executionModeSelect` input: the workspace and the mode it switches to. */
export interface ExecutionModeSelectRequest {
  workspaceId: WorkspaceId;
  executionMode: ExecutionMode;
}
/** Wire schema for {@link ExecutionModeSelectRequest}. */
export const ExecutionModeSelectRequestSchema: z.ZodType<
  ExecutionModeSelectRequest,
  ExecutionModeSelectRequest
> = z
  .object({
    workspaceId: WorkspaceIdSchema,
    // Required, with no `.default()`: an omitted mode must not read as a chosen one, and a
    // default is a transform, so Input would stop equalling Output.
    executionMode: ExecutionModeSchema,
  })
  .strict() as unknown as z.ZodType<ExecutionModeSelectRequest, ExecutionModeSelectRequest>;

/** The `repo.executionModeSelect` result: the recorded mode and the workspace's position. */
export interface ExecutionModeSelectResponse {
  workspaceId: WorkspaceId;
  executionMode: ExecutionMode;
  state: WorkspaceState;
}
/** Wire schema for {@link ExecutionModeSelectResponse}; single-T, as a response is no input. */
export const ExecutionModeSelectResponseSchema: z.ZodType<ExecutionModeSelectResponse> = z
  .object({
    workspaceId: WorkspaceIdSchema,
    // Echoed so the caller sees the mode actually recorded; an unavailable mode is a typed
    // `workspace.mode_unsupported` refusal, never a substituted mode.
    executionMode: ExecutionModeSchema,
    // The workspace position after select (`preparing` while the root awaits prepare); the full
    // state schema, not narrowed to that literal.
    state: WorkspaceStateSchema,
  })
  .strict();

// Materializes or binds the execution root for the workspace's selected mode before a run
// enters `running`; explicit worktree reuse rides this surface by naming the candidate.

/**
 * The `repo.executionRootPrepare` input: the workspace, its branch, and any worktree to reuse.
 * It carries no `runId`: the run-setup gate supplies it service-side, so a caller cannot forge
 * run provenance.
 */
export interface ExecutionRootPrepareRequest {
  workspaceId: WorkspaceId;
  branchName?: string | undefined;
  baseRef?: string | undefined;
  reuseWorktreeId?: WorktreeId | undefined;
  acknowledgeDirtyCandidate?: boolean | undefined;
  carryUncommitted?: boolean | undefined;
}
/** Wire schema for {@link ExecutionRootPrepareRequest}. */
export const ExecutionRootPrepareRequestSchema: z.ZodType<
  ExecutionRootPrepareRequest,
  ExecutionRootPrepareRequest
> = z
  .object({
    workspaceId: WorkspaceIdSchema,
    // Optional in the schema, required in practice: a wire prepare has no run to derive a name
    // from, so omitting it draws the typed `workspace.branch_name_required` refusal before any
    // git call.
    branchName: wireFreeFormString(
      WORKTREE_GIT_REF_MAX_LEN,
      "ExecutionRootPrepareRequest.branchName",
    ).optional(),
    // Omitted means the mount's current HEAD branch, which the daemon reads; a detached HEAD with
    // no explicit base is a typed refusal. Git reads a leading dash as an option even in the
    // positional slot, so the daemon refuses such a value before git.
    baseRef: wireFreeFormString(
      WORKTREE_GIT_REF_MAX_LEN,
      "ExecutionRootPrepareRequest.baseRef",
    ).optional(),
    // Reuse happens only by naming a candidate; there is no implicit "reuse if available" path.
    // The candidate must belong to the mount behind `workspaceId`; neither row is visible at
    // parse time, so the reuse validation checks it.
    reuseWorktreeId: WorktreeIdSchema.optional(),
    // Separate consent to bind a dirty candidate: a candidate that turned dirty after the reuse
    // check refuses `worktree.reuse_conflict` without it, and it never overrides incompatibility.
    // No `.default(false)`: absence already means no consent, and a default would add a
    // transform that breaks the double-T annotation.
    acknowledgeDirtyCandidate: z.boolean().optional(),
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
/** Wire schema for {@link ExecutionRootPrepareResponse}; single-T, as a response is no input. */
export const ExecutionRootPrepareResponseSchema: z.ZodType<ExecutionRootPrepareResponse> = z
  .object({
    // Prepare resolves a root or refuses with a typed error (`worktree.create_failed` or a
    // workspace code); there is no partial success.
    executionRoot: wireFreeFormString(
      FILE_PATH_MAX_LEN,
      "ExecutionRootPrepareResponse.executionRoot",
    ),
    // The workspace position after the prepare; the full state vocabulary, as in the select
    // response.
    state: WorkspaceStateSchema,
    // Present for a `provisioned-worktree` prepare only, which the schema cannot see. Every
    // prepare writes or refreshes a branch context, so `branchContextId` is always present.
    worktreeId: WorktreeIdSchema.optional(),
    branchContextId: BranchContextIdSchema,
  })
  .strict();

/** The `repo.worktreeReuseCheck` input: the mount and branch to find a live worktree for. */
export interface WorktreeReuseCheckRequest {
  repoMountId: RepoMountId;
  branchName: string;
}
/** Wire schema for {@link WorktreeReuseCheckRequest}. */
export const WorktreeReuseCheckRequestSchema: z.ZodType<
  WorktreeReuseCheckRequest,
  WorktreeReuseCheckRequest
> = z
  .object({
    // Keyed by mount, not workspace: the uniqueness read is `(repo_mount_id, branch_name)`, and
    // several workspaces on one mount share those candidates.
    repoMountId: RepoMountIdSchema,
    // Required, unlike on prepare: with no branch there is no key to look a candidate up by.
    branchName: wireFreeFormString(
      WORKTREE_GIT_REF_MAX_LEN,
      "WorktreeReuseCheckRequest.branchName",
    ),
  })
  .strict();

/**
 * The `repo.worktreeReuseCheck` result: at most one candidate, since the active-branch unique
 * index allows one live checkout per mount and branch. Branch, cleanliness and compatibility
 * are daemon verdicts, sent as decided booleans and a reason rather than raw git state.
 */
export interface WorktreeReuseCheckResponse {
  available: boolean;
  worktreeId?: WorktreeId | undefined;
  state?: WorktreeState | undefined;
  branchName?: string | undefined;
  isClean?: boolean | undefined;
  compatible?: boolean | undefined;
  reason?: string | undefined;
}
/** Wire schema for {@link WorktreeReuseCheckResponse}; single-T, as a read is no input. */
export const WorktreeReuseCheckResponseSchema: z.ZodType<WorktreeReuseCheckResponse> = z
  .object({
    // The only required field: true when a live candidate exists. The rest describe it, so
    // `{ available: false }` alone is a complete answer.
    available: z.boolean(),
    worktreeId: WorktreeIdSchema.optional(),
    // Full six-value vocabulary, not narrowed to live states: narrowing would encode a
    // cross-field rule this schema does not make.
    state: WorktreeStateSchema.optional(),
    // Echoed so the caller sees which branch the candidate holds.
    branchName: wireFreeFormString(
      WORKTREE_GIT_REF_MAX_LEN,
      "WorktreeReuseCheckResponse.branchName",
    ).optional(),
    // Daemon verdicts: `isClean` gates the dirty acknowledgement, and an incompatible candidate
    // never binds, acknowledged or not.
    isClean: z.boolean().optional(),
    compatible: z.boolean().optional(),
    // Populated when `!isClean || !compatible` (an emitter obligation). A short authored
    // summary, not raw porcelain output.
    reason: wireFreeFormString(
      WORKTREE_REUSE_REASON_MAX_LEN,
      "WorktreeReuseCheckResponse.reason",
    ).optional(),
  })
  .strict();

// Retirement is recorded before any disk work: the row transition and its `worktree.retired`
// event land first, and the async sweep stamps `cleaned_at` afterwards. Metadata and provenance
// survive retirement.

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
/** Wire schema for {@link WorktreeRetireResponse}; single-T, since a response is not an input. */
export const WorktreeRetireResponseSchema: z.ZodType<WorktreeRetireResponse> = z
  .object({
    worktreeId: WorktreeIdSchema,
    // The one success state; a refusal is the typed `worktree.retire_conflict` error, not a
    // response carrying the unchanged state.
    state: z.literal("retired"),
    kept: z.object({ removedWorktreeId: RemovedWorktreeIdSchema }).strict().optional(),
  })
  .strict();

/**
 * The code `repo.worktreeRetire` refuses with when a plain removal would lose something the
 * confirm did not show, or an agent runs in the tree.
 */
export type WorktreeRetireConflictCode = "worktree.retire_conflict";
/** The code of {@link WorktreeRetireConflictCode}. */
export const WORKTREE_RETIRE_CONFLICT_CODE: WorktreeRetireConflictCode = "worktree.retire_conflict";

/**
 * Why a removal was refused: `root_busy` (an agent runs in the tree, naming the workspace that
 * holds it) or `has_changes` (the tree has something to lose, ignored files included, and the
 * details carry the current risks so the confirm redraws them).
 */
export const WORKTREE_RETIRE_CONFLICT_REASONS = ["root_busy", "has_changes"] as const;
/** One of {@link WORKTREE_RETIRE_CONFLICT_REASONS}. */
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
    uncommittedFileCount: z.number().int().nonnegative(),
    ignoredFileCount: z.number().int().nonnegative(),
    unpushedCommitCount: z.number().int().nonnegative(),
    occupyingSessionIds: z.array(SessionIdSchema),
  })
  .strict();

/** The details a `worktree.retire_conflict` refusal carries, by its reason. */
export type WorktreeRetireConflictDetails =
  | { worktreeId: WorktreeId; reason: "root_busy"; holdingWorkspaceId: WorkspaceId }
  | { worktreeId: WorktreeId; reason: "has_changes"; risks: WorktreeRemovalRisks };
/** Wire schema for {@link WorktreeRetireConflictDetails}. */
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
 * One listed worktree, as its switcher row draws it.
 *
 * `name` is the tree's own name and `baseBranchName` the branch it was cut from
 * (`off <base>`). `ahead` and `behind` count commits against the branch's
 * upstream, read against the daemon's latest background fetch, and are absent
 * when the branch has none. `uncommittedFileCount` and `unpushedCommitCount` are
 * the same figures the removal confirm names; unpushed means not reachable from
 * any remote-tracking branch of the folder. `occupyingSessionIds` are the
 * sessions standing in the tree, and `runningSessionId` names the one whose
 * agent is running there, which locks the trash.
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
    branchName: wireFreeFormString(WORKTREE_GIT_REF_MAX_LEN, "WorktreeStatusRecord.branchName"),
    baseBranchName: wireFreeFormString(
      WORKTREE_GIT_REF_MAX_LEN,
      "WorktreeStatusRecord.baseBranchName",
    ),
    // A root under the daemon's worktrees folder, never a path inside the
    // attached checkout.
    fsRoot: wireFreeFormString(FILE_PATH_MAX_LEN, "WorktreeStatusRecord.fsRoot"),
    state: WorktreeStateSchema.refine(
      (state): state is ListedWorktreeState => state !== "retired",
      "A retired worktree is not listed",
    ),
    ahead: z.number().int().nonnegative().optional(),
    behind: z.number().int().nonnegative().optional(),
    uncommittedFileCount: z.number().int().nonnegative(),
    unpushedCommitCount: z.number().int().nonnegative(),
    occupyingSessionIds: z.array(SessionIdSchema),
    runningSessionId: SessionIdSchema.nullable(),
    createdBySessionId: SessionIdSchema,
    // Absent for a tree prepared before any run, which has no run to attribute.
    createdByRunId: RunIdSchema.optional(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
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
 * What the new-worktree form opens with, from the same daemon function that
 * creates the tree and names its folder: the fixed leading part of the name (the
 * project's branch pattern filled in up to `{title}`), the suggested tail derived
 * from the session's title, and the folder the tree will get up to that tail.
 * The form shows the folder as `folderBefore` followed by whatever tail is typed,
 * so it copies none of the daemon's naming.
 */
export interface NewWorktreeSuggestion {
  fixedPart: string;
  suggestedTail: string;
  folderBefore: string;
}

/**
 * The `repo.worktreeStatusRead` result.
 *
 * One read supplies every figure a switcher row draws, so it cannot show a tree as free while
 * another read calls it occupied. Only standing trees are listed, so a row never carries
 * `retired`; a copy kept by a discard is listed by `repo.removedWorktreeList`.
 * `repoRoot` is the project's own checkout and the branch it is on. `worktrees` lists the
 * project's standing trees, empty when it has none. `countsAsOf` is present when the last
 * background fetch failed, and says when the ahead and behind figures were last true.
 * `newWorktree` is present when the request named the asking session.
 */
export interface WorktreeStatusReadResponse {
  repoRoot: { path: string; branchName: string };
  worktrees: WorktreeStatusRecord[];
  countsAsOf?: string | undefined;
  newWorktree?: NewWorktreeSuggestion | undefined;
}
/** Wire schema for {@link WorktreeStatusReadResponse}; single-T, since a read is not an input. */
export const WorktreeStatusReadResponseSchema: z.ZodType<WorktreeStatusReadResponse> = z
  .object({
    repoRoot: z
      .object({
        path: wireFreeFormString(FILE_PATH_MAX_LEN, "WorktreeStatusReadResponse.repoRoot.path"),
        branchName: wireFreeFormString(
          WORKTREE_GIT_REF_MAX_LEN,
          "WorktreeStatusReadResponse.repoRoot.branchName",
        ),
      })
      .strict(),
    worktrees: z.array(worktreeStatusRecordSchema),
    countsAsOf: z.iso.datetime({ offset: true }).optional(),
    newWorktree: z
      .object({
        fixedPart: z.string().max(WORKTREE_GIT_REF_MAX_LEN),
        suggestedTail: wireFreeFormString(
          WORKTREE_GIT_REF_MAX_LEN,
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
