// What an execution root IS, read off the wire and turned into something a card
// can draw — and nothing else. No React, no fetching, no eligibility.
//
// THIS VIEW'S JOB, stated here because a view's composition lives in the
// console's code: show what
// execution roots exist on disk for this session, which run holds one, and what is
// safe to reclaim. One of those is a decision, made here so a
// card never makes it twice:
//
//   1. WHICH SUB-STATE A ROW IS IN. `state` is one wire string and the row's real
//      disposition needs two fields: a `retired` worktree with no `cleanedAt` is a
//      retired RECORD whose files are still on disk, which the design calls out as
//      a distinct sub-state. `worktreeDiskDisposition` is the only place that
//      pairing is read.
//
// THE STATE VOCABULARIES ARE THE CONTRACT'S, IMPORTED AND NEVER RESTATED.
// `WorktreeState` (six) lives in `packages/contracts/src/worktree.ts`; the table below is a
// `Record` keyed BY that union, so a seventh state added to the wire fails to compile here
// rather than rendering as an unstyled string.
//
// HOW A ROW IS TABULATED IS BESIDE IT. The column key sets, the labels, the summary
// and detail selections, and the absent-cell copy are `execution-root-columns.ts`: that is
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
//     `execution-root-columns.ts` comes back as the wire's own string or as absent.
//   • No snapshot refs. Turn-boundary snapshots land under `refs/sidekicks/...` and
//     never on `refs/heads/`, so a branch column can only ever hold a branch.

import type { WorktreeState, WorktreeStatusReadResponse } from "@ai-sidekicks/contracts";

import type { ChipTone } from "@renderer/console/primitives/index.js";

/** One worktree row of `repo.worktreeStatusRead`. */
export type WorktreeStatusRecord = WorktreeStatusReadResponse["worktrees"][number];

/** What a state name means and how loudly it reads. The name itself is the wire's. */
export interface RootStatePresentation {
  /**
   * The chip's tone. Amber means a person is needed, red means something failed,
   * and everything else is neutral — the console's whole color vocabulary, so a
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
    meaning: "The background service is provisioning this checkout.",
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
    meaning: "The record is retired. The background service will not bind this checkout again.",
  },
  failed: {
    tone: "failure",
    meaning:
      "Provisioning failed. This state is not separately evented; it arrives on a status re-read.",
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
  live: "No cleanup stamp on this record; the background service still owns this root.",
  "retired-on-disk":
    "Retired, and the files are still on disk. The record keeps its provenance; a later sweep removes the checkout.",
  reclaimed: "The checkout has been removed from disk. The record and its provenance stay.",
};
