// ==========================================================================
// Execution-root preparation — Plan-010 T2.4.
// ==========================================================================
//
// The mode-dispatched orchestrator behind `repo.executionRootPrepare`, and the
// SOLE writer of `branch_contexts` (CP-010-6). Everything below is composition:
// this module materializes nothing itself. Worktrees come from T2.2, ephemeral
// clones from T2.3, and every `workspaces` mutation rides the Plan-009
// primitives (CP-010-2). What is genuinely ITS OWN is the ORDER — which refusal
// fires before which side effect — and the `branch_contexts` row.
//
// Spec coverage (Plan-010 Phase 2, T2.4):
//
// - `Spec-010 §Required Behavior` (one canonical mode) — `#requireKnownMode` +
//   the `#prepareWritableRoot` switch: exactly one canonical mode decides, and
//   an unreadable one is a loud defect, never a default.
// - `Spec-010 §Required Behavior` (branch is an explicit writable override) —
//   the `branch` arm: an override on the EXISTING checkout, verified bind-only.
// - `Spec-010 §Required Behavior` (no silent main-checkout fallback) — no arm
//   anywhere resolves the main checkout except `branch` mode, whose root IS the
//   main checkout by ratified design; every other failure refuses.
// - `Spec-010 §Fallback Behavior` (creation failure blocks in setup) —
//   `#failReprovision` on the materialization catch: the workspace lands
//   `stale` with the detail, which is what blocks the run in setup rather than
//   degrading it.
// - `Spec-010 §Fallback Behavior` (stale prepares refuse) — `assertWritable`
//   runs on writable arms whose bracket is closed — the open bracket's own
//   provisioner lawfully skips it — and on read-only, which needs the gate's
//   PERSISTENCE half. See `#resolveBindRoot`.
// - `Spec-010 §State And Data Implications` (branch context per writable mode)
//   — `#writeBranchContext`: a row for each of the three writable modes,
//   polymorphic in WHICH root column it fills, and none at all for `read-only`.
// - `Spec-010 §Resolved Questions and V1 Scope Decisions` (branch-mode
//   bind-only verification) — `#verifyBranchModeBind`: `symbolic-ref` compare,
//   `workspace.branch_mismatch` on disagreement.
//
// Invariants (`Plan-010 §Invariants`):
//
// - I-010-5  — every prepared root is representable as ONE `branch_contexts`
//              row. The polymorphism is enforced by the table's CHECK, and this
//              module never fills both root columns: each write site names one.
// - I-010-6  — the main checkout is never mutated. `branch` mode's only git
//              call is a READ (`symbolic-ref`), and the disagreement case
//              REFUSES rather than switching branches. See `#runGit`.
// - I-010-7  — no silent mode substitution. The mode comes off the row, the
//              switch is exhaustive, and every arm either returns ITS mode's
//              root or throws.
// - I-010-11 — workspace writes ride the Plan-009 primitives exclusively. This
//              module holds NO `workspaces` write statement; see the header
//              section below.
// - I-010-12 — `assertWritable` precedes every writable-mode prepare that finds
//              the CP-010-2 bracket closed; when it runs, it runs first —
//              before argument resolution and before any git call. The invariant
//              is a FLOOR, not an exclusivity claim: the read-only arm calls the
//              same gate for the reason `#resolveBindRoot` gives, and satisfying
//              a floor on a path it does not quantify over amends nothing.
//
// ## Why the primitives arrive as ONE object, not four functions
//
// `./ephemeral-clone-service.ts` takes its single CP-010-2 primitive as a bare
// function, and that shape does not transfer here. This module needs FOUR, and
// the load-bearing fact about them is not their individual signatures — it is
// that they must all be the SAME workspace authority. `assertWritable`'s verdict
// and `beginReprovision`'s compare-and-swap are only meaningful together if they
// read and write the same rows on the same connection; four independently-passed
// functions let a composition root satisfy the types while wiring two different
// services, and nothing here could detect it. {@link WorkspaceLifecyclePrimitives}
// makes "one authority" a type-level fact instead of a wiring convention, and the
// real `WorkspaceService` satisfies it structurally — its extra optional
// `options` parameters do not block assignability — so the composition root can
// pass the service itself.
//
// ## I-010-11, structurally
//
// No statement prepared in this file writes the `workspaces` table. Every write
// statement here targets `branch_contexts`; the reads span `workspaces`,
// `repo_mounts` and `branch_contexts`. The invariant holds because this module
// OWNS no workspace writer, not because it remembers not to use one — the same
// posture, and the same reasoning, as `../git/ephemeral-clone-service.ts`'s
// injected beginner. The suite asserts it by scanning this source, so keep the
// prose free of literal write statements naming that table.
//
// Workspace READS are not restricted and are used freely: dispatching on the
// selected mode requires reading it, and I-010-11 quantifies over writes.
//
// ## Ordering: what happens before the workspace is touched
//
// Every refusal that a caller could have avoided fires BEFORE `beginReprovision`,
// so a refused prepare leaves the workspace exactly where it was:
//
//   1. `assertWritable`               (CP-010-3, I-010-12 — see the residual on
//                                      the open-bracket exemption)
//   2. branch-name resolution          (D-010-19 — `workspace.branch_name_required`)
//   3. busy refusal                    (`Spec-010 §State And Data Implications` — `workspace.busy`)
//   4. `branch`-mode bind verification (D-010-9 — `workspace.branch_mismatch`)
//   ---- the workspace is now committed to `provisioning` ----
//   5. materialize (T2.2 / T2.3)
//   6. write `branch_contexts`
//   7. `completeReprovision(workspaceId, root)`   |  `failReprovision(id, detail)`
//   8. only when step 7 itself fails: compensate the root nothing will adopt
//      (`#compensateOrphanedRoot`)
//
// Steps 1-4 are deliberately outside the try/catch. `failReprovision`'s only
// legal predecessor is `provisioning`, so calling it from a pre-bracket refusal
// would trade a typed 4xx-shaped carrier for Plan-009's anonymous invariant
// error — the caller would learn that something went wrong instead of what.
//
// Step 4 sits before the bracket for a second reason: `Spec-010 §Fallback
// Behavior` reserves `stale` for FAULTS, and a branch mismatch is a caller
// disagreement, not a fault. Marking the workspace stale for it would make a
// well-formed refusal look like broken provisioning.
//
// Step 6 sits before step 7 so that a `branch_contexts` write failure lands on
// the failure path. A `ready` workspace whose root has no branch context would
// satisfy I-010-5 vacuously while leaving Plan-011 nothing to attribute against.
//
// ## RESIDUALS
//
// - **`assertWritable` is skipped when the workspace already sits `provisioning`,
//   and I-010-12 / CP-010-3 are scoped to say so.** As first ratified, the gate
//   preceded EVERY writable prepare; `repo.workspaceBind` lands writable
//   workspaces in `provisioning`; and `WorkspaceService.assertWritable` raises
//   for `provisioning`. All three could not hold. Skipping the gate inside the
//   open bracket is the only reading under which the primary paths work at all,
//   and it costs nothing the gate was protecting — `stale` and `archived` are
//   still refused, by the gate, on every closed-bracket prepare, and a `stale`
//   workspace can never sit `provisioning` (states are exclusive). The rejected
//   readings both lose more: gating unconditionally refuses every first-bind and
//   post-retirement clone prepare, and widening `assertWritable` to admit
//   `provisioning` would weaken a Plan-009 guard for every OTHER caller of it.
//
// - **`base_branch` for `ephemeral clone` mode self-anchors ONLY when no branch
//   referenced the source's HEAD commit.** T2.3 observes the branch its clone was
//   cut from and reports it on `PreparedEphemeralClone.baseBranch`, so the
//   recorded base is now a measurement in the ordinary case. It is absent exactly
//   when the CLONE's own HEAD lands detached — which takes a source HEAD commit
//   no branch references, since `git clone` resolves the remote HEAD to a branch
//   naming it — a lawful outcome there, not a failure — and `base_branch` is
//   `TEXT NOT NULL`, so something must still be written. The fallback records the
//   head branch, which is the one true statement available: a clone whose own
//   HEAD landed detached has no branch it descends from. What that cannot express
//   is the COMMIT it descends from, which is the honest answer and needs a column
//   no ratified surface has. Plan-011's recorded-context extension is where that
//   belongs; until then the fallback is indistinguishable from a genuine
//   self-anchor, and only for those unreferenced-commit clones.
//
// - **`base_branch` for `branch` mode self-anchors too**, and for a stronger
//   reason: branch mode CUTS NOTHING. It binds a branch that already exists, so
//   there is no cut point to record, and the daemon cannot observe an integration
//   target without inventing one. `ExecutionRootPrepareRequest.baseRef` is not
//   pressed into service here — that field is documented worktree-scoped ("the
//   daemon reads HEAD, and the schema cannot", at `baseRef`), and repurposing it
//   would give one wire field two meanings depending on a mode the caller may not
//   know.
//
// - **Branch mode INSERTS one row per prepare rather than refreshing one.**
//   D-010-15 ratifies upsert semantics for the WORKTREE pair, which is where T1.3
//   minted a partial-unique index; branch-mode rows fill neither root column, so no
//   index arbitrates them and the plan is silent. Accumulating is the reading that
//   assumes least. `BranchContextReadRequest` has no workspace-only arm, so nothing
//   needs a one-row-per-workspace resolution rule; the clone arm already inserts per
//   prepare under exactly the same silence; and Plan-011 reaches a specific row
//   through `run_execution_contexts.branch_context_id` rather than by resolving a
//   workspace's "current" one. Refreshing in place would additionally DESTROY the
//   previous binding's base and head branches — provenance no other row carries.
//
// - **`holdingRunId` is read out of `workspaces.metadata` by JSON path here.**
//   Plan-009 exports neither its `readHoldingRunId` nor the path constant, and the
//   alternative — passing `null` — would put "this row carries no attribution" on
//   the wire for a row that carries one. The duplication is one string, and the
//   key is ratified vocabulary rather than an implementation detail.
//
// - **The busy check reads a snapshot.** A workspace that becomes busy between
//   the read and `beginReprovision` is not refused here; it is refused there, by
//   `#refuseIllegalPredecessor`, which raises the SAME `WorkspaceBusyError` this
//   module raises and carries the same holding-run attribution. So the window costs
//   an extra round trip, never answer quality. Nothing short of a row lock closes
//   it, and Plan-010 ratifies none.

