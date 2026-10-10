// Making a worktree: the base it is cut from, its branch and folder through the name plan, git's
// judgment of the name, the tree itself, the uncommitted work it carries, its rows and events, and
// its setup card, opened before git runs and finished once the tree is ready.
//
//   * Git decides a name: `check-ref-format --branch`, then `worktree add -b` against the branches
//     that exist. A refusal of the name carries git's own line and writes nothing.
//   * The main checkout is never mutated: in it git runs only reads, `worktree add -b` and, to undo
//     a tree this call made, `worktree remove` and `branch -D`; a failed tree's own record is the
//     one record removed from the repository's git folder.
//   * Carried work is stashed, and its stash is handed back to the caller, who drops it only once
//     the tree is adopted, so every failure before that keeps the stash and names the command that
//     recovers it.

import { dirname, sep } from "node:path";
import type { Statement } from "better-sqlite3";
import { SessionIdSchema } from "@ai-sidekicks/contracts/session/id";
import {
  WorktreeIdSchema,
  type NewWorktreeSuggestion,
  type WorktreeId,
  type WorktreeState,
} from "@ai-sidekicks/contracts/worktree/lifecycle";
import type { ServiceLogWriter } from "../../daemon/service-log.js";
import type { DatabaseWriter } from "../../database/writer.js";
import { withCleanupFailures } from "../../cleanup-failures.js";
import { RunAgentReader } from "../../session/run/agent.js";
import { hasSqliteErrorCode } from "../../session/sqlite-error-code.js";
import { mintUuidV7 } from "../../uuid-v7.js";
import { CHECKOUT_ROOT_METADATA_PATH } from "../../workspace/row-guards.js";
import type { KeyedLock } from "../../keyed-lock.js";
import { describeRejection } from "../../rejection.js";
import { canonicalFolderPath } from "../../workspace/folder/canonical-path.js";
import { DEFAULT_GIT_FILESYSTEM, pathExists, type GitFilesystem } from "../filesystem.js";
import {
  createGitCommand,
  DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  runGitWithExecFile,
  type GitCommand,
  type GitInvocationResult,
} from "../process.js";
import {
  carryUncommittedWork,
  dropCarriedStash,
  keptStashError,
  requireCarryOntoCurrentBranch,
  type CarriedStash,
} from "./carry.js";
import { WorktreeBranchCollisionError, WorktreeCreateFailedError } from "./errors.js";
import type { WorktreeEventEmitter } from "./event-emitter.js";
import { hasBranch, readCurrentBranch, readLinkedTreeRecord } from "./reads.js";
import {
  GIT_TAKEN_BRANCH_NAME_PATTERNS,
  readGitRefusalLine,
  WorktreeNamePlan,
  suggestTailFor,
  type WorktreeName,
  type WorktreeNaming,
} from "./naming.js";
import {
  explainWorktreeRowRefusal,
  insertWorktreeStatement,
  LIVE_WORKTREE_STATE_PREDICATE,
  MARK_READY_SQL,
  transitionStatement,
  type BranchLookupParams,
  type WorktreeIdRow,
} from "./rows.js";
import type { WorktreeService, WorktreeServiceDeps } from "./service.js";
import type { WorktreeSetupRunner } from "./setup.js";

// Git's line refusing an invalid branch name, printed under `LC_ALL=C`. It names a ref only; any
// other `fatal:` line can name a path, so it never becomes a message.
const GIT_INVALID_BRANCH_NAME_PATTERN = /^fatal: '.*' is not a valid branch name$/;

// No event accompanies this one: the caller's `failRootPreparation` events the failure as
// `workspace.stale`.
const MARK_FAILED_SQL = `UPDATE worktrees
    SET state = 'failed', updated_at = @now
  WHERE id = @worktree_id AND state = 'creating'`;

// The folders other sessions' runs are live in, with each run: a run whose execution context is
// unreleased, and a run still queued or starting, at the checkout its session's workspace is in.
const OTHER_SESSIONS_LIVE_RUN_FOLDERS_SQL = `SELECT session_id, run_id, folder FROM (
    SELECT run.session_id AS session_id, run.run_id AS run_id, run.checkout_root AS folder
      FROM run_execution_contexts AS run
     WHERE run.released_at IS NULL
    UNION ALL
    SELECT runs.session_id AS session_id, runs.run_id AS run_id,
           COALESCE(json_extract(standing.metadata, '${CHECKOUT_ROOT_METADATA_PATH}'),
                    standing.fs_root) AS folder
      FROM runs
      JOIN workspaces AS standing ON standing.session_id = runs.session_id
     WHERE runs.state IN ('queued', 'starting')
       AND standing.state <> 'archived'
       AND standing.fs_root IS NOT NULL
  )
  WHERE session_id <> @session_id`;

