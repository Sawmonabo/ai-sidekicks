/**
 * Mode-dispatched orchestrator behind `repo.executionRootPrepare`, and the sole writer of
 * `branch_contexts`. Worktrees come from the worktree service; `workspaces` changes go through
 * the lifecycle primitives.
 *
 * - The workspace's stored mode decides; an unreadable mode is a defect, never a default.
 * - Every refusal a caller could avoid fires before `beginRootPreparation` and outside the
 *   try/catch, because `failRootPreparation` is legal only from `preparing`.
 * - The gate is skipped inside an open bracket: `assertWritable` refuses `preparing`, and every
 *   first bind is born `preparing`.
 * - `bound-root` inserts one row per prepare (no index arbitrates it) and anchors `base_branch`
 *   to the head branch, since it cuts nothing. Rows accumulate because refreshing one in place
 *   would destroy the previous binding's base and head branches, which no other row records.
 */

import type { Database, Statement } from "better-sqlite3";

import {
  ExecutionModeSchema,
  type ExecutionMode,
  type WorkspaceState,
} from "@ai-sidekicks/contracts/repo/mount";
import {
  WorkspaceBranchMismatchError,
  WorkspaceBranchNameRequiredError,
} from "../git/worktree/errors.js";
import { deriveWorktreeBranchName } from "../git/worktree/branch-name.js";
import {
  type CreateWorktreeInput,
  type CreatedWorktree,
} from "../git/worktree/worktree-service.js";
import {
  createHookNeutralizedGitCommand,
  DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  readGitExitStatus,
  type GitCommand,
  type GitInvocationResult,
  type GitRunner,
} from "../git/process.js";
import { DaemonDomainError } from "../ipc/domain-error.js";

import { RepoMountNotFoundError } from "./repo/errors.js";
import { HOLDING_RUN_ID_METADATA_PATH } from "./row-guards.js";
import { WorkspaceBusyError, WorkspaceNotFoundError } from "./service-errors.js";
import { mintUuidV7 } from "../ids/uuid-v7.js";

/** A space is illegal in a git ref, so this cannot be mistaken for a real branch name. */
const DETACHED_HEAD_BRANCH_LABEL = "(detached HEAD)";

/** Exit status of `symbolic-ref --quiet` on a detached HEAD; any other non-zero one is a fault. */
const DETACHED_HEAD_EXIT_CODE = 1;

/** The filesystem seam. One verb: create leading directories, tolerate existing. */
interface ExecutionRootFilesystem {
  createDirectory(path: string): Promise<void>;
}

/** The worktree service narrowed to the calls this module makes; data types stay shared. */
export interface ExecutionRootWorktreeProvisioner {
  create(input: CreateWorktreeInput): Promise<CreatedWorktree>;
  /**
   * Compensation only: records the retirement and removes nothing from disk. `Promise<unknown>`
   * because the response is ignored and the real one is not `void`.
   */
  retire(worktreeId: string): Promise<unknown>;
}

/**
 * The four workspace primitives as one object, so the gate's verdict and the compare-and-swap
 * read and write the same rows on one connection. `WorkspaceService` satisfies it structurally.
 */
export interface WorkspaceLifecyclePrimitives {
  /** The gate: passes `ready` and `busy`, refuses `stale`, and is a defect otherwise. */
  assertWritable(workspaceId: string): Promise<void>;
  /** `ready` | `stale` -> `preparing`, releasing the old root. */
  beginRootPreparation(workspaceId: string, targetMode: ExecutionMode): Promise<void>;
  /** `preparing` -> `ready`, adopting `fsRoot`. */
  completeRootPreparation(workspaceId: string, fsRoot: string): Promise<void>;
  /** `preparing` -> `stale`, recording `failureDetail` as `metadata.lastError`. */
  failRootPreparation(workspaceId: string, failureDetail: string): Promise<void>;
}

