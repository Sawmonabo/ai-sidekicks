// Removing a worktree the daemon made. A plain removal is refused while an agent runs in the tree
// or while the tree holds anything to lose, ignored files included; it records the retirement and
// leaves the folder to the cleanup sweep. A discard keeps the tree whole: it ends the processes
// working in it, writes the kept copy's row, moves the tree aside with everything git needs to put
// it back, and records the retirement and the finished kept copy in one write, then removes the
// tree's own record from the repository. Either way every session in the tree is moved back to the
// repository's own checkout. A retired tree the sweep finds holding something new is kept aside
// the same way, so the person decides on it from the removed list.
//
// A discard a crash cut short is put right on its own: each one under its kept copy's lock, which
// a discard holds from writing its row until it is recorded or undone and git's record of the tree
// is removed, so a repair never takes a discard under way for one a crash cut short, a put-back
// never takes that record's name before it goes, and one that fails blocks no other tree. The lock
// is the one the removed list's put-back and deletion take. A tree's sessions are swept once the
// lock is let go, since the sweep takes the workspace locks, which come before it.
//
// The repair puts right every discard or keeping aside a crash cut short, so no kept folder is
// left that nothing lists. One that never recorded what its copy holds, or whose tree was never
// moved or copied whole, is undone; one whose tree moved is finished as what it was; one that left
// both folders is listed with the tree left in place; and one whose tree is in neither folder is
// listed for the person to delete; the moved tree's record is removed only when it is still the
// copy's own. Then it undoes every put-back a crash cut short, so its kept copy stands whole,
// deletes what is left of the kept copy of every tree put back once that tree stands sound or has
// gone through its own removal, whether a crash or a failure left it, removes each kept copy's
// old tree record when it is still the copy's own, and removes every in-progress copy a crash left
// in the worktrees folder that no worktree row names.

import { join } from "node:path";

import { ProjectIdSchema } from "@ai-sidekicks/contracts/project";
import { SessionIdSchema, type SessionId } from "@ai-sidekicks/contracts/session/id";
import {
  RemovedWorktreeIdSchema,
  WorktreeIdSchema,
  type WorktreeId,
  type WorktreeRetireRequest,
  type WorktreeRetireResponse,
} from "@ai-sidekicks/contracts/worktree/lifecycle";

import { withCleanupFailures } from "../../cleanup-failures.js";
import type { ServiceLogWriter } from "../../daemon/service-log.js";
import type { KeyedLock } from "../../keyed-lock.js";
import { settleAll } from "../../settle-all.js";
import { mintUuidV7 } from "../../uuid-v7.js";
import { canonicalFolderPath } from "../../workspace/folder/canonical-path.js";
import type { GitFilesystem } from "../filesystem.js";
import { pathExists } from "../../file/path-exists.js";
import type { GitCommand } from "../process.js";
import { WorktreeRetireConflictError, WorktreeRetireIncompleteError } from "./errors.js";
import {
  FolderMoveIncompleteError,
  KEPT_TREE_ENTRY,
  listLeftoverCopies,
  moveWorktreeAside,
  type KeptCopyTools,
  type MovedAsideWorktree,
} from "./kept-copy.js";
import type { MountOccupancyReader } from "./occupancy.js";
import type { RemovedWorktreeStore } from "./removed-store.js";
import { hasSomethingToLose, readRemovalRisks } from "./risks.js";
import type { WorktreeRow } from "./rows.js";
import { removeStaleTreeRecord } from "./stale-record.js";
import {
  WorktreeAlreadyRetiredError,
  type RetiredWorktreeKeeper,
  type WorktreeService,
} from "./service.js";
import type { UnfinishedKeptWorktree } from "./unfinished-discards.js";

/** One owner of processes the daemon started in a folder, which a removal ends before it moves. */
interface FolderProcessOwner {
  /**
   * Ends every process this owner started whose working folder is `folder` or inside it, and
   * resolves once each has exited; a process it cannot end is thrown.
   */
  endProcessesInFolder(folder: string): Promise<void>;
}

/** The removed tree a sweep empties. */
export interface WorktreeSweepInput {
  readonly repoMountId: string;
  readonly worktreeId: WorktreeId;
  readonly folder: string;
}

