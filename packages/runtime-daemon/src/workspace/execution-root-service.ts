/**
 * Place-dispatched orchestrator behind `repo.executionRootPrepare` and a session's move between
 * trees, and the sole writer of `branch_contexts`. Worktrees come from the worktree creator;
 * `workspaces` changes go through the lifecycle primitives.
 *
 * - A prepare that names a branch makes a worktree; any other prepare works in the workspace's
 *   stored place. An unreadable place is a defect, never a default.
 * - Every refusal a caller could avoid fires before `beginRootPreparation` and outside the
 *   try/catch, because `failRootPreparation` is legal only from `preparing`.
 * - The gate is skipped inside an open bracket: `assertWritable` refuses `preparing`, and every
 *   first bind is born `preparing`. A gated prepare into an open bracket checks the mount alone,
 *   so nothing is made in a mount folder that is gone or holds another repository now.
 * - Every preparation of one workspace holds `workspacePreparationLock` on its id, so a bracket
 *   another caller opened is never taken for this call's own.
 * - `bound-root` binds the folder the bind admitted on whatever branch it is on, and never runs a
 *   command that changes a checkout. It inserts one branch-context row per prepare, anchoring
 *   `base_branch` to the head branch since it cuts nothing; rows accumulate because refreshing one
 *   in place would destroy the previous binding's branches, which no other row records.
 */

import { realpath } from "node:fs/promises";
import * as nodePath from "node:path";

import type { Statement } from "better-sqlite3";

import {
  ExecutionModeSchema,
  type ExecutionMode,
  type WorkspaceState,
} from "@ai-sidekicks/contracts/repo/mount";
import {
  BranchContextIdSchema,
  type BranchContextId,
  type WorktreeId,
} from "@ai-sidekicks/contracts/worktree/lifecycle";

import { withCleanupFailures } from "../cleanup-failures.js";
import type { DatabaseConnections } from "../database/connection/lifecycle.js";
import type { DatabaseWriter } from "../database/writer.js";
import {
  createGitCommand,
  DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  runGitWithExecFile,
  type GitCommand,
  type GitRunner,
} from "../git/process.js";
import { keptStashError, type CarriedStash } from "../git/worktree/carry.js";
import type {
  CreatedWorktree,
  CreateWorktreeInput,
  WorktreeCreator,
} from "../git/worktree/creation.js";
import { WorkspaceBranchNameRequiredError } from "../git/worktree/errors.js";
import { readCurrentBranch } from "../git/worktree/reads.js";
import { canonicalFolderPath } from "./folder/canonical-path.js";
import type { WorktreeService } from "../git/worktree/service.js";
import { DaemonDomainError } from "../ipc/domain-error.js";
import { KeyedLock } from "../keyed-lock.js";
import { mintUuidV7 } from "../uuid-v7.js";

import { WorkspaceNotFoundError } from "./errors.js";
import { RepoMountNotFoundError, TrustEnvelopeViolationError } from "./repo/errors.js";
import { stripSingleLineTerminator } from "./repo/root-resolver.js";
import {
  assertModeOffered,
  BOUND_ROOT_METADATA_PATH,
  CHECKOUT_ROOT_METADATA_PATH,
} from "./row-guards.js";
import {
  componentsEqual,
  toComparableComponents,
  type AdmittedExecutionRoot,
} from "./trust-envelope.js";

// What `branch_contexts.head_branch` records while the bound checkout's HEAD is detached: git's own
// name for it, which no branch can take.
const DETACHED_HEAD_NAME = "HEAD";

/**
 * Serializes the preparations of one workspace, keyed by its id: a prepare, a move, the run-setup
 * gate's binding and a re-attach's preparation again each run inside it.
 */
export const workspacePreparationLock: KeyedLock<string> = new KeyedLock<string>();

/**
 * The worktree calls a prepare makes: the creator's `create`, its drop of a carry's stash once the
 * tree is adopted, and the service's undo.
 */
export interface ExecutionRootWorktrees {
  create(input: CreateWorktreeInput): Promise<CreatedWorktree>;
  dropCarriedStash: WorktreeCreator["dropCarriedStash"];
  retireUnadopted: WorktreeService["retireUnadopted"];
}