import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { Database, Statement } from "better-sqlite3";

import {
  ExecutionModeSchema,
  WorkspaceStateSchema,
  type ExecutionMode,
  type WorkspaceState,
} from "@ai-sidekicks/contracts";

import type {
  PrepareEphemeralCloneInput,
  PreparedEphemeralClone,
} from "../git/ephemeral-clone-service.js";
import {
  WorkspaceBranchMismatchError,
  WorkspaceBranchNameRequiredError,
} from "../git/worktree-errors.js";
import {
  deriveWorktreeBranchName,
  type CreateWorktreeInput,
  type CreatedWorktree,
  type ReusableWorktreeCandidate,
  type ValidateWorktreeReuseInput,
} from "../git/worktree-service.js";
import { DaemonDomainError } from "../ipc/domain-error.js";

import { RepoMountNotFoundError } from "./repo-errors.js";
import {
  WorkspaceBusyError,
  WorkspaceNotFoundError,
  WorkspaceStaleError,
} from "./workspace-service.js";

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

/**
 * Two minutes, matching the worktree service's ceiling — NOT the clone
 * service's, which deliberately runs ten (a large-repository `git clone` is
 * its normal case; this module's only git call is a `symbolic-ref` read).
 */
const DEFAULT_EXECUTION_ROOT_GIT_TIMEOUT_MS = 120_000;

/**
 * The empty directory `core.hooksPath` points at (I-010-10). Spelled the same as
 * `../git/worktree-service.ts`'s segment ON PURPOSE — both resolve against the
 * same `executionRootsDirectory`, so they name the same directory, and one
 * neutralization directory shared by every provisioning service is the point.
 */
const HOOK_NEUTRALIZATION_SEGMENT = ".hook-neutralization";

/**
 * Plan-009's `workspaces.metadata` key for the run holding a `busy` workspace.
 * Duplicated rather than imported — see the header's residual on it.
 */
const HOLDING_RUN_ID_METADATA_PATH = "$.holdingRunId";

/**
 * What `currentBranchName` carries when the main checkout is on a detached HEAD.
 *
 * D-010-9's refusal needs a value for a checkout that is on no branch at all. A
 * space is not a legal git ref character, so this string cannot be confused with
 * a real branch name by any reader, human or machine — which is what keeps the
 * comparison in `WorkspaceBranchMismatchError`'s message honest.
 */
const DETACHED_HEAD_BRANCH_LABEL = "(detached HEAD)";

/**
 * What `symbolic-ref --quiet` exits with when HEAD is on no branch.
 *
 * `--quiet` is what makes this a STATUS rather than a diagnostic: without it the
 * command writes an error to `stderr`, and the same 1 would be indistinguishable
 * from a usage failure. Anything other than 0 or this is infrastructure — see
 * `#verifyBranchModeBind`.
 */
const DETACHED_HEAD_EXIT_CODE = 1;

// --------------------------------------------------------------------------
// Seams
// --------------------------------------------------------------------------