/** Moves every session out of a removed tree. */
export interface WorktreeSessionSweep {
  /**
   * Moves every session standing in `folder` to the repository's own checkout, clears every
   * pending move to it, and records one `session.swept_to_repo_root` per session.
   */
  sweepToRepoRoot(input: WorktreeSweepInput): Promise<void>;
}

/** A kept copy the repair could not put right, left for the next try. */
interface InterruptedKeptCopyFailure {
  readonly removedWorktreeId: string;
  readonly failure: unknown;
}

/** An in-progress copy a crash left that could not be removed, left for the next try. */
interface LeftoverCopyFailure {
  readonly folder: string;
  readonly failure: unknown;
}

// A failure removing git's record of a moved tree, thrown once its sessions are swept.
interface RecordRemovalFailure {
  readonly recordFailure: unknown;
}

// A tree whose sessions a repair leaves to sweep once the kept copy's lock is let go.
interface PendingSweep {
  readonly row: WorktreeRow;
  readonly recordRemoval: RecordRemovalFailure | null;
}

// What one repair of a discard did, and the sweep it leaves.
interface InterruptedDiscardRepair {
  readonly outcome: "none" | "undone" | "listed";
  readonly sweep: PendingSweep | null;
}

/** What one repair of the work a crash cut short did. */
export interface InterruptedKeptCopyRepair {
  /** The kept copies whose discard, keeping aside or put-back was put right. */
  readonly repairedRemovedWorktreeIds: readonly string[];
  readonly failures: readonly InterruptedKeptCopyFailure[];
  readonly leftoverCopyFailures: readonly LeftoverCopyFailure[];
}

/** Dependencies of {@link WorktreeRemoval}. */
export interface WorktreeRemovalDeps {
  readonly worktrees: Pick<
    WorktreeService,
    | "requireWorktree"
    | "readRunningSession"
    | "requireAttachedMount"
    | "recordRetirement"
    | "removeWorktreeRecord"
    | "stampCleaned"
    | "recordKeptAside"
    | "isWorktreeFolder"
  >;
  readonly removedWorktrees: Pick<
    RemovedWorktreeStore,
    | "keptFolderFor"
    | "recordPending"
    | "recordKeptState"
    | "finishStatement"
    | "finish"
    | "finishWithoutTree"
    | "forgetPending"
    | "listUnfinished"
    | "discardUnfinished"
    | "listKept"
    | "removeStaleRecordOf"
    | "listInterruptedPutBacks"
    | "finishInterruptedPutBack"
    | "listRestored"
    | "deleteRestoredCopy"
    | "claims"
    | "measureLater"
  >;
  /** The lock per kept copy, by its id, which the removed list's put-back and deletion take too. */
  readonly keptCopyLock: KeyedLock<string>;
  readonly occupancy: Pick<MountOccupancyReader, "read">;
  /** Every owner of processes the daemon starts in a tree, each ended before the tree moves. */
  readonly processes: readonly FolderProcessOwner[];
  readonly sessions: WorktreeSessionSweep;
  /** The daemon's git entry point. */
  readonly runGit: GitCommand;
  readonly filesystem: Pick<GitFilesystem, "rename" | "removePath">;
  /** Where a discard's copy across volumes, and its undo's, reports its progress. */
  readonly copies: KeptCopyTools["copies"];
  /** Where the repair writes a tree record it found set aside and left there, its name taken. */
  readonly writeServiceLog: ServiceLogWriter;
  /** The daemon's worktrees folder, where the repair looks for copies a crash left. */
  readonly worktreesDirectory: string;
  /** `removed_worktrees.id` source; defaults to `mintUuidV7`. */
  readonly newRemovedWorktreeId?: () => string;
}

/** Answers `repo.worktreeRetire`, and keeps aside a retired tree the sweep must not delete. */
export class WorktreeRemoval implements RetiredWorktreeKeeper {
  readonly #deps: WorktreeRemovalDeps;
  readonly #newRemovedWorktreeId: () => string;
  // Held per kept copy by its discard, any repair of it, its put-back and its deletion.
  readonly #keptCopyLock: KeyedLock<string>;

  constructor(deps: WorktreeRemovalDeps) {
    this.#deps = deps;
    this.#newRemovedWorktreeId = deps.newRemovedWorktreeId ?? mintUuidV7;
    this.#keptCopyLock = deps.keptCopyLock;
  }