/** Constructor dependencies for {@link ExecutionRootService}. */
export interface ExecutionRootServiceDeps {
  /**
   * The daemon's SQLite handle; it must be the connection `workspaces` writes through, which the
   * composition root owns.
   */
  readonly database: Database;
  /** The workspace lifecycle primitives, the only `workspaces` write channel. */
  readonly workspaces: WorkspaceLifecyclePrimitives;
  /** The worktree service, narrowed to the calls the `provisioned-worktree` arm makes. */
  readonly worktrees: ExecutionRootWorktreeProvisioner;
  /**
   * The execution-roots directory; only its hook-neutralization child is used, and it must match
   * the one the worktree services resolve.
   */
  readonly executionRootsDirectory: string;
  /** Git process seam; required, so the composition root names the runner. */
  readonly git: GitRunner;
  /** Filesystem seam. Required, like `git`. */
  readonly filesystem: ExecutionRootFilesystem;
  /** Per-invocation git timeout; defaults to two minutes. */
  readonly gitCommandTimeoutMs?: number;
  /** Wall clock for `created_at` / `updated_at`. Injectable for tests. */
  readonly now?: () => string;
  /** `branch_contexts.id` source. Injectable for deterministic tests. */
  readonly newBranchContextId?: () => string;
}

/**
 * `repo.executionRootPrepare`'s daemon-side input: ids are plain strings, and `runId` is
 * gate-only, so a wire caller cannot reach the branch-name fallback.
 */
export interface PrepareExecutionRootInput {
  readonly workspaceId: string;
  /** Required unless {@link runId} is given; neither refuses `workspace.branch_name_required`. */
  readonly branchName?: string;
  /**
   * The worktree base. Worktree-scoped, so `bound-root` mode ignores it; reusing it there would
   * give one field two meanings depending on a mode the caller may not know.
   */
  readonly baseRef?: string;
  /** Gate-only. Present iff a run is being set up; unlocks the branch fallback. */
  readonly runId?: string;
  /** Branch-collision disposition for a worktree CREATE. Defaults to `refuse`. */
  readonly onCollision?: "refuse" | "suffix";
}

/** A resolved execution root, a superset of `ExecutionRootPrepareResponse` for the gate. */
export interface PreparedExecutionRoot {
  readonly workspaceId: string;
  /** The mode that was dispatched. Never substituted. */
  readonly executionMode: ExecutionMode;
  /** Absolute. The directory the run executes in. */
  readonly executionRoot: string;
  /** The workspace's position AFTER the bracket: `ready` on success. */
  readonly state: WorkspaceState;
  /** The bound head branch. */
  readonly branchName: string;
  /** Present for `provisioned-worktree` mode only. */
  readonly worktreeId?: string;
  /** The `branch_contexts` row this prepare wrote or refreshed. */
  readonly branchContextId: string;
}

/** What {@link ExecutionRootServiceInvariantError} reports. */
type ExecutionRootInvariantKind =
  /** A `workspaces` row carries a mode outside the execution-mode vocabulary. */
  | "unreadable_workspace_row"
  /** A `branch_contexts` write reported a row count this module cannot explain. */
  | "branch_context_write_lost"
  /** `symbolic-ref` could not be run, or answered with a status this module cannot read. */
  | "branch_verification_failed";

/**
 * A defect, not a refusal, so not a `DaemonDomainError`: no retry or different arguments fixes it.
 * Messages carry ids, never paths, because they can reach a log.
 */
class ExecutionRootServiceInvariantError extends Error {
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
    this.name = new.target.name;
    this.kind = options.kind;
    this.workspaceId = options.workspaceId ?? null;
  }
}

interface WorkspaceLookupParams {
  readonly workspace_id: string;
}

interface MountLookupParams {
  readonly repo_mount_id: string;
}

interface WorktreePairLookupParams {
  readonly worktree_id: string;
  readonly workspace_id: string;
}