/** One git invocation's captured output. */
export interface ExecutionRootGitInvocationResult {
  /**
   * The process's exit status.
   *
   * Load-bearing, not diagnostic: `symbolic-ref --quiet` reports a detached HEAD
   * by EXITING 1 with empty output, which is a legitimate answer, while a missing
   * binary or an unreadable repository is not. Without this field both arrive as
   * the same rejection and `#verifyBranchModeBind` cannot tell "git said no
   * branch" from "git never answered" — so it would report an infrastructure
   * fault to the caller as a branch disagreement they could not act on.
   */
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Per-invocation bounds. */
export interface ExecutionRootGitInvocationOptions {
  /** Wall-clock ceiling; the child is killed past it. */
  readonly timeoutMs: number;
}

/**
 * The git process seam.
 *
 * Takes the COMPLETE argv — including `-C <dir>` — and no working directory, for
 * the reason `../git/worktree-service.ts` gives at its own runner: I-010-6 is
 * asserted by inspecting recorded argvs, and a suite that cannot see WHICH
 * repository a command ran against cannot tell a read of the main checkout from a
 * mutation of it.
 *
 * Declared locally rather than reusing Plan-009's `GitFileExecutor`
 * (`./repo-root-resolver.js`) or T2.2's `WorktreeGitRunner`: the first takes the
 * executable and a per-call env policy this module does not have, and importing
 * the second would make one service's seam the other's public contract for no
 * gain — they are the same three lines and neither owns the other.
 *
 * RESOLVES whenever the process RAN, whatever it exited with; it rejects only
 * when there was no exit status to report — a spawn failure, or a kill past
 * {@link ExecutionRootGitInvocationOptions.timeoutMs}. That split is what makes
 * {@link ExecutionRootGitInvocationResult.exitCode} readable as an answer.
 *
 * Rejections are opaque: nothing reads a field off the thrown value, which keeps
 * git's `stderr` out of every typed carrier this module raises.
 */
export type ExecutionRootGitRunner = (
  argv: readonly string[],
  options: ExecutionRootGitInvocationOptions,
) => Promise<ExecutionRootGitInvocationResult>;

/** The filesystem seam. One verb: create leading directories, tolerate existing. */
export interface ExecutionRootFilesystem {
  createDirectory(path: string): Promise<void>;
}

/**
 * The T2.2 surface this module consumes, narrowed to the two methods it calls.
 *
 * A structural port rather than `import type { WorktreeService }`: the concrete
 * class also owns retirement and the sweep, and a type that admits those would
 * let a later edit here reach them. The DATA types are imported rather than
 * re-declared — one definition of `CreateWorktreeInput` is the point; only the
 * method surface is narrowed.
 */
export interface ExecutionRootWorktreeProvisioner {
  create(input: CreateWorktreeInput): Promise<CreatedWorktree>;
  validateReuse(input: ValidateWorktreeReuseInput): Promise<ReusableWorktreeCandidate>;
  /**
   * Compensation only — see `#compensateOrphanedRoot`. Records the retirement and
   * removes nothing from disk (I-010-9); the sweep reclaims the root later.
   *
   * `Promise<unknown>` because this module ignores the response. Naming T2.2's
   * response type here would import a shape for a value nothing reads, and
   * `Promise<void>` would not admit the real method, whose response is not `void`.
   */
  retire(worktreeId: string): Promise<unknown>;
}

/** The T2.3 surface this module consumes: preparation, and compensation for it. */
export interface ExecutionRootClonePreparer {
  prepare(input: PrepareEphemeralCloneInput): Promise<PreparedEphemeralClone>;
  /** Compensation only. `Promise<unknown>` for the reason `retire` gives. */
  dispose(cloneId: string): Promise<unknown>;
}

/**
 * The four Plan-009 workspace primitives (CP-010-2 / CP-010-3), as ONE authority.
 *
 * See the header for why these arrive grouped. `WorkspaceService` is assignable
 * as written — each method's trailing `options` parameter is optional, and a
 * function may always be passed where a shorter signature is expected.
 */
export interface WorkspaceLifecyclePrimitives {
  /** CP-010-3's gate. Passes `ready` / `busy`; refuses `stale`; defect otherwise. */
  assertWritable(workspaceId: string): Promise<void>;
  /** `ready` | `stale` -> `provisioning`, releasing the old root. */
  beginReprovision(workspaceId: string, targetMode: ExecutionMode): Promise<void>;
  /** `provisioning` -> `ready`, adopting `fsRoot`. */
  completeReprovision(workspaceId: string, fsRoot: string): Promise<void>;
  /** `provisioning` -> `stale`, recording `failureDetail` as `metadata.lastError`. */
  failReprovision(workspaceId: string, failureDetail: string): Promise<void>;
}

export interface ExecutionRootServiceDeps {
  /**
   * The daemon's SQLite handle. Statements are prepared once, in the constructor.
   *
   * SHOULD be the connection {@link workspaces} writes through: this module reads
   * the workspace row that the primitives then transition, and a divergent handle
   * would let it dispatch on a mode another connection has already changed.
   * Nothing here can verify it — the primitives arrive behind an interface — so
   * the composition root owns the constraint.
   */
  readonly database: Database;
  /** The Plan-009 primitives — the ONLY `workspaces` write channel (I-010-11). */
  readonly workspaces: WorkspaceLifecyclePrimitives;
  /** T2.2. Consumed by the `worktree` arm. */
  readonly worktrees: ExecutionRootWorktreeProvisioner;
  /** T2.3. Consumed by the `ephemeral clone` arm. */
  readonly clones: ExecutionRootClonePreparer;
  /**
   * The daemon's execution-roots directory (D-010-6). Not a placement input here
   * — T2.2 and T2.3 place their own roots — but the hook-neutralization directory
   * is its child, and it must be the SAME one those services resolve against or
   * `#runGit` would point `core.hooksPath` at a directory nobody created.
   */
  readonly executionRootsDirectory: string;
  /**
   * Git process seam. REQUIRED, unlike the sibling services' optional-with-default
   * shape: neither `./repo-root-resolver.ts` nor `../git/worktree-service.ts`
   * exports a reusable executor (the resolver exports only the type and its
   * env-scrub constants; the worktree service's default is module-private), so a
   * default here would mean a THIRD hand-rolled `execFile` wrapper in the daemon.
   * One line of composition-root wiring is the cheaper of the two.
   */
  readonly git: ExecutionRootGitRunner;
  /** Filesystem seam. REQUIRED, for the same reason. */
  readonly filesystem: ExecutionRootFilesystem;
  /** Per-invocation git timeout; defaults to two minutes. */
  readonly gitCommandTimeoutMs?: number;
  /** Wall clock for `created_at` / `updated_at`. Injectable for tests. */
  readonly now?: () => string;
  /** `branch_contexts.id` source. Injectable for deterministic tests. */
  readonly newBranchContextId?: () => string;
}

// --------------------------------------------------------------------------
// Inputs and results
// --------------------------------------------------------------------------

/**
 * `repo.executionRootPrepare`'s daemon-side input.
 *
 * Mirrors `ExecutionRootPrepareRequest` with two differences, both from D-010-19.
 * The ids are plain strings — branding is the binder's job, and this service is
 * also called from the run-setup gate, which holds row values rather than parsed
 * wire scalars. And `runId` exists here but NOT on the wire: it is the gate's
 * evidence that a run is being set up, which is what makes the `run-<short-8>`
 * branch-name fallback lawful. A wire caller cannot supply it, so a wire caller
 * cannot reach the fallback.
 */
export interface PrepareExecutionRootInput {
  readonly workspaceId: string;
  /**
   * REQUIRED for writable modes in practice, optional in shape: a call carrying
   * neither this nor {@link runId} refuses `workspace.branch_name_required`.
   * Ignored entirely by `read-only`, which creates no branch.
   */
  readonly branchName?: string;
  /** The worktree base (D-010-8). Worktree-scoped; see the header's residual. */
  readonly baseRef?: string;
  /** EXPLICIT reuse only (I-010-8): a candidate binds by being named. */
  readonly reuseWorktreeId?: string;
  /** The separate consent that binds a DIRTY named candidate (D-010-15). */
  readonly acknowledgeDirtyCandidate?: boolean;
  /** Gate-only. Present iff a run is being set up; unlocks the branch fallback. */
  readonly runId?: string;
  /** Branch-collision disposition for a worktree CREATE. Defaults to `refuse`. */
  readonly onCollision?: "refuse" | "suffix";
}

/**
 * A resolved execution root.
 *
 * Plain strings rather than the wire brands, and a superset of
 * `ExecutionRootPrepareResponse`: `executionMode` and `branchName` are here
 * because the run-setup gate needs both for `run_execution_contexts` and neither
 * is on the response. The binder projects; it does not reconstruct.
 */
export interface PreparedExecutionRoot {
  readonly workspaceId: string;
  /** The mode that was dispatched. Never substituted (I-010-7). */
  readonly executionMode: ExecutionMode;
  /** Absolute. The directory the run executes in. */
  readonly executionRoot: string;
  /** The workspace's position AFTER the bracket. `ready` on every writable success. */
  readonly state: WorkspaceState;
  /** The bound head branch. Absent for `read-only`, which binds none. */
  readonly branchName?: string;
  /** Present for `worktree` mode only. */
  readonly worktreeId?: string;
  /** Present for `ephemeral clone` mode only. */
  readonly ephemeralCloneId?: string;
  /** Present for all three WRITABLE modes; absent for `read-only`. */
  readonly branchContextId?: string;
}

// --------------------------------------------------------------------------
// Defect carrier
// --------------------------------------------------------------------------

/** What {@link ExecutionRootServiceInvariantError} reports. */
export type ExecutionRootInvariantKind =
  /** A `workspaces` row carries a mode or state outside the ratified vocabulary. */
  | "unreadable_workspace_row"
  /** A read-only workspace sits in a state that cannot serve a root. */
  | "read_only_workspace_unusable"
  /** A reuse candidate has no `branch_contexts` row to carry a base branch from. */
  | "reuse_candidate_without_branch_context"
  /** A `branch_contexts` write reported a row count this module cannot explain. */
  | "branch_context_write_lost"
  /** `symbolic-ref` could not be run, or answered with a status D-010-9 cannot read. */
  | "branch_verification_failed";

/**
 * A DEFECT, not a refusal — deliberately not a `DaemonDomainError`.
 *
 * Every condition here means the daemon's own state is unreadable or its own
 * write did not land. None is something a caller can fix by retrying or by
 * sending different arguments, so none earns a wire code; giving them one would
 * put a repair affordance on the wire that does not exist. Mirrors
 * `WorkspaceServiceInvariantError`'s posture in `./workspace-service.ts`.
 *
 * Messages carry ids, never paths — the `error-contracts.md §Worktree`
 * no-path-echo rule applies to anything that can reach a log.
 */
export class ExecutionRootServiceInvariantError extends Error {
  /** What broke. */
  readonly kind: ExecutionRootInvariantKind;
  /** The row this failure attaches to, or `null` when no row is implicated. */
  readonly workspaceId: string | null;

