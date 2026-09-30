// Worktree lifecycle service: owns the `worktrees` table and every git call that provisions or
// inspects a worktree root. Each `fs_root` sits under the execution-roots directory, never in the
// attached checkout. It holds no `workspaces` write; its caller wraps these calls.
//
//   * The main checkout is never mutated: git runs only `symbolic-ref --quiet --short HEAD`,
//     `worktree add -b`, `worktree prune` (the only thing that unregisters what `add` wrote) and
//     `status --porcelain`.
//   * `cleanupPass` removes the directory, prunes, then stamps `cleaned_at`, so a crash between
//     steps is retried and never recorded as a cleanup that did not happen.
//   * Known gap: removing a worktree keeps its branch, so a later `worktree add -b <same-name>`
//     fails (exit 255 on git 2.50.1) while the index says free; `refuse` then reports
//     `worktree.create_failed`, not a collision, and `suffix` cannot advance. A second arbiter
//     would race, and git's stderr has paths.

import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { Database, Statement } from "better-sqlite3";

import {
  WORKTREE_GIT_REF_MAX_LEN,
  WorktreeIdSchema,
  WorktreeStateSchema,
  type WorktreeRetireResponse,
  type WorktreeState,
} from "@ai-sidekicks/contracts";

import { RepoMountNotFoundError } from "../workspace/repo-errors.js";
import {
  DEFAULT_GIT_EXECUTABLE,
  DISCOVERY_REDIRECTING_GIT_ENV_KEYS,
} from "../workspace/repo-root-resolver.js";

import {
  WorktreeBranchCollisionError,
  WorktreeCreateFailedError,
  WorktreeNotFoundError,
  WorktreeRetireConflictError,
  WorktreeReuseConflictError,
} from "./worktree-errors.js";
import type { WorktreeEventEmitter } from "./worktree-event-emitter.js";
import { mintUuidV7 } from "../ids/uuid-v7.js";

/** Captured stdio from one completed git invocation. */
export interface WorktreeGitInvocationResult {
  readonly stdout: string;
  readonly stderr: string;
}

/** Per-invocation bounds. */
interface WorktreeGitInvocationOptions {
  /** Wall-clock ceiling; the child is killed past it. */
  readonly timeoutMs: number;
}

/**
 * The git process seam: takes the complete argv (including `-C <dir>`) and no working directory.
 * Rejections are opaque, since git `stderr` is exactly what the typed errors must not carry.
 */
export type WorktreeGitRunner = (
  argv: readonly string[],
  options: WorktreeGitInvocationOptions,
) => Promise<WorktreeGitInvocationResult>;

/**
 * Two idempotent verbs: create tolerates an existing directory, remove a missing one. The sweep
 * retries removal until `cleaned_at` is stamped, so the tolerance is load-bearing.
 */
export interface WorktreeFilesystem {
  createDirectory(path: string): Promise<void>;
  removeDirectory(path: string): Promise<void>;
}

/** Dependencies of {@link WorktreeService}; only the first three are required. */
export interface WorktreeServiceDeps {
  /**
   * MUST be the connection {@link events} appends through, or a row write silently leaves the event
   * transaction. Nothing here can verify that, so the composition root owns it.
   */
  readonly database: Database;
  /** Event emission seam; this service constructs no envelopes of its own. */
  readonly events: WorktreeEventEmitter;
  /**
   * Absolute, and not re-validated here. Roots are `<dir>/<repoMountId>/worktrees/<worktreeId>`;
   * the hook-neutralization directory is a sibling.
   */
  readonly executionRootsDirectory: string;
  /** Git process seam; defaults to `execFile` against `git`. */
  readonly git?: WorktreeGitRunner;
  /** Filesystem seam; defaults to `node:fs/promises`. */
  readonly filesystem?: WorktreeFilesystem;
  /** Per-invocation git timeout; defaults to two minutes. */
  readonly gitCommandTimeoutMs?: number;
  /** Wall clock for `created_at` / `updated_at` / `cleaned_at`. Injectable for tests. */
  readonly now?: () => string;
  /** `worktrees.id` source. Injectable for deterministic tests; defaults to `mintUuidV7`. */
  readonly newWorktreeId?: () => string;
}

/** Inputs for {@link WorktreeService.create}; no names are derived here, so both are required. */
export interface CreateWorktreeInput {
  /** The mount to check out from. Must be `attached`. */
  readonly repoMountId: string;
  /** Creating-session provenance — `created_by_session_id`, NOT NULL. */
  readonly sessionId: string;
  /** `null` records a prepare before any run. Provenance only; the `run-` fallback is elsewhere. */
  readonly runId?: string | null;
  /** The branch to create, resolved by the caller (see {@link deriveWorktreeBranchName}). */
  readonly branchName: string;
  /**
   * `refuse` (a caller-supplied name) raises {@link WorktreeBranchCollisionError}; `suffix` (a
   * daemon-derived name) takes the first free ordinal. Explicit: every call arrives with a name.
   */
  readonly onCollision: "refuse" | "suffix";
  /** Base ref for the new branch; omitted, the mount's HEAD branch. A leading `-` is refused. */
  readonly baseRef?: string;
  /** Envelope actor for the emitted events; defaults to the system actor. */
  readonly actor?: string | null;
  /** Envelope linkage back to the causing event, when the caller has one. */
  readonly correlationId?: string | null;
}