interface BranchContextWriteParams {
  readonly id: string;
  readonly workspace_id: string;
  readonly worktree_id: string | null;
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

interface BranchContextIdRow {
  readonly id: string;
}

/**
 * How a root came to be. Only `created` is compensated: a `bound` root is the user's own checkout.
 */
type ExecutionRootProvenance = "created" | "bound";

/** What one mode arm produced, before the branch context and the bracket close. */
interface MaterializedRoot {
  readonly executionRoot: string;
  readonly branchName: string;
  readonly baseBranch: string;
  readonly worktreeId: string | null;
  readonly provenance: ExecutionRootProvenance;
}

/**
 * Prepares the execution root for a repo-bound workspace in the mode `repo.workspaceBind` already
 * selected. The mode is read, never chosen.
 */
export class ExecutionRootService {
  readonly #workspaces: WorkspaceLifecyclePrimitives;
  readonly #worktrees: ExecutionRootWorktreeProvisioner;
  readonly #runGit: GitCommand;
  readonly #now: () => string;
  readonly #newBranchContextId: () => string;

  readonly #selectWorkspaceStmt: Statement<WorkspaceLookupParams, WorkspaceRootRow>;
  readonly #selectAttachedMountStmt: Statement<MountLookupParams, AttachedMountRow>;
  readonly #selectWorktreePairContextStmt: Statement<WorktreePairLookupParams, BranchContextIdRow>;
  readonly #upsertWorktreeContextStmt: Statement<BranchContextWriteParams>;
  readonly #insertBranchContextStmt: Statement<BranchContextWriteParams>;
  readonly #deleteBranchContextStmt: Statement<BranchContextDeleteParams>;

  constructor(deps: ExecutionRootServiceDeps) {
    this.#workspaces = deps.workspaces;
    this.#worktrees = deps.worktrees;
    // `-c core.fsmonitor=false` is inert here (`symbolic-ref` never reaches the fsmonitor hook);
    // the shared entry point keeps every service's argv the same.
    this.#runGit = createHookNeutralizedGitCommand({
      git: deps.git,
      createDirectory: (path) => deps.filesystem.createDirectory(path),
      executionRootsDirectory: deps.executionRootsDirectory,
      timeoutMs: deps.gitCommandTimeoutMs ?? DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    });
    this.#now = deps.now ?? ((): string => new Date().toISOString());
    this.#newBranchContextId = deps.newBranchContextId ?? mintUuidV7;

    const database = deps.database;

    // Projected in SQL so the row type stays flat.
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

