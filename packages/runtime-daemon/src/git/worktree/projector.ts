// Worktree status-read projection: a pure fold with no filesystem, clock, database or other I/O.
// The caller reads git's list of trees, the daemon's records and the figures; this module turns
// what it is handed into the `repo.worktreeStatusRead` response, so every branch can be driven
// from a test with no database.
//
// The read lists the trees still standing, so a `retired` record is left out rather than refused
// (a tree kept by a discard has its own removed-worktree list). Every other state is carried
// verbatim: `dirty` and `merged` are verdicts the transitioning service wrote, and nothing here
// infers cleanliness. The fold keeps the order it receives and never sorts.

import {
  WorktreeStatusReadResponseSchema,
  type WorktreeStatusReadResponse,
} from "@ai-sidekicks/contracts/worktree/lifecycle";

// --------------------------------------------------------------------------
// Inputs
// --------------------------------------------------------------------------

/**
 * The `worktrees` columns a tree this daemon made contributes, and the base its branch context
 * recorded. Snake_case, as the DDL and `better-sqlite3` return it; the rename onto wire fields is
 * the fold.
 */
export interface WorktreeRecordRow {
  /** `worktrees.id`, the wire's `worktreeId`. */
  readonly id: string;
  /** The project's mount the tree belongs to; must be the one the reading names. */
  readonly repo_mount_id: string;
  readonly created_by_session_id: string;
  /** `NULL` for a tree prepared before any run. */
  readonly created_by_run_id: string | null;
  /**
   * Typed `string` rather than `WorktreeState` because a database row can carry a value the
   * compiler never saw; the parse at the end of the fold refuses it.
   */
  readonly state: string;
  readonly created_at: string;
  readonly updated_at: string;
  /** The base the tree was cut off, from its first branch context; `null` when none recorded it. */
  readonly base_branch_name: string | null;
}

/** One tree's row: where it is, what it is on, its figures, and its record when the app made it. */
export interface WorktreeStatusRow {
  readonly path: string;
  readonly name: string;
  readonly branchName: string;
  /** Commits ahead of the branch's upstream; `null` when it has none. */
  readonly ahead: number | null;
  /** Commits behind the branch's upstream; `null` when it has none. */
  readonly behind: number | null;
  readonly uncommittedFileCount: number;
  readonly unpushedCommitCount: number;
  readonly occupyingSessionIds: readonly string[];
  /** The session whose agent is running in the tree, if one is. */
  readonly runningSessionId: string | null;
  /** The daemon's record of a tree it made; `null` for one the person made. */
  readonly record: WorktreeRecordRow | null;
}

