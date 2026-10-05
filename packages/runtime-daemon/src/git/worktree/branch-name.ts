/**
 * Derives the branch name a worktree is created on from its task summary and id, and the
 * ordinal suffix that resolves a collision.
 */

import { WorktreeCreateFailedError } from "./errors.js";

/** Inputs for {@link deriveWorktreeBranchName}. */
export interface WorktreeBranchNameInput {
  /** The session whose last 8 hex digits form the `<session-short-id>` segment. */
  readonly sessionId: string;
  /** The run behind the `run-<run-short-id>` fallback; `null` when there is none. */
  readonly runId: string | null;
  /** The queue-item summary, the preferred `<task-slug>` source. */
  readonly taskSummary?: string | null;
}

const DERIVED_BRANCH_NAME_PREFIX = "sidekicks";

const SHORT_ID_LENGTH = 8;

const TASK_SLUG_MAX_LENGTH = 40;

/**
 * Collision suffixes run `-2` to `-100`; past that the daemon is looping on an unresolvable
 * condition, and a typed `branch_name_unavailable` beats an endless retry.
 */
export const MAX_BRANCH_NAME_ORDINAL = 100;

/**
 * The default branch name `sidekicks/<session-short-id>/<task-slug>`: the slug is the summary
 * lowercased, non-alphanumeric runs collapsed to `-`, cut to 40 characters at a `-` boundary, or
 * `run-<run-short-id>` without one. Throws `branch_name_underivable` when neither exists.
 */
export function deriveWorktreeBranchName(input: WorktreeBranchNameInput): string {
  const taskSlug = slugifyTaskSummary(input.taskSummary ?? null) ?? runFallbackSlug(input.runId);
  if (taskSlug === null) {
    throw new WorktreeCreateFailedError("branch_name_underivable");
  }
  return `${DERIVED_BRANCH_NAME_PREFIX}/${shortId(input.sessionId)}/${taskSlug}`;
}

/** The last 8 hex digits, hyphens stripped: a v7 id's random tail, so the handle keeps entropy. */
function shortId(identifier: string): string {
  return identifier.replace(/-/g, "").slice(-SHORT_ID_LENGTH).toLowerCase();
}

/** The `run-<short-id>` slug, or `null` when there is no run id. */
function runFallbackSlug(runId: string | null): string | null {
  if (runId === null || runId.length === 0) {
    return null;
  }
  return `run-${shortId(runId)}`;
}

/**
 * ASCII alphanumerics only: the slug must round-trip across platforms whose normalization and
 * case folding differ, so a non-ASCII letter is a separator, not transliterated.
 */
function slugifyTaskSummary(taskSummary: string | null): string | null {
  if (taskSummary === null) {
    return null;
  }
  const collapsed = taskSummary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (collapsed.length === 0) {
    return null;
  }
  return truncateSlugAtBoundary(collapsed, TASK_SLUG_MAX_LENGTH);
}

/** Truncates at a `-` boundary so the tail is not a half-word; without one, cuts hard. */
function truncateSlugAtBoundary(slug: string, maxLength: number): string {
  if (slug.length <= maxLength) {
    return slug;
  }
  const clipped = slug.slice(0, maxLength);
  if (slug.charAt(maxLength) === "-") {
    return clipped;
  }
  const lastBoundary = clipped.lastIndexOf("-");
  if (lastBoundary <= 0) {
    return clipped;
  }
  return clipped.slice(0, lastBoundary);
}
