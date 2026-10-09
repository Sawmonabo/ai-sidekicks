// The kept worktrees `Discard and remove` leaves: their rows in `removed_worktrees`, listing them,
// putting one back, and deleting one when the person presses `Delete now`. Nothing else deletes a
// kept worktree: no age, no sweep and no data cleanup reaches its folder or its pins. Put back
// moves the kept copy back into the tree, and only what is left of it goes after the answer.
//
// A discard writes its row before it makes anything the row lists, with no `removed_at`, fills in
// what the copy records before the tree moves, and the retirement's write sets `removed_at`; a row
// still without one names a discard a crash cut short, which the daemon's start finishes or undoes,
// so no kept folder or pin is ever left that nothing lists. A put-back marks the row with what it
// is doing before the tree moves, and the put-back's own write clears the mark; a row still marked
// names a put-back a crash cut short, which is undone so the kept copy is whole again.
//
// Put back first undoes a put-back of the copy a crash cut short. It puts the tree where it lived,
// or at `<folder>-restored` when that folder exists or a retired tree's cleanup still owns it, on
// the branch the put-back chooses; a taken name takes the next number, `-restored-2` and on, one
// number shared when both the folder and a new branch are renamed. The tree is recorded with
// `worktree.created` naming the kept copy, and the press answers once that write has committed.
// What is left of the copy (its pins, its folder and its row) goes after the answer, under the
// copy's lock, once the tree put back stands sound or has gone through its own removal; when that
// fails, or a crash comes first, the failure goes to the service log and the next cleanup tries
// again. What is left is listed only while it is the one source to rebuild a live tree put back
// that git cannot read, which is also when the cleanup leaves it; Put back then rebuilds from it
// while its files are whole, linking it to the new tree, and refuses `kept_tree_missing` once
// they went into that tree.
//
// One lock per kept copy, shared with the removal, runs its discard, its repair, its put-back and
// its deletion one at a time, so each reads the row as the one before left it.

import * as nodePath from "node:path";

import type { Statement } from "better-sqlite3";

import { ProjectIdSchema } from "@ai-sidekicks/contracts/project";
import { GitObjectIdSchema } from "@ai-sidekicks/contracts/repo/git-reads";
import type { WorktreeCopySubject } from "@ai-sidekicks/contracts/worktree/copy-progress";
import {
  RemovedWorktreeIdSchema,
  WorktreeIdSchema,
  type RemovedWorktreeId,
} from "@ai-sidekicks/contracts/worktree/lifecycle";
import type {
  RemovedWorktreeListRequest,
  RemovedWorktreeListResponse,
  WorktreeRestoreResponse,
} from "@ai-sidekicks/contracts/worktree/removed";

import { withCleanupFailures } from "../../cleanup-failures.js";
import type { ServiceLogWriter } from "../../daemon/service-log.js";
import type { DatabaseConnections } from "../../database/connection/lifecycle.js";
import type { WriteStatement } from "../../database/statement.js";
import type { DatabaseWriter } from "../../database/writer.js";
import type { KeyedLock } from "../../keyed-lock.js";
import { mapWithProcessorBound } from "../../processor-bound.js";
import { COMMON_DIR_METADATA_PATH } from "../../workspace/row-guards.js";
import { componentsEqual, toComparableComponents } from "../../workspace/trust-envelope.js";
import { pathExists, type GitFilesystem } from "../filesystem.js";
import type { GitCommand } from "../process.js";
import { prepareKeptCopyClaims, type KeptCopyClaims } from "./claims.js";
import { RemovedWorktreeNotFoundError } from "./errors.js";
import {
  deleteKeptCopy,
  KEPT_TREE_ENTRY,
  measureKeptCopy,
  type KeptCopyTools,
  type KeptWorktreeState,
} from "./kept-copy.js";
import { REMOVED_WORKTREES_FOLDER_NAME } from "./naming.js";
import {
  choosePutBackBranch,
  putWorktreeBackAtFreeName,
  requireSoundRestoredTree,
  undoPutBack,
  type PutBackMark,
  type PutBackTools,
} from "./put-back.js";
import { LIVE_WORKTREE_STATE_PREDICATE, type WorktreeRow } from "./rows.js";
import type { WorktreeService } from "./service.js";
import { removeStaleTreeRecord } from "./stale-record.js";
import {
  prepareUnfinishedDiscardListing,
  type UnfinishedKeptWorktree,
} from "./unfinished-discards.js";

// Written before anything it lists is made, so it names no `removed_at` until the retirement sets
// it, and no `head_commit` until the copy's state is read.
const INSERT_PENDING_REMOVED_WORKTREE_SQL = `INSERT INTO removed_worktrees (
    id, mount_id, project_id, created_by_session_id, worktree_name, original_path, kept_path,
    branch, base_ref
  )
  SELECT @id, repo_mounts.id, repo_mounts.project_id, @created_by_session_id, @worktree_name,
         @original_path, @kept_path, @branch, @base_ref
    FROM repo_mounts
   WHERE repo_mounts.id = @mount_id`;