/**
 * How a new tree is named: a whole branch name a caller supplied, or a tail the branch-name
 * pattern fills in.
 */
type WorktreeNameRequest =
  | { readonly kind: "branch"; readonly branchName: string }
  | { readonly kind: "tail"; readonly tail: string };

/** Inputs for {@link WorktreeCreator.create}. */
export interface CreateWorktreeInput {
  /** The mount to check out from. Must be `attached`. */
  readonly repoMountId: string;
  /** Creating-session provenance (`created_by_session_id`), and the folder's short id. */
  readonly sessionId: string;
  /** `null` records a prepare before any run. Provenance only. */
  readonly runId?: string | null;
  readonly name: WorktreeNameRequest;
  /**
   * `refuse` (a caller-supplied name) raises {@link WorktreeBranchCollisionError} or git's
   * refusal; `suffix` (a daemon-derived name) takes the first ordinal git and the index both
   * accept.
   */
  readonly onCollision: "refuse" | "suffix";
  /** Base ref for the new branch; omitted, the mount's HEAD branch. A leading `-` is refused. */
  readonly baseRef?: string;
  /**
   * The folder whose uncommitted work, untracked files included, the new tree takes. Refused
   * unless the base is the branch that folder is on, and while another session's run is live in
   * that checkout.
   */
  readonly carryUncommittedFrom?: string;
  /** Envelope actor for the emitted events; defaults to the system actor. */
  readonly actor?: string | null;
  /** Envelope linkage back to the causing event, when the caller has one. */
  readonly correlationId?: string | null;
}

/** A materialized, ready worktree. */
export interface CreatedWorktree {
  readonly worktreeId: WorktreeId;
  readonly repoMountId: string;
  /** The branch as created, suffix included, so a caller never has to reconstruct it. */
  readonly branchName: string;
  /** The tree's flat folder. */
  readonly fsRoot: string;
  /** The ref the branch was cut from, as given or resolved. */
  readonly baseRef: string;
  /** Always `ready`: a create that did not reach `ready` throws instead. */
  readonly state: Extract<WorktreeState, "ready">;
  /**
   * The stash still holding the carried work, `null` when nothing was carried. The caller drops it
   * with {@link WorktreeCreator.dropCarriedStash} once it has adopted the tree, and names it in any
   * failure before that.
   */
  readonly carriedStash: CarriedStash | null;
}

/**
 * Dependencies of {@link WorktreeCreator}: the service's but its occupancy reader, plus the service
 * it records beside and the setup card each tree it makes is followed on.
 */
export interface WorktreeCreatorDeps extends Omit<WorktreeServiceDeps, "occupancy"> {
  /** The attached mount a tree is cut from, and the record removal after a failed creation. */
  readonly worktrees: Pick<WorktreeService, "requireAttachedMount" | "removeWorktreeRecord">;
  readonly setup: Pick<WorktreeSetupRunner, "begin" | "treeFailed" | "treeMade" | "forget">;
  /** Where a carried stash that could not be dropped once its tree was adopted is written. */
  readonly writeServiceLog: ServiceLogWriter;
  /**
   * Held per checkout, keyed by its `canonicalFolderPath`, from a carry's last check for another
   * session's run through its stash, and by the run gate's run-context write in that checkout.
   */
  readonly checkoutLock: KeyedLock<string>;
}

interface SessionLookupParams {
  readonly session_id: string;
}

interface LiveRunFolderRow {
  readonly session_id: string;
  readonly run_id: string;
  readonly folder: string;
}

interface SessionTitleRow {
  readonly name: string | null;
  readonly first_message_preview: string | null;
}

/** Where a new tree was made, for the steps that record it or undo it. */
interface MaterializedTree {
  readonly canonicalRoot: string;
  readonly name: WorktreeName;
  readonly baseRef: string;
}

