// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Setting a new tree up, as the composer's setup card follows it, and its retry.

import type { WorktreeId } from "./lifecycle.js";

/**
 * The longest captured output a setup step carries; the daemon keeps the tail of a longer
 * output, cut to this many code points.
 */
export const WORKTREE_SETUP_OUTPUT_MAX_LEN = 32768 as const;

/**
 * The stages of setting a tree up, in the order they run.
 */
export type WorktreeSetupStage = "makeTree" | "projectSteps" | "warmCaches";
/**
 * Where one setup step stands.
 */
export type WorktreeSetupStepState = "pending" | "running" | "succeeded" | "failed";
/**
 * Where a tree's setup card stands; `notRun`, with no steps, is a tree with no card to show: its
 * setup did not run since the daemon started, or it has none.
 */
export type WorktreeSetupState = "running" | "succeeded" | "failed" | "notRun";

/**
 * One step of the setup card, in run order. `error` and `output` are present on a failed step,
 * `output` also on a made tree's step whose checkout hook failed, and `elapsedMs` once the step
 * has run.
 */
export interface WorktreeSetupStep {
  /**
   * Its stage.
   */
  stage: WorktreeSetupStage;
  /**
   * What it is: the command, for a project step.
   */
  label: string;
  /**
   * Where it stands.
   */
  state: WorktreeSetupStepState;
  /**
   * How long it ran, in milliseconds.
   */
  elapsedMs?: number;
  /**
   * Why it failed.
   */
  error?: string;
  /**
   * Its captured output.
   */
  output?: string;
}
/**
 * One `worktree.setup.subscribe` emission: the whole card for one tree.
 */
export interface WorktreeSetupStatus {
  /**
   * The tree.
   */
  worktreeId: WorktreeId;
  /**
   * Where the card stands.
   */
  state: WorktreeSetupState;
  /**
   * Its steps.
   */
  steps: WorktreeSetupStep[];
}
/**
 * `worktree.setup.subscribe` and `worktree.setup.retry`: the tree whose setup a card follows
 * or retries. A retry runs the failed step and the ones after it.
 */
export interface WorktreeSetupRequest {
  /**
   * The tree.
   */
  worktreeId: WorktreeId;
}