  constructor(
    message: string,
    options: {
      readonly kind: ExecutionRootInvariantKind;
      readonly workspaceId?: string | null;
      readonly cause?: unknown;
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    // The class name comes from the constructor that ran, not from a literal a
    // subclass would have to remember to update.
    this.name = new.target.name;
    this.kind = options.kind;
    this.workspaceId = options.workspaceId ?? null;
  }
}

// --------------------------------------------------------------------------
// Row and parameter shapes
// --------------------------------------------------------------------------

interface WorkspaceLookupParams {
  readonly workspace_id: string;
}

interface MountLookupParams {
  readonly repo_mount_id: string;
}

interface WorktreeContextLookupParams {
  readonly worktree_id: string;
}

interface WorktreePairLookupParams {
  readonly worktree_id: string;
  readonly workspace_id: string;
}

interface BranchContextWriteParams {
  readonly id: string;
  readonly workspace_id: string;
  readonly worktree_id: string | null;
  readonly ephemeral_clone_id: string | null;
  readonly base_branch: string;
  readonly head_branch: string;
  readonly now: string;
}

interface BranchContextDeleteParams {
  readonly id: string;
}

interface WorkspaceRootRow {
  readonly id: string;
  readonly session_id: string;
  readonly repo_mount_id: string;
  readonly execution_mode: string;
  readonly fs_root: string | null;
  readonly state: string;
  readonly holding_run_id: string | null;
}

interface AttachedMountRow {
  readonly id: string;
  readonly canonical_root: string;
}

interface BusyWorktreeHolderParams {
  readonly worktree_id: string;
}

interface BusyWorktreeHolderRow {
  readonly workspace_id: string;
  readonly holding_run_id: string | null;
}

interface BranchContextIdRow {
  readonly id: string;
}

interface BranchContextBaseRow {
  readonly base_branch: string;
}

/** A read-only workspace's position and the root it can serve from. */
interface ServableBindRow {
  readonly state: WorkspaceState;
  readonly executionRoot: string;
}

/** The three writable modes — every mode that reaches `#prepareWritableRoot`. */
type WritableExecutionMode = Exclude<ExecutionMode, "read-only">;

/**
 * How a root came to be. Named for the ORIGIN rather than for what compensation
 * does with it, because the distinction is a fact about the root either way.
 *
 * - `created` — this call brought the root into existence, so this call is the
 *   only party that can be holding it. The one value compensation may act on.
 * - `reused` — a PRE-EXISTING worktree, possibly bound by other workspaces.
 *   Retiring it would destroy state this call did not create.
 * - `bound` — branch mode, which materializes nothing: the root is the user's own
 *   main checkout, and there is nothing to compensate even in principle (I-010-6).
 */
type ExecutionRootProvenance = "created" | "reused" | "bound";

/** What one mode arm produced, before the branch context and the bracket close. */
interface MaterializedRoot {
  readonly executionRoot: string;
  readonly branchName: string;
  readonly baseBranch: string;
  readonly worktreeId: string | null;
  readonly ephemeralCloneId: string | null;
  readonly provenance: ExecutionRootProvenance;
}

// --------------------------------------------------------------------------
// Service
// --------------------------------------------------------------------------

/**
 * Prepares the execution root for a repo-bound workspace, dispatching on the
 * mode the workspace already selected.
 *
 * The mode is READ, never chosen: `repo.workspaceBind` decided it, and I-010-7
 * makes substituting a different one at preparation time a contract break. A mode
 * that cannot be served refuses by name.
 */
export class ExecutionRootService {
  readonly #workspaces: WorkspaceLifecyclePrimitives;
  readonly #worktrees: ExecutionRootWorktreeProvisioner;
  readonly #clones: ExecutionRootClonePreparer;
  readonly #git: ExecutionRootGitRunner;
  readonly #filesystem: ExecutionRootFilesystem;
  readonly #hookNeutralizationDirectory: string;
  readonly #gitCommandTimeoutMs: number;
  readonly #now: () => string;
  readonly #newBranchContextId: () => string;

  readonly #selectWorkspaceStmt: Statement<WorkspaceLookupParams, WorkspaceRootRow>;
  readonly #selectAttachedMountStmt: Statement<MountLookupParams, AttachedMountRow>;
  readonly #selectWorktreeBaseBranchStmt: Statement<
    WorktreeContextLookupParams,
    BranchContextBaseRow
  >;
  readonly #selectBusyWorktreeHolderStmt: Statement<
    BusyWorktreeHolderParams,
    BusyWorktreeHolderRow
  >;
  readonly #selectWorktreePairContextStmt: Statement<WorktreePairLookupParams, BranchContextIdRow>;
  readonly #upsertWorktreeContextStmt: Statement<BranchContextWriteParams>;
  readonly #insertBranchContextStmt: Statement<BranchContextWriteParams>;
  readonly #deleteBranchContextStmt: Statement<BranchContextDeleteParams>;

  constructor(deps: ExecutionRootServiceDeps) {
    this.#workspaces = deps.workspaces;
    this.#worktrees = deps.worktrees;
    this.#clones = deps.clones;
    this.#git = deps.git;
    this.#filesystem = deps.filesystem;
    // `join` rather than string concatenation, so the spelling is byte-identical
    // to the sibling services' — they resolve the same directory the same way,
    // and a path that differed only in separators would be a SECOND directory.
    this.#hookNeutralizationDirectory = join(
      deps.executionRootsDirectory,
      HOOK_NEUTRALIZATION_SEGMENT,
    );
    this.#gitCommandTimeoutMs = deps.gitCommandTimeoutMs ?? DEFAULT_EXECUTION_ROOT_GIT_TIMEOUT_MS;
    this.#now = deps.now ?? ((): string => new Date().toISOString());
    this.#newBranchContextId = deps.newBranchContextId ?? ((): string => randomUUID());

    const database = deps.database;

    // `holding_run_id` is projected in the SELECT rather than parsed in JS: the
    // JSON path is SQLite's to evaluate, and a projected column keeps the row
    // type flat instead of carrying a `metadata` blob nothing else here reads.
    this.#selectWorkspaceStmt = database.prepare(
      `SELECT id,
              session_id,
              repo_mount_id,
              execution_mode,
              fs_root,
              state,
              json_extract(metadata, '${HOLDING_RUN_ID_METADATA_PATH}') AS holding_run_id
         FROM workspaces
        WHERE id = @workspace_id`,
    );

    // Scoped to `attached`, matching the Plan-009 ordering obligation the sibling
    // services take: a detached mount is not a provisioning target.
    this.#selectAttachedMountStmt = database.prepare(
      `SELECT id, canonical_root
         FROM repo_mounts
        WHERE id = @repo_mount_id AND state = 'attached'`,
    );

