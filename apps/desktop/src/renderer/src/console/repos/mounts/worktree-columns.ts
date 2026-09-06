// Which columns a worktree or clone row has, what each is called, and what a card
// draws where the wire sent nothing.
//
// A MODULE BESIDE THE MODEL, not a second model. `worktree-model.ts` answers what a
// root IS — its sub-state on disk, whether a clone is past its disposal time — and
// this answers how a row is TABULATED: the column key sets, the labels, the summary
// and detail selections, and the sentence that renders in an absent cell. The two
// were one file and the file was doing both jobs; a reader looking for the reason a
// cell reads "Not swept." had to scroll past the disk-disposition pairing to find it.
//
// THE ABSENCE COPY IS TOTAL OVER EXACTLY THE OPTIONAL COLUMNS, which is the property
// that makes it worth its own home: `OptionalColumnKey` derives that set from the
// contract, so a column that becomes optional fails to compile here until somebody
// writes the sentence that renders in its place, and one that stops being optional
// makes its now-unreachable sentence an error too.
//
// NO DERIVED VALUES, on the model's own terms: every cell below comes back as the
// wire's own string or as absent. Nothing here computes a branch name or a checkout
// root.

import type { EphemeralCloneStatusRecord, WorktreeStatusRecord } from "./worktree-model.js";

/** Every column of a worktree row, as the wire names it. */
export type WorktreeColumnKey = keyof WorktreeStatusRecord;

/** Every column of a clone row, as the wire names it. */
export type EphemeralCloneColumnKey = keyof EphemeralCloneStatusRecord;

/**
 * The keys a record may legally omit.
 *
 * Derived rather than listed, so the absence copy below is total over exactly the
 * optional columns: a column that becomes optional gains a compile error here until
 * somebody writes the sentence that renders in its place, and one that stops being
 * optional makes its now-unreachable sentence an error too.
 */
type OptionalColumnKey<TRecord> = {
  [Key in keyof TRecord]-?: object extends Pick<TRecord, Key> ? Key : never;
}[keyof TRecord];

/**
 * Every worktree column's label. Total over the record's keys by construction, so a
 * column added to the wire cannot reach a card without a label.
 */
export const WORKTREE_COLUMN_LABELS: Readonly<Record<WorktreeColumnKey, string>> = {
  worktreeId: "Worktree id",
  repoMountId: "Repo mount",
  branchName: "Branch",
  fsRoot: "Checkout root",
  state: "State",
  createdBySessionId: "Created by session",
  createdByRunId: "Created by run",
  createdAt: "Created",
  updatedAt: "Updated",
  cleanedAt: "Files removed",
};

/** Every clone column's label. Total over that record's keys for the same reason. */
export const EPHEMERAL_CLONE_COLUMN_LABELS: Readonly<Record<EphemeralCloneColumnKey, string>> = {
  cloneId: "Clone id",
  workspaceId: "Workspace",
  cloneRoot: "Clone root",
  branchName: "Branch",
  state: "State",
  cleanupPolicy: "Cleanup policy",
  expiresAt: "Disposal due",
  createdAt: "Created",
  cleanedAt: "Files removed",
};

/**
 * What the card shows without being asked. `WorktreeCard.tsx` owns the density rule —
 * each list shows state, branch, root, and age. Age is `createdAt` read relatively, so
 * the column is `createdAt` and the reading is the card's.
 */
export const WORKTREE_SUMMARY_COLUMNS: readonly WorktreeColumnKey[] = [
  "state",
  "branchName",
  "fsRoot",
  "createdAt",
];

/** The rest, behind the row disclosure: provenance and cleanup. */
export const WORKTREE_DETAIL_COLUMNS: readonly WorktreeColumnKey[] = [
  "worktreeId",
  "repoMountId",
  "createdBySessionId",
  "createdByRunId",
  "updatedAt",
  "cleanedAt",
];

/**
 * The clone summary, one column longer than the worktree's. `expiresAt` joins it
 * because the design puts the countdown on the row rather than behind the
 * disclosure: disposal is the one thing here that changes with nobody acting, and
 * that is exactly the fact that must not be one click away.
 */