// What the kept copy records, filled in before the tree moves; a detached HEAD keeps the tree's
// own branch for the list.
const RECORD_KEPT_STATE_SQL = `UPDATE removed_worktrees SET head_commit = @head_commit,
         branch = coalesce(@branch, branch), is_on_branch = @branch IS NOT NULL,
         record_folder = @record_folder
  WHERE id = @id AND removed_at IS NULL`;

const FINISH_REMOVED_WORKTREE_SQL = `UPDATE removed_worktrees SET removed_at = @removed_at
  WHERE id = @id AND removed_at IS NULL`;

// Links the kept copy to the tree put back, in the put-back's own write, and clears the put-back's
// mark. A rebuild moves the link from the unreadable tree it read, compared and swapped here.
const MARK_RESTORED_SQL = `UPDATE removed_worktrees SET restored_worktree_id = @worktree_id,
         restoring_to = NULL, restoring_record = NULL, restoring_branch = NULL,
         restoring_branch_commit = NULL
  WHERE id = @id AND restored_worktree_id IS @read_restored_worktree_id`;

// What a put-back is doing, written before its tree moves, only while the copy is linked as the
// put-back read it.
const MARK_PUT_BACK_SQL = `UPDATE removed_worktrees SET restoring_to = @restoring_to,
         restoring_record = @restoring_record, restoring_branch = @restoring_branch,
         restoring_branch_commit = @restoring_branch_commit
  WHERE id = @id AND restoring_to IS NULL
    AND restored_worktree_id IS @read_restored_worktree_id`;

const CLEAR_PUT_BACK_MARK_SQL = `UPDATE removed_worktrees SET restoring_to = NULL,
         restoring_record = NULL, restoring_branch = NULL, restoring_branch_commit = NULL
  WHERE id = @id`;

// The kept copies whose put-back a crash cut short.
const SELECT_INTERRUPTED_PUT_BACKS_SQL = `SELECT id FROM removed_worktrees
  WHERE restoring_to IS NOT NULL ORDER BY id`;

// The kept copies whose discard finished.
const SELECT_LISTED_IDS_SQL = `SELECT id FROM removed_worktrees
  WHERE removed_at IS NOT NULL ORDER BY id`;

// The kept copies of trees put back, whose deletion a crash or a failure left undone.
const SELECT_RESTORED_IDS_SQL = `SELECT id FROM removed_worktrees
  WHERE restored_worktree_id IS NOT NULL ORDER BY id`;

// No row for a tree gone through its own removal or a session purge.
const SELECT_LIVE_TREE_SQL = `SELECT fs_root FROM worktrees
  WHERE id = @worktree_id AND ${LIVE_WORKTREE_STATE_PREDICATE}`;

const REMOVED_WORKTREE_COLUMNS = `id, mount_id, project_id, created_by_session_id, worktree_name,
  original_path, kept_path, branch, is_on_branch, base_ref, head_commit, record_folder, removed_at,
  size_bytes, size_read_at, restored_worktree_id, restoring_to, restoring_record, restoring_branch,
  restoring_branch_commit`;

interface RemovedWorktreeRow {
  readonly id: string;
  readonly mount_id: string;
  readonly project_id: string;
  readonly created_by_session_id: string;
  readonly worktree_name: string;
  readonly original_path: string;
  readonly kept_path: string;
  readonly branch: string;
  /** 1 when `branch` is the one the kept HEAD names, or in a rebase the one being rebased. */
  readonly is_on_branch: number;
  readonly base_ref: string;
  /** Set before the tree moves, with `record_folder`; every listed row has it. */
  readonly head_commit: string;
  /** Git's record of the tree as git named it at the discard; set with `head_commit`. */
  readonly record_folder: string;
  readonly removed_at: string;
  readonly size_bytes: number | null;
  readonly size_read_at: string | null;
  readonly restored_worktree_id: string | null;
  readonly restoring_to: string | null;
  readonly restoring_record: string | null;
  readonly restoring_branch: string | null;
  readonly restoring_branch_commit: string | null;
}

interface LiveTreeRow {
  readonly fs_root: string;
}

interface MountRow {
  readonly id: string;
  readonly canonical_root: string;
  readonly common_dir: string | null;
}

/** What one discard keeps, for the row it writes before it makes anything the row lists. */
export interface KeptWorktreeRecord {
  readonly removedWorktreeId: string;
  readonly worktree: WorktreeRow;
  readonly keptFolder: string;
}

