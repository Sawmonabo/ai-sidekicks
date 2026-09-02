// What an execution root IS, read off the wire and turned into something a card
// can draw — and nothing else. No React, no fetching, no eligibility.
//
// `Spec-023 §Console Design (Meridian)` §10.3's job for this surface: "Show what
// execution roots exist on disk for this session, which run holds one, and what is
// safe to reclaim." Two of those three are decisions, and both are made here so a
// card never makes them twice:
//
//   1. WHICH SUB-STATE A ROW IS IN. `state` is one wire string and the row's real
//      disposition needs two fields: a `retired` worktree with no `cleanedAt` is a
//      retired RECORD whose files are still on disk, which the design calls out as
//      a distinct sub-state. `worktreeDiskDisposition` is the only place that
//      pairing is read.
//   2. WHETHER A CLONE IS PAST ITS DISPOSAL TIME. A comparison against the caller's
//      instant, never a timer — the design forbids polling on this surface, so the
//      caller supplies `now` and the reading is a pure function of it.
//
// THE STATE VOCABULARIES ARE THE CONTRACT'S, IMPORTED AND NEVER RESTATED.
// `WorktreeState` (six) and `EphemeralCloneState` (four) live in
// `packages/contracts/src/worktree.ts`; the tables below are `Record`s keyed BY
// those unions, so a seventh state added to the wire fails to compile here rather
// than rendering as an unstyled string.
//
// WHY THE RECORD TYPES ARE SPELLED WITH AN INDEXED ACCESS. The contract exports no
// named item type for either array — it says so, and tells consumers to spell
// `WorktreeStatusReadResponse["worktrees"][number]`. These aliases are that
// spelling, done once.
//
// NEVER, from the same section, and each is a property of THIS file:
//   • No sixth worktree event. Only five worktree event strings are registered, and
//     `failed` arrives through a status re-read; nothing here waits for a frame.
//   • No derived branch name and no derived checkout root. Both are wire strings on
//     the record, rendered, never computed — which is why every column value below
//     comes back as the wire's own string or as absent.
//   • No snapshot refs. Turn-boundary snapshots land under `refs/sidekicks/...` and
//     never on `refs/heads/`, so a branch column can only ever hold a branch.

import type {
  EphemeralCloneState,
  WorktreeState,
  WorktreeStatusReadResponse,
} from "@ai-sidekicks/contracts";

import type { ChipTone } from "../primitives/index.js";

/** One worktree row of `repo.worktreeStatusRead`. */
export type WorktreeStatusRecord = WorktreeStatusReadResponse["worktrees"][number];

/** One ephemeral-clone row of the same read. Nine columns, and no `updatedAt`. */
export type EphemeralCloneStatusRecord = WorktreeStatusReadResponse["ephemeralClones"][number];

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

/** What a state name means and how loudly it reads. The name itself is the wire's. */
export interface RootStatePresentation {
  /**
   * The chip's tone. Amber means a person is needed, red means something failed,
   * and everything else is neutral — the console's whole colour vocabulary, so a
   * state that is merely uninteresting never borrows the accent to look busy.
   */
  readonly tone: ChipTone;
  /** One sentence saying what the daemon means by this state. Never the state name reworded. */
  readonly meaning: string;
}

/**
 * The six worktree states, total over `WorktreeState` by construction. `failed` says
 * where it comes from, because there is no `worktree.failed` event to wait for.
 */
export const WORKTREE_STATE_PRESENTATION: Readonly<Record<WorktreeState, RootStatePresentation>> = {
  creating: {
    tone: "neutral",
    meaning: "The daemon is provisioning this checkout.",
  },
  ready: {
    tone: "neutral",
    meaning: "The checkout exists and a run may bind it.",
  },
  dirty: {
    tone: "attention",
    meaning: "Uncommitted work is present in this checkout.",
  },
  merged: {
    tone: "neutral",
    meaning: "This checkout's branch has been merged.",
  },
  retired: {
    tone: "neutral",
    meaning: "The record is retired. The daemon will not bind this checkout again.",
  },
  failed: {
    tone: "failure",
    meaning:
      "Provisioning failed. This state is not separately evented; it arrives on a status re-read.",
  },
};

/** The four clone states. Total over `EphemeralCloneState` by construction. */
export const EPHEMERAL_CLONE_STATE_PRESENTATION: Readonly<
  Record<EphemeralCloneState, RootStatePresentation>