/** What a completed preparation adopts beside its execution root. */
export interface CompletedRootPreparation {
  /** The top level of the working tree the root sits in. */
  readonly checkoutRoot: string;
  /** The place the root was made in; absent keeps the stored one. */
  readonly executionMode?: ExecutionMode;
  /** The folder a `bound-root` workspace now binds, when a move changed it. */
  readonly boundRoot?: string;
}

/**
 * The workspace primitives as one object, so the gate's verdict, the admission and the
 * compare-and-swap read and write the same rows. `WorkspaceService` satisfies it structurally.
 */
export interface WorkspaceLifecyclePrimitives {
  /**
   * Admits a folder to move the workspace into, on a mount still reachable and holding its
   * repository, through the trust envelope.
   */
  admitFolder(workspaceId: string, folder: string): Promise<AdmittedExecutionRoot>;
  /**
   * Refuses, writing nothing, a workspace whose mount is gone or holds another repository than the
   * one attached there.
   */
  assertMountHealthy(workspaceId: string): Promise<void>;
  /** The gate: passes `ready`, refuses `stale`, and is a defect otherwise. */
  assertWritable(workspaceId: string): Promise<void>;
  /** `ready` | `stale` -> `preparing` in `targetMode`, releasing the old root. */
  beginRootPreparation(workspaceId: string, targetMode: ExecutionMode): Promise<void>;
  /** `preparing` -> `ready`, adopting `fsRoot` and the checkout around it. */
  completeRootPreparation(
    workspaceId: string,
    fsRoot: string,
    options: CompletedRootPreparation,
  ): Promise<void>;
  /** `preparing` -> `stale`, recording `failureDetail` as `metadata.lastError`. */
  failRootPreparation(workspaceId: string, failureDetail: string): Promise<void>;
}

/** Constructor dependencies for {@link ExecutionRootService}. */
export interface ExecutionRootServiceDeps {
  /** The daemon database: reads on its reader, `branch_contexts` writes through its writer. */
  readonly database: DatabaseConnections;
  /** The workspace lifecycle primitives, the only `workspaces` write channel. */
  readonly workspaces: WorkspaceLifecyclePrimitives;
  readonly worktrees: ExecutionRootWorktrees;
  /** Git process seam; defaults to `execFile` against `git`. */
  readonly git?: GitRunner;
  /** Per-invocation git timeout; defaults to two minutes. */
  readonly gitCommandTimeoutMs?: number;
  /** Wall clock for `created_at` / `updated_at`. Injectable for tests. */
  readonly now?: () => string;
  /** `branch_contexts.id` source. Injectable for deterministic tests. */
  readonly newBranchContextId?: () => string;
}

/**
 * `repo.executionRootPrepare`'s daemon-side input. `tail` and `runId` are gate-only, so a wire
 * caller cannot reach the derived name.
 */
export interface PrepareExecutionRootInput {
  readonly workspaceId: string;
  /** The whole branch a wire prepare names; a prepare with one makes a worktree. */
  readonly branchName?: string;
  /** Gate-only: the tail the branch pattern fills in when no branch is named. */
  readonly tail?: string;
  /** The worktree base; a `bound-root` prepare cuts nothing and ignores it. */
  readonly baseRef?: string;
  /** Gate-only provenance for the tree a run's setup makes. */
  readonly runId?: string;
  /** Branch-collision disposition for a named branch. Defaults to `refuse`. */
  readonly onCollision?: "refuse" | "suffix";
  /** Carries the uncommitted work of the folder the workspace works in onto the new tree. */
  readonly carryUncommitted?: boolean;
}

/** A session's move into a tree its repository already has. */
export interface MoveToFolderInput {
  readonly workspaceId: string;
  /** Any tree git lists for the repository, the repository's own checkout included. */
  readonly folder: string;
}

/** A resolved execution root, a superset of `ExecutionRootPrepareResponse` for the gate. */
export interface PreparedExecutionRoot {
  readonly workspaceId: string;
  /** The place the root was prepared in. Never substituted. */
  readonly executionMode: ExecutionMode;
  /** Absolute. The directory the run executes in. */
  readonly executionRoot: string;
  /** The workspace's position AFTER the bracket: `ready` on success. */
  readonly state: WorkspaceState;
  /** The bound head branch; `HEAD` while the bound checkout is detached. */
  readonly branchName: string;
  /** Present for `provisioned-worktree` mode only. */
  readonly worktreeId?: WorktreeId;
  /** The `branch_contexts` row this prepare wrote or refreshed. */
  readonly branchContextId: BranchContextId;
}