export const EPHEMERAL_CLONE_SUMMARY_COLUMNS: readonly EphemeralCloneColumnKey[] = [
  "state",
  "branchName",
  "cloneRoot",
  "createdAt",
  "expiresAt",
];

/** The rest of the clone row, behind its disclosure. */
export const EPHEMERAL_CLONE_DETAIL_COLUMNS: readonly EphemeralCloneColumnKey[] = [
  "cloneId",
  "workspaceId",
  "cleanupPolicy",
  "cleanedAt",
];

/** One sentence for one sweep: both record kinds carry `cleanedAt` and both read it. */
const CLEANUP_STAMP_ABSENT_COPY = "Not swept.";

/**
 * What an omitted worktree column MEANS, per column.
 *
 * Total over the optional keys and no wider. Both sentences describe a real state
 * of the world rather than a gap in the console's knowledge: a worktree prepared
 * before any run has no run to attribute, and a row with no cleanup stamp has not
 * been swept. Rendering either as "unknown" would be the console reporting its own
 * ignorance in place of the daemon's answer.
 */
export const WORKTREE_ABSENT_COLUMN_COPY: Readonly<
  Record<OptionalColumnKey<WorktreeStatusRecord>, string>
> = {
  createdByRunId: "No run — this root was prepared explicitly.",
  cleanedAt: CLEANUP_STAMP_ABSENT_COPY,
};

/** The same, for the one clone column the wire may omit. */
export const EPHEMERAL_CLONE_ABSENT_COLUMN_COPY: Readonly<
  Record<OptionalColumnKey<EphemeralCloneStatusRecord>, string>
> = {
  cleanedAt: CLEANUP_STAMP_ABSENT_COPY,
};

/**
 * One column, ready to draw: the wire's own string, or the sentence that stands in
 * for its absence.
 *
 * A discriminated cell rather than `string | undefined` because the two arms render
 * differently and the difference is the point — an omitted column is a fact about
 * the world (no run to attribute, no sweep yet) and rendering it as an empty cell
 * would report the console's silence as the daemon's.
 */
export type ColumnCell =
  | { readonly kind: "value"; readonly value: string }
  | { readonly kind: "absent"; readonly copy: string };

/**
 * What an absent column says when the wire omitted one it declares REQUIRED.
 *
 * Not a dead branch: the console holds these rows as typed values, and a payload
 * that reached it without passing the response schema can carry a hole the type
 * says cannot exist. Saying so is better than rendering `undefined` or throwing
 * inside a list row.
 */
export const COLUMN_ABSENT_FALLBACK = "The daemon sent no value for this column.";

/**
 * The optional-keyed copy tables, widened to a lookup over every column. Assignment
 * and not a cast: a record keyed by a subset of the columns IS a partial record over
 * all of them, so the exported tables keep their totality over exactly the optional
 * keys while the accessors below get something indexable.
 */
const WORKTREE_ABSENT_COPY_BY_COLUMN: Readonly<Partial<Record<WorktreeColumnKey, string>>> =
  WORKTREE_ABSENT_COLUMN_COPY;

const EPHEMERAL_CLONE_ABSENT_COPY_BY_COLUMN: Readonly<
  Partial<Record<EphemeralCloneColumnKey, string>>
> = EPHEMERAL_CLONE_ABSENT_COLUMN_COPY;

/**
 * One worktree column, as a cell.
 *
 * Every column on both records is a string on the wire — branded ids included — so
 * the accessor is total and needs no per-column branch. It exists so a card can
 * iterate a column list instead of writing ten property reads, which is what keeps
 * the "columns verbatim" claim checkable: the list is data a test holds against the
 * labels table.
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

/** The same accessor for a clone row. */
export function ephemeralCloneColumnCell(
  record: EphemeralCloneStatusRecord,
  column: EphemeralCloneColumnKey,
): ColumnCell {
  const value = record[column];
  if (value !== undefined) {
    return { kind: "value", value };
  }
  return {
    kind: "absent",
    copy: EPHEMERAL_CLONE_ABSENT_COPY_BY_COLUMN[column] ?? COLUMN_ABSENT_FALLBACK,
  };
}
