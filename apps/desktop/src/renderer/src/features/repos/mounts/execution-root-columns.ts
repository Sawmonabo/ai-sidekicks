// Which columns a worktree row has, what each is called, and what a card draws where the wire
// sent nothing. Every cell is the wire's own string or absent, never derived. The absence copy
// is total over exactly the optional columns (`OptionalColumnKey`), so a column that becomes
// optional or stops being optional fails to compile until its sentence is written or removed.

import type { WorktreeStatusRecord } from "@ai-sidekicks/contracts";

/**
 * Every text column of a worktree row, as the wire names it: the members whose value is
 * a string, optional ones included. The figures and the occupancy lists are not columns
 * this card tabulates.
 */
export type WorktreeColumnKey = {
  [Key in keyof WorktreeStatusRecord]-?: WorktreeStatusRecord[Key] extends string | undefined
    ? Key
    : never;
}[keyof WorktreeStatusRecord];

/** The keys a record may legally omit, derived so the absence copy stays total over them. */
type OptionalColumnKey<TRecord> = {
  [Key in keyof TRecord]-?: object extends Pick<TRecord, Key> ? Key : never;
}[keyof TRecord];

/** Every worktree column's label; total over the text columns, so none reaches a card unlabeled. */
export const WORKTREE_COLUMN_LABELS: Readonly<Record<WorktreeColumnKey, string>> = {
  worktreeId: "Worktree id",
  repoMountId: "Repo mount",
  name: "Name",
  branchName: "Branch",
  baseBranchName: "Base",
  fsRoot: "Checkout root",
  state: "State",
  createdBySessionId: "Created by session",
  createdByRunId: "Created by run",
  createdAt: "Created",
  updatedAt: "Updated",
};

/**
 * What the card shows without being asked: state, branch, root, and age. Age is `createdAt`
 * read relatively, so the column is `createdAt` and the reading is the card's.
 */
export const WORKTREE_SUMMARY_COLUMNS: readonly WorktreeColumnKey[] = [
  "state",
  "branchName",
  "fsRoot",
  "createdAt",
];

/** The rest, behind the row disclosure: the tree's name, its base and its provenance. */
export const WORKTREE_DETAIL_COLUMNS: readonly WorktreeColumnKey[] = [
  "name",
  "baseBranchName",
  "worktreeId",
  "repoMountId",
  "createdBySessionId",
  "createdByRunId",
  "updatedAt",
];

/**
 * What an omitted worktree column means, per column. Total over the optional text columns and
 * no wider. It states a real fact (a root prepared before any run has no run to attribute),
 * not "unknown".
 */
export const WORKTREE_ABSENT_COLUMN_COPY: Readonly<
  Record<OptionalColumnKey<Pick<WorktreeStatusRecord, WorktreeColumnKey>>, string>
> = {
  createdByRunId: "No run — this root was prepared explicitly.",
};

/**
 * One column, ready to draw: the wire's own string, or the sentence standing in for its
 * absence. Two arms because an omitted column is a fact about the world, and an empty cell
 * would report the console's silence as the daemon's.
 */
export type ColumnCell =
  | { readonly kind: "value"; readonly value: string }
  | { readonly kind: "absent"; readonly copy: string };

/**
 * What an absent column says when the wire omitted one it declares required. A payload that
 * skipped the response schema can carry such a hole; saying so beats rendering `undefined`.
 */
export const COLUMN_ABSENT_FALLBACK = "The background service sent no value for this column.";

/** The optional-keyed copy table widened to a lookup over every column (assignment, no cast). */
const WORKTREE_ABSENT_COPY_BY_COLUMN: Readonly<Partial<Record<WorktreeColumnKey, string>>> =
  WORKTREE_ABSENT_COLUMN_COPY;

/**
 * One worktree column as a cell. Every column is a string on the wire, so the accessor needs no
 * per-column branch and a card can iterate a column list.
 */
export function worktreeColumnCell(
  record: WorktreeStatusRecord,
  column: WorktreeColumnKey,
): ColumnCell {
  const value = record[column];
  if (value !== undefined) {
    return { kind: "value", value };
  }
  return { kind: "absent", copy: WORKTREE_ABSENT_COPY_BY_COLUMN[column] ?? COLUMN_ABSENT_FALLBACK };
}