/** A materialized, ready worktree. */
export interface CreatedWorktree {
  readonly worktreeId: string;
  readonly repoMountId: string;
  /** The branch as created, suffix included, so a caller never has to reconstruct it. */
  readonly branchName: string;
  /** `<executionRootsDirectory>/<repoMountId>/worktrees/<worktreeId>`. */
  readonly fsRoot: string;
  /** The ref the branch was cut from, returned so the caller need not re-resolve HEAD. */
  readonly baseRef: string;
  /** Always `ready`: a create that did not reach `ready` throws instead. */
  readonly state: Extract<WorktreeState, "ready">;
}

/** Inputs for {@link WorktreeService.validateReuse}. */
export interface ValidateWorktreeReuseInput {
  /** The explicitly named candidate. */
  readonly worktreeId: string;
  /** The mount the caller expects; a candidate from another mount sits in another repository. */
  readonly repoMountId: string;
  /** The branch the caller intends to execute against. */
  readonly branchName: string;
  /** Explicit acknowledgement that a dirty candidate may still bind. */
  readonly acknowledgeDirtyCandidate?: boolean;
}

/** A candidate that passed every compatibility check and may be bound. */
export interface ReusableWorktreeCandidate {
  readonly worktreeId: string;
  readonly repoMountId: string;
  readonly branchName: string;
  readonly fsRoot: string;
  readonly state: WorktreeState;
  /** Provenance, preserved from creation. */
  readonly createdBySessionId: string;
  readonly createdByRunId: string | null;
  /**
   * `true` means the caller acknowledged it (an unacknowledged dirty candidate throws). Reported,
   * not acted on: no `worktree.dirty` event is written.
   */
  readonly dirty: boolean;
}

/** Options for {@link WorktreeService.retire}. */
export interface RetireWorktreeOptions {
  readonly actor?: string | null;
  readonly correlationId?: string | null;
}

/** What one {@link WorktreeService.cleanupPass} did, in the order it did it. */
export interface WorktreeCleanupPassResult {
  /** Worktrees retired by the inactive-mount cascade. */
  readonly retiredWorktreeIds: readonly string[];
  /** Worktrees whose root was removed and whose `cleaned_at` was stamped. */
  readonly cleanedWorktreeIds: readonly string[];
}

/** Inputs for {@link deriveWorktreeBranchName}. */
export interface WorktreeBranchNameInput {
  /** The session whose last 8 hex digits form the `<session-short-id>` segment. */
  readonly sessionId: string;
  /** The run behind the `run-<run-short-id>` fallback; `null` when there is none. */
  readonly runId: string | null;
  /** The queue-item summary, the preferred `<task-slug>` source. */
  readonly taskSummary?: string | null;
}

const WORKTREE_ROOTS_SEGMENT = "worktrees";

// A dotted sibling of the per-mount root directories, so it can never collide with a mount id.
const HOOK_NEUTRALIZATION_SEGMENT = ".hook-neutralization";

const DERIVED_BRANCH_NAME_PREFIX = "sidekicks";
const SHORT_ID_LENGTH = 8;
const TASK_SLUG_MAX_LENGTH = 40;

// Suffixes run `-2` to `-100`; past that the daemon is looping on an unresolvable condition, and a
// typed `branch_name_unavailable` beats an endless retry.
const MAX_BRANCH_NAME_ORDINAL = 100;

// Well above `DEFAULT_GIT_COMMAND_TIMEOUT_MS`: `worktree add` materializes a full checkout, and 10
// seconds would kill a healthy provisioning on a large repository.
const DEFAULT_WORKTREE_GIT_TIMEOUT_MS = 120_000;

// Only `status --porcelain` can approach it; an overflow rejects and the cleanliness path refuses,
// which fails closed.
const GIT_STDIO_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

// Spelled to match `idx_worktrees_active_branch` exactly, so "live" reads agree with the arbiter.
const LIVE_WORKTREE_STATE_PREDICATE = "worktrees.state NOT IN ('retired', 'failed')";

/**
 * Aborts `#emitRetirement`'s prelude for an already-retired row: the append path INSERTs the event
 * unconditionally and only a throw rolls back. Internal, not a `DaemonDomainError`; `retire` and
 * `cleanupPass` both catch it.
 */
class WorktreeAlreadyRetiredError extends Error {
  constructor(worktreeId: string) {
    super(
      `WorktreeService: worktree ${worktreeId} was already retired when the retirement ` +
        `transaction opened; aborting so no second worktree.retired event is appended for one ` +
        `transition.`,
    );
    this.name = "WorktreeAlreadyRetiredError";
  }
}

// Type arguments on `prepare<Bind, Result>` make query/shape drift a type error, not a cast.

interface WorktreeRow {
  readonly id: string;
  readonly repo_mount_id: string;
  readonly created_by_session_id: string;
  readonly created_by_run_id: string | null;
  readonly branch_name: string;
  readonly fs_root: string;
  readonly state: string;
  readonly cleaned_at: string | null;
}

interface AttachedMountRow {
  readonly id: string;
  readonly canonical_root: string;
}

interface WorktreeIdRow {
  readonly id: string;
}

interface WorktreeRootRow {
  readonly id: string;
  readonly fs_root: string;
  /** The owning mount's root for the prune; nullable because the read LEFT-joins. */
  readonly canonical_root: string | null;
}