/** What {@link ExecutionRootServiceInvariantError} reports. */
type ExecutionRootInvariantKind =
  /** A `workspaces` row carries a mode outside the vocabulary, or no bound folder. */
  | "unreadable_workspace_row"
  /** A `branch_contexts` upsert returned no row id. */
  | "branch_context_write_lost"
  /** Git could not say which branch or working tree the bound folder is in. */
  | "bound_root_unreadable";

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

interface WorkspaceRootRow {
  readonly id: string;
  readonly session_id: string;
  readonly repo_mount_id: string;
  readonly execution_mode: string;
  readonly state: string;
  readonly bound_root: string | null;
  readonly checkout_root: string | null;
}

interface AttachedMountRow {
  readonly id: string;
  readonly canonical_root: string;
  /** The chat a managed mount belongs to; `null` on a project's mount. */
  readonly managed_session_id: string | null;
}

interface BranchContextIdRow {
  readonly id: BranchContextId;
}

interface WorktreeRootRow {
  readonly fs_root: string;
}

interface LiveWorktreeRow {
  readonly id: WorktreeId;
  readonly fs_root: string;
  readonly base_branch: string;
  readonly head_branch: string;
}

// The conflict target repeats the partial index's WHERE clause, as SQLite requires. `@id` is
// discarded on the update arm, so the row's own id is returned.
const UPSERT_WORKTREE_CONTEXT_SQL = `INSERT INTO branch_contexts (
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
                 updated_at  = excluded.updated_at
   RETURNING id`;

const INSERT_BRANCH_CONTEXT_SQL = `INSERT INTO branch_contexts (
          id, workspace_id, worktree_id,
          base_branch, head_branch, created_at, updated_at
        )
   VALUES (
          @id, @workspace_id, @worktree_id,
          @base_branch, @head_branch, @now, @now
        )`;

// Keyed on the row id alone, so it can only reach the one row the failing call inserted.
const DELETE_BRANCH_CONTEXT_SQL = `DELETE FROM branch_contexts WHERE id = @id`;

/**
 * How a root came to be. Only `created` is compensated: a `bound` root is the user's own checkout,
 * and a tree moved into already had its owner.
 */
type ExecutionRootProvenance = "created" | "bound";

/** What one place arm produced, before the branch context and the bracket close. */
interface MaterializedRoot {
  readonly executionMode: ExecutionMode;
  readonly executionRoot: string;
  readonly checkoutRoot: string;
  readonly branchName: string;
  readonly baseBranch: string;
  readonly worktreeId: WorktreeId | null;
  readonly provenance: ExecutionRootProvenance;
  /** The folder a `bound-root` move binds from now on. */
  readonly boundRoot?: string;
  /** The stash holding work carried onto a created tree, dropped once the tree is adopted. */
  readonly carriedStash?: CarriedStash;
}

/**
 * Prepares the execution root for a repo-bound workspace, and moves a workspace into a tree its
 * repository already has.
 */
export class ExecutionRootService {
  readonly #workspaces: WorkspaceLifecyclePrimitives;
  readonly #worktrees: ExecutionRootWorktrees;
  readonly #runGit: GitCommand;
  readonly #now: () => string;
  readonly #newBranchContextId: () => string;

  readonly #selectWorkspaceStmt: Statement<WorkspaceLookupParams, WorkspaceRootRow>;
  readonly #selectAttachedMountStmt: Statement<MountLookupParams, AttachedMountRow>;
  readonly #selectLiveWorktreesStmt: Statement<MountLookupParams, LiveWorktreeRow>;
  readonly #selectUnsweptRetiredRootsStmt: Statement<MountLookupParams, WorktreeRootRow>;
  readonly #writer: Pick<DatabaseWriter, "write">;

