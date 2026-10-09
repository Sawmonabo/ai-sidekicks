// Worktree lifecycle service: owns the `worktrees` table's reads, its retirement, the record of a
// put-back tree, and the sweep that cleans retired folders. A tree's making is `creation.ts`. It
// holds no `workspaces` write; its caller wraps these calls.
//
//   * The main checkout is never mutated: git runs only reads in it, and the one record removed
//     from the repository's git folder is the removed tree's own.
//   * `cleanupPass` records its decision to delete, removes the tree's record, then the folder,
//     then stamps `cleaned_at`, so a crash between steps leaves a row the next pass finishes by its
//     path and never a cleanup recorded that did not happen.
//   * A retired tree holding what the person could lose is never deleted: it is kept aside whole
//     and listed with the removed worktrees.
//   * Only a tree `repo.worktreeRetire` retired loses its folder; a tree retired because its
//     project was detached keeps its folder on disk as it is.

import { relative, sep } from "node:path";
import type { Statement } from "better-sqlite3";
import { SessionIdSchema } from "@ai-sidekicks/contracts/session/id";
import {
  WorktreeIdSchema,
  WorktreeStateSchema,
  type WorktreeRetireResponse,
} from "@ai-sidekicks/contracts/worktree/lifecycle";
import type { DatabaseConnections } from "../../database/connection/lifecycle.js";
import type { WriteStatement } from "../../database/statement.js";
import { WriteRefusedError, type DatabaseWriter } from "../../database/writer.js";
import { mintUuidV7 } from "../../uuid-v7.js";
import { RepoMountNotFoundError } from "../../workspace/repo/errors.js";
import { describeRejection } from "../../rejection.js";
import { canonicalFolderPath } from "../../workspace/folder/canonical-path.js";
import { DEFAULT_GIT_FILESYSTEM, pathExists, type GitFilesystem } from "../filesystem.js";
import {
  createGitCommand,
  DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  runGitWithExecFile,
  type GitCommand,
  type GitRunner,
} from "../process.js";
import { WorktreeNotFoundError, WorktreeRetireConflictError } from "./errors.js";
import type { WorktreeEventEmitter } from "./event-emitter.js";
import { readLinkedTreeRecord } from "./reads.js";
import type { WorktreeNaming } from "./naming.js";
import type { MountOccupancyReader } from "./occupancy.js";
import { hasSomethingToLose, readRemovalRiskReading } from "./risks.js";
import {
  explainWorktreeRowRefusal,
  insertWorktreeStatement,
  LIVE_WORKTREE_STATE_PREDICATE,
  liveWorktreeStatePredicate,
  MARK_READY_SQL,
  transitionStatement,
  UNRELEASED_RUN_IN_WORKTREE_SQL,
  UNRELEASED_RUNS_SQL,
  type AttachedMountRow,
  type MountLookupParams,
  type UnreleasedRunRow,
  type WorktreeLookupParams,
  type WorktreeRow,
} from "./rows.js";