    // Scoped to `attached`: a detached mount is not a preparation target.
    this.#selectAttachedMountStmt = database.prepare(
      `SELECT id, canonical_root
         FROM repo_mounts
        WHERE id = @repo_mount_id AND state = 'attached'`,
    );

    this.#selectWorktreePairContextStmt = database.prepare(
      `SELECT id
         FROM branch_contexts
        WHERE worktree_id = @worktree_id AND workspace_id = @workspace_id`,
    );

    // The conflict target repeats the partial index's WHERE clause, as SQLite requires. `@id` is
    // discarded on the update arm, so the caller re-reads the row id.
    this.#upsertWorktreeContextStmt = database.prepare(
      `INSERT INTO branch_contexts (
              id, workspace_id, worktree_id,
              base_branch, head_branch, created_at, updated_at
            )
       VALUES (
              @id, @workspace_id, @worktree_id,
              @base_branch, @head_branch, @now, @now
            )
       ON CONFLICT (worktree_id, workspace_id) WHERE worktree_id IS NOT NULL
       DO UPDATE SET base_branch = excluded.base_branch,
                     head_branch = excluded.head_branch,
                     updated_at  = excluded.updated_at`,
    );

    this.#insertBranchContextStmt = database.prepare(
      `INSERT INTO branch_contexts (
              id, workspace_id, worktree_id,
              base_branch, head_branch, created_at, updated_at
            )
       VALUES (
              @id, @workspace_id, @worktree_id,
              @base_branch, @head_branch, @now, @now
            )`,
    );

    // Keyed on the row id alone, so it can only reach the one row the failing call inserted.
    this.#deleteBranchContextStmt = database.prepare(
      `DELETE FROM branch_contexts
        WHERE id = @id`,
    );
  }

  /**
   * Materializes the workspace's root in its selected mode. Refusals (not found, stale, busy,
   * branch name required, branch mismatch, mount not attached) fire before the bracket opens.
   */
  async prepare(input: PrepareExecutionRootInput): Promise<PreparedExecutionRoot> {
    const workspace = this.#requireWorkspace(input.workspaceId);
    const executionMode = this.#requireKnownMode(workspace);

    // Open when this prepare is the bind's own preparation (`repo.workspaceBind` creates
    // workspaces `preparing`) or a prior `failRootPreparation` failed (`#failRootPreparation`).
    // `assertWritable` refuses `preparing`, so this one predicate drives the gate and the bracket.
    const bracketAlreadyOpen = workspace.state === "preparing";

    // Empty means absent: a whitespace run id derives no branch and never reaches
    // `created_by_run_id`.
    const runId = input.runId?.trim() ?? "";

    // Before any git call, so a stale workspace costs no spawn; skipped inside an open bracket.
    if (!bracketAlreadyOpen) {
      await this.#workspaces.assertWritable(workspace.id);
    }

    const branchName = this.#resolveBranchName(input, workspace, runId);

    // `assertWritable` passes `busy`; a second run is refused here so a busy bound-root prepare
    // never spawns git. A workspace that turns busy after this read is refused by
    // `beginRootPreparation` with the same error.
    if (workspace.state === "busy") {
      throw new WorkspaceBusyError(workspace.id, workspace.holding_run_id);
    }

    const mount = this.#requireAttachedMount(workspace.repo_mount_id);

    // Before the bracket: a mismatch is a caller disagreement, and `stale` is reserved for faults.
    if (executionMode === "bound-root") {
      await this.#verifyBoundRootBranch(workspace.id, mount.canonical_root, branchName);
    }

    // From here the workspace is `preparing` (an open bracket already is), which makes
    // `failRootPreparation` legal in the catch.
    if (!bracketAlreadyOpen) {
      await this.#workspaces.beginRootPreparation(workspace.id, executionMode);
    }

    let materialized: MaterializedRoot | undefined;
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
      // A failed context write leaves a root nothing will adopt, invisible to the sweep; an unset
      // `materialized` means materialization itself failed and its own service recorded that.
      const cleanupFailures: unknown[] =
        materialized === undefined ? [] : await this.#compensateOrphanedRoot(materialized, null);
      cleanupFailures.push(...(await this.#failRootPreparation(workspace.id, preparationFailure)));
      // Rethrow the cause itself where it can carry the cleanup failures: the run-setup gate wraps
      // by code.
      throw withCleanupFailures(preparationFailure, cleanupFailures);
    }

    try {
      await this.#workspaces.completeRootPreparation(workspace.id, materialized.executionRoot);
    } catch (completionFailure) {
      throw withCleanupFailures(
        completionFailure,
        await this.#compensateOrphanedRoot(materialized, branchContextId),
      );
    }

    return {
      workspaceId: workspace.id,
      executionMode,
      executionRoot: materialized.executionRoot,
      // What completing the bracket produced; a re-read could show a concurrent writer's state.
      state: "ready",
      branchName: materialized.branchName,
      ...(materialized.worktreeId === null ? {} : { worktreeId: materialized.worktreeId }),
      branchContextId,
    };
  }

  /**
   * The supplied name wins, else a name derived from `runId`, else a refusal. `runId` arrives
   * trimmed and empty means absent, or a caller error would become `branch_name_underivable`.
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

  /** Exhaustive over the execution modes; no default arm. */
  async #materialize(
    input: PrepareExecutionRootInput,
    workspace: WorkspaceRootRow,
    executionMode: ExecutionMode,
    mount: AttachedMountRow,
    branchName: string,
    runId: string,
  ): Promise<MaterializedRoot> {
    switch (executionMode) {
      case "bound-root":
        return this.#bindBoundRoot(mount, branchName);
      case "provisioned-worktree":
        return this.#prepareWorktreeRoot(input, workspace, mount, branchName, runId);
    }
  }

  /**
   * `bound-root` mode: bind only. The root comes from the mount because `beginRootPreparation`
   * releases `workspaces.fs_root`.
   */
  #bindBoundRoot(mount: AttachedMountRow, branchName: string): MaterializedRoot {
    return {
      executionRoot: mount.canonical_root,
      branchName,
      baseBranch: branchName,
      worktreeId: null,
      provenance: "bound",
    };
  }

  /** `provisioned-worktree` mode: a new worktree, cut for this workspace. */
  async #prepareWorktreeRoot(
    input: PrepareExecutionRootInput,
    workspace: WorkspaceRootRow,
    mount: AttachedMountRow,
    branchName: string,
    runId: string,
  ): Promise<MaterializedRoot> {
    const created = await this.#worktrees.create({
      repoMountId: mount.id,
      sessionId: workspace.session_id,
      branchName,
      // `refuse` by default: a suffix silently changes the branch a run publishes from.
      onCollision: input.onCollision ?? "refuse",
      ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
      // Omitted when absent: `created_by_run_id` is provenance.
      ...(runId.length === 0 ? {} : { runId }),
    });
    return {
      executionRoot: created.fsRoot,
      // The created name, not the requested one: `onCollision: 'suffix'` may have changed it.
      branchName: created.branchName,
      baseBranch: created.baseRef,
      worktreeId: created.worktreeId,
      provenance: "created",
    };
  }

  /**
   * Writes or refreshes the workspace's branch context: an upsert on the `(worktree_id,
   * workspace_id)` pair for a worktree root, a plain insert for `bound-root`. Synchronous, so a
   * second connection loses on the partial-unique index with a constraint failure, not a duplicate.
   */
  #writeBranchContext(workspaceId: string, materialized: MaterializedRoot): string {
    const now = this.#now();

    if (materialized.worktreeId !== null) {
      const worktreeId = materialized.worktreeId;
      this.#upsertWorktreeContextStmt.run({
        id: this.#newBranchContextId(),
        workspace_id: workspaceId,
        worktree_id: worktreeId,
        base_branch: materialized.baseBranch,
        head_branch: materialized.branchName,
        now,
      });
      // Re-read: the update arm discards the bound `@id`.
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

    // `bound-root`: rows accumulate, so this cannot conflict with an existing one.
    const branchContextId = this.#newBranchContextId();
    this.#insertBranchContextStmt.run({
      id: branchContextId,
      workspace_id: workspaceId,
      worktree_id: null,
      base_branch: materialized.baseBranch,
      head_branch: materialized.branchName,
      now,
    });
    return branchContextId;
  }

  #requireWorkspace(workspaceId: string): WorkspaceRootRow {
    const row = this.#selectWorkspaceStmt.get({ workspace_id: workspaceId });
    if (row === undefined) {
      // The shared carrier, so `instanceof` does not depend on which module threw.
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
   * The workspace's mode, validated rather than cast: a value outside the vocabulary means the
   * database disagrees with the schema. Re-raised typed, because a `ZodError` names no domain
   * fault.
   */
  #requireKnownMode(workspace: WorkspaceRootRow): ExecutionMode {
    const parsed = ExecutionModeSchema.safeParse(workspace.execution_mode);
    if (!parsed.success) {
      throw new ExecutionRootServiceInvariantError(
        `workspace ${workspace.id} carries an execution mode outside the ExecutionMode vocabulary`,
        {
          kind: "unreadable_workspace_row",
          workspaceId: workspace.id,
          cause: parsed.error,
        },
      );
    }
    return parsed.data;
  }

  /**
   * Records the failure on the workspace so the run blocks in setup, and returns the recording's
   * own failure, if any, for the caller to attach to the original cause. A workspace whose
   * recording failed stays `preparing`, which a later prepare treats as an open bracket.
   */
  async #failRootPreparation(workspaceId: string, cause: unknown): Promise<unknown[]> {
    try {
      await this.#workspaces.failRootPreparation(workspaceId, composeLastErrorDetail(cause));
      return [];
    } catch (recordingFailure) {
      return [recordingFailure];
    }
  }

  /**
   * Undoes a root this call created but could not hand over; nothing else reclaims it. Each step
   * runs even after an earlier one failed, and the failures are returned for the caller to attach
   * to the original cause: a delete followed by a failed retire leaves a live worktree with no
   * pair row, whose `(mount, branch)` stays held.
   */
  async #compensateOrphanedRoot(
    materialized: MaterializedRoot,
    branchContextId: string | null,
  ): Promise<unknown[]> {
    // Only `created`: a `bound` root is the user's own checkout.
    if (materialized.provenance !== "created") {
      return [];
    }

    const failures: unknown[] = [];
    // The preparation catch passes `null`: the context write is what failed, so no row exists.
    if (branchContextId !== null) {
      try {
        this.#deleteBranchContextStmt.run({ id: branchContextId });
      } catch (deleteFailure) {
        failures.push(deleteFailure);
      }
    }

    // Records the retirement only; the sweep reclaims the root. Its busy probe joins on `fs_root`,
    // and this workspace is `preparing` with none, so it does not refuse.
    try {
      if (materialized.worktreeId !== null) {
        await this.#worktrees.retire(materialized.worktreeId);
      }
    } catch (retireFailure) {
      failures.push(retireFailure);
    }
    return failures;
  }

  /**
   * The main checkout must already be on the requested branch; the daemon never switches a shared
   * checkout, and `WorkspaceBranchMismatchError` carries both names.
   */
  async #verifyBoundRootBranch(
    workspaceId: string,
    canonicalRoot: string,
    requestedBranchName: string,
  ): Promise<void> {
    // Exit 1 with empty output is a detached HEAD, an answer refused as a mismatch. Any other
    // status (git's 128) or none at all is infrastructure, and reporting it as detached would
    // suggest an impossible repair. Status only in the message: git's diagnostics name the
    // repository.
    let currentBranchName: string;
    try {
      const result: GitInvocationResult = await this.#runGit([
        "-C",
        canonicalRoot,
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      ]);
      currentBranchName = result.stdout.toString("utf8").trim();
    } catch (invocationFailure) {
      const exitStatus: number | null = readGitExitStatus(invocationFailure);
      if (exitStatus !== DETACHED_HEAD_EXIT_CODE || !printedNothing(invocationFailure)) {
        throw new ExecutionRootServiceInvariantError(
          exitStatus === null
            ? `branch verification for workspace ${workspaceId} could not run git`
            : `branch verification for workspace ${workspaceId} exited with status ${exitStatus}`,
          // For local logs; nothing puts it on the wire.
          { kind: "branch_verification_failed", workspaceId, cause: invocationFailure },
        );
      }
      currentBranchName = "";
    }

    // An empty name (detached) never equals a requested one, which is never empty.
    if (currentBranchName !== requestedBranchName) {
      throw new WorkspaceBranchMismatchError(
        workspaceId,
        requestedBranchName,
        currentBranchName.length === 0 ? DETACHED_HEAD_BRANCH_LABEL : currentBranchName,
      );
    }
  }
}

