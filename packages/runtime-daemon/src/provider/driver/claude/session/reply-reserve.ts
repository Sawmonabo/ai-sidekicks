// Claude Code's reply reserve and constant, which no request reports. Its compaction point is the
// window less the reply reserve (the model's maximum reply, capped) and a constant, so two context
// reads on one known window, the second with a maximum reply below the reserve, give both:
// the second read's point moves by the reserve less that maximum.

import { readNonEmptyString } from "../../../record-readers.js";
import type { ClaudeReplyReserveReads } from "./transport.js";

/** The window key both reads set: the smallest window Claude Code takes for it. */
export const CLAUDE_RESERVE_READ_WINDOW_TOKENS = 100_000;

/** The maximum reply the second read sets, chosen below any model's reply reserve. */
export const CLAUDE_RESERVE_READ_MAXIMUM_OUTPUT_TOKENS = 1_000;

/** The environment key that sets the window Claude Code compacts on. */
export const CLAUDE_AUTO_COMPACT_WINDOW_KEY = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";

/** The environment key that caps every reply; set only in the creation-time control process. */
export const CLAUDE_MAX_OUTPUT_TOKENS_KEY = "CLAUDE_CODE_MAX_OUTPUT_TOKENS";

/**
 * The reply reserve and constant Claude Code subtracts from the window for the session's model, in
 * tokens, or why they could not be read.
 */
export type ClaudeReplyReserve =
  | {
      readonly kind: "read";
      /** The model the reads ran on, as Claude Code's context report names it. */
      readonly model: string;
      readonly replyReserveTokens: number;
      readonly constantTokens: number;
    }
  | { readonly kind: "unread"; readonly reason: string };

function readTokenCount(reply: Record<string, unknown> | undefined, key: string): number | null {
  const value = reply?.[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Derives the reply reserve and constant from the two reads. Unread when Claude Code refused a
 * request on the way, when a reply lacks the window or the compaction point, when either read is
 * not on the window key's window (Claude Code drops a key it does not take), or when the maximum
 * reply did not move the point.
 */
export function deriveClaudeReplyReserve(
  requestedModel: string,
  reads: ClaudeReplyReserveReads,
): ClaudeReplyReserve {
  if (reads.kind === "refused") {
    return { kind: "unread", reason: `Claude Code refused a context read: ${reads.detail}` };
  }
  const window = CLAUDE_RESERVE_READ_WINDOW_TOKENS;
  const maximumOutput = CLAUDE_RESERVE_READ_MAXIMUM_OUTPUT_TOKENS;
  const windowOnlyPoint = readTokenCount(reads.windowOnly, "autoCompactThreshold");
  const cappedPoint = readTokenCount(reads.withMaximumOutput, "autoCompactThreshold");
  if (windowOnlyPoint === null || cappedPoint === null) {
    return { kind: "unread", reason: "Claude Code's context report carried no compaction point." };
  }
  if (
    readTokenCount(reads.windowOnly, "maxTokens") !== window ||
    readTokenCount(reads.withMaximumOutput, "maxTokens") !== window
  ) {
    return { kind: "unread", reason: "Claude Code did not take the window key." };
  }
  const constantTokens = window - maximumOutput - cappedPoint;
  if (cappedPoint <= windowOnlyPoint || constantTokens < 0) {
    return { kind: "unread", reason: "Claude Code did not take the maximum reply key." };
  }
  return {
    kind: "read",
    model: readNonEmptyString(reads.windowOnly ?? {}, "model") ?? requestedModel,
    replyReserveTokens: maximumOutput + cappedPoint - windowOnlyPoint,
    constantTokens,
  };
}