> = {
  creating: {
    tone: "neutral",
    meaning: "The daemon is provisioning this clone.",
  },
  ready: {
    tone: "neutral",
    meaning: "The clone exists and a run may bind it.",
  },
  retired: {
    tone: "neutral",
    meaning: "The record is retired. The daemon will not bind this clone again.",
  },
  failed: {
    tone: "failure",
    meaning:
      "Provisioning failed. Clone transitions are not separately evented; this arrives on a status re-read.",
  },
};

/**
 * Where a worktree's FILES are, which is a different question from what its RECORD
 * says. Closed at three, and the middle member is the one the design names:
 * retirement records a decision and a later sweep removes the checkout, so between
 * them a row is retired with its files still on disk. Collapsing that into `retired`
 * would tell an operator the disk is free when it is not.
 */
export const WORKTREE_DISK_DISPOSITIONS = ["live", "retired-on-disk", "reclaimed"] as const;

/** One disk disposition. Derived, so the vocabulary is declared exactly once. */
export type WorktreeDiskDisposition = (typeof WORKTREE_DISK_DISPOSITIONS)[number];

/**
 * Read a row's disk disposition off the two fields that decide it. `cleanedAt` is
 * checked FIRST and independently of `state`: the stamp means the sweep ran, whatever
 * the state says, and reading `state` first would report an already-swept `failed`
 * row as still occupying disk.
 */
export function worktreeDiskDisposition(record: WorktreeStatusRecord): WorktreeDiskDisposition {
  if (record.cleanedAt !== undefined) {
    return "reclaimed";
  }
  return record.state === "retired" ? "retired-on-disk" : "live";
}

/**
 * What each disposition says out loud.
 *
 * `live` deliberately claims nothing about the filesystem beyond the absence of a
 * cleanup stamp — the daemon owns that root and the console has not looked at it.
 */
export const WORKTREE_DISK_DISPOSITION_COPY: Readonly<Record<WorktreeDiskDisposition, string>> = {
  live: "No cleanup stamp on this record; the daemon still owns this root.",
  "retired-on-disk":
    "Retired, and the files are still on disk. The record keeps its provenance; a later sweep removes the checkout.",
  reclaimed: "The checkout has been removed from disk. The record and its provenance stay.",
};

/**
 * Whether a clone has reached its disposal time.
 *
 * Two readings, not three: the design calls a clone past `expiresAt` degraded and
 * says nothing about one approaching it, and a "soon" band would need a threshold
 * whose only justification would be that it felt right.
 */
export const CLONE_EXPIRY_READINGS = ["scheduled", "elapsed"] as const;

/** One expiry reading. Derived, so the vocabulary is declared exactly once. */
export type CloneExpiryReading = (typeof CLONE_EXPIRY_READINGS)[number];

/**
 * Classify a clone's disposal time against the caller's instant.
 *
 * A pure function of `nowMilliseconds` rather than of the wall clock, which is the
 * no-polling rule made structural: nothing here can schedule a re-render, so a
 * countdown moves when the surface above re-reads and at no other time. An
 * unparseable stamp reads `scheduled` — the fail-safe direction, since the loud arm
 * says the snapshot refs may already be gone and asserting that off a timestamp the
 * console could not read would be the console inventing the fact.
 */
export function cloneExpiryReading(
  record: EphemeralCloneStatusRecord,
  nowMilliseconds: number,
): CloneExpiryReading {
  const expiresAtMilliseconds = Date.parse(record.expiresAt);
  if (Number.isNaN(expiresAtMilliseconds)) {
    return "scheduled";
  }
  return expiresAtMilliseconds <= nowMilliseconds ? "elapsed" : "scheduled";
}

/**
 * What each reading says, and the consequence it exists to state.
 *
 * Both arms name what disposal takes with it, because the design's reason for
 * putting a countdown on the row at all is that disposal takes that clone's
 * snapshot refs — a row that showed a time and not a consequence would be a clock.
 */
export const CLONE_EXPIRY_COPY: Readonly<Record<CloneExpiryReading, string>> = {
  scheduled: "Disposal takes this clone's snapshot refs with it.",
  elapsed:
    "Past its disposal time. Disposal takes this clone's snapshot refs with it; they may already be gone.",
};

/** The tone each reading carries. Elapsed is amber: it is a person's to act on. */
export const CLONE_EXPIRY_TONE: Readonly<Record<CloneExpiryReading, ChipTone>> = {
  scheduled: "neutral",
  elapsed: "attention",
};

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
 * What the card shows without being asked. §10.3 §Density: "Each list shows state,
 * branch, root, and age." Age is `createdAt` read relatively, so the column is
 * `createdAt` and the reading is the card's.
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