    // Step (3b)'s busy-holder probe (`Spec-010 §State And Data Implications`,
    // the busy bullet): is a run executing in the reuse CANDIDATE's directory?
    // Joined on `fs_root` like T2.3's sweep predicates rather than through
    // `branch_contexts` — this service's own compensation deletes pair rows
    // while roots stay live, so the path is the one link that cannot be severed
    // out from under the probe — and keyed by the candidate's ROW ID so the
    // probe runs pre-bracket with nothing but the request in hand. A candidate
    // this read cannot resolve answers nothing here; `validateReuse` owns that
    // refusal taxonomy. `json_extract` mirrors `#selectWorkspaceStmt`'s
    // projection of the same metadata key.
    this.#selectBusyWorktreeHolderStmt = database.prepare(
      `SELECT holder.id AS workspace_id,
              json_extract(holder.metadata, '${HOLDING_RUN_ID_METADATA_PATH}') AS holding_run_id
         FROM worktrees
         JOIN workspaces AS holder ON holder.fs_root = worktrees.fs_root
        WHERE worktrees.id = @worktree_id
          AND holder.state = 'busy'
        LIMIT 1`,
    );

    // The carry-over source for an explicit reuse. EARLIEST row wins: it is the
    // one written when the worktree was created, so it names the branch the
    // worktree was actually cut from. A later row belongs to a different
    // workspace's binding and carries the same base forward, so the ordering is
    // stable rather than merely deterministic. `id` breaks a `created_at` tie —
    // an injected clock can hand two rows the same instant.
    this.#selectWorktreeBaseBranchStmt = database.prepare(
      `SELECT base_branch
         FROM branch_contexts
        WHERE worktree_id = @worktree_id
        ORDER BY created_at ASC, id ASC
        LIMIT 1`,
    );

    this.#selectWorktreePairContextStmt = database.prepare(
      `SELECT id
         FROM branch_contexts
        WHERE worktree_id = @worktree_id AND workspace_id = @workspace_id`,
    );

    // D-010-15's upsert, arbitrated by T1.3's partial-unique
    // `(worktree_id, workspace_id)` index — the conflict target repeats the
    // index's WHERE clause because SQLite requires a partial index to be named
    // that way. The `@id` bound here is DISCARDED on the update arm, which is
    // why the caller re-reads the row id rather than assuming it minted one.
    this.#upsertWorktreeContextStmt = database.prepare(
      `INSERT INTO branch_contexts (
              id, workspace_id, worktree_id, ephemeral_clone_id,
              base_branch, head_branch, created_at, updated_at
            )
       VALUES (
              @id, @workspace_id, @worktree_id, @ephemeral_clone_id,
              @base_branch, @head_branch, @now, @now
            )
       ON CONFLICT (worktree_id, workspace_id) WHERE worktree_id IS NOT NULL
       DO UPDATE SET base_branch = excluded.base_branch,
                     head_branch = excluded.head_branch,
                     updated_at  = excluded.updated_at`,
    );

    this.#insertBranchContextStmt = database.prepare(
      `INSERT INTO branch_contexts (
              id, workspace_id, worktree_id, ephemeral_clone_id,
              base_branch, head_branch, created_at, updated_at
            )
       VALUES (
              @id, @workspace_id, @worktree_id, @ephemeral_clone_id,
              @base_branch, @head_branch, @now, @now
            )`,
    );

    // Compensation's first leg. Keyed on the row id ALONE, never on a workspace or
    // a worktree, so it can only ever reach the one row the failing call inserted.
    this.#deleteBranchContextStmt = database.prepare(
      `DELETE FROM branch_contexts
        WHERE id = @id`,
    );
  }

  // ------------------------------------------------------------------------
  // prepare
  // ------------------------------------------------------------------------

  /**
   * Resolve — and for writable modes, materialize — the workspace's execution
   * root.
   *
   * @throws {WorkspaceNotFoundError} when the workspace id does not resolve.
   * @throws {WorkspaceStaleError} when the workspace's root is gone
   *   (`Spec-010 §Fallback Behavior`).
   * @throws {WorkspaceBusyError} when another run holds the root
   *   (`Spec-010 §State And Data Implications`).
   * @throws {WorkspaceBranchNameRequiredError} on a writable prepare carrying
   *   neither a branch name nor a run id (D-010-19).
   * @throws {WorkspaceBranchMismatchError} when `branch` mode's checkout is on a
   *   different branch (D-010-9). The checkout is left untouched.
   * @throws {RepoMountNotFoundError} when the workspace's mount is not attached.
   */
  async prepare(input: PrepareExecutionRootInput): Promise<PreparedExecutionRoot> {
    const workspace = this.#requireWorkspace(input.workspaceId);
    const executionMode = this.#requireKnownMode(workspace);

    if (executionMode === "read-only") {
      return this.#resolveBindRoot(workspace);
    }
    return this.#prepareWritableRoot(input, workspace, executionMode);
  }

  // ------------------------------------------------------------------------
  // read-only
  // ------------------------------------------------------------------------

  /**
   * The `read-only` arm: report the root the BIND resolved, materializing
   * nothing.
   *
   * `workspaces.fs_root` is the source, NOT the mount's canonical root. A
   * read-only bind may target a subdirectory (`repo.workspaceBind` validates a
   * caller-supplied `directory` for containment and stores the result), and
   * CP-009-8 hands `fs_root` to Plan-012 as the approval scope root — answering
   * with the mount root would silently WIDEN that scope from the subtree the
   * caller was granted to the whole repository.
   *
   * No reprovision bracket and no `branch_contexts` row:
   * `Spec-010 §State And Data Implications` scopes the branch context to the
   * three writable modes, and there is nothing to reprovision when nothing is
   * materialized.
   *
   * ## Why a gate named for WRITES runs on a read-only path
   *
   * Not for its verdict — the partition in `#requireServableBindRow` already knows
   * which states can serve a root. For its PERSISTENCE. Observing that a root has
   * vanished obliges the daemon to RECORD the stale transition, and that record is
   * a `workspaces` write, which I-010-11 forbids this module from making. Plan-009's
   * gate is the one lawful surface that both probes and persists: a local probe seam
   * could observe the vanished root and would then have nowhere to put the finding,
   * leaving the next `list` to answer `ready` for a workspace this call already knows
   * is not. An unobserved-but-unrecorded staleness is the worse failure, because
   * CP-009-8 hands `fs_root` to Plan-012 as an approval scope.
   *
   * I-010-12 is a FLOOR — the gate precedes every writable prepare — not a claim
   * that writable prepares are its only lawful callers. Satisfying it on a path it
   * does not quantify over amends no plan.
   *
   * The partition runs on BOTH sides of the gate, for two different reasons. Before,
   * because `assertWritable` answers `archived` and `provisioning` with Plan-009's
   * anonymous invariant error where this module has a kind that names the actual
   * condition, and because a NULL `fs_root` under a probe-bearing state reaches
   * Plan-009's health projector as a NULL-root precondition failure rather than as
   * staleness. After, because the gate AWAITS, and a concurrent writer can move the
   * row while it does.
   */
  async #resolveBindRoot(workspace: WorkspaceRootRow): Promise<PreparedExecutionRoot> {
    // Guard only; the answer comes from the post-gate read below.
    this.#requireServableBindRow(workspace);

    await this.#workspaces.assertWritable(workspace.id);

    const observed = this.#requireWorkspace(workspace.id);
    const servable = this.#requireServableBindRow(observed);

    return {
      workspaceId: observed.id,
      executionMode: "read-only",
      executionRoot: servable.executionRoot,
      state: servable.state,
    };
  }

  /**
   * The states and roots a read-only workspace can serve from — ONE partition,
   * applied on both sides of the gate.
   *
   * `stale` and a released root give the same answer, because they are the same
   * fact and carry the same repair (re-bind). `provisioning` and `archived` are
   * local defects: a read-only bind is born `ready` and has no reprovision cycle,
   * so either state means something moved the row somewhere it cannot serve from.
   */
  #requireServableBindRow(workspace: WorkspaceRootRow): ServableBindRow {
    const state = this.#requireKnownState(workspace);

    if (state === "stale") {
      throw new WorkspaceStaleError(workspace.id);
    }
    if (state !== "ready" && state !== "busy") {
      throw new ExecutionRootServiceInvariantError(
        `read-only workspace ${workspace.id} cannot serve an execution root from state ${state}`,
        { kind: "read_only_workspace_unusable", workspaceId: workspace.id },
      );
    }
    if (workspace.fs_root === null) {
      // A read-only bind always stores a root, so a NULL here means something
      // released it — `beginReprovision` is the only writer that does. Reported as
      // stale rather than as a defect: the row's root really is gone, which is
      // precisely what `workspace.stale` says.
      throw new WorkspaceStaleError(workspace.id);
    }

    return { state, executionRoot: workspace.fs_root };
  }

  // ------------------------------------------------------------------------
  // writable modes
  // ------------------------------------------------------------------------

  /**
   * The three writable arms, in the order the header sets out.
   *
   * Steps 1-4 (gate, branch name, busy — the requester's hold and the reuse
   * candidate's, bind verification) run before the workspace is committed to
   * `provisioning`, so every refusal below leaves the row exactly as it was
   * found.
   */
  async #prepareWritableRoot(
    input: PrepareExecutionRootInput,
    workspace: WorkspaceRootRow,
    executionMode: WritableExecutionMode,
  ): Promise<PreparedExecutionRoot> {
    // The CP-010-2 bracket is ALREADY OPEN — this prepare is its provisioner.
    // Three producers land a workspace here: `repo.workspaceBind` (a writable
    // first bind is born `provisioning`), a prior prepare whose swallowed
    // `failReprovision` left the bracket open (see `#failReprovision`), and
    // T2.3's cleanup leg (d), which returns a retired clone's workspace to
    // `provisioning` between runs — the steady state for clone mode.
    // `provisioning` is the one state that is both a lawful starting point and
    // outside `assertWritable`'s admitted set, so it drives BOTH the gate below
    // and the bracket further down — one predicate, because they are one fact.
    const bracketAlreadyOpen = workspace.state === "provisioning";

    // Normalized ONCE, here, and threaded from this point on — `input.runId` is not
    // read again below. Trimming at each use site was the bug: branch-name
    // resolution trimmed and the worktree create did not, so a padded run id
    // derived its branch from the trimmed value while persisting the padded one
    // into `worktrees.created_by_run_id`. An empty result means ABSENT, which is
    // what `#resolveBranchName` refuses on and what keeps `create` from receiving
    // a run id that is only whitespace.
    const runId = input.runId?.trim() ?? "";

    // (1) CP-010-3 / I-010-12. FIRST, and before any git call: a stale workspace
    // must not spend a process spawn discovering it is stale.
    //
    // SKIPPED inside an open bracket, which is not a loophole but the only
    // reading that leaves this service usable. `assertWritable` admits `ready`
    // and `busy` and raises Plan-009's invariant error for `provisioning` — so
    // calling it unconditionally would refuse every first-bind prepare and every
    // post-retirement clone prepare, i.e. the primary paths. I-010-12 and
    // CP-010-3 scope the gate to prepares that find the bracket closed, so the
    // exemption is the plan's own, not an invention here.
    //
    // Nothing protective is lost. The gate exists to refuse `stale` and
    // `archived`; `provisioning` is neither, and it is the state that says this
    // workspace's provisioning is in progress — which is what this call is.
    if (!bracketAlreadyOpen) {
      await this.#workspaces.assertWritable(workspace.id);
    }

    // (2) D-010-19. The wire cannot supply `runId`, so a wire-originated pre-run
    // prepare that omits `branchName` lands here and is refused by name rather
    // than being given a derived branch it never asked for.
    const branchName = this.#resolveBranchName(input, workspace, runId);

    // (3) `Spec-010 §State And Data Implications` (the busy bullet).
    // `assertWritable` passes `busy` deliberately — it scopes the precise
    // refusal to `markBusy`, the call that actually contends for the hold — but
    // a second root HANDOFF while that run holds the workspace is what that
    // bullet refuses. `beginReprovision` would refuse it too, through
    // `#refuseIllegalPredecessor`, and with the SAME carrier and the same holding-
    // run attribution: raising here is about ORDER, not about the answer. It keeps
    // the refusal in the pre-bracket group, so a busy branch-mode prepare never
    // spawns the git read below.
    if (workspace.state === "busy") {
      throw new WorkspaceBusyError(workspace.id, workspace.holding_run_id);
    }

    // (3b) The same bullet, asked of the reuse CANDIDATE: an explicit reuse
    // names a worktree whose directory another workspace can hold `busy`, and
    // handing that working tree to a second run is exactly the concurrent root
    // HANDOFF the bullet refuses. PRE-bracket like step (3), and for the same
    // reason busy refusals live in this group at all — busy is a wait-and-retry
    // answer, and routing it through the materialization catch would
    // `failReprovision` the REQUESTER into `stale` repair for someone else's
    // live run. Root-keyed rather than workspace-keyed, which is also the shape
    // the Phase-3 gate must add beside CP-010-4's workspace-keyed `markBusy`
    // when it lands — `branch` mode shares the mount's checkout, the same
    // hazard one arm over.
    if (input.reuseWorktreeId !== undefined) {
      const busyHolder = this.#selectBusyWorktreeHolderStmt.get({
        worktree_id: input.reuseWorktreeId,
      });
      if (busyHolder !== undefined) {
        throw new WorkspaceBusyError(busyHolder.workspace_id, busyHolder.holding_run_id);
      }
    }

    const mount = this.#requireAttachedMount(workspace.repo_mount_id);

    // (4) D-010-9. Bind-only verification, before the bracket: a mismatch is a
    // caller disagreement, and `Spec-010 §Fallback Behavior` reserves `stale` for
    // faults. The only git call this module makes, and it is a READ (I-010-6).
    if (executionMode === "branch") {
      await this.#verifyBranchModeBind(workspace.id, mount.canonical_root, branchName);
    }

    // The workspace is committed from here. An open bracket is ALREADY
    // `provisioning`, and beginning again would fail that primitive's
    // `ready`/`stale` compare-and-swap — so the closed-bracket case is the one
    // that begins, not the open one. Either way the row is `provisioning`
    // below, which is what makes `failReprovision` legal on the catch.
    if (!bracketAlreadyOpen) {
      await this.#workspaces.beginReprovision(workspace.id, executionMode);
    }

    let materialized: MaterializedRoot;
    let branchContextId: string;
    try {
      materialized = await this.#materialize(
        input,
        workspace,
        executionMode,
        mount,
        branchName,
        runId,
      );
      branchContextId = this.#writeBranchContext(workspace.id, materialized);
    } catch (preparationFailure) {
      await this.#failReprovision(workspace.id, preparationFailure);
      // The ORIGINAL cause, not a wrapper: D-010-16 makes wrapping the run-setup
      // gate's job, and it wraps by CODE. A cause replaced here would arrive
      // there with this module's identity instead of the failure's.
      throw preparationFailure;
    }

    try {
      await this.#workspaces.completeReprovision(workspace.id, materialized.executionRoot);
    } catch (completionFailure) {
      // The root exists and nothing will ever adopt it. See
      // `#compensateOrphanedRoot` for why this is compensated rather than left to
      // a sweep, and why `failReprovision` is NOT the answer here.
      await this.#compensateOrphanedRoot(materialized, branchContextId);
      throw completionFailure;
    }

    return {
      workspaceId: workspace.id,
      executionMode,
      executionRoot: materialized.executionRoot,
      // Not re-read from the row: `completeReprovision` resolving is what makes
      // this `ready`, and re-reading would report a state a concurrent writer had
      // already moved on from as if this call had produced it.
      state: "ready",
      branchName: materialized.branchName,
      ...(materialized.worktreeId === null ? {} : { worktreeId: materialized.worktreeId }),
      ...(materialized.ephemeralCloneId === null
        ? {}
        : { ephemeralCloneId: materialized.ephemeralCloneId }),
      branchContextId,
    };
  }

  /**
   * D-010-19's resolution order: the supplied name wins; a gate-supplied `runId`
   * falls back to the T2.2 helper; neither refuses.
   *
   * The fallback goes through `deriveWorktreeBranchName` rather than formatting a
   * name here, so the `sidekicks/<session-short-8>/<slug>` shape has exactly one
   * implementation. `taskSummary` is deliberately not passed: the queue-item
   * summary lives on the run-setup gate, which supplies `branchName` directly when
   * it has one — reaching this fallback means there was no summary to use.
   *
   * `runId` arrives ALREADY NORMALIZED, and empty means absent. Whitespace is not
   * a run id, and letting it through would trade a 400-shaped
   * `workspace.branch_name_required` for `deriveWorktreeBranchName`'s
   * `branch_name_underivable` — a 500-shaped worktree defect code — for what is a
   * caller error.
   */
  #resolveBranchName(
    input: PrepareExecutionRootInput,
    workspace: WorkspaceRootRow,
    runId: string,
  ): string {
    const supplied = input.branchName?.trim() ?? "";
    if (supplied.length > 0) {
      return supplied;
    }

    if (runId.length === 0) {
      throw new WorkspaceBranchNameRequiredError(workspace.id);
    }

    return deriveWorktreeBranchName({ sessionId: workspace.session_id, runId });
  }

  /** Dispatch. Exhaustive by construction — I-010-7 admits no default arm. */
  async #materialize(
    input: PrepareExecutionRootInput,
    workspace: WorkspaceRootRow,
    executionMode: WritableExecutionMode,
    mount: AttachedMountRow,
    branchName: string,
    runId: string,
  ): Promise<MaterializedRoot> {
    switch (executionMode) {
      case "branch":
        return this.#bindBranchMode(mount, branchName);
      case "worktree":
        return this.#prepareWorktreeRoot(input, workspace, mount, branchName, runId);
      case "ephemeral clone":
        return this.#prepareCloneRoot(workspace, branchName);
    }
  }

  /**
   * `branch` mode: BIND ONLY (D-010-9). Nothing is created and nothing is
   * switched — the verification already ran, so this is the bookkeeping that
   * follows it.
   *
   * The root is the mount's canonical root, per the branch-mode applicability
   * bullet of `Spec-010 §Turn-Boundary Snapshots`. It could not come from
   * `workspaces.fs_root` even if it were preferable: `beginReprovision`
   * releases that column on the way into `provisioning`.
   *
   * `baseBranch` self-anchors — see the header's residual. Branch mode cuts
   * nothing, so there is no base to record that this module could observe.
   */
  #bindBranchMode(mount: AttachedMountRow, branchName: string): MaterializedRoot {
    return {
      executionRoot: mount.canonical_root,
      branchName,
      baseBranch: branchName,
      worktreeId: null,
      ephemeralCloneId: null,
      provenance: "bound",
    };
  }

  /** `worktree` mode: explicit reuse when a candidate is NAMED, otherwise create. */
  async #prepareWorktreeRoot(
    input: PrepareExecutionRootInput,
    workspace: WorkspaceRootRow,
    mount: AttachedMountRow,
    branchName: string,
    runId: string,
  ): Promise<MaterializedRoot> {
    if (input.reuseWorktreeId !== undefined) {
      const candidate = await this.#worktrees.validateReuse({
        worktreeId: input.reuseWorktreeId,
        // The candidate's mount must be the WORKSPACE's mount. Passing the
        // workspace's mount is what lets T2.2 catch a cross-repository bind that
        // no schema could see.
        repoMountId: workspace.repo_mount_id,
        branchName,
        ...(input.acknowledgeDirtyCandidate === undefined
          ? {}
          : { acknowledgeDirtyCandidate: input.acknowledgeDirtyCandidate }),
      });
      return {
        executionRoot: candidate.fsRoot,
        branchName: candidate.branchName,
        baseBranch: this.#requireCarriedBaseBranch(workspace.id, candidate),
        worktreeId: candidate.worktreeId,
        ephemeralCloneId: null,
        provenance: "reused",
      };
    }

    const created = await this.#worktrees.create({
      repoMountId: mount.id,
      sessionId: workspace.session_id,
      branchName,
      // `refuse` is the default because the alternative silently changes the
      // branch a run publishes from. A caller that wants a suffix asks for one.
      onCollision: input.onCollision ?? "refuse",
      ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
      // The NORMALIZED value, and omitted when it is absent — `created_by_run_id`
      // is provenance, and padding stored there would not match the run it names.
      ...(runId.length === 0 ? {} : { runId }),
    });
    return {
      executionRoot: created.fsRoot,
      // `created.branchName`, not the requested one: an `onCollision: 'suffix'`
      // create returns the SUFFIXED name, and the branch context must record the
      // branch that exists rather than the one that was asked for.
      branchName: created.branchName,
      baseBranch: created.baseRef,
      worktreeId: created.worktreeId,
      ephemeralCloneId: null,
      provenance: "created",
    };
  }

  /** `ephemeral clone` mode: delegate wholesale to T2.3. */
  async #prepareCloneRoot(
    workspace: WorkspaceRootRow,
    branchName: string,
  ): Promise<MaterializedRoot> {
    const prepared = await this.#clones.prepare({
      workspaceId: workspace.id,
      branchName,
      // `cleanupPolicy` is deliberately not forwarded: it is not on
      // `ExecutionRootPrepareRequest`, and T2.3's default — retire when the run
      // completes — is the disposable-per-run case `Spec-010 §Required Behavior`
      // describes. Passing an unset value through would put a policy choice on a
      // surface that never offered one.
    });
    return {
      executionRoot: prepared.cloneRoot,
      branchName: prepared.branchName,
      // T2.3 OBSERVED the base its clone was cut from, and reports it whenever
      // a branch referenced the source's HEAD commit. Absent means none did —
      // the clone's own HEAD landed detached — a lawful outcome there rather
      // than a failure — and `base_branch` is `TEXT NOT NULL`, so the
      // self-anchor stays mandatory. See the header's residual for what that
      // fallback still cannot express.
      baseBranch: prepared.baseBranch ?? prepared.branchName,
      worktreeId: null,
      ephemeralCloneId: prepared.cloneId,
      provenance: "created",
    };
  }

  // ------------------------------------------------------------------------
  // branch_contexts — the sole writer (CP-010-6)
  // ------------------------------------------------------------------------

  /**
   * Write or refresh the workspace's branch context, polymorphic per mode
   * (`Spec-010 §State And Data Implications`, I-010-5).
   *
   * Three shapes, one per writable mode:
   *
   * - `worktree` — the row references the worktree, and the write is D-010-15's
   *   upsert on the `(worktree_id, workspace_id)` pair. That keying is what makes
   *   cross-workspace reuse land a FRESH row scoped to the binding workspace while
   *   leaving the candidate's own row untouched, and makes a workspace re-binding
   *   a worktree it bound before refresh its existing row instead of duplicating.
   * - `ephemeral clone` — the row references the clone. A plain insert: every
   *   prepare mints a new clone, so there is nothing to conflict with.
   * - `branch` — the row references NEITHER root, and is likewise a plain insert,
   *   one per prepare; see the header's residual on why accumulating is the reading
   *   that assumes least.
   *
   * Synchronous throughout, which is not incidental: `better-sqlite3` runs
   * statements synchronously, so the worktree arm's write-then-re-read cannot be
   * interleaved by another task on THIS connection. That is the whole guarantee — a
   * second connection can still interleave, which T1.3's partial-unique index
   * arbitrates: the loser gets a constraint failure, never a duplicate. The other
   * two arms are single statements and need no such reasoning.
   */
  #writeBranchContext(workspaceId: string, materialized: MaterializedRoot): string {
    const now = this.#now();

    if (materialized.worktreeId !== null) {
      const worktreeId = materialized.worktreeId;
      this.#upsertWorktreeContextStmt.run({
        id: this.#newBranchContextId(),
        workspace_id: workspaceId,
        worktree_id: worktreeId,
        ephemeral_clone_id: null,
        base_branch: materialized.baseBranch,
        head_branch: materialized.branchName,
        now,
      });
      // Re-read rather than trusting the minted id: on the update arm the bound
      // `@id` was discarded and the row kept the id it already had.
      const bound = this.#selectWorktreePairContextStmt.get({
        worktree_id: worktreeId,
        workspace_id: workspaceId,
      });
      if (bound === undefined) {
        throw new ExecutionRootServiceInvariantError(
          `branch context for workspace ${workspaceId} and worktree ${worktreeId} did not persist`,
          { kind: "branch_context_write_lost", workspaceId },
        );
      }
      return bound.id;
    }

    // The two remaining arms are one statement: a plain insert of a row naming AT
    // MOST one root. Clone mode names the clone it just minted, branch mode names
    // neither, and neither can conflict with an existing row — a clone is new by
    // construction, and branch-mode rows accumulate.
    const branchContextId = this.#newBranchContextId();
    this.#insertBranchContextStmt.run({
      id: branchContextId,
      workspace_id: workspaceId,
      worktree_id: null,
      ephemeral_clone_id: materialized.ephemeralCloneId,
      base_branch: materialized.baseBranch,
      head_branch: materialized.branchName,
      now,
    });
    return branchContextId;
  }

  /**
   * The base branch a REUSED worktree was cut from, carried from the row written
   * when it was created.
   *
   * FAILS CLOSED when there is none. This service is the sole `branch_contexts`
   * writer and writes a row for every worktree it creates, so a candidate without
   * one is a worktree this daemon did not provision — or one whose failed
   * handover was half-compensated (`#compensateOrphanedRoot`'s delete landing
   * while its retire faulted) — and any value invented here would be persisted
   * as a provenance claim about a branch nobody can verify.
   * `head_branch` comes from the worktree row instead of from the carried context:
   * `validateReuse` has already established that the candidate is on the requested
   * branch, which makes the worktree the fresher authority.
   */
  #requireCarriedBaseBranch(workspaceId: string, candidate: ReusableWorktreeCandidate): string {
    const carried = this.#selectWorktreeBaseBranchStmt.get({
      worktree_id: candidate.worktreeId,
    });
    if (carried === undefined) {
      throw new ExecutionRootServiceInvariantError(
        `worktree ${candidate.worktreeId} has no branch context to carry a base branch from`,
        { kind: "reuse_candidate_without_branch_context", workspaceId },
      );
    }
    return carried.base_branch;
  }

  // ------------------------------------------------------------------------
  // Row reads
  // ------------------------------------------------------------------------

  #requireWorkspace(workspaceId: string): WorkspaceRootRow {
    const row = this.#selectWorkspaceStmt.get({ workspace_id: workspaceId });
    if (row === undefined) {
      // Plan-009's carrier rather than a Plan-010 re-mint, so `instanceof`
      // discrimination does not depend on which module a throw site imported.
      throw new WorkspaceNotFoundError(workspaceId);
    }
    return row;
  }

  #requireAttachedMount(repoMountId: string): AttachedMountRow {
    const row = this.#selectAttachedMountStmt.get({ repo_mount_id: repoMountId });
    if (row === undefined) {
      throw new RepoMountNotFoundError(repoMountId);
    }
    return row;
  }

  /**
   * The workspace's selected mode, validated rather than cast.
   *
   * `execution_mode` is a CHECK-constrained TEXT column, so a value outside the
   * vocabulary means the database disagrees with the schema — a defect, and
   * exactly the one I-010-7 cares about, because the alternative to failing here
   * is picking a mode. A `ZodError` would name no domain fault, hence the
   * `safeParse` and the typed re-raise.
   */
  #requireKnownMode(workspace: WorkspaceRootRow): ExecutionMode {
    const parsed = ExecutionModeSchema.safeParse(workspace.execution_mode);
    if (!parsed.success) {
      throw new ExecutionRootServiceInvariantError(
        `workspace ${workspace.id} carries an execution mode outside the ratified vocabulary`,
        {
          kind: "unreadable_workspace_row",
          workspaceId: workspace.id,
          cause: parsed.error,
        },
      );
    }
    return parsed.data;
  }

  /** The workspace's position, validated for the same reason as the mode. */
  #requireKnownState(workspace: WorkspaceRootRow): WorkspaceState {
    const parsed = WorkspaceStateSchema.safeParse(workspace.state);
    if (!parsed.success) {
      throw new ExecutionRootServiceInvariantError(
        `workspace ${workspace.id} carries a state outside the ratified vocabulary`,
        {
          kind: "unreadable_workspace_row",
          workspaceId: workspace.id,
          cause: parsed.error,
        },
      );
    }
    return parsed.data;
  }

  // ------------------------------------------------------------------------
  // Failure disposition
  // ------------------------------------------------------------------------

  /**
   * Record the failure on the workspace (`Spec-010 §Fallback Behavior` — the run blocks in setup).
   *
   * The detail is composed by {@link describeFailure}, which discriminates by
   * error CLASS so that only values held to the `error-contracts.md` sanitization
   * discipline contribute a message at all.
   *
   * A throw from `failReprovision` is SWALLOWED. What the caller needs is the
   * original cause, and replacing it with a bookkeeping failure would hide the
   * thing that actually went wrong. The workspace is left in `provisioning` —
   * which is precisely the no-double-begin arm a later prepare handles, so the
   * next attempt still works.
   */
  async #failReprovision(workspaceId: string, cause: unknown): Promise<void> {
    try {
      await this.#workspaces.failReprovision(workspaceId, describeFailure(cause));
    } catch {
      // Deliberate. See the docblock.
    }
  }

  /**
   * Undo a root this call materialized but could not hand over.
   *
   * `completeReprovision` is the last step, and a throw from it leaves the row
   * `provisioning` with no `fs_root` while the worktree or clone sits on disk.
   * Nothing reclaims that on its own: T2.2's sweep retires worktrees whose MOUNT
   * detached and cleans rows already `retired`, and an orphan on an attached mount
   * is in neither set — so the leak is permanent rather than eventual. That is why
   * it is compensated here instead of recorded as a residual.
   *
   * `failReprovision` is deliberately NOT the answer: the preparation SUCCEEDED, and
   * labelling it a preparation failure would misreport which step broke.
   *
   * ORDER IS LOAD-BEARING. The `branch_contexts` row goes first. T2.2's retirement
   * refuses while a `busy` workspace is bound to the worktree, and it detects that
   * binding by joining `branch_contexts` on `worktree_id` — `worktrees` carries no
   * workspace column, so this row IS the binding it would find. That binding is
   * provably dead: this call inserted the row, and the completion it claims never
   * happened. Deleting it first lets the retirement proceed rather than be refused.
   * Retiring then RECORDS the retirement and removes nothing from disk (I-010-9);
   * the sweep reclaims the root on a later tick, which is the only lawful shape.
   *
   * GATED on `created`, both legs, for reasons that differ per provenance. A
   * `reused` worktree pre-existed this call and may be bound by other workspaces,
   * so retiring it would destroy state this call never created — and its pair row
   * was UPSERTED onto a pre-existing id, so `#writeBranchContext`'s returned id
   * may be one a previous binding owns and the DELETE would take that binding's
   * provenance with it. `bound` is the user's own main checkout, never retired;
   * its freshly-inserted row stands as history of a binding that never completed,
   * the same benign accumulation the insert-per-prepare reading already accepts.
   * Only a `created` root is certainly this call's own on both legs.
   *
   * Every fault is swallowed — the caller is owed the completion failure, not a
   * compensation stack. The swallowing carries its own residual: a delete that
   * succeeds followed by a retire that faults leaves a live `ready` worktree
   * with NO pair row, which a later explicit reuse refuses as
   * `reuse_candidate_without_branch_context` and whose `(mount, branch)` pair
   * stays held against a later create — strictly worse than not compensating at
   * all, accepted because surfacing the compensation fault would mask the
   * completion failure the caller is owed. A second residual stays open by
   * design: a worktree that a legitimate reuse bound between the delete and the
   * retire is refused by that busy probe, and SHOULD be. The refusal is the
   * correct answer there, not a missed cleanup.
   */
  async #compensateOrphanedRoot(
    materialized: MaterializedRoot,
    branchContextId: string,
  ): Promise<void> {
    if (materialized.provenance !== "created") {
      return;
    }

    try {
      this.#deleteBranchContextStmt.run({ id: branchContextId });
    } catch {
      // Deliberate. See the docblock.
    }

    try {
      if (materialized.worktreeId !== null) {
        await this.#worktrees.retire(materialized.worktreeId);
      } else if (materialized.ephemeralCloneId !== null) {
        await this.#clones.dispose(materialized.ephemeralCloneId);
      }
    } catch {
      // Deliberate. See the docblock.
    }
  }

  // ------------------------------------------------------------------------
  // git
  // ------------------------------------------------------------------------

  /**
   * D-010-9's bind-only verification: the main checkout must ALREADY be on the
   * requested branch.
   *
   * A READ, and the only git call in this module (I-010-6). The daemon never
   * switches branches in a checkout the user shares — the disagreement refuses,
   * and `WorkspaceBranchMismatchError` carries both names so the caller can decide
   * which side to move.
   *
   * THREE outcomes, discriminated by EXIT STATUS rather than collapsed into one.
   * `symbolic-ref --quiet --short HEAD` exits 0 carrying the branch name, or exits
   * {@link DETACHED_HEAD_EXIT_CODE} with empty output when HEAD is on no branch —
   * a real answer, and the mismatch refusal is its right carrier. Anything else is
   * INFRASTRUCTURE: git's 128 for a repository it cannot read, or a rejection,
   * which this seam raises only when the process produced no status at all. Those
   * became `(detached HEAD)` under the previous collapse, which handed the caller a
   * repair — "switch your checkout" — that could not possibly work.
   *
   * The defect carries the exit status and NOTHING else. No `stderr`, no path:
   * git's diagnostics routinely name the repository, and this carrier reaches logs.
   */
  async #verifyBranchModeBind(
    workspaceId: string,
    canonicalRoot: string,
    requestedBranchName: string,
  ): Promise<void> {
    let result: ExecutionRootGitInvocationResult;
    try {
      result = await this.#runGit([
        "-C",
        canonicalRoot,
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      ]);
    } catch (invocationFailure) {
      throw new ExecutionRootServiceInvariantError(
        `branch verification for workspace ${workspaceId} could not run git`,
        {
          kind: "branch_verification_failed",
          workspaceId,
          // Attached but never projected: `cause` is what a local log needs, and
          // nothing puts it on the wire.
          cause: invocationFailure,
        },
      );
    }

    const currentBranchName = result.stdout.trim();
    const detached = result.exitCode === DETACHED_HEAD_EXIT_CODE && currentBranchName.length === 0;

    if (result.exitCode !== 0 && !detached) {
      throw new ExecutionRootServiceInvariantError(
        `branch verification for workspace ${workspaceId} exited with status ${result.exitCode}`,
        { kind: "branch_verification_failed", workspaceId },
      );
    }

    if (detached || currentBranchName !== requestedBranchName) {
      throw new WorkspaceBranchMismatchError(
        workspaceId,
        requestedBranchName,
        currentBranchName.length === 0 ? DETACHED_HEAD_BRANCH_LABEL : currentBranchName,
      );
    }
  }

  /**
   * The single git entry point.
   *
   * Prepends `-c core.hooksPath=<empty dir>` unconditionally (I-010-10). The
   * invariant quantifies over INVOCATIONS, not over invocations believed to run
   * hooks, and this module's one call runs against the USER's main checkout —
   * the single place in Plan-010 where a repository's own hooks are most likely
   * to exist. Discharged by there being no other way to reach git from here.
   *
   * A command-line `-c` outranks repository, global and system config alike, so a
   * repo-local `core.hooksPath` cannot win it back.
   */
  async #runGit(argv: readonly string[]): Promise<ExecutionRootGitInvocationResult> {
    await this.#filesystem.createDirectory(this.#hookNeutralizationDirectory);
    return this.#git(["-c", `core.hooksPath=${this.#hookNeutralizationDirectory}`, ...argv], {
      timeoutMs: this.#gitCommandTimeoutMs,
    });
  }
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/**
 * Compose the `metadata.lastError` detail for a failed preparation.
 *
 * This string lands in `metadata.lastError`, which `WorkspaceRead` puts ON THE
 * WIRE, and `normalizeWorkspaceLastError` scrubs credentials rather than paths. So
 * the question each arm answers is not "what is most informative" but "what is
 * this value's message GUARANTEED not to contain".
 *
 * Discrimination is by CLASS, deliberately, and the shape it replaces is why. A
 * `"code" in cause` test admits anything that happens to carry a `code` field —
 * `SqliteError` and Node's `ErrnoException` both do — and their messages carry
 * driver text and filesystem paths respectively. Class membership is the only test
 * that actually implies the sanitization discipline it is standing in for.
 *
 * Four arms, most specific first:
 *
 *   1. a non-`Error` throw contributes a fixed string; it has no message worth
 *      trusting and may not be a string at all;
 *   2. this module's own defect reports its `kind` — a closed vocabulary, and the
 *      one value that names the condition rather than describing it;
 *   3. a {@link DaemonDomainError} reports `code: message`, both wire-safe by the
 *      `error-contracts.md` sanitization discipline every such carrier is held to;
 *   4. everything else reports its CLASS NAME and nothing else.
 *
 * `normalizeWorkspaceLastError` is NOT applied here: `failReprovision` applies it
 * itself, and scrubbing twice would truncate an already-truncated detail.
 */
function describeFailure(cause: unknown): string {
  if (!(cause instanceof Error)) {
    return "execution root preparation failed";
  }
  if (cause instanceof ExecutionRootServiceInvariantError) {
    return cause.kind;
  }
  if (cause instanceof DaemonDomainError) {
    return `${cause.code}: ${cause.message}`;
  }
  return cause.name;
}