/** Dependencies of {@link WorktreeService} and its creator; only the first three are required. */
export interface WorktreeServiceDeps {
  /** Reads on its reader; a row write without an event goes through its writer. */
  readonly database: DatabaseConnections;
  /** Event emission seam; this service constructs no envelopes of its own. */
  readonly events: WorktreeEventEmitter;
  /** Names every tree and the create form's suggestion; the sweep reads its worktrees folder. */
  readonly naming: WorktreeNaming;
  /** The daemon's one occupancy reader, for the sessions standing in a tree. */
  readonly occupancy: MountOccupancyReader;
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

/** A tree a put-back made from a kept copy, recorded as a new row. */
export interface RecordRestoredWorktreeInput {
  readonly repoMountId: string;
  readonly sessionId: string;
  readonly branchName: string;
  readonly baseRef: string;
  readonly fsRoot: string;
  /** The kept copy the tree came from, carried on `worktree.created`. */
  readonly restoredFrom: string;
  /** Statements committed in the row's write, after its insert and its move to `ready`. */
  readonly transactionalPrelude?: (worktreeId: string) => readonly WriteStatement[];
}

/** What a retirement's write carries beyond the row's own transition. */
export interface RecordRetirementOptions {
  readonly actor?: string | null;
  readonly correlationId?: string | null;
  /** The kept copy a discard made, carried on `worktree.retired`; its folder is stamped cleaned. */
  readonly removedWorktreeId?: string;
  /**
   * The folder stays on disk as it is, so the row is stamped cleaned in the same write and no
   * sweep ever removes it: a retirement because the project was detached.
   */
  readonly isFolderLeftOnDisk?: boolean;
  /** The digest of what the risk read showed at retirement, which the sweep compares against. */
  readonly retiredRiskDigest?: string;
  /** Statements committed in the same write, after the retirement's own checks. */
  readonly transactionalPrelude?: readonly WriteStatement[];
}

/** Keeps a retired tree whose folder holds what the person could lose, for them to decide on. */
export interface RetiredWorktreeKeeper {
  /**
   * Moves the retired tree aside whole as a kept copy the removed list shows, its row stamped
   * cleaned in the write that lists the copy.
   */
  keepRetiredAside(row: WorktreeRow): Promise<void>;
}

/** What one {@link WorktreeService.cleanupPass} did, in the order it did it. */
export interface WorktreeCleanupPassResult {
  /** Worktrees retired by the inactive-mount cascade, their folders left on disk. */
  readonly retiredWorktreeIds: readonly string[];
  /** Worktrees whose folder was removed and whose `cleaned_at` was stamped. */
  readonly cleanedWorktreeIds: readonly string[];
  /** Retired worktrees whose folder held something new, kept aside or left where they are. */
  readonly keptWorktreeIds: readonly string[];
}

// A retired, uncleaned tree as the sweep reads it, with what its retirement recorded and the
// state of its mount.
interface RetiredFolderRow extends WorktreeRow {
  readonly retired_risk_digest: string | null;
  readonly cleanup_started_at: string | null;
  readonly mount_state: string;
}

const WORKTREE_ROW_COLUMNS =
  "id, repo_mount_id, created_by_session_id, branch_name, base_ref, fs_root, state";

// The retirement's write checks, in order, that the row is not yet retired and that no agent runs
// in the tree, then retires it; every non-`retired` state is a legal predecessor, `failed`
// included.
const SELECT_UNRETIRED_WORKTREE_SQL = `SELECT id FROM worktrees
  WHERE id = @worktree_id AND state <> 'retired'`;
const RETIRE_SQL = `UPDATE worktrees
    SET state = 'retired', retired_risk_digest = @retired_risk_digest, updated_at = @now
  WHERE id = @worktree_id AND state <> 'retired'`;
// The positions of the retirement write's checks among its statements.
const UNRETIRED_CHECK_INDEX = 0;
const RUNNING_SESSION_CHECK_INDEX = 1;

// Guarded on `cleaned_at IS NULL` so a concurrent pass that already stamped the row does not have
// its timestamp overwritten. A discard stamps it in its retirement's write: its folder is moved.
const STAMP_CLEANED_SQL = `UPDATE worktrees
    SET cleaned_at = @now, updated_at = @now
  WHERE id = @worktree_id AND cleaned_at IS NULL`;

const MARK_CLEANUP_STARTED_SQL = `UPDATE worktrees
    SET cleanup_started_at = @now, updated_at = @now
  WHERE id = @worktree_id AND cleaned_at IS NULL AND cleanup_started_at IS NULL`;

/**
 * What `#recordRetirement` throws when its write found the row already retired, so no second
 * `worktree.retired` was appended. Internal, not a `DaemonDomainError`.
 */
export class WorktreeAlreadyRetiredError extends Error {
  constructor(worktreeId: string) {
    super(
      `WorktreeService: worktree ${worktreeId} was already retired when the retirement ` +
        `was written; nothing was appended, so one transition carries one worktree.retired event.`,
    );
    this.name = "WorktreeAlreadyRetiredError";
  }
}

/**
 * Owns every `worktrees` transition and worktree-scoped git call. Each `UPDATE` carries its
 * legal-predecessor set in its `WHERE`, so the transition table lives in the statements.
 */
export class WorktreeService {
  readonly #events: WorktreeEventEmitter;
  readonly #naming: WorktreeNaming;
  readonly #runGit: GitCommand;
  readonly #filesystem: GitFilesystem;
  readonly #now: () => string;
  readonly #newWorktreeId: () => string;