/**
 * The error to throw for `original` once cleanup after it failed too: `original` itself carrying
 * the cleanup failures as its `cause` when that is free, so its code still reaches the caller, or
 * every failure in one `AggregateError` when it is not.
 */
function withCleanupFailures(original: unknown, cleanupFailures: readonly unknown[]): unknown {
  if (cleanupFailures.length === 0) {
    return original;
  }
  if (original instanceof Error && original.cause === undefined) {
    original.cause =
      cleanupFailures.length === 1
        ? cleanupFailures[0]
        : new AggregateError(cleanupFailures, "execution root cleanup failed");
    return original;
  }
  return new AggregateError(
    [original, ...cleanupFailures],
    "execution root preparation failed, and cleaning up after it failed too",
  );
}

/** Whether a rejected git invocation printed nothing on stdout. */
function printedNothing(rejection: unknown): boolean {
  if (typeof rejection !== "object" || rejection === null || !("stdout" in rejection)) {
    return true;
  }
  const stdout: unknown = rejection.stdout;
  return !Buffer.isBuffer(stdout) || stdout.toString("utf8").trim().length === 0;
}

/**
 * Composes the `metadata.lastError` detail. `WorkspaceRead` puts it on the wire and
 * `normalizeWorkspaceLastError` scrubs credentials, not paths, so each arm returns only what its
 * message cannot contain. It discriminates by class because `SqliteError` and `ErrnoException`
 * both carry `code` and messages with paths. `failRootPreparation` applies the normalizer.
 */
function composeLastErrorDetail(cause: unknown): string {
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