/** One read's worth of input: the project's mount, its own checkout and its trees. */
export interface WorktreeStatusReading {
  /** The mount the read resolved the project to; every record must belong to it. */
  readonly repoMountId: string;
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

interface WorktreeStatusFiguresDraft {
  readonly path: string;
  readonly name: string;
  readonly branchName: string;
  readonly ahead?: number;
  readonly behind?: number;
  readonly uncommittedFileCount: number;
  readonly unpushedCommitCount: number;
  readonly occupyingSessionIds: readonly string[];
  readonly runningSessionId: string | null;
}

interface AppMadeWorktreeDraft extends WorktreeStatusFiguresDraft {
  readonly madeBy: "app";
  readonly worktreeId: string;
  readonly repoMountId: string;
  readonly baseBranchName: string;
  readonly state: string;
  readonly createdBySessionId: string;
  readonly createdByRunId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface PersonMadeWorktreeDraft extends WorktreeStatusFiguresDraft {
  readonly madeBy: "person";
}

interface WorktreeStatusReadResponseDraft {
  readonly repoRoot: { readonly path: string; readonly branchName: string };
  readonly worktrees: readonly (AppMadeWorktreeDraft | PersonMadeWorktreeDraft)[];
  readonly countsAsOf?: string;
  readonly newWorktree?: {
    readonly fixedPart: string;
    readonly suggestedTail: string;
    readonly folderBefore: string;
  };
}

// The drafts restate each record arm unbranded, so nothing structural ties them to the contract:
// a required field added there would compile here and fail only at runtime. These key-name pins
// close that gap; each arm's `.strict()` refuses a draft key the contract lacks.
type _AssertExtends<A extends B, B> = A;
type WorktreeStatusRecord = WorktreeStatusReadResponse["worktrees"][number];
type _AssertDraftCoversAppMadeRecord = _AssertExtends<
  keyof Extract<WorktreeStatusRecord, { madeBy: "app" }>,
  keyof AppMadeWorktreeDraft
>;
type _AssertDraftCoversPersonMadeRecord = _AssertExtends<
  keyof Extract<WorktreeStatusRecord, { madeBy: "person" }>,
  keyof PersonMadeWorktreeDraft
>;

// --------------------------------------------------------------------------
// The fold
// --------------------------------------------------------------------------

/**
 * Folds one project's trees onto the `repo.worktreeStatusRead` response. Throws when a record
 * belongs to another mount than the reading names or recorded no base, and leaves out `retired`
 * records.
 */
export function projectWorktreeStatusRead(
  reading: WorktreeStatusReading,
): WorktreeStatusReadResponse {
  const worktrees: (AppMadeWorktreeDraft | PersonMadeWorktreeDraft)[] = [];
  for (const row of reading.worktrees) {
    // Field by field, never a spread: each record arm is strict, so a stray key would fail the
    // whole read.
    const figures: WorktreeStatusFiguresDraft = {
      path: row.path,
      name: row.name,
      branchName: row.branchName,
      // Omitted, never `undefined`, and tested by positive membership: a figure the caller forgot
      // arrives `undefined`, and a `=== null` test would ship it as a present key with no value.
      ...(typeof row.ahead === "number" ? { ahead: row.ahead } : {}),
      ...(typeof row.behind === "number" ? { behind: row.behind } : {}),
      uncommittedFileCount: row.uncommittedFileCount,
      unpushedCommitCount: row.unpushedCommitCount,
      occupyingSessionIds: row.occupyingSessionIds,
      runningSessionId: row.runningSessionId,
    };
    const record = row.record;
    if (record === null) {
      worktrees.push({ ...figures, madeBy: "person" });
      continue;
    }
    assertRecordBelongsToReadMount(record, reading.repoMountId);
    if (record.state === "retired") {
      continue;
    }
    worktrees.push({
      ...figures,
      madeBy: "app",
      worktreeId: record.id,
      repoMountId: record.repo_mount_id,
      baseBranchName: requireRecordedBase(record),
      state: record.state,
      createdBySessionId: record.created_by_session_id,
      ...(typeof record.created_by_run_id === "string"
        ? { createdByRunId: record.created_by_run_id }
        : {}),
      createdAt: record.created_at,
      updatedAt: record.updated_at,
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
 * Throws on a record from another mount. Filtering it out would hide the caller's mispaired
 * query, and listing it would attribute another project's trees to this one.
 */
function assertRecordBelongsToReadMount(record: WorktreeRecordRow, readRepoMountId: string): void {
  if (record.repo_mount_id === readRepoMountId) {
    return;
  }
  throw new Error(
    "Worktree status-read projection refused a worktree record on a different project mount " +
      `than the one being read: record "${record.id}". Projecting it would list another ` +
      "project's worktrees, and no screen could detect it.",
  );
}

// A row names the base it was cut off; a record whose base was never recorded has no true value
// to show, so the read fails rather than inventing one.
function requireRecordedBase(record: WorktreeRecordRow): string {
  if (record.base_branch_name !== null) {
    return record.base_branch_name;
  }
  throw new Error(
    `Worktree status-read projection found no recorded base for worktree "${record.id}", so ` +
      "its row cannot name the branch it was cut off.",
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