/** Dependencies of {@link RemovedWorktreeStore}. */
export interface RemovedWorktreeStoreDeps {
  readonly database: DatabaseConnections;
  /** The daemon's git entry point. */
  readonly runGit: GitCommand;
  readonly filesystem: Pick<GitFilesystem, "rename" | "removePath">;
  /** Where a put-back's copy across volumes, and its undo's, reports its progress. */
  readonly copies: KeptCopyTools["copies"];
  /** Records the tree a put-back makes. */
  readonly worktrees: Pick<WorktreeService, "recordRestoredWorktree">;
  /** The daemon's worktrees folder; a kept folder is deleted only from inside it. */
  readonly worktreesDirectory: string;
  /**
   * Where a failed size read is written, the size then unknown, a put-back whose kept copy could
   * not be removed, a put-back's target its undo left alone, and a tree record set aside and left
   * there, its name taken.
   */
  readonly writeServiceLog: ServiceLogWriter;
  /** The lock per kept copy, by its id, which the removal holds for its discards and repairs. */
  readonly keptCopyLock: KeyedLock<string>;
  readonly now?: () => string;
}

/** Lists, puts back and deletes the worktrees a discard kept. */
export class RemovedWorktreeStore {
  /** What live trees and put-backs under way hold, which no kept copy's removal takes. */
  readonly claims: KeptCopyClaims;
  /** Every discard a crash cut short, with the live tree it was moving. */
  readonly listUnfinished: () => readonly UnfinishedKeptWorktree[];
  readonly #runGit: GitCommand;
  readonly #putBackTools: PutBackTools;
  readonly #worktrees: RemovedWorktreeStoreDeps["worktrees"];
  readonly #worktreesDirectory: string;
  readonly #writeServiceLog: ServiceLogWriter;
  readonly #now: () => string;
  readonly #writer: Pick<DatabaseWriter, "write">;
  readonly #sizeReads = new Set<Promise<void>>();
  // The deletions of kept copies put back, which run after the put-back answered.
  readonly #restoredCopyDeletions = new Set<Promise<void>>();
  readonly #keptCopyLock: KeyedLock<string>;
  // Kept copies whose stale record this process already looked for: a record is left behind only
  // by a crash or a failed removal before the copy's first look, so each copy is read once a run.
  // A copy's id goes once its row does.
  readonly #staleRecordCheckedIds = new Set<string>();

  readonly #selectAllStmt: Statement<[], RemovedWorktreeRow>;
  readonly #selectByProjectStmt: Statement<{ project_id: string }, RemovedWorktreeRow>;
  readonly #selectOneStmt: Statement<{ id: string }, RemovedWorktreeRow>;
  readonly #selectProjectMountStmt: Statement<{ project_id: string }, MountRow>;
  readonly #selectMountStmt: Statement<{ mount_id: string }, MountRow>;
  readonly #selectLiveTreeStmt: Statement<{ worktree_id: string }, LiveTreeRow>;
  readonly #selectInterruptedPutBacksStmt: Statement<[], string>;
  readonly #selectListedIdsStmt: Statement<[], string>;
  readonly #selectRestoredIdsStmt: Statement<[], string>;
  readonly #selectUncleanedRetiredAtFolderStmt: Statement<{ fs_root: string }, unknown>;

  constructor(deps: RemovedWorktreeStoreDeps) {
    const reader = deps.database.reader;
    this.claims = prepareKeptCopyClaims(reader);
    this.listUnfinished = prepareUnfinishedDiscardListing(reader);
    this.#runGit = deps.runGit;
    this.#putBackTools = {
      runGit: deps.runGit,
      filesystem: deps.filesystem,
      copies: deps.copies,
      writeServiceLog: deps.writeServiceLog,
      claims: this.claims,
    };
    this.#worktrees = deps.worktrees;
    this.#worktreesDirectory = deps.worktreesDirectory;
    this.#writeServiceLog = deps.writeServiceLog;
    this.#keptCopyLock = deps.keptCopyLock;
    this.#now = deps.now ?? ((): string => new Date().toISOString());
    this.#writer = deps.database.writer;

