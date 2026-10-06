// Worktree status-read projection: a pure fold with no filesystem, clock, database or other I/O.
// The caller reads the rows and the git figures; this module turns what it is handed into the
// `repo.worktreeStatusRead` response, so every branch can be driven from a test with no database.
//
// The read lists the trees still standing, so a `retired` row is left out rather than refused
// (a tree kept by a discard has its own removed-worktree list). Every other state is carried
// verbatim: `dirty` and `merged` are verdicts the transitioning service wrote, and nothing here
// infers cleanliness. The fold keeps the order it receives and never sorts; ordering is the
// caller's `ORDER BY`.

import {
  WorktreeStatusReadResponseSchema,
  type WorktreeStatusReadRequest,
  type WorktreeStatusReadResponse,
} from "@ai-sidekicks/contracts/worktree/worktree";

// --------------------------------------------------------------------------
// Inputs
// --------------------------------------------------------------------------

/**
 * The `worktrees` columns this projection reads, plus figures the caller reads beside each row.
 * Snake_case, as the DDL and `better-sqlite3` return it; the rename onto wire fields is the fold.
 * The figures after `updated_at` are not `worktrees` columns: the tree's name and base come from
 * where the tree records them, the counts from git against the latest background fetch, and the
 * occupancy from the sessions standing in the tree.
 */
export interface WorktreeStatusRow {
  /** `worktrees.id`, the wire's `worktreeId`. */
  readonly id: string;
  /** The project's folder the tree belongs to; must be the one the read names. */
  readonly repo_mount_id: string;
  readonly created_by_session_id: string;
  /** `NULL` for a tree prepared before any run. */
  readonly created_by_run_id: string | null;
  readonly branch_name: string;
  readonly fs_root: string;
  /**
   * Typed `string` rather than `WorktreeState` because a database row can carry a value the
   * compiler never saw; the parse at the end of the fold refuses it.
   */
  readonly state: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly name: string;
  readonly base_branch_name: string;
  /** Commits ahead of the branch's upstream; `null` when it has none. */
  readonly ahead: number | null;
  /** Commits behind the branch's upstream; `null` when it has none. */
  readonly behind: number | null;
  readonly uncommitted_file_count: number;
  readonly unpushed_commit_count: number;
  readonly occupying_session_ids: readonly string[];
  /** The session whose agent is running in the tree, if one is. */
  readonly running_session_id: string | null;
}

/** One read's worth of input: the project's root checkout and its trees. */
export interface WorktreeStatusReading {
  readonly repoRoot: { readonly path: string; readonly branchName: string };
  readonly worktrees: readonly WorktreeStatusRow[];
  /** When the ahead and behind figures were last true, when the last fetch failed. */
  readonly countsAsOf: string | null;
  /** The new-worktree form's suggestion, when the read named the asking session. */
  readonly newWorktree: {
    readonly fixedPart: string;
    readonly suggestedTail: string;
    readonly folderBefore: string;
  } | null;
}

// --------------------------------------------------------------------------
// Drafts
// --------------------------------------------------------------------------
//
// The fold's unbranded output. `WorktreeStatusReadResponseSchema.parse` brands it, so this file
// carries no `as` cast.

