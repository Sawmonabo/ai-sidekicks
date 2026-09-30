// What a worktree's state means on a card — and nothing else. No React, no fetching,
// no eligibility.
//
// THE STATE VOCABULARY IS THE CONTRACT'S, IMPORTED AND NEVER RESTATED. A listed
// worktree's state is `ListedWorktreeState` (every `WorktreeState` but `retired`, which
// the status read never lists); the table below is a `Record` keyed BY that union, so a
// state added to the wire fails to compile here rather than rendering as an unstyled
// string.
//
// HOW A ROW IS TABULATED IS BESIDE IT. The column key sets, the labels, the summary
// and detail selections, and the absent-cell copy are `execution-root-columns.ts`: that is
// how a root is DRAWN, and this file is what its state means.
//
// NEVER, each a property of THIS file:
//   • No sixth worktree event. Only five worktree event strings are registered, and
//     `failed` arrives through a status re-read; nothing here waits for a frame.
//   • No derived branch name and no derived checkout root. Both are wire strings on
//     the record, rendered, never computed.
//   • No snapshot refs. Turn-boundary snapshots land under `refs/sidekicks/...` and
//     never on `refs/heads/`, so a branch column can only ever hold a branch.

import type { ListedWorktreeState } from "@ai-sidekicks/contracts";

import type { ChipTone } from "@renderer/components/Chip/Chip.js";

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
 * The five listed worktree states, total over `ListedWorktreeState` by construction.
 * `failed` says where it comes from, because there is no `worktree.failed` event to
 * wait for.
 */
export const WORKTREE_STATE_PRESENTATION: Readonly<
  Record<ListedWorktreeState, RootStatePresentation>
> = {
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
  failed: {
    tone: "failure",
    meaning:
      "Provisioning failed. This state is not separately evented; it arrives on a status re-read.",
  },
};
