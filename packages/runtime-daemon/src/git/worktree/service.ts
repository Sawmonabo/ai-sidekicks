// Worktree lifecycle service: owns the `worktrees` table and every git call that provisions or
// inspects a worktree root. Each `fs_root` sits under the execution-roots directory, never in the
// attached checkout. It holds no `workspaces` write; its caller wraps these calls.
//
//   * The main checkout is never mutated: git runs only `symbolic-ref --quiet --short HEAD`,
//     `check-ref-format --branch`, `for-each-ref`, `worktree add -b`, `worktree prune` (the only
//     thing that unregisters what `add` wrote).
//   * `cleanupPass` removes the directory, prunes, then stamps `cleaned_at`, so a crash between
//     steps is retried and never recorded as a cleanup that did not happen.

import { join, relative, sep } from "node:path";
import type { Statement } from "better-sqlite3";
import {
  WorktreeIdSchema,
  WorktreeStateSchema,
  type WorktreeRetireResponse,
  type WorktreeState,
} from "@ai-sidekicks/contracts/worktree/lifecycle";
import type { DatabaseConnections } from "../../database/connections.js";
import type { WriteStatement } from "../../database/statement.js";
import { WriteRefusedError, type DatabaseWriter } from "../../database/writer.js";
import { RepoMountNotFoundError } from "../../workspace/repo/errors.js";
import {
  WorktreeBranchCollisionError,
  WorktreeCreateFailedError,
  WorktreeNotFoundError,
  WorktreeRetireConflictError,
} from "./errors.js";
import type { WorktreeEventEmitter } from "./event-emitter.js";
import { mintUuidV7 } from "../../uuid-v7.js";
import { DEFAULT_GIT_FILESYSTEM, type GitFilesystem } from "../filesystem.js";
import {
  createHookNeutralizedGitCommand,
  DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  runGitWithExecFile,
  type GitCommand,
  type GitInvocationResult,
  type GitRunner,
} from "../process.js";
import { MAX_BRANCH_NAME_ORDINAL } from "./branch-name.js";
import {
  explainWorktreeRowRefusal,
  type AttachedMountRow,
  type BranchLookupParams,
  type HoldingWorkspaceRow,
  type InsertWorktreeParams,
  type MountLookupParams,
  type WorktreeIdRow,
  type WorktreeLookupParams,
  type WorktreeRootRow,
  type WorktreeRetirementRow,
  type WorktreeTransitionParams,
} from "./rows.js";
import { hasSqliteErrorCode } from "../../session/sqlite-error-code.js";
import { withCleanupFailures } from "../../cleanup-failures.js";