  /**
   * Removes the tree. Throws {@link WorktreeRetireConflictError} with `root_busy` while an agent
   * runs in it, or, for a plain removal, with `has_changes` and the current risks while it holds
   * anything to lose; a discard throws `worktree.retire_folder_held` when the system refuses the
   * move. Every refusal removes nothing. A discard whose move across volumes copied the tree whole
   * but could not remove the original throws {@link WorktreeRetireIncompleteError}, with the kept
   * copy listed and the tree left live. A tree already retired has its sessions swept again. A
   * discard of this tree a crash cut short is put right first, and its failure is thrown.
   */
  async retire(request: WorktreeRetireRequest): Promise<WorktreeRetireResponse> {
    const { worktrees } = this.#deps;
    await this.#finishInterruptedDiscardsIn(worktrees.requireWorktree(request.worktreeId).fs_root);
    const row = worktrees.requireWorktree(request.worktreeId);
    const worktreeId = WorktreeIdSchema.parse(row.id);
    if (row.state === "retired") {
      await this.#sweep(row);
      return { worktreeId, state: "retired" };
    }
    const [, hasFolder] = await Promise.all([
      this.#refuseWhileRunning(row),
      pathExists(row.fs_root),
    ]);
    if (!request.discard && hasFolder) {
      const risks = await readRemovalRisks(
        this.#deps.runGit,
        row.fs_root,
        await this.#occupying(row),
      );
      if (hasSomethingToLose(risks)) {
        throw new WorktreeRetireConflictError({ worktreeId, reason: "has_changes", risks });
      }
    }
    if (hasFolder) {
      await settleAll(
        this.#deps.processes.map((owner) => owner.endProcessesInFolder(row.fs_root)),
        "ending the processes in the worktree",
      );
    }

    if (!request.discard || !hasFolder) {
      await this.#recordRetirement(row);
      await this.#sweep(row);
      return { worktreeId, state: "retired" };
    }

    const removedWorktreeId = this.#newRemovedWorktreeId();
    const recordRemoval = await this.#keptCopyLock.run(removedWorktreeId, async () => {
      const movedAside = await this.#moveAside(row, removedWorktreeId);
      await this.#recordOrUndo(movedAside, removedWorktreeId, () =>
        this.#recordRetirement(row, {
          removedWorktreeId,
          transactionalPrelude: [this.#deps.removedWorktrees.finishStatement(removedWorktreeId)],
        }),
      );
      return this.#removeRecord(() =>
        this.#deps.worktrees.removeWorktreeRecord(movedAside.recordFolder),
      );
    });
    this.#deps.removedWorktrees.measureLater(
      removedWorktreeId,
      this.#deps.removedWorktrees.keptFolderFor(row, removedWorktreeId),
    );
    await this.#sweepAfterRecord({ row, recordRemoval });
    return {
      worktreeId,
      state: "retired",
      kept: { removedWorktreeId: RemovedWorktreeIdSchema.parse(removedWorktreeId) },
    };
  }

  /**
   * Keeps a retired tree aside whole, as a discard would, and lists it with its row stamped cleaned
   * in one write. A move that copied the tree whole but left the original lists the copy, stamps
   * the row so no later sweep copies it again, and throws {@link WorktreeRetireIncompleteError}.
   * A keeping aside of this tree a crash cut short is put right first and its failure thrown, so
   * the tree is never kept aside twice: one that lists its copy leaves the row stamped cleaned.
   */
  async keepRetiredAside(row: WorktreeRow): Promise<void> {
    const { removedWorktrees, worktrees } = this.#deps;
    const isKeptAlready = await this.#finishInterruptedDiscardsIn(row.fs_root);
    if (isKeptAlready) {
      // A folder left beside the listed copy is no longer the sweep's to copy or delete.
      if (await pathExists(row.fs_root)) {
        await worktrees.stampCleaned(row.id);
      }
      return;
    }
    const removedWorktreeId = this.#newRemovedWorktreeId();
    await this.#keptCopyLock.run(removedWorktreeId, async () => {
      let movedAside: MovedAsideWorktree;
      try {
        movedAside = await this.#moveAside(row, removedWorktreeId);
      } catch (moveFailure) {
        if (moveFailure instanceof WorktreeRetireIncompleteError) {
          await worktrees.stampCleaned(row.id);
        }
        throw moveFailure;
      }
      await this.#recordOrUndo(movedAside, removedWorktreeId, () =>
        worktrees.recordKeptAside(row.id, removedWorktrees.finishStatement(removedWorktreeId)),
      );
      removedWorktrees.measureLater(
        removedWorktreeId,
        removedWorktrees.keptFolderFor(row, removedWorktreeId),
      );
      await worktrees.removeWorktreeRecord(movedAside.recordFolder);
    });
  }

  /**
   * Puts right the work a crash cut short, as the file header describes, each on its own so a
   * failure stops no other; resolves with what was put right and the failures, which stay for the
   * next call. Stops between steps once `signal` aborts.
   */
  async finishInterruptedKeptCopies(signal: AbortSignal): Promise<InterruptedKeptCopyRepair> {
    const { removedWorktrees } = this.#deps;
    const repairedRemovedWorktreeIds: string[] = [];
    const failures: InterruptedKeptCopyFailure[] = [];
    for (const { removedWorktreeId } of removedWorktrees.listUnfinished()) {
      if (signal.aborted) {
        break;
      }
      try {
        if ((await this.#finishInterruptedDiscardOf(removedWorktreeId)) !== "none") {
          repairedRemovedWorktreeIds.push(removedWorktreeId);
        }
      } catch (failure) {
        failures.push({ removedWorktreeId, failure });
      }
    }
    for (const removedWorktreeId of removedWorktrees.listInterruptedPutBacks()) {
      if (signal.aborted) {
        break;
      }
      try {
        if (await removedWorktrees.finishInterruptedPutBack(removedWorktreeId)) {
          repairedRemovedWorktreeIds.push(removedWorktreeId);
        }
      } catch (failure) {
        failures.push({ removedWorktreeId, failure });
      }
    }
    for (const removedWorktreeId of removedWorktrees.listRestored()) {
      if (signal.aborted) {
        break;
      }
      try {
        await removedWorktrees.deleteRestoredCopy(removedWorktreeId);
      } catch (failure) {
        failures.push({ removedWorktreeId, failure });
      }
    }
    for (const removedWorktreeId of removedWorktrees.listKept()) {
      if (signal.aborted) {
        break;
      }
      try {
        await removedWorktrees.removeStaleRecordOf(removedWorktreeId);
      } catch (failure) {
        failures.push({ removedWorktreeId, failure });
      }
    }
    const leftoverCopyFailures: LeftoverCopyFailure[] = [];
    let leftoverCopies: readonly string[] = [];
    try {
      leftoverCopies = await listLeftoverCopies(this.#deps.worktreesDirectory);
    } catch (failure) {
      // A folder that cannot be read blocks only this step, never the cleanup after it.
      leftoverCopyFailures.push({ folder: this.#deps.worktreesDirectory, failure });
    }
    for (const folder of leftoverCopies) {
      if (signal.aborted) {
        break;
      }
      if (this.#deps.worktrees.isWorktreeFolder(folder)) {
        continue;
      }
      try {
        await this.#deps.filesystem.removePath(folder);
      } catch (failure) {
        leftoverCopyFailures.push({ folder, failure });
      }
    }
    return { repairedRemovedWorktreeIds, failures, leftoverCopyFailures };
  }

  // Puts right each discard of the tree at `folder` a crash cut short; a failure is thrown. Answers
  // whether any of them listed a kept copy.
  async #finishInterruptedDiscardsIn(folder: string): Promise<boolean> {
    let isAnyListed = false;
    for (const unfinished of this.#deps.removedWorktrees.listUnfinished()) {
      if (unfinished.originalPath === folder) {
        const outcome = await this.#finishInterruptedDiscardOf(unfinished.removedWorktreeId);
        isAnyListed ||= outcome === "listed";
      }
    }
    return isAnyListed;
  }

  // Puts right one discard under its kept copy's lock, then sweeps the tree it finished once the
  // lock is let go. Answers what it did: nothing, undid the discard, or listed its kept copy.
  async #finishInterruptedDiscardOf(
    removedWorktreeId: string,
  ): Promise<InterruptedDiscardRepair["outcome"]> {
    const repair = await this.#finishInterruptedDiscardHeld(removedWorktreeId);
    if (repair.sweep !== null) {
      await this.#sweepAfterRecord(repair.sweep);
    }
    return repair.outcome;
  }

  // Under the kept copy's lock the row is read again, so one a discard or another repair finished
  // while this one waited is left alone.
  async #finishInterruptedDiscardHeld(
    removedWorktreeId: string,
  ): Promise<InterruptedDiscardRepair> {
    return this.#keptCopyLock.run(removedWorktreeId, async () => {
      const unfinished = this.#deps.removedWorktrees
        .listUnfinished()
        .find((candidate) => candidate.removedWorktreeId === removedWorktreeId);
      if (unfinished === undefined) {
        return { outcome: "none", sweep: null };
      }
      return this.#finishInterruptedDiscard(unfinished);
    });
  }

  async #finishInterruptedDiscard(
    unfinished: UnfinishedKeptWorktree,
  ): Promise<InterruptedDiscardRepair> {
    const { removedWorktrees } = this.#deps;
    const keptTree = join(unfinished.keptFolder, KEPT_TREE_ENTRY);
    const [hasKeptTree, hasTree] = await Promise.all([
      pathExists(keptTree),
      pathExists(unfinished.originalPath),
    ]);
    // The tree moves only once what the copy records is written, so without it nothing moved. A
    // copy takes the kept tree's name only once whole, and a deletion takes the tree off it first,
    // so with no kept tree the live tree is the whole one, and a partial copy goes with the kept
    // folder.
    const { recordFolder } = unfinished;
    if (recordFolder === null || (!hasKeptTree && hasTree)) {
      await removedWorktrees.discardUnfinished(unfinished);
      return { outcome: "undone", sweep: null };
    }
    // With neither there, nothing is known to be whole, so the person decides.
    if (!hasKeptTree && !hasTree) {
      await removedWorktrees.finishWithoutTree(unfinished.removedWorktreeId);
      return { outcome: "listed", sweep: null };
    }
    let sweep: PendingSweep | null = null;
    if (hasKeptTree && !hasTree) {
      // The moved tree's record, which nothing needs once the discard is recorded, is judged once
      // no live row stands at the tree's folder, and removed only while it is the copy's own, since
      // a later tree of that folder name may have taken the record's name.
      const removeOwnRecord = (): Promise<boolean> =>
        removeStaleTreeRecord(
          {
            filesystem: this.#deps.filesystem,
            writeServiceLog: this.#deps.writeServiceLog,
            claims: removedWorktrees.claims,
          },
          recordFolder,
          unfinished.originalPath,
        );
      if (unfinished.worktree !== null) {
        await this.#recordRetirement(unfinished.worktree, {
          removedWorktreeId: unfinished.removedWorktreeId,
          transactionalPrelude: [removedWorktrees.finishStatement(unfinished.removedWorktreeId)],
        });
        const recordRemoval = await this.#removeRecord(removeOwnRecord);
        sweep = { row: unfinished.worktree, recordRemoval };
      } else {
        // A retired tree the sweep was keeping aside: listing the copy finishes it, and the sweep
        // stamps the row once it finds the folder gone.
        await removedWorktrees.finish(unfinished.removedWorktreeId);
        await removeOwnRecord();
      }
    } else {
      // With both there, either a move across volumes copied the tree whole and the crash came
      // before or while the original was removed, or an undo across volumes was cut short while
      // removing the kept tree, which may then be partial. The copy is listed either way, so
      // nothing that may be whole is deleted, and the person decides.
      await removedWorktrees.finish(unfinished.removedWorktreeId);
    }
    removedWorktrees.measureLater(unfinished.removedWorktreeId, unfinished.keptFolder);
    return { outcome: "listed", sweep };
  }

  // Removes git's record of a moved tree, under the kept copy's lock. Its sessions are swept after,
  // since a later retire of the retired tree sweeps again but nothing comes back for a record left
  // behind, so a failure is answered for the sweep to throw once it has run.
  async #removeRecord(removeRecord: () => Promise<unknown>): Promise<RecordRemovalFailure | null> {
    try {
      await removeRecord();
      return null;
    } catch (recordFailure) {
      return { recordFailure };
    }
  }

  // Sweeps the tree's sessions, then throws a failure removing its record, with a failed sweep's.
  async #sweepAfterRecord({ row, recordRemoval }: PendingSweep): Promise<void> {
    if (recordRemoval === null) {
      await this.#sweep(row);
      return;
    }
    const sweepFailures: unknown[] = [];
    try {
      await this.#sweep(row);
    } catch (sweepFailure) {
      sweepFailures.push(sweepFailure);
    }
    throw withCleanupFailures(
      recordRemoval.recordFailure,
      sweepFailures,
      "removing git's record of the tree",
    );
  }

  // Records a tree moved aside; a failed record moves it back and deletes the kept copy's row.
  async #recordOrUndo(
    moved: MovedAsideWorktree,
    removedWorktreeId: string,
    record: () => Promise<void>,
  ): Promise<void> {
    try {
      await record();
    } catch (recordFailure) {
      const undoFailures: unknown[] = [];
      try {
        await moved.undo();
        await this.#deps.removedWorktrees.forgetPending(removedWorktreeId);
      } catch (undoFailure) {
        // The row stays unfinished, so the next repair of interrupted discards puts the move right.
        undoFailures.push(undoFailure);
      }
      throw withCleanupFailures(recordFailure, undoFailures, "keeping the worktree");
    }
  }

  // Moves the tree aside, its kept copy's row written first. A move that copied the tree whole but
  // left the original lists the kept copy and throws the typed refusal naming both; any other
  // failure deletes the row it wrote once its cleanup succeeded, and keeps it for the repair when
  // that cleanup failed.
  async #moveAside(row: WorktreeRow, removedWorktreeId: string): Promise<MovedAsideWorktree> {
    const { removedWorktrees } = this.#deps;
    const keptFolder = removedWorktrees.keptFolderFor(row, removedWorktreeId);
    const mount = this.#deps.worktrees.requireAttachedMount(row.repo_mount_id);
    try {
      return await moveWorktreeAside(
        { runGit: this.#deps.runGit, filesystem: this.#deps.filesystem, copies: this.#deps.copies },
        {
          worktreeId: WorktreeIdSchema.parse(row.id),
          projectId: ProjectIdSchema.parse(mount.project_id),
          treeFolder: row.fs_root,
          canonicalRoot: mount.canonical_root,
          keptFolder,
          removedWorktreeId,
        },
        {
          recordPending: () =>
            removedWorktrees.recordPending({ removedWorktreeId, worktree: row, keptFolder }),
          recordState: (state) => removedWorktrees.recordKeptState(removedWorktreeId, state),
          forgetPending: () => removedWorktrees.forgetPending(removedWorktreeId),
        },
      );
    } catch (moveFailure) {
      if (moveFailure instanceof FolderMoveIncompleteError) {
        await removedWorktrees.finish(removedWorktreeId);
        removedWorktrees.measureLater(removedWorktreeId, keptFolder);
        throw new WorktreeRetireIncompleteError(
          {
            worktreeId: WorktreeIdSchema.parse(row.id),
            removedWorktreeId: RemovedWorktreeIdSchema.parse(removedWorktreeId),
          },
          moveFailure,
        );
      }
      throw moveFailure;
    }
  }

  async #refuseWhileRunning(row: WorktreeRow): Promise<void> {
    const runningSessionId = await this.#deps.worktrees.readRunningSession(row.id);
    if (runningSessionId !== null) {
      throw new WorktreeRetireConflictError({
        worktreeId: WorktreeIdSchema.parse(row.id),
        reason: "root_busy",
        runningSessionId: SessionIdSchema.parse(runningSessionId),
      });
    }
  }

  // A retirement another call recorded first is this call's too; its sweep still runs.
  async #recordRetirement(
    row: WorktreeRow,
    options?: Parameters<WorktreeService["recordRetirement"]>[1],
  ): Promise<void> {
    try {
      await this.#deps.worktrees.recordRetirement(row, options);
    } catch (retirementFailure) {
      if (!(retirementFailure instanceof WorktreeAlreadyRetiredError) || options !== undefined) {
        throw retirementFailure;
      }
    }
  }

  async #occupying(row: WorktreeRow): Promise<SessionId[]> {
    const occupancy = await this.#deps.occupancy.read(row.repo_mount_id);
    const standing = occupancy.standingByFolder.get(await canonicalFolderPath(row.fs_root));
    return (standing ?? []).map((session) => session.sessionId);
  }

  async #sweep(row: WorktreeRow): Promise<void> {
    await this.#deps.sessions.sweepToRepoRoot({
      repoMountId: row.repo_mount_id,
      worktreeId: WorktreeIdSchema.parse(row.id),
      folder: row.fs_root,
    });
  }
}
