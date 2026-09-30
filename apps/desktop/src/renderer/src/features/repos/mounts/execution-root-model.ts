// What a worktree's state means on a card. The table is keyed by `ListedWorktreeState` (every
// `WorktreeState` but `retired`), so a new wire state fails to compile here. Column layout is
// `execution-root-columns.ts`. There is no `worktree.failed` event: `failed` arrives through a
// status re-read. Snapshot refs live under `refs/sidekicks/`, never `refs/heads/`.

import type { ListedWorktreeState } from "@ai-sidekicks/contracts";

import type { ChipTone } from "@renderer/components/Chip/Chip.js";

/** What a state name means and how loudly it reads. The name itself is the wire's. */
export interface RootStatePresentation {
  /** Amber means a person is needed, red means something failed, everything else is neutral. */
  readonly tone: ChipTone;
  /** One sentence saying what the daemon means by this state. Never the state name reworded. */
  readonly meaning: string;
}

/**
 * The five listed worktree states, total over `ListedWorktreeState`. `failed` says where it
 * comes from, since there is no event to wait for.
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