/**
 * Makes worktrees and answers the create form's suggestion, through one name plan. Each `UPDATE`
 * carries its legal-predecessor set in its `WHERE`, so the transition table lives in the
 * statements.
 */
export class WorktreeCreator {
  readonly #events: WorktreeEventEmitter;
  readonly #naming: WorktreeNaming;
  readonly #worktrees: WorktreeCreatorDeps["worktrees"];
  readonly #setup: WorktreeCreatorDeps["setup"];
  readonly #runGit: GitCommand;
  readonly #filesystem: GitFilesystem;
  readonly #now: () => string;
  readonly #newWorktreeId: () => string;
  readonly #writer: Pick<DatabaseWriter, "write">;
  readonly #writeServiceLog: ServiceLogWriter;
  readonly #checkoutLock: KeyedLock<string>;
  readonly #selectLiveWorktreeOnBranchStmt: Statement<BranchLookupParams, WorktreeIdRow>;
  readonly #selectOtherLiveRunFoldersStmt: Statement<SessionLookupParams, LiveRunFolderRow>;
  readonly #selectSessionTitleStmt: Statement<SessionLookupParams, SessionTitleRow>;
  readonly #runAgents: RunAgentReader;

  constructor(deps: WorktreeCreatorDeps) {
    this.#events = deps.events;
    this.#naming = deps.naming;
    this.#worktrees = deps.worktrees;
    this.#setup = deps.setup;
    this.#filesystem = deps.filesystem ?? DEFAULT_GIT_FILESYSTEM;
    this.#runGit = createGitCommand({
      git: deps.git ?? runGitWithExecFile,
      timeoutMs: deps.gitCommandTimeoutMs ?? DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    });
    this.#now = deps.now ?? ((): string => new Date().toISOString());
    this.#newWorktreeId = deps.newWorktreeId ?? mintUuidV7;
    this.#writer = deps.database.writer;
    this.#writeServiceLog = deps.writeServiceLog;
    this.#checkoutLock = deps.checkoutLock;
    this.#selectOtherLiveRunFoldersStmt = deps.database.reader.prepare<
      SessionLookupParams,
      LiveRunFolderRow
    >(OTHER_SESSIONS_LIVE_RUN_FOLDERS_SQL);
    this.#runAgents = new RunAgentReader(deps.database.reader);

    // The index's own predicate, read before git runs so a daemon-made live tree on the name is
    // the typed collision.
    this.#selectLiveWorktreeOnBranchStmt = deps.database.reader.prepare<
      BranchLookupParams,
      WorktreeIdRow
    >(
      `SELECT id
         FROM worktrees
        WHERE repo_mount_id = @repo_mount_id
          AND branch_name = @branch_name
          AND ${LIVE_WORKTREE_STATE_PREDICATE}
        LIMIT 1`,
    );
    this.#selectSessionTitleStmt = deps.database.reader.prepare<
      SessionLookupParams,
      SessionTitleRow
    >("SELECT name, first_message_preview FROM sessions WHERE id = @session_id");
  }

  /**
   * Makes a worktree: resolves the base, names the branch and folder through the name plan, lets
   * git judge the name and make the tree, carries uncommitted work when asked, then records the
   * row with `worktree.created` and `ready` with `worktree.ready`, and runs the project's setup
   * steps on the tree's card, resolving once they have ended, a failed step included. A refusal of
   * the name writes nothing; a failure after the row exists marks it `failed` and stands on the
   * card. Never substitutes another place. A carry's stash is kept and answered, never dropped
   * here.
   */
  async create(input: CreateWorktreeInput): Promise<CreatedWorktree> {
    const canonicalRoot = this.#worktrees.requireAttachedMount(input.repoMountId).canonical_root;
    const baseRef = await this.#resolveBaseRef(canonicalRoot, input.baseRef);
    if (input.carryUncommittedFrom !== undefined) {
      await requireCarryOntoCurrentBranch(this.#runGit, input.carryUncommittedFrom, baseRef);
      await this.#refuseCarryWhileAnotherRuns(input.carryUncommittedFrom, input.sessionId);
    }

    // Minted before git runs, so the card the tree's `worktree.created` names is already open.
    const worktreeId: WorktreeId = WorktreeIdSchema.parse(this.#newWorktreeId());
    this.#setup.begin(worktreeId);
    let isRecorded = false;
    let tree: MaterializedTree;
    let carried: CarriedStash | null = null;
    try {
      const nameBase = await this.#naming.baseFor(input.repoMountId, input.sessionId);
      const plan =
        input.name.kind === "tail"
          ? WorktreeNamePlan.forTail(nameBase, input.name.tail)
          : WorktreeNamePlan.forBranchName(nameBase, input.name.branchName);
      tree = await this.#materializeFirstFreeName(canonicalRoot, plan, input, baseRef);

      const carryFrom = input.carryUncommittedFrom;
      if (carryFrom !== undefined) {
        try {
          // Again right before the stash: a run another session started while git made the tree.
          // The checkout's lock keeps a run from being bound there between this check and the
          // stash; the caller holds the workspace's preparation lock, taken first.
          const treeFolder = tree.name.folderPath;
          carried = await this.#checkoutLock.run(await canonicalFolderPath(carryFrom), async () => {
            await this.#refuseCarryWhileAnotherRuns(carryFrom, input.sessionId);
            return carryUncommittedWork(this.#runGit, carryFrom, treeFolder, worktreeId);
          });
        } catch (carryFailure) {
          throw withCleanupFailures(
            carryFailure,
            await this.#undoUnrecordedTree(tree),
            "worktree creation",
          );
        }
      }

      try {
        await this.#recordCreatedRow(tree, worktreeId, input);
        isRecorded = true;
        await this.#markReady(tree, worktreeId, input.sessionId, input.repoMountId, input);
      } catch (recordFailure) {
        // The tree that took the work is undone, so the stash is the only copy left.
        throw carried === null ? recordFailure : keptStashError(carried, recordFailure);
      }
    } catch (creationFailure) {
      // A tree no row records was never named to anyone, so its card goes; a recorded one's
      // failure stands on its card.
      if (isRecorded) {
        this.#setup.treeFailed(worktreeId, describeRejection(creationFailure));
      } else {
        this.#setup.forget(worktreeId);
      }
      throw creationFailure;
    }
    // A failed step stands on the card for its retry; a setup that could not be read is thrown.
    await this.#setup.treeMade({
      worktreeId,
      treePath: tree.name.folderPath,
      repositoryRoot: canonicalRoot,
      repoMountId: input.repoMountId,
    });
    return {
      worktreeId,
      repoMountId: input.repoMountId,
      branchName: tree.name.branchName,
      fsRoot: tree.name.folderPath,
      baseRef,
      state: "ready",
      carriedStash: carried,
    };
  }

  /**
   * Drops a carry's stash once the caller has adopted its tree. The work then stands in the tree,
   * so a stash that cannot be dropped only repeats it: the failure is written to the service log,
   * where the person can find the leftover, and never fails the tree.
   */
  async dropCarriedStash(carried: CarriedStash, worktreeId: string): Promise<void> {
    try {
      await dropCarriedStash(this.#runGit, carried);
    } catch (dropFailure) {
      this.#writeServiceLog(
        `worktree ${worktreeId}: the carried work is in the tree, but its stash ` +
          `${carried.commit} could not be dropped: ${describeRejection(dropFailure)}`,
      );
    }
  }

  // Stashing takes the checkout's uncommitted work from under any run working there, so a carry is
  // refused while another session's run is live in that checkout or in a folder inside it, naming
  // that run's session and agent.
  async #refuseCarryWhileAnotherRuns(folder: string, sessionId: string): Promise<void> {
    const folderKey = await canonicalFolderPath(folder);
    for (const row of this.#selectOtherLiveRunFoldersStmt.all({ session_id: sessionId })) {
      const runKey = await canonicalFolderPath(row.folder);
      if (
        runKey === folderKey ||
        runKey.startsWith(`${folderKey}${sep}`) ||
        folderKey.startsWith(`${runKey}${sep}`)
      ) {
        throw new WorktreeCreateFailedError("carry_checkout_running", {
          runningSessionId: SessionIdSchema.parse(row.session_id),
          runningAgentId: this.#runAgents.readAgent(row.session_id, row.run_id),
        });
      }
    }
  }

  /**
   * The create form's parts for the session's next tree on the mount, from the same plan
   * {@link create} names a tree with. The tail comes from the session's title, or its provisional
   * title, and is the first whose branch and folder are free, so the form never opens on a refusal.
   */
  async suggestNewWorktree(input: {
    readonly repoMountId: string;
    readonly sessionId: string;
  }): Promise<NewWorktreeSuggestion> {
    const canonicalRoot = this.#worktrees.requireAttachedMount(input.repoMountId).canonical_root;
    const title = this.#selectSessionTitleStmt.get({ session_id: input.sessionId });
    if (title === undefined) {
      throw new Error(
        `cannot suggest a worktree for session "${input.sessionId}": no such session`,
      );
    }
    const plan = WorktreeNamePlan.forTail(
      await this.#naming.baseFor(input.repoMountId, input.sessionId),
      suggestTailFor({ name: title.name, firstMessagePreview: title.first_message_preview }),
    );
    if (plan.nameAt(1).tail.length === 0) {
      return plan.describeAt(1);
    }
    const branches = await this.#listBranches(canonicalRoot);
    // Each ordinal is a new name, and only finitely many are taken, so the walk ends.
    for (let ordinal = 1; ; ordinal += 1) {
      if (await this.#isNameFree(input.repoMountId, plan.nameAt(ordinal), branches)) {
        return plan.describeAt(ordinal);
      }
    }
  }

  /**
   * Makes the tree at the first name git and the index accept: ordinal 1 only under `refuse`,
   * each ordinal in turn under `suffix`. Git's own check decides; the index and branch reads only
   * spare `suffix` a refused git call.
   */
  async #materializeFirstFreeName(
    canonicalRoot: string,
    plan: WorktreeNamePlan,
    input: CreateWorktreeInput,
    baseRef: string,
  ): Promise<MaterializedTree> {
    const branches = input.onCollision === "suffix" ? await this.#listBranches(canonicalRoot) : [];
    // `refuse` stops at ordinal 1, made or refused; `suffix` walks until a name is free, which it
    // reaches because only finitely many names are taken.
    for (let ordinal = 1; ; ordinal += 1) {
      const name = plan.nameAt(ordinal);
      await this.#requireValidBranchName(canonicalRoot, name.branchName);
      if (
        input.onCollision === "suffix" &&
        !(await this.#isNameFree(input.repoMountId, name, branches))
      ) {
        continue;
      }
      if (input.onCollision === "refuse") {
        this.#refuseTakenName(input.repoMountId, name);
        if (await pathExists(name.folderPath)) {
          throw new WorktreeCreateFailedError("worktree_folder_taken");
        }
      }
      const tree: MaterializedTree = { canonicalRoot, name, baseRef };
      const refusalLine = await this.#addWorktree(tree);
      if (refusalLine === null) {
        return tree;
      }
      if (input.onCollision === "refuse") {
        throw new WorktreeCreateFailedError("branch_name_taken", refusalLine, undefined);
      }
    }
  }

  #refuseTakenName(repoMountId: string, name: WorktreeName): void {
    const liveRow = this.#selectLiveWorktreeOnBranchStmt.get({
      repo_mount_id: repoMountId,
      branch_name: name.branchName,
    });
    if (liveRow !== undefined) {
      throw new WorktreeBranchCollisionError(repoMountId, name.branchName);
    }
  }

  // Free when no live row holds the branch, no branch git has holds it or sits inside or above it,
  // and the folder does not exist.
  async #isNameFree(
    repoMountId: string,
    name: WorktreeName,
    branches: readonly string[],
  ): Promise<boolean> {
    const liveRow = this.#selectLiveWorktreeOnBranchStmt.get({
      repo_mount_id: repoMountId,
      branch_name: name.branchName,
    });
    return (
      liveRow === undefined &&
      !branches.some((branch) => branchesConflict(branch, name.branchName)) &&
      !(await pathExists(name.folderPath))
    );
  }

  /**
   * `git worktree add -b` at the tree's folder; `null` when the tree was made, or git's line when
   * git refused the name because a branch holds it or sits inside or above it.
   */
  async #addWorktree(tree: MaterializedTree): Promise<string | null> {
    try {
      await this.#filesystem.createDirectory(dirname(tree.name.folderPath));
    } catch (filesystemFailure) {
      throw new WorktreeCreateFailedError("execution_root_unavailable", filesystemFailure);
    }
    // Read first so an undo deletes the branch only when this call made it: git can fail on a bad
    // base before it checks the branch, and the person's own branch of that name must stay.
    let isBranchNew: boolean;
    try {
      isBranchNew = !(await hasBranch(this.#runGit, tree.canonicalRoot, tree.name.branchName));
    } catch (gitFailure) {
      throw new WorktreeCreateFailedError("git_invocation_failed", gitFailure);
    }
    try {
      // `-C` rather than a `cwd`: the invocation is entirely in the argv. `-b` creates the branch
      // and checkout together, which the unique index models.
      await this.#runGit([
        "-C",
        tree.canonicalRoot,
        "worktree",
        "add",
        "-b",
        tree.name.branchName,
        tree.name.folderPath,
        tree.baseRef,
      ]);
      return null;
    } catch (gitFailure) {
      const takenLine = readGitRefusalLine(gitFailure, GIT_TAKEN_BRANCH_NAME_PATTERNS);
      if (takenLine !== null) {
        return takenLine;
      }
      // git's `stderr` rides only on `cause`: it is the value most likely to name a path. A git
      // that failed after it began, such as a failing checkout hook, can leave the tree, its
      // record or the new branch behind.
      throw withCleanupFailures(
        new WorktreeCreateFailedError("git_invocation_failed", gitFailure),
        await this.#undoUnrecordedTree(tree, isBranchNew),
        "worktree creation",
      );
    }
  }

  /** Inserts the `creating` row and `worktree.created` in one write; undoes the tree on refusal. */
  async #recordCreatedRow(
    tree: MaterializedTree,
    worktreeId: string,
    input: CreateWorktreeInput,
  ): Promise<void> {
    try {
      await this.#events.emitWorktreeCreated({
        sessionId: input.sessionId,
        worktreeId,
        repoMountId: input.repoMountId,
        actor: input.actor ?? null,
        ...(input.correlationId != null ? { correlationId: input.correlationId } : {}),
        transactionalPrelude: [
          insertWorktreeStatement({
            id: worktreeId,
            repo_mount_id: input.repoMountId,
            created_by_session_id: input.sessionId,
            created_by_run_id: input.runId ?? null,
            branch_name: tree.name.branchName,
            base_ref: tree.baseRef,
            fs_root: tree.name.folderPath,
            now: this.#now(),
          }),
        ],
      });
    } catch (appendFailure) {
      const recorded: unknown = hasSqliteErrorCode(appendFailure, "SQLITE_CONSTRAINT_UNIQUE")
        ? new WorktreeBranchCollisionError(input.repoMountId, tree.name.branchName)
        : appendFailure;
      throw withCleanupFailures(
        recorded,
        await this.#undoUnrecordedTree(tree),
        "worktree creation",
      );
    }
  }

  /**
   * Records `creating -> ready`. A failure marks the row `failed` and removes the folder: a
   * `creating` row is live under the unique index and unreachable by any sweep, so a bare throw
   * would wedge (mount, branch).
   */
  async #markReady(
    tree: MaterializedTree,
    worktreeId: string,
    sessionId: string,
    repoMountId: string,
    linkage: Pick<CreateWorktreeInput, "actor" | "correlationId">,
  ): Promise<void> {
    try {
      await this.#events.emitWorktreeReady({
        sessionId,
        worktreeId,
        repoMountId,
        actor: linkage.actor ?? null,
        ...(linkage.correlationId != null ? { correlationId: linkage.correlationId } : {}),
        transactionalPrelude: [
          transitionStatement(MARK_READY_SQL, { worktree_id: worktreeId, now: this.#now() }, 1),
        ],
      });
    } catch (readyEmissionFailure) {
      throw withCleanupFailures(
        explainWorktreeRowRefusal(readyEmissionFailure, worktreeId, "mark ready"),
        await this.#recordCreateFailure(tree, worktreeId),
        "worktree creation",
      );
    }
  }

  /**
   * Marks a `creating` row `failed`, removes its folder and its own record, then the branch this
   * call made. The removal is scoped to the folder this call made. Answers each step's failure,
   * the mark's included, for the caller to carry beside the creation failure.
   */
  async #recordCreateFailure(tree: MaterializedTree, worktreeId: string): Promise<unknown[]> {
    const failures: unknown[] = [];
    try {
      // Zero rows changed is tolerated, not asserted: the creation failure is the one to report.
      await this.#writer.write([
        transitionStatement(MARK_FAILED_SQL, { worktree_id: worktreeId, now: this.#now() }),
      ]);
    } catch (markFailure) {
      failures.push(markFailure);
    }
    try {
      // Read while the folder exists: git names the record only from inside the tree.
      const recordFolder = await readLinkedTreeRecord(this.#runGit, tree.name.folderPath);
      await this.#filesystem.removePath(tree.name.folderPath);
      await this.#worktrees.removeWorktreeRecord(recordFolder);
    } catch (cleanupFailure: unknown) {
      // A `failed` row is reached by no sweep step, so the folder stays until
      // `repo.worktreeRetire` moves the row.
      failures.push(cleanupFailure);
    }
    try {
      // Refused while the tree that failed to go still has the branch checked out.
      await this.#runGit(["-C", tree.canonicalRoot, "branch", "-D", tree.name.branchName]);
    } catch (branchFailure) {
      failures.push(branchFailure);
    }
    return failures;
  }

  /**
   * Undoes a tree git made that no row records: its folder and record, and the branch this call
   * created, which nothing else names. Each step runs only while what it removes is there, and the
   * branch only when this call made it. Answers each step's failure for the caller to carry.
   */
  async #undoUnrecordedTree(tree: MaterializedTree, isBranchNew = true): Promise<unknown[]> {
    const failures: unknown[] = [];
    const undoSteps: (() => Promise<void>)[] = [
      async () => {
        const { canonicalRoot, name } = tree;
        if (await pathExists(name.folderPath)) {
          const removeArgv = ["worktree", "remove", "--force", name.folderPath];
          await this.#runGit(["-C", canonicalRoot, ...removeArgv]);
        }
      },
      async () => {
        const { canonicalRoot, name } = tree;
        if (isBranchNew && (await hasBranch(this.#runGit, canonicalRoot, name.branchName))) {
          await this.#runGit(["-C", canonicalRoot, "branch", "-D", name.branchName]);
        }
      },
    ];
    for (const undoStep of undoSteps) {
      try {
        await undoStep();
      } catch (undoFailure) {
        failures.push(undoFailure);
      }
    }
    return failures;
  }

  /**
   * The supplied ref, else the mount's current HEAD branch, else a typed refusal, never a guess. A
   * leading `-` is refused before any git call, since git would read it as a flag; a failed read
   * and a detached HEAD both refuse.
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
    let headBranch: string | null;
    try {
      headBranch = await readCurrentBranch(this.#runGit, canonicalRoot);
    } catch (gitFailure) {
      throw new WorktreeCreateFailedError("base_ref_unresolved", gitFailure);
    }
    if (headBranch === null) {
      throw new WorktreeCreateFailedError("base_ref_unresolved");
    }
    return headBranch;
  }

  /**
   * Git's own branch-name rule, run before any row or tree exists. A name starting with `-` would
   * otherwise reach `worktree add -b` as an option. The refusal carries git's `fatal:` line as git
   * printed it, which names only the branch.
   */
  async #requireValidBranchName(canonicalRoot: string, branchName: string): Promise<void> {
    try {
      await this.#runGit(["-C", canonicalRoot, "check-ref-format", "--branch", branchName]);
    } catch (refusal) {
      const gitRefusalLine = readGitRefusalLine(refusal, [GIT_INVALID_BRANCH_NAME_PATTERN]);
      if (gitRefusalLine === null) {
        throw new WorktreeCreateFailedError("git_invocation_failed", refusal);
      }
      throw new WorktreeCreateFailedError("branch_name_invalid", gitRefusalLine, refusal);
    }
  }

  /** Every local branch's name. A read that does not complete is a creation failure. */
  async #listBranches(canonicalRoot: string): Promise<readonly string[]> {
    let result: GitInvocationResult;
    try {
      result = await this.#runGit([
        "-C",
        canonicalRoot,
        "for-each-ref",
        "--format=%(refname:lstrip=2)",
        "refs/heads/",
      ]);
    } catch (gitFailure) {
      throw new WorktreeCreateFailedError("git_invocation_failed", gitFailure);
    }
    return result.stdout
      .toString("utf8")
      .split("\n")
      .filter((branch) => branch.length > 0);
  }
}

// `feature` and `feature/x` cannot both be branches: one would be a folder of the other's file.
function branchesConflict(existing: string, candidate: string): boolean {
  return (
    existing === candidate ||
    existing.startsWith(`${candidate}/`) ||
    candidate.startsWith(`${existing}/`)
  );
}
