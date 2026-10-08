// The run-setup gate that binds a run to its session's working folder before the provider starts
// it. It applies a move the session held for this boundary, makes the first root of a workspace
// still `preparing` (a worktree named from the session's title, or a chat's own folder, which makes
// nothing), and writes the run's execution context: the folder, the working tree around it and
// the repository's git folder, which outlives a removed tree. Nothing holds the workspace while a
// run works in it, so two sessions' runs may work in one folder. The run's end stamps the context
// released and applies a move held during it.
//
// - A workspace a re-attach moved waits `preparing` with its root kept; the gate admits it again
//   first, as the re-attach would, so a run never binds the old repository's root.
// - Only the binding holds the workspace's preparation lock, so no move or re-preparation runs
//   inside it. The run-context write also holds the checkout's lock, taken second, so a carry out
//   of that checkout never stashes between its last check and the stash while a run is bound.
// - Every pass refuses a mount folder that is gone or holds another repository now, before a
//   first root is made in it as well as before a ready workspace takes the run.
// - The context is written only while the workspace is `ready` on the attached mount the binding
//   read, and its checkout is no tree whose removal is under way, so a detach, re-attach or
//   removal that commits meanwhile refuses the run.
// - A run folder whose git folder is not the mount's repository is refused, so a run never works
//   in another repository's checkout.

import { realpath } from "node:fs/promises";
import * as nodePath from "node:path";

import type { Statement } from "better-sqlite3";

import type { DatabaseConnections } from "../database/connection/lifecycle.js";
import type { DatabaseWriter } from "../database/writer.js";
import {
  createGitCommand,
  DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  runGitWithExecFile,
  type GitCommand,
  type GitRunner,
} from "../git/process.js";
import { WorkspaceExecutionRootUnresolvedError } from "../git/worktree/errors.js";
import { deriveRunTail, suggestTailFor } from "../git/worktree/naming.js";
import { canonicalFolderPath } from "./folder/canonical-path.js";
import type { KeyedLock } from "../keyed-lock.js";
import type {
  RunSetupContext,
  RunSetupGate,
  RunTerminalContext,
} from "../session/run/setup-gates.js";
import type { SessionWorkingFolders } from "../session/working-folder/move.js";

import { WorkspaceServiceInvariantError, WorkspaceStaleError } from "./errors.js";
import {
  workspacePreparationLock,
  type ExecutionRootService,
  type WorkspaceLifecyclePrimitives,
} from "./execution-root-service.js";
import { RepoRootResolutionError } from "./repo/errors.js";
import type { RepoMountReattachService } from "./repo/reattach.js";
import { stripSingleLineTerminator } from "./repo/root-resolver.js";
import { CHECKOUT_ROOT_METADATA_PATH, COMMON_DIR_METADATA_PATH } from "./row-guards.js";
import { componentsEqual, toComparableComponents } from "./trust-envelope.js";

interface RunWorkspaceRow {
  readonly id: string;
  readonly repo_mount_id: string;
  readonly execution_mode: string;
  readonly state: string;
  readonly fs_root: string | null;
  readonly checkout_root: string | null;
  /** The repository the mount was attached as; `null` on a mount that records none. */
  readonly mount_common_dir: string | null;
}

interface SessionTitleRow {
  readonly name: string | null;
  readonly first_message_preview: string | null;
}

interface RunRootIdsRow {
  readonly worktree_id: string | null;
  readonly branch_context_id: string | null;
}

// The session's live workspace, the newest when a detach left an older one archived.
const SELECT_RUN_WORKSPACE_SQL = `SELECT workspace.id, workspace.repo_mount_id,
       workspace.execution_mode, workspace.state, workspace.fs_root,
       json_extract(workspace.metadata, '${CHECKOUT_ROOT_METADATA_PATH}') AS checkout_root,
       json_extract(mount.metadata, '${COMMON_DIR_METADATA_PATH}') AS mount_common_dir
  FROM workspaces AS workspace
  JOIN repo_mounts AS mount ON mount.id = workspace.repo_mount_id
 WHERE workspace.session_id = @session_id AND workspace.state <> 'archived'
 ORDER BY workspace.created_at DESC, workspace.id DESC
 LIMIT 1`;

// The daemon's live tree at the root, and the workspace's newest context for it, or for a
// `bound-root` root its newest context with no tree.
const SELECT_RUN_ROOT_IDS_SQL = `SELECT wt.id AS worktree_id,
       (SELECT bc.id FROM branch_contexts AS bc
         WHERE bc.workspace_id = @workspace_id
           AND bc.worktree_id IS wt.id
         ORDER BY bc.updated_at DESC, bc.id DESC
         LIMIT 1) AS branch_context_id
  FROM (SELECT 1) AS anchor
  LEFT JOIN worktrees AS wt
    ON @execution_mode = 'provisioned-worktree'
   AND wt.fs_root = @execution_root
   AND wt.state IN ('ready', 'dirty', 'merged')`;