interface HoldingWorkspaceRow {
  readonly workspace_id: string;
}

interface MountLookupParams {
  readonly repo_mount_id: string;
}

interface WorktreeLookupParams {
  readonly worktree_id: string;
}

interface BranchLookupParams {
  readonly repo_mount_id: string;
  readonly branch_name: string;
}

interface InsertWorktreeParams {
  readonly id: string;
  readonly repo_mount_id: string;
  readonly created_by_session_id: string;
  readonly created_by_run_id: string | null;
  readonly branch_name: string;
  readonly fs_root: string;
  readonly now: string;
}

interface WorktreeTransitionParams {
  readonly worktree_id: string;
  readonly now: string;
}

/** One `create` call's arbitration-loop state; the name and policy stay on `input`. */
interface CreatingRowAttempt {
  readonly worktreeId: string;
  readonly fsRoot: string;
  readonly input: CreateWorktreeInput;
}

/**
 * What a failed `create` disposes of. Both paths are absolute; transposing them would aim
 * `removeDirectory` at the user's repository root.
 */
interface CreateFailureRecovery {
  readonly worktreeId: string;
  /** The worktree root this attempt minted, under the execution-roots directory. */
  readonly fsRoot: string;
  /** The MOUNT's root, for the administrative-entry prune — never a removal target. */
  readonly canonicalRoot: string;
}

/** Everything `git worktree add` needs, named so the five cannot be transposed. */
interface WorktreeMaterialization {
  readonly canonicalRoot: string;
  readonly worktreeRootsDirectory: string;
  readonly fsRoot: string;
  readonly branchName: string;
  readonly baseRef: string;
}

/**
 * The default branch name `sidekicks/<session-short-id>/<task-slug>`: the slug is the summary
 * lowercased, non-alphanumeric runs collapsed to `-`, cut to 40 characters at a `-` boundary, or
 * `run-<run-short-id>` without one. Throws `branch_name_underivable` when neither exists.
 */
export function deriveWorktreeBranchName(input: WorktreeBranchNameInput): string {
  const taskSlug = slugifyTaskSummary(input.taskSummary ?? null) ?? runFallbackSlug(input.runId);
  if (taskSlug === null) {
    throw new WorktreeCreateFailedError("branch_name_underivable");
  }
  return `${DERIVED_BRANCH_NAME_PREFIX}/${shortId(input.sessionId)}/${taskSlug}`;
}

/** The last 8 hex digits, hyphens stripped: a v7 id's random tail, so the handle keeps entropy. */
function shortId(identifier: string): string {
  return identifier.replace(/-/g, "").slice(-SHORT_ID_LENGTH).toLowerCase();
}

/** The `run-<short-id>` slug, or `null` when there is no run id. */
function runFallbackSlug(runId: string | null): string | null {
  if (runId === null || runId.length === 0) {
    return null;
  }
  return `run-${shortId(runId)}`;
}

/**
 * ASCII alphanumerics only: the slug must round-trip across platforms whose normalization and
 * case folding differ, so a non-ASCII letter is a separator, not transliterated.
 */
function slugifyTaskSummary(taskSummary: string | null): string | null {
  if (taskSummary === null) {
    return null;
  }
  const collapsed = taskSummary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (collapsed.length === 0) {
    return null;
  }
  return truncateSlugAtBoundary(collapsed, TASK_SLUG_MAX_LENGTH);
}

/** Truncates at a `-` boundary so the tail is not a half-word; without one, cuts hard. */
function truncateSlugAtBoundary(slug: string, maxLength: number): string {
  if (slug.length <= maxLength) {
    return slug;
  }
  const clipped = slug.slice(0, maxLength);
  if (slug.charAt(maxLength) === "-") {
    return clipped;
  }
  const lastBoundary = clipped.lastIndexOf("-");
  if (lastBoundary <= 0) {
    return clipped;
  }
  return clipped.slice(0, lastBoundary);
}

// Imported from the resolver: two copies of this security list would drift.
const DISCOVERY_REDIRECTING_GIT_ENV_KEYS_UPPERCASED = new Set(
  DISCOVERY_REDIRECTING_GIT_ENV_KEYS.map((key) => key.toUpperCase()),
);

/** The environment for every git call, read at call time so a mutated environment is followed. */
function buildWorktreeGitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (DISCOVERY_REDIRECTING_GIT_ENV_KEYS_UPPERCASED.has(key.toUpperCase())) {
      continue;
    }
    environment[key] = value;
  }
  environment["LC_ALL"] = "C";
  environment["LANG"] = "C";
  // Defense in depth: a git that prompted would block on a terminal the daemon lacks.
  environment["GIT_TERMINAL_PROMPT"] = "0";
  return environment;
}