    this.#selectAllStmt = reader.prepare<[], RemovedWorktreeRow>(
      `SELECT ${REMOVED_WORKTREE_COLUMNS} FROM removed_worktrees
        WHERE removed_at IS NOT NULL ORDER BY removed_at DESC, id`,
    );
    this.#selectByProjectStmt = reader.prepare<{ project_id: string }, RemovedWorktreeRow>(
      `SELECT ${REMOVED_WORKTREE_COLUMNS} FROM removed_worktrees
        WHERE project_id = @project_id AND removed_at IS NOT NULL ORDER BY removed_at DESC, id`,
    );
    this.#selectOneStmt = reader.prepare<{ id: string }, RemovedWorktreeRow>(
      `SELECT ${REMOVED_WORKTREE_COLUMNS} FROM removed_worktrees
        WHERE id = @id AND removed_at IS NOT NULL`,
    );
    const mountColumns = `id, canonical_root,
      json_extract(metadata, '${COMMON_DIR_METADATA_PATH}') AS common_dir`;
    // The project's mount now, which a detach and re-attach may have replaced since the discard.
    this.#selectProjectMountStmt = reader.prepare<{ project_id: string }, MountRow>(
      `SELECT ${mountColumns} FROM repo_mounts
        WHERE project_id = @project_id AND state = 'attached'`,
    );
    // The mount the discard was made on, attached or not: its repository holds the pins.
    this.#selectMountStmt = reader.prepare<{ mount_id: string }, MountRow>(
      `SELECT ${mountColumns} FROM repo_mounts WHERE id = @mount_id`,
    );
    this.#selectLiveTreeStmt = reader.prepare<{ worktree_id: string }, LiveTreeRow>(
      SELECT_LIVE_TREE_SQL,
    );
    this.#selectInterruptedPutBacksStmt = reader
      .prepare<[], string>(SELECT_INTERRUPTED_PUT_BACKS_SQL)
      .pluck();
    this.#selectListedIdsStmt = reader.prepare<[], string>(SELECT_LISTED_IDS_SQL).pluck();
    this.#selectRestoredIdsStmt = reader.prepare<[], string>(SELECT_RESTORED_IDS_SQL).pluck();
    // A retired tree's folder the cleanup still owns: a put-back there would be taken for it.
    this.#selectUncleanedRetiredAtFolderStmt = reader.prepare<{ fs_root: string }, unknown>(
      `SELECT 1 FROM worktrees
        WHERE fs_root = @fs_root AND state = 'retired' AND cleaned_at IS NULL LIMIT 1`,
    );
  }

  /** Where a tree's kept copy goes: `<project folder>/.removed/<name>-<removed id>/`. */
  keptFolderFor(worktree: WorktreeRow, removedWorktreeId: string): string {
    return nodePath.join(
      nodePath.dirname(worktree.fs_root),
      REMOVED_WORKTREES_FOLDER_NAME,
      `${nodePath.basename(worktree.fs_root)}-${removedWorktreeId}`,
    );
  }

  /**
   * Writes the kept copy's row before anything it lists is made, with no `removed_at`, so a crash
   * at any step leaves a row that names the kept folder and the pins. No list shows it yet.
   */
  async recordPending(record: KeptWorktreeRecord): Promise<void> {
    await this.#writer.write([
      {
        sql: INSERT_PENDING_REMOVED_WORKTREE_SQL,
        bindings: {
          id: record.removedWorktreeId,
          mount_id: record.worktree.repo_mount_id,
          created_by_session_id: record.worktree.created_by_session_id,
          worktree_name: nodePath.basename(record.worktree.fs_root),
          original_path: record.worktree.fs_root,
          kept_path: record.keptFolder,
          branch: record.worktree.branch_name,
          base_ref: record.worktree.base_ref,
        },
        expectedRowCount: 1,
      },
    ]);
  }

  /**
   * Fills in what the kept copy records, before the tree moves; a detached HEAD keeps the row's
   * own branch.
   */
  async recordKeptState(removedWorktreeId: string, state: KeptWorktreeState): Promise<void> {
    await this.#writer.write([
      {
        sql: RECORD_KEPT_STATE_SQL,
        bindings: {
          id: removedWorktreeId,
          head_commit: state.headCommit,
          branch: state.branch,
          record_folder: state.recordFolder,
        },
        expectedRowCount: 1,
      },
    ]);
  }

  /** Sets the kept copy's `removed_at`, written in the same write as the tree's retirement. */
  finishStatement(removedWorktreeId: string): WriteStatement {
    return {
      sql: FINISH_REMOVED_WORKTREE_SQL,
      bindings: { id: removedWorktreeId, removed_at: this.#now() },
      expectedRowCount: 1,
    };
  }

  /** Lists the kept copy on its own, for a move that left both folders and retires nothing. */
  async finish(removedWorktreeId: string): Promise<void> {
    await this.#writer.write([this.finishStatement(removedWorktreeId)]);
  }

  /**
   * Lists a kept copy a crash cut short whose tree is neither in its kept folder nor where it
   * lived, and writes its id to the service log, for the person to delete: `Put back` refuses it
   * `kept_tree_missing`, and `Delete now` deletes what is left and its pins.
   */
  async finishWithoutTree(removedWorktreeId: string): Promise<void> {
    await this.finish(removedWorktreeId);
    this.#writeServiceLog(
      `kept worktree ${removedWorktreeId}: a crash cut its discard short and its tree is neither ` +
        "in its kept folder nor where it lived; it is listed for Delete now, and Put back " +
        "refuses it",
    );
  }

  /** The ids of the kept copies whose put-back a crash cut short. */
  listInterruptedPutBacks(): readonly string[] {
    return this.#selectInterruptedPutBacksStmt.all();
  }

  /**
   * Undoes a put-back of this kept copy a crash cut short, under the copy's lock, so the copy
   * stands whole again, and clears its mark; answers whether there was one. A failure keeps the
   * mark for the next try and is thrown.
   */
  async finishInterruptedPutBack(removedWorktreeId: string): Promise<boolean> {
    return this.#keptCopyLock.run(removedWorktreeId, async () => {
      const kept = this.#selectOneStmt.get({ id: removedWorktreeId });
      return kept !== undefined && (await this.#undoInterruptedPutBack(kept));
    });
  }

  /** The ids of every kept copy whose discard finished. */
  listKept(): readonly string[] {
    return this.#selectListedIdsStmt.all();
  }

  /**
   * Removes a kept copy's old tree record when it is still the copy's own, under the copy's lock,
   * so git never counts it a duplicate of a tree put back; once a run per copy.
   */
  async removeStaleRecordOf(removedWorktreeId: string): Promise<void> {
    if (this.#staleRecordCheckedIds.has(removedWorktreeId)) {
      return;
    }
    await this.#keptCopyLock.run(removedWorktreeId, async () => {
      const kept = this.#selectOneStmt.get({ id: removedWorktreeId });
      if (kept !== undefined) {
        await this.#removeStaleRecord(kept);
        this.#staleRecordCheckedIds.add(removedWorktreeId);
      }
    });
  }

  /** The ids of the kept copies of trees put back, whose deletion is left undone. */
  listRestored(): readonly string[] {
    return this.#selectRestoredIdsStmt.all();
  }

  /**
   * Deletes what is left of the kept copy of a tree put back, its pins, its folder and its row,
   * under the copy's lock, once the tree put back stands sound or has gone through its own removal.
   * A failure, or a live tree that is not sound, keeps the copy for the next cleanup to try again
   * and is thrown.
   */
  async deleteRestoredCopy(removedWorktreeId: string): Promise<void> {
    await this.#keptCopyLock.run(removedWorktreeId, async () => {
      const kept = this.#selectOneStmt.get({ id: removedWorktreeId });
      if (kept === undefined || kept.restored_worktree_id === null) {
        return;
      }
      const unsoundTree = await this.#findUnsoundRestoredTree(kept.restored_worktree_id);
      if (unsoundTree !== undefined) {
        throw unsoundTree.failure;
      }
      await this.#deleteKept(kept);
    });
  }

  /** Deletes the row of a kept copy whose tree never moved, once its folder and pins are gone. */
  async forgetPending(removedWorktreeId: string): Promise<void> {
    await this.#writer.write([
      {
        sql: "DELETE FROM removed_worktrees WHERE id = @id AND removed_at IS NULL",
        bindings: { id: removedWorktreeId },
        expectedRowCount: 1,
      },
    ]);
  }

  /**
   * Reads the kept copy's size once, after the discard has answered, so the press waits on no
   * walk of the tree. A failed read leaves the size unknown and is written to the service log.
   */
  measureLater(removedWorktreeId: string, keptFolder: string): void {
    const sizeRead = (async (): Promise<void> => {
      try {
        const sizeBytes = await measureKeptCopy(keptFolder);
        await this.#writer.write([
          {
            sql: `UPDATE removed_worktrees SET size_bytes = @size_bytes, size_read_at = @now
                   WHERE id = @id`,
            bindings: { id: removedWorktreeId, size_bytes: sizeBytes, now: this.#now() },
          },
        ]);
      } catch (sizeFailure) {
        this.#writeServiceLog(
          `kept worktree ${removedWorktreeId}: reading its size failed: ${String(sizeFailure)}`,
        );
      }
    })();
    this.#sizeReads.add(sizeRead);
    void sizeRead.finally(() => this.#sizeReads.delete(sizeRead));
  }

  /**
   * Resolves once no size read and no deletion of a kept copy put back runs, those started while it
   * waits included, for shutdown; neither ever rejects.
   */
  async settle(): Promise<void> {
    while (this.#sizeReads.size + this.#restoredCopyDeletions.size > 0) {
      await Promise.all([...this.#sizeReads, ...this.#restoredCopyDeletions]);
    }
  }

  /**
   * One project's kept worktrees, or every project's, newest first. What is left of a copy put
   * back is listed only while it is the one source to rebuild a live tree put back that git cannot
   * read, with that tree's folder.
   */
  async list(request: RemovedWorktreeListRequest): Promise<RemovedWorktreeListResponse> {
    const rows =
      request.projectId === undefined
        ? this.#selectAllStmt.all()
        : this.#selectByProjectStmt.all({ project_id: request.projectId });
    // One git read per copy put back, as many at once as the machine has processors.
    const removedWorktrees = await mapWithProcessorBound(rows, async (row) => {
      const unreadablePutBackFolder =
        row.restored_worktree_id === null
          ? null
          : (await this.#findUnsoundRestoredTree(row.restored_worktree_id))?.folder;
      if (unreadablePutBackFolder === undefined) {
        return undefined;
      }
      return {
        removedWorktreeId: RemovedWorktreeIdSchema.parse(row.id),
        projectId: ProjectIdSchema.parse(row.project_id),
        name: row.worktree_name,
        branch: row.branch,
        headCommit: GitObjectIdSchema.parse(row.head_commit),
        removedAt: row.removed_at,
        sizeBytes: row.size_bytes,
        sizeReadAt: row.size_read_at,
        unreadablePutBackFolder,
      };
    });
    return { removedWorktrees: removedWorktrees.filter((listed) => listed !== undefined) };
  }

  /**
   * Puts a kept worktree back, as the file header describes, answering once the tree is recorded.
   * Refuses `project_not_attached`, `repository_missing` and `kept_tree_missing`, keeping the copy;
   * a failure undoes every step and is thrown, and {@link RemovedWorktreeNotFoundError} when no
   * copy has the id, or what is left of it is not listed.
   */
  async restore(removedWorktreeId: RemovedWorktreeId): Promise<WorktreeRestoreResponse> {
    const response = await this.#keptCopyLock.run(removedWorktreeId, () =>
      this.#putBack(removedWorktreeId),
    );
    // Started once the hold has ended, so the deletion takes the copy's lock on its own instead of
    // riding a hold that ends while it runs.
    if (response.outcome === "restored") {
      this.#deleteRestoredCopyLater(removedWorktreeId, response.path);
    }
    return response;
  }

  /**
   * Deletes a kept worktree for good: the tree's old record when it is still the copy's own, its
   * folder, its pins and its row; the row goes last, so a failure leaves a row a second
   * `Delete now` finishes. Throws {@link RemovedWorktreeNotFoundError} when no kept copy has
   * the id.
   */
  async delete(removedWorktreeId: RemovedWorktreeId): Promise<void> {
    await this.#keptCopyLock.run(removedWorktreeId, async () => {
      // A put-back a crash cut short is undone first, so no tree it moved is left unlisted.
      await this.#undoInterruptedPutBack(this.#requireRow(removedWorktreeId));
      await this.#deleteKept(this.#requireRow(removedWorktreeId));
    });
  }

  // The live tree put back when it is not sound, with why; no git runs once that tree went through
  // its own removal, which kept what it held.
  async #findUnsoundRestoredTree(
    restoredWorktreeId: string,
  ): Promise<{ folder: string; failure: unknown } | undefined> {
    const restored = this.#selectLiveTreeStmt.get({ worktree_id: restoredWorktreeId });
    if (restored === undefined) {
      return undefined;
    }
    return requireSoundRestoredTree(this.#runGit, restored.fs_root).then(
      () => undefined,
      (soundnessFailure: unknown) => ({ folder: restored.fs_root, failure: soundnessFailure }),
    );
  }

  // Deletes what is left of the kept copy of a tree put back once the put-back has answered,
  // tracked so shutdown waits for it. A failure leaves the copy for the next cleanup to try again,
  // and goes to the service log.
  #deleteRestoredCopyLater(removedWorktreeId: string, restoredFolder: string): void {
    const deletion = (async (): Promise<void> => {
      try {
        await this.deleteRestoredCopy(removedWorktreeId);
      } catch (removalFailure) {
        this.#writeServiceLog(
          `kept worktree ${removedWorktreeId}: put back at ${restoredFolder}, but removing what ` +
            "is left of the kept copy failed; the next cleanup tries again: " +
            String(removalFailure),
        );
      }
    })();
    this.#restoredCopyDeletions.add(deletion);
    void deletion.finally(() => this.#restoredCopyDeletions.delete(deletion));
  }

  async #putBack(removedWorktreeId: string): Promise<WorktreeRestoreResponse> {
    // A put-back of this copy a crash cut short is undone first, so the copy is whole again.
    await this.#undoInterruptedPutBack(this.#requireRow(removedWorktreeId));
    const kept = this.#requireRow(removedWorktreeId);
    // What is left of a copy put back is listed, and put back again, only while its live tree put
    // back is one git cannot read; a sound one, or one gone, leaves it hidden.
    if (
      kept.restored_worktree_id !== null &&
      (await this.#findUnsoundRestoredTree(kept.restored_worktree_id)) === undefined
    ) {
      throw new RemovedWorktreeNotFoundError(removedWorktreeId);
    }
    const mount = this.#selectProjectMountStmt.get({ project_id: kept.project_id });
    if (mount === undefined) {
      return { outcome: "refused", refusal: { reason: "project_not_attached" } };
    }
    if (!(await pathExists(mount.canonical_root)) || !this.#isSameRepository(kept, mount)) {
      return {
        outcome: "refused",
        refusal: { reason: "repository_missing", path: mount.canonical_root },
      };
    }

    // A leftover's files went into its unreadable tree when the first put-back renamed them there.
    const keptTree = nodePath.join(kept.kept_path, KEPT_TREE_ENTRY);
    if (!(await pathExists(keptTree))) {
      return { outcome: "refused", refusal: { reason: "kept_tree_missing" } };
    }

    const commonFolder = mount.common_dir;
    if (commonFolder === null) {
      throw new Error(`project mount "${mount.id}" carries no repository identity`);
    }
    const choice = await choosePutBackBranch(this.#putBackTools, {
      removedWorktreeId: kept.id,
      branch: kept.branch,
      isOnBranch: kept.is_on_branch === 1,
      keptFolder: kept.kept_path,
      recordFolder: kept.record_folder,
      originalPath: kept.original_path,
      canonicalRoot: mount.canonical_root,
      commonFolder,
    });
    const { putBack, targetFolder, newBranch } = await putWorktreeBackAtFreeName(
      this.#putBackTools,
      {
        keptFolder: kept.kept_path,
        originalPath: kept.original_path,
        branch: kept.branch,
        canonicalRoot: mount.canonical_root,
        commonFolder,
        choice,
        copySubject: putBackCopySubject(kept),
        isFolderTaken: (folder) => this.#isFolderTaken(folder),
      },
      {
        write: async (mark) => {
          await this.#writer.write([markPutBackStatement(kept, mark)]);
        },
        clear: async () => {
          await this.#writer.write([clearPutBackMarkStatement(kept.id)]);
        },
      },
    );
    const branch = newBranch?.name ?? kept.branch;
    let worktreeId: string;
    try {
      worktreeId = await this.#worktrees.recordRestoredWorktree({
        repoMountId: mount.id,
        sessionId: kept.created_by_session_id,
        branchName: branch,
        baseRef: kept.base_ref,
        fsRoot: targetFolder,
        restoredFrom: kept.id,
        transactionalPrelude: (restoredWorktreeId) => [
          {
            sql: MARK_RESTORED_SQL,
            bindings: {
              id: kept.id,
              worktree_id: restoredWorktreeId,
              read_restored_worktree_id: kept.restored_worktree_id,
            },
            expectedRowCount: 1,
          },
        ],
      });
    } catch (recordFailure) {
      const undoFailures: unknown[] = [];
      try {
        await putBack.undo();
      } catch (undoFailure) {
        undoFailures.push(undoFailure);
      }
      throw withCleanupFailures(recordFailure, undoFailures, "recording the put-back tree");
    }
    return {
      outcome: "restored",
      worktreeId: WorktreeIdSchema.parse(worktreeId),
      path: targetFolder,
      branch,
      onNewBranch: newBranch !== null,
    };
  }

  /**
   * Undoes a discard a crash cut short before its tree was moved or copied whole: deletes the kept
   * folder, which holds no whole tree, and the pins, then the row.
   */
  async discardUnfinished(unfinished: UnfinishedKeptWorktree): Promise<void> {
    const canonicalRoot = (await pathExists(unfinished.canonicalRoot))
      ? unfinished.canonicalRoot
      : null;
    await this.#deleteKeptFolder(
      unfinished.removedWorktreeId,
      unfinished.keptFolder,
      canonicalRoot,
    );
    await this.forgetPending(unfinished.removedWorktreeId);
  }

  // Undoes the put-back the row's mark names and clears the mark; answers whether it had one. Runs
  // under the kept copy's lock.
  async #undoInterruptedPutBack(kept: RemovedWorktreeRow): Promise<boolean> {
    if (kept.restoring_to === null || kept.restoring_record === null) {
      return false;
    }
    await undoPutBack(
      this.#putBackTools,
      {
        keptFolder: kept.kept_path,
        targetFolder: kept.restoring_to,
        recordFolder: kept.restoring_record,
        newBranch:
          kept.restoring_branch === null || kept.restoring_branch_commit === null
            ? null
            : { name: kept.restoring_branch, commit: kept.restoring_branch_commit },
      },
      putBackCopySubject(kept),
    );
    await this.#writer.write([clearPutBackMarkStatement(kept.id)]);
    return true;
  }

  // A folder on disk, or one a retired tree's cleanup still owns, which would take a tree put back
  // there for its own.
  async #isFolderTaken(folder: string): Promise<boolean> {
    return (
      this.#selectUncleanedRetiredAtFolderStmt.get({ fs_root: folder }) !== undefined ||
      (await pathExists(folder))
    );
  }

  // The same mount, or one whose repository identity is the one the tree was kept from.
  #isSameRepository(kept: RemovedWorktreeRow, mount: MountRow): boolean {
    if (kept.mount_id === mount.id) {
      return true;
    }
    const keptCommonDir = this.#selectMountStmt.get({ mount_id: kept.mount_id })?.common_dir;
    if (keptCommonDir == null || mount.common_dir === null) {
      return false;
    }
    return componentsEqual(
      toComparableComponents(keptCommonDir, nodePath),
      toComparableComponents(mount.common_dir, nodePath),
    );
  }

  #requireRow(removedWorktreeId: string): RemovedWorktreeRow {
    const row = this.#selectOneStmt.get({ id: removedWorktreeId });
    if (row === undefined) {
      throw new RemovedWorktreeNotFoundError(removedWorktreeId);
    }
    return row;
  }

  // The stored folder comes from the database, so a recursive delete must reach nothing but a
  // `<worktrees>/<project slug>/.removed/<name>` folder.
  async #deleteKeptFolder(
    removedWorktreeId: string,
    keptFolder: string,
    canonicalRoot: string | null,
  ): Promise<void> {
    const segments = nodePath.relative(this.#worktreesDirectory, keptFolder).split(nodePath.sep);
    const isKeptFolder =
      segments.length === 3 &&
      segments[1] === REMOVED_WORKTREES_FOLDER_NAME &&
      segments.every((segment) => segment.length > 0 && segment !== "..");
    if (!isKeptFolder) {
      throw new Error(
        `cannot delete kept worktree "${removedWorktreeId}": its stored folder is not a kept one`,
      );
    }
    await deleteKeptCopy(this.#putBackTools, keptFolder, canonicalRoot, removedWorktreeId);
  }

  // Deletes a kept copy for good, under its lock: the tree's old record when it is still the copy's
  // own, its folder and pins, then its row last, so a failure leaves a row a second `Delete now`
  // finishes.
  async #deleteKept(kept: RemovedWorktreeRow): Promise<void> {
    await this.#removeStaleRecord(kept);
    await this.#deleteKeptFolder(kept.id, kept.kept_path, await this.#pinRepositoryRoot(kept));
    await this.#writer.write([deleteRowStatement(kept.id)]);
    this.#staleRecordCheckedIds.delete(kept.id);
  }

  // Removes the tree's old record when it is still the copy's own, under the copy's lock.
  async #removeStaleRecord(kept: RemovedWorktreeRow): Promise<void> {
    await removeStaleTreeRecord(this.#putBackTools, kept.record_folder, kept.original_path);
  }

  // The repository the pins are in: the mount the tree was kept from, or the project's mount now
  // when it holds the same repository; `null` when neither is on disk, which leaves no pin.
  async #pinRepositoryRoot(kept: RemovedWorktreeRow): Promise<string | null> {
    const mounts = [
      this.#selectMountStmt.get({ mount_id: kept.mount_id }),
      this.#selectProjectMountStmt.get({ project_id: kept.project_id }),
    ];
    for (const mount of mounts) {
      if (
        mount !== undefined &&
        this.#isSameRepository(kept, mount) &&
        (await pathExists(mount.canonical_root))
      ) {
        return mount.canonical_root;
      }
    }
    return null;
  }
}