// Writes only while the workspace is `ready` on the attached mount the binding read and its
// checkout is no retired tree still to be cleaned; zero rows refuses the write. A run version that
// starts again rebinds its context and is live again.
const UPSERT_RUN_CONTEXT_SQL = `INSERT INTO run_execution_contexts (
    run_id, session_id, workspace_id, execution_mode, execution_root, checkout_root,
    git_common_dir, worktree_id, branch_context_id, created_at, released_at
  )
  SELECT @run_id, @session_id, workspace.id, @execution_mode, @execution_root, @checkout_root,
         @git_common_dir, @worktree_id, @branch_context_id, @now, NULL
    FROM workspaces AS workspace
    JOIN repo_mounts AS mount ON mount.id = workspace.repo_mount_id
   WHERE workspace.id = @workspace_id
     AND workspace.state = 'ready'
     AND workspace.repo_mount_id = @repo_mount_id
     AND mount.state = 'attached'
     AND NOT EXISTS (SELECT 1 FROM worktrees
                      WHERE state = 'retired' AND cleaned_at IS NULL
                        AND fs_root = @checkout_root)
  ON CONFLICT (run_id) DO UPDATE SET
    workspace_id = excluded.workspace_id,
    execution_mode = excluded.execution_mode,
    execution_root = excluded.execution_root,
    checkout_root = excluded.checkout_root,
    git_common_dir = excluded.git_common_dir,
    worktree_id = excluded.worktree_id,
    branch_context_id = excluded.branch_context_id,
    released_at = NULL`;

const RELEASE_RUN_CONTEXT_SQL = `UPDATE run_execution_contexts SET released_at = @now
  WHERE run_id = @run_id AND released_at IS NULL`;

/** Dependencies of {@link ExecutionRootSetupGate}. */
export interface ExecutionRootSetupGateDeps {
  readonly database: DatabaseConnections;
  readonly executionRoots: Pick<ExecutionRootService, "prepare">;
  readonly workspaces: Pick<WorkspaceLifecyclePrimitives, "assertWritable">;
  readonly workingFolders: Pick<SessionWorkingFolders, "applyPending" | "sweepFromRemovedTree">;
  /** Admits again a workspace a re-attach moved, when a run reaches it first. */
  readonly reattachedWorkspaces: Pick<RepoMountReattachService, "prepareMovedWorkspace">;
  /** The worktree creator's per-checkout lock, held around the run-context write. */
  readonly checkoutLock: KeyedLock<string>;
  /** Git process seam; defaults to `execFile` against `git`. */
  readonly git?: GitRunner;
  readonly gitCommandTimeoutMs?: number;
  readonly now?: () => string;
}

/** Binds each repo-bound run to its working folder; registered on the run engine's setup gates. */
export class ExecutionRootSetupGate implements RunSetupGate {
  readonly #executionRoots: ExecutionRootSetupGateDeps["executionRoots"];
  readonly #workspaces: ExecutionRootSetupGateDeps["workspaces"];
  readonly #workingFolders: ExecutionRootSetupGateDeps["workingFolders"];
  readonly #reattachedWorkspaces: ExecutionRootSetupGateDeps["reattachedWorkspaces"];
  readonly #checkoutLock: KeyedLock<string>;
  readonly #runGit: GitCommand;
  readonly #now: () => string;
  readonly #writer: Pick<DatabaseWriter, "write">;
  readonly #selectWorkspaceStmt: Statement<{ session_id: string }, RunWorkspaceRow>;
  readonly #selectTitleStmt: Statement<{ session_id: string }, SessionTitleRow>;
  readonly #selectRootIdsStmt: Statement<
    { workspace_id: string; execution_mode: string; execution_root: string },
    RunRootIdsRow
  >;