interface WorktreeStatusRecordDraft {
  readonly worktreeId: string;
  readonly repoMountId: string;
  readonly name: string;
  readonly branchName: string;
  readonly baseBranchName: string;
  readonly fsRoot: string;
  readonly state: string;
  readonly ahead?: number;
  readonly behind?: number;
  readonly uncommittedFileCount: number;
  readonly unpushedCommitCount: number;
  readonly occupyingSessionIds: readonly string[];
  readonly runningSessionId: string | null;
  readonly createdBySessionId: string;
  readonly createdByRunId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface WorktreeStatusReadResponseDraft {
  readonly repoRoot: { readonly path: string; readonly branchName: string };
  readonly worktrees: readonly WorktreeStatusRecordDraft[];
  readonly countsAsOf?: string;
  readonly newWorktree?: {
    readonly fixedPart: string;
    readonly suggestedTail: string;
    readonly folderBefore: string;
  };
}

// The draft restates the record shape unbranded, so nothing structural ties it to the contract: a
// required field added there would compile here and fail only at runtime. This key-name pin
// closes that gap; the item-level `.strict()` refuses a draft key the contract lacks.
type _AssertExtends<A extends B, B> = A;
type _AssertDraftCoversWorktreeRecord = _AssertExtends<
  keyof WorktreeStatusReadResponse["worktrees"][number],
  keyof WorktreeStatusRecordDraft
>;

// --------------------------------------------------------------------------
// The fold
// --------------------------------------------------------------------------

/**
 * Folds one project's worktree rows and figures onto the `repo.worktreeStatusRead` response.
 * Throws when a row belongs to a different repo mount than the request names, and leaves out
 * `retired` rows.
 */
export function projectWorktreeStatusRead(
  request: WorktreeStatusReadRequest,
  reading: WorktreeStatusReading,
): WorktreeStatusReadResponse {
  const worktrees: WorktreeStatusRecordDraft[] = [];
  for (const row of reading.worktrees) {
    assertRowBelongsToReadFolder(row.repo_mount_id, request.repoMountId, row.id);
    if (row.state === "retired") {
      continue;
    }
    // Field by field, never a spread: the record schema is strict, so a stray column would fail
    // the whole read.
    worktrees.push({
      worktreeId: row.id,
      repoMountId: row.repo_mount_id,
      name: row.name,
      branchName: row.branch_name,
      baseBranchName: row.base_branch_name,
      fsRoot: row.fs_root,
      state: row.state,
      // Omitted, never `undefined`, and tested by positive membership: a figure the caller forgot
      // arrives `undefined`, and a `=== null` test would ship it as a present key with no value.
      ...(typeof row.ahead === "number" ? { ahead: row.ahead } : {}),
      ...(typeof row.behind === "number" ? { behind: row.behind } : {}),
      uncommittedFileCount: row.uncommitted_file_count,
      unpushedCommitCount: row.unpushed_commit_count,
      occupyingSessionIds: row.occupying_session_ids,
      runningSessionId: row.running_session_id,
      createdBySessionId: row.created_by_session_id,
      ...(typeof row.created_by_run_id === "string"
        ? { createdByRunId: row.created_by_run_id }
        : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  return parseProjection({
    repoRoot: reading.repoRoot,
    worktrees,
    ...(reading.countsAsOf === null ? {} : { countsAsOf: reading.countsAsOf }),
    ...(reading.newWorktree === null ? {} : { newWorktree: reading.newWorktree }),
  });
}

// --------------------------------------------------------------------------
// Guards
// --------------------------------------------------------------------------

/**
 * Throws on a row from another repo mount. Filtering it out would hide the caller's mispaired
 * query, and listing it would attribute another project's trees to this one.
 */
function assertRowBelongsToReadFolder(
  rowRepoMountId: string,
  readRepoMountId: string,
  rowId: string,
): void {
  if (rowRepoMountId === readRepoMountId) {
    return;
  }
  throw new Error(
    "Worktree status-read projection refused a worktree row on a different project folder " +
      `than the one being read: row "${rowId}". Projecting it would list another project's ` +
      "worktrees, and no screen could detect it.",
  );
}

/**
 * Validates the folded response through the contract's schema so a row that cannot be projected
 * fails here rather than at the outbound response check. The `ZodError` rides as `cause`; its
 * issue path names the array, the record index and the field.
 */
function parseProjection(draft: WorktreeStatusReadResponseDraft): WorktreeStatusReadResponse {
  try {
    return WorktreeStatusReadResponseSchema.parse(draft);
  } catch (error) {
    throw new Error(
      "Worktree status-read projection produced a value the WorktreeStatusReadResponse shape " +
        "refuses. A row that cannot be projected fails the read at the projection that " +
        "produced it; the cause names the array, the record index, and the field.",
      { cause: error },
    );
  }
}