// The kept copy's row as the removed list shows it, which a put-back's copy and its undo draw on.
function putBackCopySubject(kept: RemovedWorktreeRow): WorktreeCopySubject {
  return {
    kind: "putting_back",
    removedWorktreeId: RemovedWorktreeIdSchema.parse(kept.id),
    projectId: ProjectIdSchema.parse(kept.project_id),
    name: kept.worktree_name,
  };
}

function markPutBackStatement(kept: RemovedWorktreeRow, mark: PutBackMark): WriteStatement {
  return {
    sql: MARK_PUT_BACK_SQL,
    bindings: {
      id: kept.id,
      read_restored_worktree_id: kept.restored_worktree_id,
      restoring_to: mark.targetFolder,
      restoring_record: mark.recordFolder,
      restoring_branch: mark.newBranch?.name ?? null,
      restoring_branch_commit: mark.newBranch?.commit ?? null,
    },
    expectedRowCount: 1,
  };
}

function clearPutBackMarkStatement(removedWorktreeId: string): WriteStatement {
  return {
    sql: CLEAR_PUT_BACK_MARK_SQL,
    bindings: { id: removedWorktreeId },
    expectedRowCount: 1,
  };
}

function deleteRowStatement(removedWorktreeId: string): WriteStatement {
  return {
    sql: "DELETE FROM removed_worktrees WHERE id = @id",
    bindings: { id: removedWorktreeId },
    expectedRowCount: 1,
  };
}
