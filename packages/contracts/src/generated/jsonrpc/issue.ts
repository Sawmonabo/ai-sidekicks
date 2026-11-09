// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// What a refused message's check found: each issue's path, a member's name or an array's index at each step, its message, and the finding a rule adds.

/**
 * The most issues a `request.paramsInvalid` or `request.resultInvalid` refusal lists, the
 * first in the check's order.
 */
export const ISSUES_MAX = 32 as const;

/** The most steps an issue's path holds; a deeper fault is named at its ancestor this deep. */
export const ISSUE_PATH_SEGMENTS_MAX = 32 as const;

/**
 * One step of an issue's path: a member's name as the message spells it, or an array's index.
 */
export type IssuePathSegment = string | number;

/**
 * One fault a `request.paramsInvalid` or `request.resultInvalid` refusal names: where it sits,
 * what is wrong in fixed words, and, for a rule whose finding a client reads, that finding.
 */
export interface Issue {
  /**
   * Where the fault sits, empty for the whole message.
   */
  path: IssuePathSegment[];
  /**
   * What is wrong, in words that never quote the value.
   */
  message: string;
  /**
   * The finding of a rule a client acts on (a repeated workflow node id's
   * `nodeIdDuplicate`); absent for every other fault.
   */
  params?: {
    [k: string]: unknown | undefined;
  };
}