/** Dependencies of {@link WorktreeService}; only the first three are required. */
export interface WorktreeServiceDeps {
  /** Reads on its reader; a row write without an event goes through its writer. */
  readonly database: DatabaseConnections;
  /** Event emission seam; this service constructs no envelopes of its own. */
  readonly events: WorktreeEventEmitter;
  /**
   * Absolute, and not re-validated here. Roots are `<dir>/<repoMountId>/worktrees/<worktreeId>`;
   * the hook-neutralization directory is a sibling.
   */
  readonly executionRootsDirectory: string;
  /** Git process seam; defaults to `execFile` against `git`. */
  readonly git?: GitRunner;
  /** Filesystem seam; defaults to `node:fs/promises`. */
  readonly filesystem?: GitFilesystem;
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
  /**
   * The branch to create, resolved by the caller (see {@link deriveWorktreeBranchName}). Git's own
   * branch-name rule judges it before anything else runs; a refusal carries git's line.
   */
  readonly branchName: string;
  /**
   * `refuse` (a caller-supplied name) raises {@link WorktreeBranchCollisionError}; `suffix` (a
   * daemon-derived name) takes the first ordinal free both in the index and among the
   * repository's branches. Explicit: every call arrives with a name.
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

const WORKTREE_ROOTS_SEGMENT = "worktrees";

// Spelled to match `idx_worktrees_active_branch` exactly, so "live" reads agree with the arbiter.
const LIVE_WORKTREE_STATE_PREDICATE = "worktrees.state NOT IN ('retired', 'failed')";

// `state` is left to the column DEFAULT ('creating'); naming it would copy that fact.
const INSERT_WORKTREE_SQL = `INSERT INTO worktrees (
    id, repo_mount_id, created_by_session_id, created_by_run_id,
    branch_name, fs_root, created_at, updated_at
  ) VALUES (
    @id, @repo_mount_id, @created_by_session_id, @created_by_run_id,
    @branch_name, @fs_root, @now, @now
  )`;

const MARK_READY_SQL = `UPDATE worktrees
    SET state = 'ready', updated_at = @now
  WHERE id = @worktree_id AND state = 'creating'`;

// No event accompanies this one: the caller's `failRootPreparation` events the failure as
// `workspace.stale`.
const MARK_FAILED_SQL = `UPDATE worktrees
    SET state = 'failed', updated_at = @now
  WHERE id = @worktree_id AND state = 'creating'`;

// The retirement's write checks, in order, that the row is not yet retired and that no `busy`
// workspace holds its root, then retires it; every non-`retired` state is a legal predecessor,
// `failed` included.
const SELECT_UNRETIRED_WORKTREE_SQL = `SELECT id FROM worktrees
  WHERE id = @worktree_id AND state <> 'retired'`;
const RETIRE_SQL = `UPDATE worktrees
    SET state = 'retired', updated_at = @now
  WHERE id = @worktree_id AND state <> 'retired'`;
// The positions of the retirement write's checks among its statements.
const UNRETIRED_CHECK_INDEX = 0;
const BUSY_HOLDER_CHECK_INDEX = 1;

// Guarded on `cleaned_at IS NULL` so a concurrent pass that already stamped the row does not have
// its timestamp overwritten.
const STAMP_CLEANED_SQL = `UPDATE worktrees
    SET cleaned_at = @now, updated_at = @now
  WHERE id = @worktree_id AND cleaned_at IS NULL`;

// Keyed on `fs_root`, not `branch_contexts`: context rows are retained history, so a join would let
// a workspace since moved to another root block a retirement. A `busy` workspace at this `fs_root`
// is exactly a run holding it. Runs in the retirement's write and per sweep row.
const SELECT_BUSY_HOLDER_SQL = `SELECT holder.id AS workspace_id
    FROM worktrees
    JOIN workspaces AS holder ON holder.fs_root = worktrees.fs_root
   WHERE worktrees.id = @worktree_id
     AND holder.state = 'busy'
   LIMIT 1`;

// A transition statement on one worktree row, guarded on its row count when one is given.
function transitionStatement(
  sql: string,
  params: WorktreeTransitionParams,
  expectedRowCount?: number,
): WriteStatement {
  // Spread, because an interface carries no index signature for the bindings' record.
  const bindings = { ...params };
  return expectedRowCount === undefined ? { sql, bindings } : { sql, bindings, expectedRowCount };
}

/**
 * What `#emitRetirement` throws when its write found the row already retired, so no second
 * `worktree.retired` was appended. Internal, not a `DaemonDomainError`; `retire` and
 * `cleanupPass` both catch it.
 */
class WorktreeAlreadyRetiredError extends Error {
  constructor(worktreeId: string) {
    super(
      `WorktreeService: worktree ${worktreeId} was already retired when the retirement ` +
        `was written; nothing was appended, so one transition carries one worktree.retired event.`,
    );
    this.name = "WorktreeAlreadyRetiredError";
  }
}

/** One `create` call's arbitration-loop state; the name and policy stay on `input`. */
interface CreatingRowAttempt {
  readonly worktreeId: string;
  readonly fsRoot: string;
  /** The mount's root, where `suffix` asks git whether a candidate branch already exists. */
  readonly canonicalRoot: string;
  readonly input: CreateWorktreeInput;
}

/**
 * What a failed `create` disposes of. Both paths are absolute; transposing them would aim
 * `removePath` at the user's repository root.
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
 * Owns every `worktrees` transition and worktree-scoped git call. Each `UPDATE` carries its
 * legal-predecessor set in its `WHERE`, so the transition table lives in the statements.
 */
export class WorktreeService {
  readonly #events: WorktreeEventEmitter;
  readonly #executionRootsDirectory: string;
  readonly #runGit: GitCommand;
  readonly #filesystem: GitFilesystem;
  readonly #now: () => string;
  readonly #newWorktreeId: () => string;