/** `execFile` with an argv array, never a shell string. */
function runGitWithExecFile(
  argv: readonly string[],
  options: WorktreeGitInvocationOptions,
): Promise<WorktreeGitInvocationResult> {
  return new Promise<WorktreeGitInvocationResult>((resolve, reject) => {
    execFile(
      DEFAULT_GIT_EXECUTABLE,
      [...argv],
      {
        encoding: "utf8",
        timeout: options.timeoutMs,
        maxBuffer: GIT_STDIO_MAX_BUFFER_BYTES,
        env: buildWorktreeGitEnvironment(),
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

const DEFAULT_WORKTREE_FILESYSTEM: WorktreeFilesystem = {
  async createDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  },
  async removeDirectory(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  },
};

/**
 * Owns every `worktrees` transition and worktree-scoped git call. Each `UPDATE` carries its
 * legal-predecessor set in its `WHERE`, so the transition table lives in the statements.
 */
export class WorktreeService {
  readonly #events: WorktreeEventEmitter;
  readonly #executionRootsDirectory: string;
  readonly #hookNeutralizationDirectory: string;
  readonly #git: WorktreeGitRunner;
  readonly #filesystem: WorktreeFilesystem;
  readonly #gitCommandTimeoutMs: number;
  readonly #now: () => string;
  readonly #newWorktreeId: () => string;

  readonly #selectAttachedMountStmt: Statement<MountLookupParams, AttachedMountRow>;
  readonly #selectWorktreeStmt: Statement<WorktreeLookupParams, WorktreeRow>;
  readonly #selectLiveWorktreeOnBranchStmt: Statement<BranchLookupParams, WorktreeIdRow>;
  readonly #selectBusyHolderStmt: Statement<WorktreeLookupParams, HoldingWorkspaceRow>;
  readonly #selectSweepableStmt: Statement<[], WorktreeRow>;
  readonly #selectUncleanedRetiredStmt: Statement<[], WorktreeRootRow>;
  readonly #insertWorktreeStmt: Statement<InsertWorktreeParams>;
  readonly #markReadyStmt: Statement<WorktreeTransitionParams>;
  readonly #markFailedStmt: Statement<WorktreeTransitionParams>;
  readonly #retireStmt: Statement<WorktreeTransitionParams>;
  readonly #stampCleanedStmt: Statement<WorktreeTransitionParams>;

  constructor(deps: WorktreeServiceDeps) {
    this.#events = deps.events;
    this.#executionRootsDirectory = deps.executionRootsDirectory;
    this.#hookNeutralizationDirectory = join(
      deps.executionRootsDirectory,
      HOOK_NEUTRALIZATION_SEGMENT,
    );
    this.#git = deps.git ?? runGitWithExecFile;
    this.#filesystem = deps.filesystem ?? DEFAULT_WORKTREE_FILESYSTEM;
    this.#gitCommandTimeoutMs = deps.gitCommandTimeoutMs ?? DEFAULT_WORKTREE_GIT_TIMEOUT_MS;
    this.#now = deps.now ?? ((): string => new Date().toISOString());
    this.#newWorktreeId = deps.newWorktreeId ?? mintUuidV7;

    const database = deps.database;

    // Only `attached` mounts are provisioning targets; a detached one gets `repo.not_found`.
    this.#selectAttachedMountStmt = database.prepare<MountLookupParams, AttachedMountRow>(
      `SELECT id, canonical_root
         FROM repo_mounts
        WHERE id = @repo_mount_id AND state = 'attached'`,
    );

    this.#selectWorktreeStmt = database.prepare<WorktreeLookupParams, WorktreeRow>(
      `SELECT id, repo_mount_id, created_by_session_id, created_by_run_id,
              branch_name, fs_root, state, cleaned_at
         FROM worktrees
        WHERE id = @worktree_id`,
    );

    // The UNIQUE-violation confirmation read; its predicate is the index's.
    this.#selectLiveWorktreeOnBranchStmt = database.prepare<BranchLookupParams, WorktreeIdRow>(
      `SELECT id
         FROM worktrees
        WHERE repo_mount_id = @repo_mount_id
          AND branch_name = @branch_name
          AND ${LIVE_WORKTREE_STATE_PREDICATE}
        LIMIT 1`,
    );

    // Keyed on `fs_root`, not `branch_contexts`: context rows are retained history, so a join would
    // let a workspace since moved to another root block a retirement. A `busy` workspace at this
    // `fs_root` is exactly a run holding it. Runs in the retirement prelude and per sweep row.
    this.#selectBusyHolderStmt = database.prepare<WorktreeLookupParams, HoldingWorkspaceRow>(
      `SELECT holder.id AS workspace_id
         FROM worktrees
         JOIN workspaces AS holder ON holder.fs_root = worktrees.fs_root
        WHERE worktrees.id = @worktree_id
          AND holder.state = 'busy'
        LIMIT 1`,
    );

    // Live worktrees on a mount no longer `attached`. They retire through `#emitRetirement`, so the
    // busy probe applies; a conflict means the tables disagree and propagates fail-closed.
    this.#selectSweepableStmt = database.prepare<[], WorktreeRow>(
      `SELECT worktrees.id, worktrees.repo_mount_id, worktrees.created_by_session_id,
              worktrees.created_by_run_id, worktrees.branch_name, worktrees.fs_root,
              worktrees.state, worktrees.cleaned_at
         FROM worktrees
         JOIN repo_mounts ON repo_mounts.id = worktrees.repo_mount_id
        WHERE repo_mounts.state <> 'attached'
          AND ${LIVE_WORKTREE_STATE_PREDICATE}
        ORDER BY worktrees.created_at ASC, worktrees.id ASC`,
    );

    // LEFT JOIN so a row with no mount still gets its directory removed; a NULL root skips only the
    // prune. Unreachable through this package (`repo_mount_id` is NOT NULL, no `ON DELETE`, no
    // mount is ever deleted); kept against out-of-band mutation (a handle without foreign keys).
    //
    // `NOT EXISTS` defers a root a `busy` workspace holds: `markBusy` needs only `ready`, so it can
    // land after retirement, and the next pass would delete a tree a live run just received.
    // Deferred, not excluded: `releaseBusy` frees it and a later pass reclaims it.
    this.#selectUncleanedRetiredStmt = database.prepare<[], WorktreeRootRow>(
      `SELECT worktrees.id, worktrees.fs_root, repo_mounts.canonical_root
         FROM worktrees
         LEFT JOIN repo_mounts ON repo_mounts.id = worktrees.repo_mount_id
        WHERE worktrees.state = 'retired' AND worktrees.cleaned_at IS NULL
          AND NOT EXISTS (
                SELECT 1
                  FROM workspaces AS holder
                 WHERE holder.state = 'busy'
                   AND holder.fs_root = worktrees.fs_root
              )
        ORDER BY worktrees.updated_at ASC, worktrees.id ASC`,
    );

    // `state` is left to the column DEFAULT ('creating'); naming it would copy that fact.
    this.#insertWorktreeStmt = database.prepare<InsertWorktreeParams>(
      `INSERT INTO worktrees (
         id, repo_mount_id, created_by_session_id, created_by_run_id,
         branch_name, fs_root, created_at, updated_at
       ) VALUES (
         @id, @repo_mount_id, @created_by_session_id, @created_by_run_id,
         @branch_name, @fs_root, @now, @now
       )`,
    );

    this.#markReadyStmt = database.prepare<WorktreeTransitionParams>(
      `UPDATE worktrees
          SET state = 'ready', updated_at = @now
        WHERE id = @worktree_id AND state = 'creating'`,
    );

    // No event accompanies this one: the caller's `failRootPreparation` events the failure as
    // `workspace.stale`.
    this.#markFailedStmt = database.prepare<WorktreeTransitionParams>(
      `UPDATE worktrees
          SET state = 'failed', updated_at = @now
        WHERE id = @worktree_id AND state = 'creating'`,
    );

    // Every non-`retired` state is a legal predecessor, `failed` included. The prelude has already
    // handled a `retired` row, so a mismatch here is an invariant violation (plain assert).
    this.#retireStmt = database.prepare<WorktreeTransitionParams>(
      `UPDATE worktrees
          SET state = 'retired', updated_at = @now
        WHERE id = @worktree_id AND state <> 'retired'`,
    );

    // Guarded on `cleaned_at IS NULL` so a concurrent pass that already stamped the row does not
    // have its timestamp overwritten.
    this.#stampCleanedStmt = database.prepare<WorktreeTransitionParams>(
      `UPDATE worktrees
          SET cleaned_at = @now, updated_at = @now
        WHERE id = @worktree_id AND cleaned_at IS NULL`,
    );
  }

  /**
   * Provisions a worktree: resolves the base ref, records the row and `worktree.created`,
   * materializes the checkout, then records `ready` and `worktree.ready`. Throws on any failure and
   * never substitutes another execution mode; a failure after the row exists marks it `failed`.
   */
  async create(input: CreateWorktreeInput): Promise<CreatedWorktree> {
    const mount = this.#requireAttachedMount(input.repoMountId);

    const baseRef = await this.#resolveBaseRef(mount.canonical_root, input.baseRef);

    // Minted once, before the arbitration loop: the id is the last segment of `fs_root`.
    const worktreeId = this.#newWorktreeId();
    const worktreeRootsDirectory = join(
      this.#executionRootsDirectory,
      input.repoMountId,
      WORKTREE_ROOTS_SEGMENT,
    );
    const fsRoot = join(worktreeRootsDirectory, worktreeId);

    const branchName = await this.#insertCreatingRow({ worktreeId, fsRoot, input });

    try {
      await this.#materializeWorktree({
        canonicalRoot: mount.canonical_root,
        worktreeRootsDirectory,
        fsRoot,
        branchName,
        baseRef,
      });
    } catch (materializationFailure) {
      await this.#recordCreateFailure({
        worktreeId,
        fsRoot,
        canonicalRoot: mount.canonical_root,
      });
      throw materializationFailure;
    }

    try {
      await this.#events.emitWorktreeReady({
        sessionId: input.sessionId,
        worktreeId,
        repoMountId: input.repoMountId,
        actor: input.actor ?? null,
        ...(input.correlationId != null ? { correlationId: input.correlationId } : {}),
        transactionalPrelude: () => {
          assertSingleRowChanged(
            this.#markReadyStmt.run({ worktree_id: worktreeId, now: this.#now() }),
            worktreeId,
            "mark ready",
          );
        },
      });
    } catch (readyEmissionFailure) {
      // Same recovery as materialization: a `creating` row is live under the unique index and
      // unreachable by any sweep, so a bare throw would wedge (mount, branch). A rejected append
      // commits nothing, so `#markFailedStmt`'s `creating` predicate matches.
      await this.#recordCreateFailure({
        worktreeId,
        fsRoot,
        canonicalRoot: mount.canonical_root,
      });
      throw readyEmissionFailure;
    }

    return {
      worktreeId,
      repoMountId: input.repoMountId,
      branchName,
      fsRoot,
      baseRef,
      state: "ready",
    };
  }

  /**
   * Decides whether a named candidate may be bound as an execution root: returns it, or throws
   * `WorktreeReuseConflictError` (never substituting a fresh worktree) or `WorktreeNotFoundError`.
   * Cheapest check first, so no git process spawns for a doomed candidate; the dirty verdict is a
   * sample, since the user's editor can change the tree at any moment.
   */
  async validateReuse(input: ValidateWorktreeReuseInput): Promise<ReusableWorktreeCandidate> {
    const row = this.#selectWorktreeStmt.get({ worktree_id: input.worktreeId });
    if (row === undefined) {
      throw new WorktreeNotFoundError(input.worktreeId);
    }

    if (row.repo_mount_id !== input.repoMountId) {
      throw new WorktreeReuseConflictError(input.worktreeId, "mount_mismatch");
    }

    // Parsed, not cast: an out-of-vocabulary value is reachable only through corruption.
    const state = WorktreeStateSchema.parse(row.state);
    if (state === "retired" || state === "failed") {
      throw new WorktreeReuseConflictError(input.worktreeId, "not_live");
    }

    // Independent of the acknowledgement: an incompatible candidate is never bindable.
    if (row.branch_name !== input.branchName) {
      throw new WorktreeReuseConflictError(input.worktreeId, "branch_mismatch");
    }

    const dirty = await this.#isWorkingTreeDirty(input.worktreeId, row.fs_root);
    if (dirty && input.acknowledgeDirtyCandidate !== true) {
      throw new WorktreeReuseConflictError(input.worktreeId, "dirty_unacknowledged");
    }

    return {
      worktreeId: row.id,
      repoMountId: row.repo_mount_id,
      branchName: row.branch_name,
      fsRoot: row.fs_root,
      state,
      createdBySessionId: row.created_by_session_id,
      createdByRunId: row.created_by_run_id,
      dirty,
    };
  }

  /**
   * Records `-> retired` plus `worktree.retired` and touches nothing on disk; `cleanupPass` removes
   * the root. Throws `WorktreeRetireConflictError` while a `busy` workspace is bound (decided
   * inside the transaction) and `WorktreeNotFoundError` for an unknown id. Idempotent on a
   * `retired` row; `failed` is a legal predecessor, the only route by which a failed creation
   * becomes sweepable.
   */
  async retire(
    worktreeId: string,
    options: RetireWorktreeOptions = {},
  ): Promise<WorktreeRetireResponse> {
    const row = this.#selectWorktreeStmt.get({ worktree_id: worktreeId });
    if (row === undefined) {
      throw new WorktreeNotFoundError(worktreeId);
    }

    // Parses the row's id, not the argument, after the not-found refusal, so a malformed argument
    // gets `WorktreeNotFoundError` rather than a ZodError.
    const parsedWorktreeId = WorktreeIdSchema.parse(row.id);
    // A fast path, not the authority: the prelude re-reads the state in the transaction. It only
    // spares an already-retired row the append lock.
    if (WorktreeStateSchema.parse(row.state) === "retired") {
      return { worktreeId: parsedWorktreeId, state: "retired" };
    }

    try {
      await this.#emitRetirement(row, options);
    } catch (retirementFailure) {
      // Only the sentinel: a concurrent retirement won, and the response is the same. Anything else
      // (busy refusal, failed append, CAS assert) propagates.
      if (!(retirementFailure instanceof WorktreeAlreadyRetiredError)) {
        throw retirementFailure;
      }
    }
    return { worktreeId: parsedWorktreeId, state: "retired" };
  }

  /**
   * One sweep: retires live worktrees on a mount no longer `attached`, then removes `retired` roots
   * with no `cleaned_at`, prunes their administrative entry, and only then stamps the row. Per-row
   * failures propagate (swallowing an `EACCES` would report a clean pass); the pass is idempotent
   * and re-entrant, so the next tick resumes. Only the administrative prune is best-effort.
   */
  async cleanupPass(): Promise<WorktreeCleanupPassResult> {
    const retiredWorktreeIds: string[] = [];
    for (const row of this.#selectSweepableStmt.all()) {
      try {
        await this.#emitRetirement(row, {});
      } catch (retirementFailure) {
        if (retirementFailure instanceof WorktreeAlreadyRetiredError) {
          continue;
        }
        throw retirementFailure;
      }
      retiredWorktreeIds.push(row.id);
    }

    const cleanedWorktreeIds: string[] = [];
    for (const row of this.#selectUncleanedRetiredStmt.all()) {
      // Re-decided per row, right before removal: earlier removals are awaits a `markBusy` can land
      // in. One landing during this row's own removal stays open (no claim column, and stamping
      // before removing is forbidden).
      if (this.#selectBusyHolderStmt.get({ worktree_id: row.id }) !== undefined) {
        continue;
      }
      await this.#filesystem.removeDirectory(row.fs_root);
      // After the removal: `worktree prune` only drops entries whose directory is missing.
      await this.#pruneWorktreeAdministrativeEntries(row.canonical_root);
      this.#stampCleanedStmt.run({ worktree_id: row.id, now: this.#now() });
      cleanedWorktreeIds.push(row.id);
    }

    return { retiredWorktreeIds, cleanedWorktreeIds };
  }

  #requireAttachedMount(repoMountId: string): AttachedMountRow {
    const mount = this.#selectAttachedMountStmt.get({ repo_mount_id: repoMountId });
    if (mount === undefined) {
      // The carrier, not a re-mint of `repo.not_found`: two classes for a code break `instanceof`.
      throw new RepoMountNotFoundError(repoMountId);
    }
    return mount;
  }

  /**
   * Inserts the `creating` row and `worktree.created` in one transaction; returns the branch that
   * landed. INSERT-and-catch, since SELECT-then-INSERT lets two creates both read "free".
   */
  async #insertCreatingRow(attempt: CreatingRowAttempt): Promise<string> {
    const { input } = attempt;

    for (let ordinal = 1; ordinal <= MAX_BRANCH_NAME_ORDINAL; ordinal += 1) {
      const candidateBranchName =
        ordinal === 1 ? input.branchName : `${input.branchName}-${ordinal}`;

      // The suffix can outgrow the wire cap, and a persisted over-cap `branch_name` would fail the
      // status-read projection for every worktree, so the first over-cap candidate is refused
      // (later ordinals are longer). Ordinal 1 reaches it only from a caller that bypassed the cap.
      if (candidateBranchName.length > WORKTREE_GIT_REF_MAX_LEN) {
        throw new WorktreeCreateFailedError("branch_name_unavailable");
      }

      try {
        await this.#events.emitWorktreeCreated({
          sessionId: input.sessionId,
          worktreeId: attempt.worktreeId,
          repoMountId: input.repoMountId,
          actor: input.actor ?? null,
          ...(input.correlationId != null ? { correlationId: input.correlationId } : {}),
          transactionalPrelude: () => {
            this.#insertWorktreeStmt.run({
              id: attempt.worktreeId,
              repo_mount_id: input.repoMountId,
              created_by_session_id: input.sessionId,
              created_by_run_id: input.runId ?? null,
              branch_name: candidateBranchName,
              fs_root: attempt.fsRoot,
              now: this.#now(),
            });
          },
        });
        return candidateBranchName;
      } catch (appendFailure) {
        // Only a confirmed live-branch collision is handled. The code check refuses non-UNIQUE
        // failures (an id collision raises SQLITE_CONSTRAINT_PRIMARYKEY); the live-row read refuses
        // a UNIQUE failure this (mount, branch) cannot explain.
        if (!isUniqueConstraintViolation(appendFailure)) {
          throw appendFailure;
        }
        const liveRow = this.#selectLiveWorktreeOnBranchStmt.get({
          repo_mount_id: input.repoMountId,
          branch_name: candidateBranchName,
        });
        if (liveRow === undefined) {
          throw appendFailure;
        }
        if (input.onCollision === "refuse") {
          throw new WorktreeBranchCollisionError(input.repoMountId, candidateBranchName);
        }
        // `suffix`: next ordinal; the failed attempt left neither a row nor an event.
      }
    }

    throw new WorktreeCreateFailedError("branch_name_unavailable");
  }

  /**
   * Marks a `creating` row `failed` and best-effort removes what the attempt left: a half-written
   * checkout, or (after a failed ready emission) a real directory and administrative entry. The
   * removal is scoped to a path this call just minted, so it only reaches its own debris.
   */
  async #recordCreateFailure(recovery: CreateFailureRecovery): Promise<void> {
    // Zero rows changed is tolerated, not asserted: an assert would replace the creation failure
    // the caller re-raises.
    this.#markFailedStmt.run({ worktree_id: recovery.worktreeId, now: this.#now() });
    try {
      await this.#filesystem.removeDirectory(recovery.fsRoot);
      await this.#pruneWorktreeAdministrativeEntries(recovery.canonicalRoot);
    } catch {
      // Swallowed only here: the caller is already throwing the creation failure. A `failed` row is
      // reached by no sweep step, so a directory whose cleanup failed stays until
      // `repo.worktreeRetire` moves the row (bounded to one root per double failure).
    }
  }

  /**
   * Appends `worktree.retired` with the whole decision in its prelude, inside the event's
   * transaction: an already-`retired` row aborts with the sentinel, a `busy` holder refuses before
   * the INSERT so nothing persists, and the compare-and-swap keeps the plain assert.
   */
  async #emitRetirement(row: WorktreeRow, options: RetireWorktreeOptions): Promise<void> {
    await this.#events.emitWorktreeRetired({
      // The row's own session: the event belongs to the creator, and the sweep has no caller.
      sessionId: row.created_by_session_id,
      worktreeId: row.id,
      repoMountId: row.repo_mount_id,
      actor: options.actor ?? null,
      ...(options.correlationId != null ? { correlationId: options.correlationId } : {}),
      transactionalPrelude: () => {
        const current = this.#selectWorktreeStmt.get({ worktree_id: row.id });
        if (current === undefined) {
          // No `DELETE` path exists, so a vanished row is corruption, not a race.
          throw new Error(
            `cannot retire worktree "${row.id}": its row disappeared before the write committed`,
          );
        }
        if (WorktreeStateSchema.parse(current.state) === "retired") {
          throw new WorktreeAlreadyRetiredError(row.id);
        }

        const holder = this.#selectBusyHolderStmt.get({ worktree_id: row.id });
        if (holder !== undefined) {
          throw new WorktreeRetireConflictError(row.id, holder.workspace_id);
        }

        assertSingleRowChanged(
          this.#retireStmt.run({ worktree_id: row.id, now: this.#now() }),
          row.id,
          "retire",
        );
      },
    });
  }

  /**
   * The single git entry point. It prepends `-c core.hooksPath=<empty dir>` and `-c
   * core.fsmonitor=false` so no call skips hook neutralization; a command-line `-c` outranks all
   * config, and the fsmonitor hook is named by config value so `hooksPath` never governs it.
   */
  async #runGit(argv: readonly string[]): Promise<WorktreeGitInvocationResult> {
    // Created per call: a temp-file reaper that removed it would silently restore the repository's
    // hooks. Checkout filter drivers are not neutralized: their commands come from git config, and
    // disabling smudge would corrupt LFS.
    await this.#filesystem.createDirectory(this.#hookNeutralizationDirectory);
    return this.#git(
      [
        "-c",
        `core.hooksPath=${this.#hookNeutralizationDirectory}`,
        "-c",
        "core.fsmonitor=false",
        ...argv,
      ],
      { timeoutMs: this.#gitCommandTimeoutMs },
    );
  }

  /**
   * Drops the `$GIT_DIR/worktrees/<name>` entries of worktrees whose directory is gone; nothing
   * else clears what `worktree add` leaves in the user's repository. Best-effort: the directory
   * removal already succeeded, and a detached mount's root may be unreadable. A `null` root: skip.
   */
  async #pruneWorktreeAdministrativeEntries(canonicalRoot: string | null): Promise<void> {
    if (canonicalRoot === null) {
      return;
    }
    try {
      await this.#runGit(["-C", canonicalRoot, "worktree", "prune"]);
    } catch {
      // Best-effort; never at the expense of the `cleaned_at` stamp the caller writes next.
    }
  }

  /**
   * The supplied ref, else the mount's current HEAD branch, else a typed refusal, never a guess. A
   * leading `-` is refused before any git call, since git would read it as a flag; a failed or
   * empty `symbolic-ref` (detached HEAD) both refuse.
   */
  async #resolveBaseRef(
    canonicalRoot: string,
    suppliedBaseRef: string | undefined,
  ): Promise<string> {
    if (suppliedBaseRef !== undefined) {
      if (suppliedBaseRef.startsWith("-")) {
        throw new WorktreeCreateFailedError("base_ref_option_like");
      }
      return suppliedBaseRef;
    }

    let result: WorktreeGitInvocationResult;
    try {
      result = await this.#runGit([
        "-C",
        canonicalRoot,
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      ]);
    } catch {
      throw new WorktreeCreateFailedError("base_ref_unresolved");
    }

    const headBranch = result.stdout.trim();
    if (headBranch.length === 0) {
      throw new WorktreeCreateFailedError("base_ref_unresolved");
    }
    return headBranch;
  }

  /**
   * Creates only the parent directory: `git worktree add` refuses a non-empty existing target, and
   * creating the leaf would make this module predict what git tolerates.
   */
  async #materializeWorktree(materialization: WorktreeMaterialization): Promise<void> {
    try {
      await this.#filesystem.createDirectory(materialization.worktreeRootsDirectory);
    } catch {
      throw new WorktreeCreateFailedError("execution_root_unavailable");
    }

    try {
      // `-C` rather than a `cwd`: the invocation is entirely in the argv. `-b` creates the branch
      // and checkout together, which the unique index models.
      await this.#runGit([
        "-C",
        materialization.canonicalRoot,
        "worktree",
        "add",
        "-b",
        materialization.branchName,
        materialization.fsRoot,
        materialization.baseRef,
      ]);
    } catch {
      // git `stderr` stops here: it is the value most likely to name a filesystem path.
      throw new WorktreeCreateFailedError("git_invocation_failed");
    }
  }

  /**
   * Whether the checkout holds uncommitted work: any `--porcelain` output means dirty. A query that
   * does not complete (including a stdout overflow) is refused, not guessed, since binding on an
   * unknown verdict is a silent bind.
   */
  async #isWorkingTreeDirty(worktreeId: string, fsRoot: string): Promise<boolean> {
    let result: WorktreeGitInvocationResult;
    try {
      result = await this.#runGit(["-C", fsRoot, "status", "--porcelain"]);
    } catch {
      throw new WorktreeReuseConflictError(worktreeId, "cleanliness_unresolved");
    }
    return result.stdout.trim().length > 0;
  }
}

/**
 * Whether a thrown value is a SQLite UNIQUE violation, narrowed with `in` rather than cast. The
 * code alone is not proof of a branch collision; the caller confirms with a live-row read.
 */
function isUniqueConstraintViolation(thrown: unknown): boolean {
  if (typeof thrown !== "object" || thrown === null) {
    return false;
  }
  if (!("code" in thrown)) {
    return false;
  }
  const code: unknown = thrown.code;
  return code === "SQLITE_CONSTRAINT_UNIQUE";
}

/**
 * Asserts a compare-and-swap moved exactly one row. Called inside a `transactionalPrelude`, where
 * a throw aborts the transaction and the event row with it. A plain `Error`: an internal
 * consistency failure with no caller repair.
 */
function assertSingleRowChanged(
  result: { readonly changes: number },
  worktreeId: string,
  attemptedAction: string,
): void {
  if (result.changes !== 1) {
    throw new Error(
      `cannot ${attemptedAction} worktree "${worktreeId}": it left its expected state before the write committed`,
    );
  }
}
