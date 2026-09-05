// What an execution root IS, read off the wire and turned into something a card
// can draw — and nothing else. No React, no fetching, no eligibility.
//
// THIS SURFACE'S JOB, stated here because `Spec-023 §Console Design (Meridian)` puts a
// surface's composition in the console's code: show what
// execution roots exist on disk for this session, which run holds one, and what is
// safe to reclaim. Two of those three are decisions, and both are made here so a
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
// HOW A ROW IS TABULATED IS NEXT DOOR. The column key sets, the labels, the summary
// and detail selections, and the absent-cell copy are `worktree-columns.ts`: that is
// how a root is DRAWN, and this file is what a root IS.
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
//     the record, rendered, never computed — which is why every column value in
//     `worktree-columns.ts` comes back as the wire's own string or as absent.
//   • No snapshot refs. Turn-boundary snapshots land under `refs/sidekicks/...` and
//     never on `refs/heads/`, so a branch column can only ever hold a branch.

import type {
  EphemeralCloneState,
  WorktreeState,
  WorktreeStatusReadResponse,
} from "@ai-sidekicks/contracts";

import { parseInstant } from "../../core/index.js";
import type { ChipTone } from "../../primitives/index.js";

/** One worktree row of `repo.worktreeStatusRead`. */
export type WorktreeStatusRecord = WorktreeStatusReadResponse["worktrees"][number];

/** One ephemeral-clone row of the same read. Nine columns, and no `updatedAt`. */
export type EphemeralCloneStatusRecord = WorktreeStatusReadResponse["ephemeralClones"][number];

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
 * What a clone's disposal actually is: still ahead, past due, or already done.
 *
 * THREE READINGS, AND THE THIRD IS A DIFFERENT KIND OF FACT. `scheduled` and
 * `elapsed` are both derived from a DEADLINE against the caller's instant, and there
 * is deliberately no fourth band between them: the design calls a clone past
 * `expiresAt` degraded and says nothing about one approaching it, and a "soon" band
 * would need a threshold whose only justification would be that it felt right.
 * `reclaimed` is not a band on that scale at all — it is the sweep's own stamp,
 * `WorktreeStatusReadResponse.ephemeralClones[].cleanedAt`, registered in
 * `api-payload-contracts.md` §Plan-010 as the "async disk-cleanup stamp; absent until
 * the sweep runs". A row carrying one has had its files removed, whatever the
 * deadline says about when they were due to be.
 */
export const CLONE_EXPIRY_READINGS = ["scheduled", "elapsed", "reclaimed"] as const;

/** One expiry reading. Derived, so the vocabulary is declared exactly once. */
export type CloneExpiryReading = (typeof CLONE_EXPIRY_READINGS)[number];

/**
 * Classify a clone's disposal against the sweep's stamp, then against the instant.
 *
 * `cleanedAt` IS READ FIRST AND INDEPENDENTLY OF THE DEADLINE, exactly as
 * `worktreeDiskDisposition` reads it one screen above: the stamp means the sweep ran,
 * and the deadline it ran before or after says nothing about that. Reading the
 * deadline first reported a swept clone with time left as awaiting disposal, and a
 * swept one past its time as files that "may" already be gone — hedging about a fact
 * the record establishes.
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
  const expiresAtMilliseconds = cloneExpiryAtMs(record);
  if (expiresAtMilliseconds === undefined) {
    return record.cleanedAt === undefined ? "scheduled" : "reclaimed";
  }
  return expiresAtMilliseconds <= nowMilliseconds ? "elapsed" : "scheduled";
}

/**
 * The instant this clone's disposal is due, or `undefined` where there is none to count
 * towards.
 *
 * THE ONE PLACE `expiresAt` IS PARSED, and it is exported because two callers need the
 * same answer: the reading above asks whether the deadline has passed, and the section's
 * wake-up asks when the earliest one will. Two parses would be two chances for a card
 * that says a clone is still scheduled to sit under a timer that already fired.
 *
 * ABSENT ON BOTH ARMS THAT HAVE NOTHING TO COUNT: a swept row, whose files are gone
 * whatever the deadline said, and an unparseable stamp, which the reading takes as
 * `scheduled` on the fail-safe direction stated above and which nothing can be woken
 * for.
 */
export function cloneExpiryAtMs(record: EphemeralCloneStatusRecord): number | undefined {
  if (record.cleanedAt !== undefined) {
    return undefined;
  }
  const reading = parseInstant(record.expiresAt);
  return reading.kind === "instant" ? reading.epochMilliseconds : undefined;
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
  // No hedge and no countdown: the sweep stamped this row, so the refs went with it.
  // The record and its provenance stay, which is what the disclosure below is for.
  reclaimed:
    "The clone has been reclaimed and its snapshot refs went with it. The record and its provenance stay.",
};

/** The tone each reading carries. Elapsed is amber: it is a person's to act on. */
export const CLONE_EXPIRY_TONE: Readonly<Record<CloneExpiryReading, ChipTone>> = {
  scheduled: "neutral",
  elapsed: "attention",
  // Neutral, not amber: a reclaimed clone is settled. Amber is for what a person
  // still has to act on, and there is nothing left here to act on.
  reclaimed: "neutral",
};