  readonly #selectAttachedMountStmt: Statement<MountLookupParams, AttachedMountRow>;
  readonly #selectWorktreeStmt: Statement<WorktreeLookupParams, WorktreeRetirementRow>;
  readonly #selectLiveWorktreeOnBranchStmt: Statement<BranchLookupParams, WorktreeIdRow>;
  readonly #selectBusyHolderStmt: Statement<WorktreeLookupParams, HoldingWorkspaceRow>;
  readonly #selectSweepableStmt: Statement<[], WorktreeRetirementRow>;
  readonly #selectUncleanedRetiredStmt: Statement<[], WorktreeRootRow>;
  readonly #writer: Pick<DatabaseWriter, "write">;

  constructor(deps: WorktreeServiceDeps) {
    this.#events = deps.events;
    this.#executionRootsDirectory = deps.executionRootsDirectory;
    this.#filesystem = deps.filesystem ?? DEFAULT_GIT_FILESYSTEM;
    this.#runGit = createHookNeutralizedGitCommand({
      git: deps.git ?? runGitWithExecFile,
      filesystem: this.#filesystem,
      executionRootsDirectory: deps.executionRootsDirectory,
      timeoutMs: deps.gitCommandTimeoutMs ?? DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    });
    this.#now = deps.now ?? ((): string => new Date().toISOString());
    this.#newWorktreeId = deps.newWorktreeId ?? mintUuidV7;

    const database = deps.database.reader;
    this.#writer = deps.database.writer;

