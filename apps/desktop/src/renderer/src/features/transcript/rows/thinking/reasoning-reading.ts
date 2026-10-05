// The reasoning row's model: the sentence for each availability arm, and how the tail is cut.
// The copy table is total over the contract's `availability` union, so a new state fails to
// compile here instead of rendering blank.

import type { Refusal } from "@renderer/lib/refusal.js";
import type { ReasoningSurfaceReadResponse } from "@ai-sidekicks/contracts/transcript/operations";
import type { RunId } from "@ai-sidekicks/contracts/provider/driver/driver";
import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row/row";

/** One arm of the contract's closed availability discriminant. */
export type ReasoningAvailability = ReasoningSurfaceReadResponse["availability"];

/**
 * How many lines of a streaming turn the tail shows.
 *
 * A display cap only: the reveal engine's text is untouched, and expanding asks the daemon
 * rather than un-cropping this.
 */
export const REASONING_TAIL_LINE_COUNT = 3;

/**
 * What the row holds about its reasoning read.
 *
 * `not-asked` (nobody put the question) is a different fact from a read that answered
 * `unavailable`; collapsing them would claim no reasoning was captured whenever a row is
 * simply not expanded.
 */
export type ReasoningReading =
  | { readonly status: "not-asked" }
  | { readonly status: "reading" }
  | { readonly status: "read"; readonly response: ReasoningSurfaceReadResponse }
  | { readonly status: "refused"; readonly refusal: Refusal };

/** What one arm says of itself when it carries no entries to show. */
export interface ReasoningAvailabilityCopy {
  /** The sentence: what happened, never a remedy. */
  readonly title: string;
  /** The second line, saying what remains readable. */
  readonly detail: string;
}

/**
 * The newest lines of a streaming reasoning body.
 *
 * The window is taken from the end so a long turn shows what is arriving. Blank lines are
 * dropped before the window is taken and each line's trailing whitespace is trimmed. Pure, so
 * a caller can memoize on the text.
 */
export function reasoningTailOf(text: string): readonly string[] {
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trimEnd();
    if (trimmed.length > 0) {
      lines.push(trimmed);
    }
  }
  return lines.slice(-REASONING_TAIL_LINE_COUNT);
}

/**
 * A sentence per availability arm, total over the contract's union.
 *
 * `available` has one because a read that served an empty page is still a fact, and a reader
 * is owed a sentence rather than a blank region.
 */
export const REASONING_AVAILABILITY_COPY: Readonly<
  Record<ReasoningAvailability, ReasoningAvailabilityCopy>
> = {
  available: {
    title: "This turn's reasoning was captured and this page of it is empty.",
    detail: "The read succeeded and served no entries at this position.",
  },
  unavailable: {
    title: "No reasoning was captured for this turn.",
    detail: "The provider recorded none.",
  },
};

/**
 * The run whose reasoning this row belongs to, or `undefined` for a row with no run
 * attribution (a `general` row), which keeps the expand control off a row the read cannot
 * answer for.
 */
export function reasoningRunIdOf(row: TranscriptEventRow): RunId | undefined {
  return row.kind === "run" ? row.runId : undefined;
}