  readonly #selectAttachedMountStmt: Statement<MountLookupParams, AttachedMountRow>;
  readonly #selectWorktreeStmt: Statement<WorktreeLookupParams, WorktreeRow>;
  readonly #selectUnreleasedRunsStmt: Statement<[], UnreleasedRunRow>;
  readonly #occupancy: MountOccupancyReader;
  readonly #selectSweepableStmt: Statement<[], WorktreeRow>;
  readonly #selectUncleanedRetiredStmt: Statement<[], RetiredFolderRow>;
  readonly #selectRowAtFolderStmt: Statement<{ fs_root: string }, unknown>;
  readonly #writer: Pick<DatabaseWriter, "write">;

  constructor(deps: WorktreeServiceDeps) {
    this.#events = deps.events;
    this.#naming = deps.naming;
    this.#filesystem = deps.filesystem ?? DEFAULT_GIT_FILESYSTEM;
    this.#runGit = createGitCommand({
      git: deps.git ?? runGitWithExecFile,
      timeoutMs: deps.gitCommandTimeoutMs ?? DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    });
    this.#now = deps.now ?? ((): string => new Date().toISOString());
    this.#newWorktreeId = deps.newWorktreeId ?? mintUuidV7;

    const database = deps.database.reader;
    this.#writer = deps.database.writer;