    // Only `attached` mounts are provisioning targets; a detached one gets `repo.not_found`.
    this.#selectAttachedMountStmt = database.prepare<MountLookupParams, AttachedMountRow>(
      `SELECT id, canonical_root
         FROM repo_mounts
        WHERE id = @repo_mount_id AND state = 'attached'`,
    );

    this.#selectWorktreeStmt = database.prepare<WorktreeLookupParams, WorktreeRetirementRow>(
      `SELECT id, repo_mount_id, created_by_session_id, state
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

    this.#selectBusyHolderStmt = database.prepare<WorktreeLookupParams, HoldingWorkspaceRow>(
      SELECT_BUSY_HOLDER_SQL,
    );

    // Live worktrees on a mount no longer `attached`. They retire through `#emitRetirement`, so the
    // busy probe applies; a conflict means the tables disagree and propagates fail-closed.
    this.#selectSweepableStmt = database.prepare<[], WorktreeRetirementRow>(
      `SELECT worktrees.id, worktrees.repo_mount_id, worktrees.created_by_session_id,
              worktrees.state
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
      `SELECT worktrees.id, worktrees.repo_mount_id, worktrees.fs_root, repo_mounts.canonical_root
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
  }

  /**
   * Provisions a worktree: resolves the base ref, records the row and `worktree.created`,
   * materializes the checkout, then records `ready` and `worktree.ready`. Throws on any failure and
   * never substitutes another execution mode; a failure after the row exists marks it `failed`.
   */
  async create(input: CreateWorktreeInput): Promise<CreatedWorktree> {
    const mount = this.#requireAttachedMount(input.repoMountId);

    const baseRef = await this.#resolveBaseRef(mount.canonical_root, input.baseRef);
    await this.#requireValidBranchName(mount.canonical_root, input.branchName);

    // Minted once, before the arbitration loop: the id is the last segment of `fs_root`.
    const worktreeId = this.#newWorktreeId();
    const worktreeRootsDirectory = join(
      this.#executionRootsDirectory,
      input.repoMountId,
      WORKTREE_ROOTS_SEGMENT,
    );
    const fsRoot = join(worktreeRootsDirectory, worktreeId);

    const branchName = await this.#insertCreatingRow({
      worktreeId,
      fsRoot,
      canonicalRoot: mount.canonical_root,
      input,
    });

    try {
      await this.#materializeWorktree({
        canonicalRoot: mount.canonical_root,
        worktreeRootsDirectory,
        fsRoot,
        branchName,
        baseRef,
      });
    } catch (materializationFailure) {
      throw withCleanupFailures(
        materializationFailure,
        await this.#recordCreateFailure({
          worktreeId,
          fsRoot,
          canonicalRoot: mount.canonical_root,
        }),
        "worktree creation",
      );
    }

    try {
      await this.#events.emitWorktreeReady({
        sessionId: input.sessionId,
        worktreeId,
        repoMountId: input.repoMountId,
        actor: input.actor ?? null,
        ...(input.correlationId != null ? { correlationId: input.correlationId } : {}),
        transactionalPrelude: [
          transitionStatement(MARK_READY_SQL, { worktree_id: worktreeId, now: this.#now() }, 1),
        ],
      });
    } catch (readyEmissionFailure) {
      // Same recovery as materialization: a `creating` row is live under the unique index and
      // unreachable by any sweep, so a bare throw would wedge (mount, branch). A rejected append
      // commits nothing, so the `failed` transition's `creating` predicate matches.
      throw withCleanupFailures(
        explainWorktreeRowRefusal(readyEmissionFailure, worktreeId, "mark ready"),
        await this.#recordCreateFailure({
          worktreeId,
          fsRoot,
          canonicalRoot: mount.canonical_root,
        }),
        "worktree creation",
      );
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
    // A fast path, not the authority: the retirement's write checks the state again. It only
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
      this.#requireMintedWorktreeRoot(row);
      await this.#filesystem.removePath(row.fs_root);
      // After the removal: `worktree prune` only drops entries whose directory is missing.
      await this.#pruneWorktreeAdministrativeEntries(row.canonical_root);
      await this.#writer.write([
        transitionStatement(STAMP_CLEANED_SQL, { worktree_id: row.id, now: this.#now() }),
      ]);
      cleanedWorktreeIds.push(row.id);
    }

    return { retiredWorktreeIds, cleanedWorktreeIds };
  }

  /**
   * Refuses a stored root that is not `<executionRootsDirectory>/<mount>/worktrees/<id>`, the only
   * shape `create` mints: the path comes from the database, and a recursive removal must not reach
   * the hooks directory, another mount's tree or anything outside the execution-roots directory.
   */
  #requireMintedWorktreeRoot(row: WorktreeRootRow): void {
    const segments: readonly string[] = relative(this.#executionRootsDirectory, row.fs_root).split(
      sep,
    );
    if (
      segments.length !== 3 ||
      segments[0] !== row.repo_mount_id ||
      segments[1] !== WORKTREE_ROOTS_SEGMENT ||
      segments[2] !== row.id
    ) {
      throw new Error(
        `cannot clean worktree "${row.id}": its stored root is not one this service minted`,
      );
    }
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

      // A removed worktree keeps its branch, so the index alone would call that name free and
      // `worktree add -b` would fail on it; `suffix` moves past a branch git already has.
      if (
        input.onCollision === "suffix" &&
        (await this.#repositoryHasBranch(attempt.canonicalRoot, candidateBranchName))
      ) {
        continue;
      }

      try {
        await this.#events.emitWorktreeCreated({
          sessionId: input.sessionId,
          worktreeId: attempt.worktreeId,
          repoMountId: input.repoMountId,
          actor: input.actor ?? null,
          ...(input.correlationId != null ? { correlationId: input.correlationId } : {}),
          transactionalPrelude: [
            {
              sql: INSERT_WORKTREE_SQL,
              bindings: {
                id: attempt.worktreeId,
                repo_mount_id: input.repoMountId,
                created_by_session_id: input.sessionId,
                created_by_run_id: input.runId ?? null,
                branch_name: candidateBranchName,
                fs_root: attempt.fsRoot,
                now: this.#now(),
              } satisfies InsertWorktreeParams,
            },
          ],
        });
        return candidateBranchName;
      } catch (appendFailure) {
        // Only a confirmed live-branch collision is handled. The code check refuses non-UNIQUE
        // failures (an id collision raises SQLITE_CONSTRAINT_PRIMARYKEY); the live-row read refuses
        // a UNIQUE failure this (mount, branch) cannot explain.
        if (!hasSqliteErrorCode(appendFailure, "SQLITE_CONSTRAINT_UNIQUE")) {
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
   * Marks a `creating` row `failed` and removes what the attempt left: a half-written checkout, or
   * (after a failed ready emission) a real directory and administrative entry. The removal is
   * scoped to a path this call just minted, so it only reaches its own debris. Answers the removal
   * failure, if any, for the caller to carry on the creation failure it throws.
   */
  async #recordCreateFailure(recovery: CreateFailureRecovery): Promise<unknown[]> {
    // Zero rows changed is tolerated, not asserted: an assert would replace the creation failure
    // the caller re-raises.
    await this.#writer.write([
      transitionStatement(MARK_FAILED_SQL, { worktree_id: recovery.worktreeId, now: this.#now() }),
    ]);
    try {
      await this.#filesystem.removePath(recovery.fsRoot);
    } catch (cleanupFailure: unknown) {
      // A `failed` row is reached by no sweep step, so the directory stays until
      // `repo.worktreeRetire` moves the row (bounded to one root per double failure).
      return [cleanupFailure];
    }
    await this.#pruneWorktreeAdministrativeEntries(recovery.canonicalRoot);
    return [];
  }

  /**
   * Appends `worktree.retired` with the whole decision in the same write: an already-`retired` row
   * refuses it with the sentinel, a `busy` holder refuses it so nothing persists, and the
   * compare-and-swap keeps the plain error.
   */
  async #emitRetirement(row: WorktreeRetirementRow, options: RetireWorktreeOptions): Promise<void> {
    const worktreeLookup = { worktree_id: row.id } satisfies WorktreeLookupParams;
    try {
      await this.#events.emitWorktreeRetired({
        // The row's own session: the event belongs to the creator, and the sweep has no caller.
        sessionId: row.created_by_session_id,
        worktreeId: row.id,
        repoMountId: row.repo_mount_id,
        actor: options.actor ?? null,
        ...(options.correlationId != null ? { correlationId: options.correlationId } : {}),
        transactionalPrelude: [
          { sql: SELECT_UNRETIRED_WORKTREE_SQL, bindings: worktreeLookup, expectedRowCount: 1 },
          { sql: SELECT_BUSY_HOLDER_SQL, bindings: worktreeLookup, expectedRowCount: 0 },
          transitionStatement(RETIRE_SQL, { worktree_id: row.id, now: this.#now() }, 1),
        ],
      });
    } catch (retirementFailure) {
      if (!(retirementFailure instanceof WriteRefusedError)) {
        throw retirementFailure;
      }
      if (retirementFailure.statementIndex === UNRETIRED_CHECK_INDEX) {
        throw this.#explainUnretiredRefusal(row.id, retirementFailure);
      }
      if (retirementFailure.statementIndex === BUSY_HOLDER_CHECK_INDEX) {
        const holder = this.#selectBusyHolderStmt.get(worktreeLookup);
        if (holder === undefined) {
          // The hold was let go after the write saw it, so the retirement is legal again.
          await this.#emitRetirement(row, options);
          return;
        }
        throw new WorktreeRetireConflictError(row.id, holder.workspace_id);
      }
      throw explainWorktreeRowRefusal(retirementFailure, row.id, "retire");
    }
  }

  // The write found no unretired row: retired is terminal and no `DELETE` path exists, so the row
  // is retired, or it vanished, which is corruption rather than a race.
  #explainUnretiredRefusal(worktreeId: string, refusal: WriteRefusedError): Error {
    const current = this.#selectWorktreeStmt.get({ worktree_id: worktreeId });
    if (current === undefined) {
      return new Error(
        `cannot retire worktree "${worktreeId}": its row disappeared before the write committed`,
        { cause: refusal },
      );
    }
    if (WorktreeStateSchema.parse(current.state) === "retired") {
      return new WorktreeAlreadyRetiredError(worktreeId);
    }
    return new Error(
      `cannot retire worktree "${worktreeId}": it left its expected state before the write ` +
        `committed`,
      { cause: refusal },
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
    } catch (pruneFailure: unknown) {
      // Logged, not thrown: never at the expense of the `cleaned_at` stamp the caller writes next.
      console.warn(
        `WorktreeService: \`git worktree prune\` in ${canonicalRoot} failed.`,
        pruneFailure,
      );
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

    let result: GitInvocationResult;
    try {
      result = await this.#runGit([
        "-C",
        canonicalRoot,
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      ]);
    } catch (gitFailure) {
      throw new WorktreeCreateFailedError("base_ref_unresolved", gitFailure);
    }

    const headBranch = result.stdout.toString("utf8").trim();
    if (headBranch.length === 0) {
      throw new WorktreeCreateFailedError("base_ref_unresolved");
    }
    return headBranch;
  }

  /**
   * Git's own branch-name rule, run before any row or event exists. A name starting with `-` would
   * otherwise reach `worktree add -b` as an option (`-D` deletes the branch named as the base).
   * The refusal carries git's `fatal:` line as git printed it, which names only the branch.
   */
  async #requireValidBranchName(canonicalRoot: string, branchName: string): Promise<void> {
    try {
      await this.#runGit(["-C", canonicalRoot, "check-ref-format", "--branch", branchName]);
    } catch (refusal) {
      const gitRefusalLine = readGitBranchNameRefusal(refusal);
      if (gitRefusalLine === null) {
        throw new WorktreeCreateFailedError("git_invocation_failed", refusal);
      }
      throw new WorktreeCreateFailedError("branch_name_invalid", gitRefusalLine, refusal);
    }
  }

  /**
   * Whether the repository already has a local branch at this name, or one nested under it. A
   * query that does not complete is a creation failure, never read as "free".
   */
  async #repositoryHasBranch(canonicalRoot: string, branchName: string): Promise<boolean> {
    let result: GitInvocationResult;
    try {
      result = await this.#runGit([
        "-C",
        canonicalRoot,
        "for-each-ref",
        "--count=1",
        "--format=%(refname)",
        `refs/heads/${branchName}`,
      ]);
    } catch (gitFailure) {
      throw new WorktreeCreateFailedError("git_invocation_failed", gitFailure);
    }
    return result.stdout.toString("utf8").trim().length > 0;
  }

  /**
   * Creates only the parent directory: `git worktree add` refuses a non-empty existing target, and
   * creating the leaf would make this module predict what git tolerates.
   */
  async #materializeWorktree(materialization: WorktreeMaterialization): Promise<void> {
    try {
      await this.#filesystem.createDirectory(materialization.worktreeRootsDirectory);
    } catch (filesystemFailure) {
      throw new WorktreeCreateFailedError("execution_root_unavailable", filesystemFailure);
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
    } catch (gitFailure) {
      // git's `stderr` rides only on `cause`: it is the value most likely to name a path.
      throw new WorktreeCreateFailedError("git_invocation_failed", gitFailure);
    }
  }
}

// Git's refusal of a branch name, printed under `LC_ALL=C`. Any other `fatal:` line (a missing
// mount directory, say) can name a path, so it never becomes the message.
const GIT_BRANCH_NAME_REFUSAL_PATTERN = /^fatal: '.*' is not a valid branch name$/;

/** Git's line refusing a branch name from a rejected call's `stderr`, else `null`. */
function readGitBranchNameRefusal(thrown: unknown): string | null {
  if (typeof thrown !== "object" || thrown === null || !("stderr" in thrown)) {
    return null;
  }
  const stderr: unknown = thrown.stderr;
  if (typeof stderr !== "string") {
    return null;
  }
  return stderr.split("\n").find((line) => GIT_BRANCH_NAME_REFUSAL_PATTERN.test(line)) ?? null;
}