  constructor(deps: ExecutionRootServiceDeps) {
    this.#workspaces = deps.workspaces;
    this.#worktrees = deps.worktrees;
    this.#runGit = createGitCommand({
      git: deps.git ?? runGitWithExecFile,
      timeoutMs: deps.gitCommandTimeoutMs ?? DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    });
    this.#now = deps.now ?? ((): string => new Date().toISOString());
    this.#newBranchContextId = deps.newBranchContextId ?? mintUuidV7;

    const database = deps.database.reader;
    this.#writer = deps.database.writer;

    // Projected in SQL so the row type stays flat.
    this.#selectWorkspaceStmt = database.prepare(
      `SELECT id,
              session_id,
              repo_mount_id,
              execution_mode,
              state,
              json_extract(metadata, '${BOUND_ROOT_METADATA_PATH}') AS bound_root,
              json_extract(metadata, '${CHECKOUT_ROOT_METADATA_PATH}') AS checkout_root
         FROM workspaces
        WHERE id = @workspace_id`,
    );

    // Scoped to `attached`: a detached mount is not a preparation target.
    this.#selectAttachedMountStmt = database.prepare(
      `SELECT id, canonical_root, managed_session_id
         FROM repo_mounts
        WHERE id = @repo_mount_id AND state = 'attached'`,
    );

    // The daemon's own live trees on the mount, each with the branches its newest context
    // recorded, which a workspace moving in carries over; the tree's base stands in before any.
    this.#selectLiveWorktreesStmt = database.prepare(
      `SELECT wt.id, wt.fs_root,
              COALESCE(newest.base_branch, wt.base_ref) AS base_branch,
              COALESCE(newest.head_branch, wt.branch_name) AS head_branch
         FROM worktrees AS wt
         LEFT JOIN branch_contexts AS newest
           ON newest.id = (SELECT bc.id FROM branch_contexts AS bc
                            WHERE bc.worktree_id = wt.id
                            ORDER BY bc.updated_at DESC, bc.id DESC
                            LIMIT 1)
        WHERE wt.repo_mount_id = @repo_mount_id
          AND wt.state IN ('ready', 'dirty', 'merged')`,
    );

    // The daemon's retired trees on the mount whose folders the sweep has not yet dealt with.
    this.#selectUnsweptRetiredRootsStmt = database.prepare(
      `SELECT fs_root
         FROM worktrees
        WHERE repo_mount_id = @repo_mount_id
          AND state = 'retired'
          AND cleaned_at IS NULL`,
    );
  }

  /**
   * Materializes the workspace's root: a new worktree when the prepare names a branch or a tail,
   * otherwise the workspace's stored place. Refusals (not found, stale, branch name required,
   * mount not attached, a worktree on a chat's managed mount) fire before the bracket opens.
   */
  async prepare(input: PrepareExecutionRootInput): Promise<PreparedExecutionRoot> {
    return workspacePreparationLock.run(input.workspaceId, async () => {
      const workspace = this.#requireWorkspace(input.workspaceId);
      const storedMode = this.#requireKnownMode(workspace);
      const name = readWorktreeName(input);
      const executionMode: ExecutionMode = name === null ? storedMode : "provisioned-worktree";
      if (executionMode === "provisioned-worktree" && name === null) {
        throw new WorkspaceBranchNameRequiredError(workspace.id);
      }
      const mount = this.#requireAttachedMount(workspace.repo_mount_id);

      return this.#runBracket(workspace, mount, executionMode, { isGated: true }, async () =>
        name === null
          ? this.#bindBoundRoot(workspace, this.#requireBoundRoot(workspace))
          : this.#prepareWorktreeRoot(input, workspace, mount, name),
      );
    });
  }

  /**
   * Moves the workspace into `folder`, any tree git lists for its repository: a tree this daemon
   * made becomes its `provisioned-worktree` root and keeps the tree's branch context; any other,
   * the repository's own checkout and a tree the person made included, binds `bound-root` as an
   * existing checkout with no record of the daemon's. Throws what
   * {@link requireListedTree} throws.
   */
  async moveToFolder(input: MoveToFolderInput): Promise<PreparedExecutionRoot> {
    return workspacePreparationLock.run(input.workspaceId, async () => {
      const workspace = this.#requireWorkspace(input.workspaceId);
      this.#requireKnownMode(workspace);
      const mount = this.#requireAttachedMount(workspace.repo_mount_id);
      const treeRoot = await this.#requireListedTree(workspace, input.folder);
      const daemonTree = await this.#findLiveWorktreeAt(mount.id, treeRoot);
      const executionMode: ExecutionMode =
        daemonTree === undefined ? "bound-root" : "provisioned-worktree";

      // Ungated: a move is how a stale workspace leaves a folder that went away.
      return this.#runBracket(workspace, mount, executionMode, { isGated: false }, async () =>
        daemonTree === undefined
          ? { ...(await this.#bindBoundRoot(workspace, treeRoot)), boundRoot: treeRoot }
          : {
              executionMode,
              executionRoot: daemonTree.fs_root,
              checkoutRoot: daemonTree.fs_root,
              branchName: daemonTree.head_branch,
              baseBranch: daemonTree.base_branch,
              worktreeId: daemonTree.id,
              provenance: "bound",
            },
      );
    });
  }

  // The daemon's live tree at `folder`, or `undefined` when the daemon made none there.
  async #findLiveWorktreeAt(
    repoMountId: string,
    folder: string,
  ): Promise<LiveWorktreeRow | undefined> {
    const target = await canonicalFolderPath(folder);
    for (const tree of this.#selectLiveWorktreesStmt.all({ repo_mount_id: repoMountId })) {
      if ((await canonicalFolderPath(tree.fs_root)) === target) {
        return tree;
      }
    }
    return undefined;
  }

  /**
   * Admits `folder` as a move target, so a move held for a run boundary names a folder the move
   * will accept: the top level of a tree of the workspace's repository, admitted as a bind admits
   * its pick. Throws `workspace.stale` when the mount folder is unreachable, `root_mismatch` when
   * it holds another repository, and `repo.outside_trust_envelope` for any other folder, reason
   * `worktree_removed` for a retired tree whose folder the sweep has not yet removed.
   */
  async requireListedTree(input: MoveToFolderInput): Promise<void> {
    await this.#requireListedTree(this.#requireWorkspace(input.workspaceId), input.folder);
  }

  // The tree's top level, symlink-resolved, which the workspace then roots at.
  async #requireListedTree(workspace: WorkspaceRootRow, folder: string): Promise<string> {
    const admitted = await this.#workspaces.admitFolder(workspace.id, folder);
    // A move names a whole tree; a folder inside one is a bind's pick, not a move.
    if (
      !componentsEqual(
        toComparableComponents(admitted.executionRoot, nodePath),
        toComparableComponents(admitted.checkoutRoot, nodePath),
      )
    ) {
      throw new TrustEnvelopeViolationError();
    }
    // A retired tree git still lists is the sweep's to delete, so edits made there would be lost.
    const target = await canonicalFolderPath(admitted.executionRoot);
    for (const retired of this.#selectUnsweptRetiredRootsStmt.all({
      repo_mount_id: workspace.repo_mount_id,
    })) {
      if ((await canonicalFolderPath(retired.fs_root)) === target) {
        throw new TrustEnvelopeViolationError("worktree_removed");
      }
    }
    return admitted.executionRoot;
  }

  /**
   * Opens the preparation bracket unless it is open already, behind the write gate when `isGated`
   * (behind the mount check alone when it is open), materializes the root, writes its branch
   * context and completes the bracket; a failure fails the bracket and undoes a root this call
   * created.
   */
  async #runBracket(
    workspace: WorkspaceRootRow,
    mount: AttachedMountRow,
    executionMode: ExecutionMode,
    options: { readonly isGated: boolean },
    materialize: () => Promise<MaterializedRoot>,
  ): Promise<PreparedExecutionRoot> {
    // Before the bracket, open or not: an open bracket skips `beginRootPreparation`'s own check.
    assertModeOffered(executionMode, mount.managed_session_id !== null);
    // Open when this prepare is the bind's own preparation (`repo.workspaceBind` creates
    // workspaces `preparing`) or a prior `failRootPreparation` failed. `assertWritable` refuses
    // `preparing`, so this one predicate drives the gate and the bracket.
    const bracketAlreadyOpen = workspace.state === "preparing";
    if (bracketAlreadyOpen) {
      if (options.isGated) {
        // The write gate's mount check, which `assertWritable` would run for a ready workspace.
        await this.#workspaces.assertMountHealthy(workspace.id);
      }
    } else {
      if (options.isGated) {
        // Before any git call, so a stale workspace costs no spawn.
        await this.#workspaces.assertWritable(workspace.id);
      }
      await this.#workspaces.beginRootPreparation(workspace.id, executionMode);
    }

    let materialized: MaterializedRoot | undefined;
    let branchContextId: BranchContextId;
    try {
      materialized = await materialize();
      branchContextId = await this.#writeBranchContext(workspace.id, materialized);
    } catch (preparationFailure) {
      // A failed context write leaves a root nothing will adopt, invisible to the sweep; an unset
      // `materialized` means materialization itself failed and its own service recorded that.
      const cleanupFailures: unknown[] =
        materialized === undefined ? [] : await this.#compensateOrphanedRoot(materialized, null);
      const failure = namingCarriedStash(materialized, preparationFailure);
      cleanupFailures.push(...(await this.#failRootPreparation(workspace.id, failure)));
      // The cause itself carries the cleanup failures: the run-setup gate wraps by code.
      throw withCleanupFailures(failure, cleanupFailures, "execution root preparation");
    }

    try {
      await this.#workspaces.completeRootPreparation(workspace.id, materialized.executionRoot, {
        checkoutRoot: materialized.checkoutRoot,
        executionMode: materialized.executionMode,
        ...(materialized.boundRoot === undefined ? {} : { boundRoot: materialized.boundRoot }),
      });
    } catch (completionFailure) {
      throw withCleanupFailures(
        namingCarriedStash(materialized, completionFailure),
        await this.#compensateOrphanedRoot(materialized, branchContextId),
        "execution root preparation",
      );
    }
    // Only now does the adopted tree stand as the one copy of the carried work.
    if (materialized.carriedStash !== undefined && materialized.worktreeId !== null) {
      await this.#worktrees.dropCarriedStash(materialized.carriedStash, materialized.worktreeId);
    }

    return {
      workspaceId: workspace.id,
      executionMode: materialized.executionMode,
      executionRoot: materialized.executionRoot,
      // What completing the bracket produced; a re-read could show a concurrent writer's state.
      state: "ready",
      branchName: materialized.branchName,
      ...(materialized.worktreeId === null ? {} : { worktreeId: materialized.worktreeId }),
      branchContextId,
    };
  }

  /**
   * `bound-root`: binds `folder` on the branch it is on, read and never changed, inside the working
   * tree git names for it.
   */
  async #bindBoundRoot(workspace: WorkspaceRootRow, folder: string): Promise<MaterializedRoot> {
    let branchName: string | null;
    let checkoutRoot: string;
    try {
      branchName = await readCurrentBranch(this.#runGit, folder);
      const topLevel = await this.#runGit(["-C", folder, "rev-parse", "--show-toplevel"]);
      checkoutRoot = await realpath(
        stripSingleLineTerminator(topLevel.stdout.toString("utf8"), nodePath),
      );
    } catch (gitFailure) {
      throw new ExecutionRootServiceInvariantError(
        `the bound folder of workspace ${workspace.id} gave git no branch or working tree`,
        { kind: "bound_root_unreadable", workspaceId: workspace.id, cause: gitFailure },
      );
    }
    const headBranch = branchName ?? DETACHED_HEAD_NAME;
    return {
      executionMode: "bound-root",
      executionRoot: folder,
      checkoutRoot,
      branchName: headBranch,
      baseBranch: headBranch,
      worktreeId: null,
      provenance: "bound",
    };
  }

  /** `provisioned-worktree`: a new worktree, cut for this workspace. */
  async #prepareWorktreeRoot(
    input: PrepareExecutionRootInput,
    workspace: WorkspaceRootRow,
    mount: AttachedMountRow,
    name: WorktreeNameChoice,
  ): Promise<MaterializedRoot> {
    const carryFrom = input.carryUncommitted === true ? workspace.checkout_root : null;
    if (input.carryUncommitted === true && carryFrom === null) {
      throw this.#unreadableRow(workspace.id, "records no folder to carry uncommitted work from");
    }
    const created = await this.#worktrees.create({
      repoMountId: mount.id,
      sessionId: workspace.session_id,
      name: name.request,
      onCollision: name.onCollision,
      ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
      // Omitted when absent: `created_by_run_id` is provenance.
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(carryFrom === null ? {} : { carryUncommittedFrom: carryFrom }),
    });
    return {
      executionMode: "provisioned-worktree",
      executionRoot: created.fsRoot,
      checkoutRoot: created.fsRoot,
      // The created name, not the requested one: `onCollision: 'suffix'` may have changed it.
      branchName: created.branchName,
      baseBranch: created.baseRef,
      worktreeId: created.worktreeId,
      provenance: "created",
      ...(created.carriedStash === null ? {} : { carriedStash: created.carriedStash }),
    };
  }

  /**
   * Writes or refreshes the workspace's branch context: an upsert on the `(worktree_id,
   * workspace_id)` pair for a worktree root, so a workspace re-binding a tree refreshes its own row
   * and a first binding inserts one beside the tree's earlier rows; a plain insert for
   * `bound-root`.
   */
  async #writeBranchContext(
    workspaceId: string,
    materialized: MaterializedRoot,
  ): Promise<BranchContextId> {
    const now = this.#now();

    if (materialized.worktreeId !== null) {
      const worktreeId = materialized.worktreeId;
      const [upserted] = await this.#writer.write([
        {
          sql: UPSERT_WORKTREE_CONTEXT_SQL,
          bindings: {
            id: this.#newBranchContextId(),
            workspace_id: workspaceId,
            worktree_id: worktreeId,
            base_branch: materialized.baseBranch,
            head_branch: materialized.branchName,
            now,
          },
        },
      ]);
      const bound = upserted?.rows[0] as BranchContextIdRow | undefined;
      if (bound === undefined) {
        throw new ExecutionRootServiceInvariantError(
          `branch context for workspace ${workspaceId} and worktree ${worktreeId} did not persist`,
          { kind: "branch_context_write_lost", workspaceId },
        );
      }
      return bound.id;
    }

    // `bound-root`: rows accumulate, so this cannot conflict with an existing one.
    const branchContextId = BranchContextIdSchema.parse(this.#newBranchContextId());
    await this.#writer.write([
      {
        sql: INSERT_BRANCH_CONTEXT_SQL,
        bindings: {
          id: branchContextId,
          workspace_id: workspaceId,
          worktree_id: null,
          base_branch: materialized.baseBranch,
          head_branch: materialized.branchName,
          now,
        },
      },
    ]);
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

  #requireBoundRoot(workspace: WorkspaceRootRow): string {
    if (workspace.bound_root === null) {
      throw this.#unreadableRow(workspace.id, "records no bound folder");
    }
    return workspace.bound_root;
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
        { kind: "unreadable_workspace_row", workspaceId: workspace.id, cause: parsed.error },
      );
    }
    return parsed.data;
  }

  #unreadableRow(workspaceId: string, what: string): ExecutionRootServiceInvariantError {
    return new ExecutionRootServiceInvariantError(`workspace ${workspaceId} ${what}`, {
      kind: "unreadable_workspace_row",
      workspaceId,
    });
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
    if (materialized.provenance !== "created" || materialized.worktreeId === null) {
      return [];
    }

    const failures: unknown[] = [];
    // The preparation catch passes `null`: the context write is what failed, so no row exists.
    if (branchContextId !== null) {
      try {
        await this.#writer.write([
          { sql: DELETE_BRANCH_CONTEXT_SQL, bindings: { id: branchContextId } },
        ]);
      } catch (deleteFailure) {
        failures.push(deleteFailure);
      }
    }

    // Records the retirement only; the sweep reclaims the folder once nothing stands in it.
    try {
      await this.#worktrees.retireUnadopted(materialized.worktreeId);
    } catch (retireFailure) {
      failures.push(retireFailure);
    }
    return failures;
  }
}

// A failure after a carry: the tree that took the work is undone, so the kept stash is the only
// copy and the failure names it.
function namingCarriedStash(materialized: MaterializedRoot | undefined, failure: unknown): unknown {
  return materialized?.carriedStash === undefined
    ? failure
    : keptStashError(materialized.carriedStash, failure);
}

/** The name a worktree prepare asks for, and what a taken one does. */
interface WorktreeNameChoice {
  readonly request: CreateWorktreeInput["name"];
  readonly onCollision: "refuse" | "suffix";
}

// A named branch is the caller's and refuses a collision unless told otherwise; the gate's tail
// takes the first free ordinal. Blank names count as none.
function readWorktreeName(input: PrepareExecutionRootInput): WorktreeNameChoice | null {
  const branchName = input.branchName?.trim() ?? "";
  if (branchName.length > 0) {
    return {
      request: { kind: "branch", branchName },
      onCollision: input.onCollision ?? "refuse",
    };
  }
  const tail = input.tail?.trim() ?? "";
  if (tail.length > 0) {
    return { request: { kind: "tail", tail }, onCollision: "suffix" };
  }
  return null;
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
