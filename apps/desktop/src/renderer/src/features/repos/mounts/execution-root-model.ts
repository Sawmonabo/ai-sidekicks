// The chip tone a worktree's state wears on a card. The table is keyed by `ListedWorktreeState`
// (every `WorktreeState` but `retired`), so a new wire state fails to compile here. Column layout
// is `execution-root-columns.ts`. There is no `worktree.failed` event: `failed` arrives through a
// status re-read. Snapshot refs live under `refs/sidekicks/`, never `refs/heads/`.

import type { ListedWorktreeState } from "@ai-sidekicks/contracts/worktree";

import type { ChipTone } from "@renderer/components/Chip/Chip.js";

/**
 * The tone each listed worktree state wears: amber means a person is needed, red means
 * something failed, everything else is neutral.
 */
export const WORKTREE_STATE_TONES: Readonly<Record<ListedWorktreeState, ChipTone>> = {
  creating: "neutral",
  ready: "neutral",
  dirty: "attention",
  merged: "neutral",
  failed: "failure",
};