    // Only `attached` mounts are provisioning targets; a detached one gets `repo.not_found`.
    this.#selectAttachedMountStmt = database.prepare<MountLookupParams, AttachedMountRow>(
      `SELECT id, canonical_root, project_id
         FROM repo_mounts
        WHERE id = @repo_mount_id AND state = 'attached'`,
    );

    this.#selectWorktreeStmt = database.prepare<WorktreeLookupParams, WorktreeRow>(
      `SELECT ${WORKTREE_ROW_COLUMNS} FROM worktrees WHERE id = @worktree_id`,
    );

    this.#selectUnreleasedRunsStmt = database.prepare<[], UnreleasedRunRow>(UNRELEASED_RUNS_SQL);
    this.#occupancy = deps.occupancy;

    // Live worktrees on a mount no longer `attached`.
    this.#selectSweepableStmt = database.prepare<[], WorktreeRow>(
      `SELECT worktrees.id, worktrees.repo_mount_id, worktrees.created_by_session_id,
              worktrees.branch_name, worktrees.base_ref, worktrees.fs_root, worktrees.state
         FROM worktrees
         JOIN repo_mounts ON repo_mounts.id = worktrees.repo_mount_id
        WHERE repo_mounts.state <> 'attached'
          AND ${LIVE_WORKTREE_STATE_PREDICATE}
        ORDER BY worktrees.created_at ASC, worktrees.id ASC`,
    );

    // A tree an agent still runs in, or a session still stands in, is deferred, not excluded: a
    // later pass reclaims it once the run ends or the session moves. A live tree at the same
    // folder, one put back there, owns the folder now, so the retired row leaves it alone.
    this.#selectUncleanedRetiredStmt = database.prepare<[], RetiredFolderRow>(
      `SELECT worktrees.id, worktrees.repo_mount_id, worktrees.created_by_session_id,
              worktrees.branch_name, worktrees.base_ref, worktrees.fs_root, worktrees.state,
              worktrees.retired_risk_digest, worktrees.cleanup_started_at,
              repo_mounts.state AS mount_state
         FROM worktrees
         JOIN repo_mounts ON repo_mounts.id = worktrees.repo_mount_id
        WHERE worktrees.state = 'retired' AND worktrees.cleaned_at IS NULL
          AND NOT EXISTS (
                SELECT 1
                  FROM run_execution_contexts AS run
                 WHERE run.released_at IS NULL
                   AND (run.worktree_id = worktrees.id OR run.execution_root = worktrees.fs_root)
              )
          AND NOT EXISTS (
                SELECT 1
                  FROM workspaces AS standing
                 WHERE standing.state <> 'archived'
                   AND standing.fs_root = worktrees.fs_root
              )
          AND NOT EXISTS (
                SELECT 1
                  FROM worktrees AS live
                 WHERE live.fs_root = worktrees.fs_root
                   AND ${liveWorktreeStatePredicate("live")}
              )
        ORDER BY worktrees.updated_at ASC, worktrees.id ASC`,
    );

    this.#selectRowAtFolderStmt = database.prepare<{ fs_root: string }, unknown>(
      "SELECT 1 FROM worktrees WHERE fs_root = @fs_root LIMIT 1",
    );
  }

  /** The row of a worktree; throws {@link WorktreeNotFoundError} for an unknown id. */
  requireWorktree(worktreeId: string): WorktreeRow {
    const row = this.#selectWorktreeStmt.get({ worktree_id: worktreeId });
    if (row === undefined) {
      throw new WorktreeNotFoundError(worktreeId);
    }
    return row;
  }

  /**
   * The session whose agent runs in the tree, or `null` when none does: a run whose context names
   * the tree, or whose root is the tree's folder or inside it, the folders compared resolved.
   */
  async readRunningSession(worktreeId: string): Promise<string | null> {
    const tree = this.requireWorktree(worktreeId);
    const treeKey = await canonicalFolderPath(tree.fs_root);
    for (const run of this.#selectUnreleasedRunsStmt.all()) {
      if (run.worktree_id === worktreeId) {
        return run.session_id;
      }
      const rootKey = await canonicalFolderPath(run.execution_root);
      if (rootKey === treeKey || rootKey.startsWith(`${treeKey}${sep}`)) {
        return run.session_id;
      }
    }
    return null;
  }

  /**
   * Whether a worktree row in any state names `folder`, compared as stored: a tree's folder can be
   * named like a leftover copy, and a detached project's trees stay on disk once cleaned.
   */
  isWorktreeFolder(folder: string): boolean {
    return this.#selectRowAtFolderStmt.get({ fs_root: folder }) !== undefined;
  }

  /** The attached mount, with its root and project; throws `RepoMountNotFoundError` if detached. */
  requireAttachedMount(repoMountId: string): AttachedMountRow {
    const mount = this.#selectAttachedMountStmt.get({ repo_mount_id: repoMountId });
    if (mount === undefined) {
      // The carrier, not a re-mint of `repo.not_found`: two classes for a code break `instanceof`.
      throw new RepoMountNotFoundError(repoMountId);
    }
    return mount;
  }

  /**
   * Records `-> retired` plus `worktree.retired` and touches nothing on disk. Refuses with
   * `root_busy` when an agent runs in the tree, decided inside the write; throws
   * {@link WorktreeAlreadyRetiredError} when the row was already retired, so nothing is appended
   * twice. `failed` is a legal predecessor, the only route by which a failed creation becomes
   * sweepable. A discard's caller stamps `cleaned_at` and inserts its kept copy in the same write.
   */
  async recordRetirement(row: WorktreeRow, options: RecordRetirementOptions = {}): Promise<void> {
    await this.#recordRetirementOnce(row, options, { canRetry: true });
  }

  // One retirement write; a run the write saw but that has ended by the read after is tried once
  // more, and a second such refusal is thrown rather than tried for ever.
  async #recordRetirementOnce(
    row: WorktreeRow,
    options: RecordRetirementOptions,
    { canRetry }: { readonly canRetry: boolean },
  ): Promise<void> {
    const worktreeLookup = { worktree_id: row.id } satisfies WorktreeLookupParams;
    try {
      await this.#events.emitWorktreeRetired({
        // The row's own session: the event belongs to the creator, and the sweep has no caller.
        sessionId: row.created_by_session_id,
        worktreeId: row.id,
        repoMountId: row.repo_mount_id,
        actor: options.actor ?? null,
        ...(options.correlationId != null ? { correlationId: options.correlationId } : {}),
        ...(options.removedWorktreeId !== undefined
          ? { removedWorktreeId: options.removedWorktreeId }
          : {}),
        transactionalPrelude: [
          { sql: SELECT_UNRETIRED_WORKTREE_SQL, bindings: worktreeLookup, expectedRowCount: 1 },
          { sql: UNRELEASED_RUN_IN_WORKTREE_SQL, bindings: worktreeLookup, expectedRowCount: 0 },
          {
            sql: RETIRE_SQL,
            bindings: {
              worktree_id: row.id,
              now: this.#now(),
              retired_risk_digest: options.retiredRiskDigest ?? null,
            },
            expectedRowCount: 1,
          },
          ...(options.removedWorktreeId !== undefined || options.isFolderLeftOnDisk === true
            ? [transitionStatement(STAMP_CLEANED_SQL, { worktree_id: row.id, now: this.#now() })]
            : []),
          ...(options.transactionalPrelude ?? []),
        ],
      });
    } catch (retirementFailure) {
      if (!(retirementFailure instanceof WriteRefusedError)) {
        throw retirementFailure;
      }
      if (retirementFailure.statementIndex === UNRETIRED_CHECK_INDEX) {
        throw this.#explainUnretiredRefusal(row.id, retirementFailure);
      }
      if (retirementFailure.statementIndex === RUNNING_SESSION_CHECK_INDEX) {
        const runningSessionId = await this.readRunningSession(row.id);
        if (runningSessionId === null) {
          if (!canRetry) {
            throw explainWorktreeRowRefusal(retirementFailure, row.id, "retire");
          }
          // The run ended after the write saw it, so the retirement is legal again.
          await this.#recordRetirementOnce(row, options, { canRetry: false });
          return;
        }
        throw new WorktreeRetireConflictError({
          worktreeId: WorktreeIdSchema.parse(row.id),
          reason: "root_busy",
          runningSessionId: SessionIdSchema.parse(runningSessionId),
        });
      }
      throw explainWorktreeRowRefusal(retirementFailure, row.id, "retire");
    }
  }

  /**
   * Retires a tree this daemon just made and could not hand over, for a caller undoing its own
   * preparation. It records the retirement with what the risk read shows in the tree, its setup's
   * own output included; `cleanupPass` removes the folder while nothing beyond that has appeared.
   * A failed read still retires the tree, recording nothing, and is then thrown.
   */
  async retireUnadopted(worktreeId: string): Promise<WorktreeRetireResponse> {
    const row = this.requireWorktree(worktreeId);
    let retiredRiskDigest: string | undefined;
    let readFailure: unknown = null;
    try {
      if (await pathExists(row.fs_root)) {
        retiredRiskDigest = (await readRemovalRiskReading(this.#runGit, row.fs_root)).digest;
      }
    } catch (error) {
      // Retired all the same, so its branch is freed; with nothing recorded the sweep keeps the
      // folder aside rather than delete it, and the read's failure is thrown after.
      readFailure = error;
    }
    try {
      await this.recordRetirement(
        row,
        retiredRiskDigest === undefined ? {} : { retiredRiskDigest },
      );
    } catch (retirementFailure) {
      if (!(retirementFailure instanceof WorktreeAlreadyRetiredError)) {
        throw readFailure === null
          ? retirementFailure
          : new AggregateError(
              [readFailure, retirementFailure],
              "reading what the worktree holds failed, and so did retiring it",
            );
      }
    }
    if (readFailure !== null) {
      throw readFailure;
    }
    return { worktreeId: WorktreeIdSchema.parse(row.id), state: "retired" };
  }

  /**
   * Records a tree a put-back made in one write: the row with `worktree.created` carrying the kept
   * copy it came from, its move to `ready` with `worktree.ready`, and `transactionalPrelude`'s
   * statements, so a failure keeps none of them. Returns the new row's id.
   */
  async recordRestoredWorktree(input: RecordRestoredWorktreeInput): Promise<string> {
    const worktreeId = this.#newWorktreeId();
    const now = this.#now();
    await this.#events.emitWorktreeCreatedAndReady({
      sessionId: input.sessionId,
      worktreeId,
      repoMountId: input.repoMountId,
      restoredFrom: input.restoredFrom,
      transactionalPrelude: [
        insertWorktreeStatement({
          id: worktreeId,
          repo_mount_id: input.repoMountId,
          created_by_session_id: input.sessionId,
          created_by_run_id: null,
          branch_name: input.branchName,
          base_ref: input.baseRef,
          fs_root: input.fsRoot,
          now,
        }),
        transitionStatement(MARK_READY_SQL, { worktree_id: worktreeId, now }, 1),
        ...(input.transactionalPrelude?.(worktreeId) ?? []),
      ],
    });
    return worktreeId;
  }

  /**
   * One sweep: retires live worktrees on a mount no longer `attached`, stamping them cleaned so
   * their folders stay on disk, then empties each `retired` folder with no `cleaned_at` while no
   * agent runs in it and no session stands in it. A folder whose risk read shows nothing to lose,
   * or the same as its retirement recorded, is deleted: git's record first, then the folder, then
   * the stamp. One holding anything more goes to `keeper`, which keeps it aside for the person;
   * on a mount no longer attached it is left where it is, since a detach touches nothing on disk.
   * A row that fails does not stop the others: once every row has been tried, the failures are
   * thrown together in an `AggregateError` whose message names each. The pass is idempotent and
   * re-entrant, so the next one retries the rows that failed. Once `signal` aborts it stops
   * between rows, leaving the rows it did not reach to the next pass.
   */
  async cleanupPass(
    keeper: RetiredWorktreeKeeper,
    signal: AbortSignal,
  ): Promise<WorktreeCleanupPassResult> {
    const failures: unknown[] = [];
    const failedRowLines: string[] = [];
    const recordRowFailure = (worktreeId: string, failure: unknown): void => {
      failures.push(failure);
      failedRowLines.push(`worktree ${worktreeId}: ${describeRejection(failure)}`);
    };

    const retiredWorktreeIds: string[] = [];
    for (const row of this.#selectSweepableStmt.all()) {
      if (signal.aborted) break;
      try {
        await this.recordRetirement(row, { isFolderLeftOnDisk: true });
        retiredWorktreeIds.push(row.id);
      } catch (retirementFailure) {
        if (!(retirementFailure instanceof WorktreeAlreadyRetiredError)) {
          recordRowFailure(row.id, retirementFailure);
        }
      }
    }

    const cleanedWorktreeIds: string[] = [];
    const keptWorktreeIds: string[] = [];
    for (const row of this.#selectUncleanedRetiredStmt.all()) {
      if (signal.aborted) break;
      try {
        const outcome = await this.#cleanRetiredFolder(row, keeper);
        if (outcome === "cleaned") cleanedWorktreeIds.push(row.id);
        if (outcome === "kept") keptWorktreeIds.push(row.id);
      } catch (cleanupFailure) {
        recordRowFailure(row.id, cleanupFailure);
      }
    }

    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `the worktree cleanup failed for ${failedRowLines.join("; ")}`,
      );
    }
    return { retiredWorktreeIds, cleanedWorktreeIds, keptWorktreeIds };
  }

  // Empties one retired folder, keeps it aside, or leaves it for a later pass while it is in use.
  async #cleanRetiredFolder(
    row: RetiredFolderRow,
    keeper: RetiredWorktreeKeeper,
  ): Promise<"cleaned" | "kept" | "deferred"> {
    this.#requireNamedWorktreeFolder(row);
    // Re-decided per row, right before removal: earlier removals are awaits a run can start in.
    if (await this.#isFolderInUse(row)) {
      return "deferred";
    }
    // Read while git still knows the tree: it names the record only from inside it. A pass after
    // a crash that already removed the record reads none and removes the folder alone.
    const recordFolder = (await pathExists(row.fs_root))
      ? await readLinkedTreeRecord(this.#runGit, row.fs_root)
      : null;
    // A removal a crash cut short while git still knows the tree is checked again, since work may
    // have been added to it since that pass decided.
    if (row.cleanup_started_at === null || recordFolder !== null) {
      if (await this.#holdsSomethingNew(row)) {
        if (row.mount_state === "attached") {
          await keeper.keepRetiredAside(row);
        } else {
          await this.stampCleaned(row.id);
        }
        return "kept";
      }
      if (row.cleanup_started_at === null) {
        await this.#writer.write([
          transitionStatement(MARK_CLEANUP_STARTED_SQL, { worktree_id: row.id, now: this.#now() }),
        ]);
      }
    }
    await this.removeWorktreeRecord(recordFolder);
    await this.#filesystem.removePath(row.fs_root);
    await this.stampCleaned(row.id);
    return "cleaned";
  }

  /**
   * Stamps a retired tree cleaned: its folder is gone from where the row points, or is left there
   * for good. A row a concurrent pass already stamped keeps its stamp.
   */
  async stampCleaned(worktreeId: string): Promise<void> {
    await this.#writer.write([
      transitionStatement(STAMP_CLEANED_SQL, { worktree_id: worktreeId, now: this.#now() }),
    ]);
  }

  /**
   * Lists a retired tree's kept copy and stamps the row cleaned in one write. Throws when the row
   * was already stamped, so a copy is never listed for a tree another pass settled.
   */
  async recordKeptAside(worktreeId: string, finishKeptCopy: WriteStatement): Promise<void> {
    await this.#writer.write([
      finishKeptCopy,
      transitionStatement(STAMP_CLEANED_SQL, { worktree_id: worktreeId, now: this.#now() }, 1),
    ]);
  }

  /**
   * Removes one tree's record from the repository's git folder, as {@link readLinkedTreeRecord}
   * named it, so no other tree's record is touched. `null`, a tree with no record left: nothing.
   * A failure is thrown.
   */
  async removeWorktreeRecord(recordFolder: string | null): Promise<void> {
    if (recordFolder !== null) {
      await this.#filesystem.removePath(recordFolder);
    }
  }

  // An agent runs in the tree, or a session stands in its folder.
  async #isFolderInUse(row: RetiredFolderRow): Promise<boolean> {
    if ((await this.readRunningSession(row.id)) !== null) {
      return true;
    }
    const occupancy = await this.#occupancy.read(row.repo_mount_id);
    return occupancy.standingByFolder.has(await canonicalFolderPath(row.fs_root));
  }

  // Git shows something in the tree to lose beyond what its retirement recorded: anything at all
  // for a removal the person confirmed, anything new for a tree the daemon could not hand over.
  async #holdsSomethingNew(row: RetiredFolderRow): Promise<boolean> {
    if (!(await pathExists(row.fs_root))) {
      return false;
    }
    const reading = await readRemovalRiskReading(this.#runGit, row.fs_root);
    return hasSomethingToLose(reading.risks) && reading.digest !== row.retired_risk_digest;
  }

  /**
   * Refuses a stored folder that is not `<worktrees>/<project slug>/<name>`, the only shape a
   * name plan makes: the path comes from the database, and a recursive removal must not reach a
   * project's kept copies under `.removed/`, another project's folder or anything outside the
   * worktrees folder.
   */
  #requireNamedWorktreeFolder(row: RetiredFolderRow): void {
    const segments: readonly string[] = relative(
      this.#naming.worktreesDirectory,
      row.fs_root,
    ).split(sep);
    const isNamedFolder =
      segments.length === 2 &&
      segments.every((segment) => segment.length > 0 && !segment.startsWith("."));
    if (!isNamedFolder) {
      throw new Error(
        `cannot clean worktree "${row.id}": its stored folder is not one a name plan makes`,
      );
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
}