  constructor(deps: ExecutionRootSetupGateDeps) {
    this.#executionRoots = deps.executionRoots;
    this.#workspaces = deps.workspaces;
    this.#workingFolders = deps.workingFolders;
    this.#reattachedWorkspaces = deps.reattachedWorkspaces;
    this.#checkoutLock = deps.checkoutLock;
    this.#runGit = createGitCommand({
      git: deps.git ?? runGitWithExecFile,
      timeoutMs: deps.gitCommandTimeoutMs ?? DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    });
    this.#now = deps.now ?? ((): string => new Date().toISOString());
    this.#writer = deps.database.writer;
    const reader = deps.database.reader;
    this.#selectWorkspaceStmt = reader.prepare(SELECT_RUN_WORKSPACE_SQL);
    this.#selectTitleStmt = reader.prepare(
      "SELECT name, first_message_preview FROM sessions WHERE id = @session_id",
    );
    this.#selectRootIdsStmt = reader.prepare(SELECT_RUN_ROOT_IDS_SQL);
  }

  /**
   * Binds the run, or throws `workspace.execution_root_unresolved` wrapping why it could not, which
   * ends the run `failed`. A session bound to no repository has nothing to bind.
   */
  async assertRunReady(context: RunSetupContext): Promise<void> {
    const before = this.#selectWorkspaceStmt.get({ session_id: context.sessionId });
    if (before === undefined) {
      return;
    }
    try {
      // Before the hold: a sweep takes each swept workspace's own lock, one at a time.
      await this.#workingFolders.sweepFromRemovedTree(context.sessionId);
      await workspacePreparationLock.run(before.id, async () => {
        await this.#workingFolders.applyPending(context.sessionId);
        let workspace = this.#requireWorkspace(context.sessionId);
        // A re-attach moved it, its root kept: admitted again before anything binds there.
        if (workspace.state === "preparing" && workspace.fs_root !== null) {
          await this.#reattachedWorkspaces.prepareMovedWorkspace(workspace.id);
          workspace = this.#requireWorkspace(context.sessionId);
        }
        if (workspace.state === "preparing") {
          // The prepare checks the mount before it makes anything.
          await this.#executionRoots.prepare({
            workspaceId: workspace.id,
            runId: context.runId,
            // Only a worktree's first root takes a name; a chat's own folder makes nothing.
            ...(workspace.execution_mode === "provisioned-worktree"
              ? { tail: this.#deriveTail(context) }
              : {}),
          });
        } else {
          await this.#workspaces.assertWritable(workspace.id);
        }
        await this.#writeRunContext(context, this.#requireWorkspace(context.sessionId));
      });
    } catch (bindFailure) {
      throw new WorkspaceExecutionRootUnresolvedError(before.id, bindFailure);
    }
  }

  /**
   * Stamps the run's context released, sweeps the session out of a tree removed while the run was
   * bound there, then applies a move the session held during the run.
   */
  async onRunTerminal(context: RunTerminalContext): Promise<void> {
    await this.#writer.write([
      { sql: RELEASE_RUN_CONTEXT_SQL, bindings: { run_id: context.runId, now: this.#now() } },
    ]);
    await this.#workingFolders.sweepFromRemovedTree(context.sessionId);
    await this.#workingFolders.applyPending(context.sessionId);
  }

  // The tail the session's title, or before it has one its first message, gives the tree;
  // `run-<run short id>` when no usable words remain.
  #deriveTail(context: RunSetupContext): string {
    const title = this.#selectTitleStmt.get({ session_id: context.sessionId });
    const titleTail = suggestTailFor(
      {
        name: title?.name ?? null,
        firstMessagePreview: title?.first_message_preview ?? null,
      },
      context.queueItem?.content ?? null,
    );
    return deriveRunTail(titleTail, context.runId);
  }

  async #writeRunContext(context: RunSetupContext, workspace: RunWorkspaceRow): Promise<void> {
    if (workspace.fs_root === null || workspace.checkout_root === null) {
      throw new Error(`workspace "${workspace.id}" is ready with no root or checkout recorded`);
    }
    const commonDirOutput = await this.#runGit([
      "-C",
      workspace.fs_root,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    const commonDir = await realpath(
      stripSingleLineTerminator(commonDirOutput.stdout.toString("utf8"), nodePath),
    );
    if (
      workspace.mount_common_dir !== null &&
      !componentsEqual(
        toComparableComponents(commonDir, nodePath),
        toComparableComponents(workspace.mount_common_dir, nodePath),
      )
    ) {
      throw new RepoRootResolutionError("root_mismatch");
    }
    const ids = this.#selectRootIdsStmt.get({
      workspace_id: workspace.id,
      execution_mode: workspace.execution_mode,
      execution_root: workspace.fs_root,
    });
    // A worktree workspace whose tree is no longer live is refused as stale, as a gone root is.
    const isTreeGone =
      workspace.execution_mode === "provisioned-worktree" && (ids?.worktree_id ?? null) === null;
    if (isTreeGone) {
      throw new WorkspaceStaleError(workspace.id);
    }
    const branchContextId = ids?.branch_context_id ?? null;
    if (branchContextId === null) {
      throw new WorkspaceServiceInvariantError(
        `workspace "${workspace.id}" is ready with no branch context for its root`,
        { kind: "branch_context_missing", workspaceId: workspace.id },
      );
    }
    const checkoutKey = await canonicalFolderPath(workspace.checkout_root);
    await this.#checkoutLock.run(checkoutKey, async () => {
      await this.#writer.write([
        {
          sql: UPSERT_RUN_CONTEXT_SQL,
          bindings: {
            run_id: context.runId,
            session_id: context.sessionId,
            workspace_id: workspace.id,
            repo_mount_id: workspace.repo_mount_id,
            execution_mode: workspace.execution_mode,
            execution_root: workspace.fs_root,
            checkout_root: workspace.checkout_root,
            git_common_dir: commonDir,
            worktree_id: ids?.worktree_id ?? null,
            branch_context_id: branchContextId,
            now: this.#now(),
          },
          expectedRowCount: 1,
        },
      ]);
    });
  }

  #requireWorkspace(sessionId: string): RunWorkspaceRow {
    const workspace = this.#selectWorkspaceStmt.get({ session_id: sessionId });
    if (workspace === undefined) {
      throw new Error(`session "${sessionId}" lost its workspace while its run was set up`);
    }
    return workspace;
  }
}
