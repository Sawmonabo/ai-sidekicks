// What a reading is when it is not the whole of what was asked for, and the one sentence set
// that says so, so every view words it the same way.
//
// A view never claims a completeness it cannot prove: `served` is the only state with no notice,
// and `readingNoticeFor` is total over the union, so a state without a sentence fails to compile.
// `partialReadNotices` takes every reading a view holds, so a served snapshot beside an unreadable
// tail cannot render as exhaustive.
//
// The subject is a caller-written noun phrase of unknown number ("the queue", "these quotas"), so
// no arm puts it in front of a verb.

import type { Refusal } from "./refusal/refusal.js";
import { formatCount } from "./wire/figures.js";

/**
 * How completely a view's reading answered the question it put. `served` is the only member
 * that claims completeness; each other member carries exactly what its sentence spends.
 */
export type ReadingState =
  /** The whole of it arrived. The only state that claims completeness. */
  | { readonly kind: "served" }
  /** The read is in flight. Nothing is claimed yet, in either direction. */
  | { readonly kind: "reading" }
  /**
   * Deliveries arrived that this build could not read. They changed no row, so the rows alone
   * cannot show it. `unreadableCount` is at least one; `unreadableDeliveryReading` holds that.
   */
  | {
      readonly kind: "partial";
      readonly unreadableCount: number;
      /** The newest unreadable delivery's own parse refusal, where one was kept. */
      readonly newestRefusal: Refusal | undefined;
    }
  /**
   * The producer cut its own enumeration. How many were dropped is not on the wire, so
   * `servedCount`, what did arrive, is the only figure.
   */
  | { readonly kind: "cut"; readonly servedCount: number };

/**
 * What a notice renders, so the component branches on a closed instruction. `"reading"` renders
 * as the skeleton; the counted sentence sits beside the rows it qualifies, led by its figure.
 */
export type PartialReadNotice =
  | { readonly shape: "none" }
  | { readonly shape: "reading"; readonly title: string }
  | {
      readonly shape: "counted-sentence";
      /** The count, already `Intl`-formatted. */
      readonly figure: string;
      /** The rest of the sentence, which the figure leads. */
      readonly copy: string;
      readonly refusal: Refusal | undefined;
    };

/** The one shape that claims the reading is whole. */
const COMPLETE_NOTICE: PartialReadNotice = { shape: "none" };

/**
 * The reading a count of unreadable deliveries is: a running count and the newest parse refusal
 * kept. Zero is `served`, since nothing this producer received failed to parse; that is a claim
 * about the deliveries, not the read they follow, so a view holding both hands both to
 * `partialReadNotices`.
 */
export function unreadableDeliveryReading(
  unreadableCount: number,
  newestRefusal: Refusal | undefined,
): ReadingState {
  if (!Number.isInteger(unreadableCount) || unreadableCount < 1) {
    return { kind: "served" };
  }
  return { kind: "partial", unreadableCount, newestRefusal };
}

/**
 * The sentence a reading state says of itself, about `subject`: a lowercase noun phrase such as
 * "the queue" or "these quotas", placed mid-sentence in every arm so callers never capitalize it.
 * Total over `ReadingState`.
 */
export function readingNoticeFor(state: ReadingState, subject: string): PartialReadNotice {
  switch (state.kind) {
    case "served":
      return COMPLETE_NOTICE;
    case "reading":
      return { shape: "reading", title: `Reading ${subject}.` };
    case "partial":
      return {
        shape: "counted-sentence",
        figure: formatCount(state.unreadableCount),
        copy: `${state.unreadableCount === 1 ? "delivery" : "deliveries"} could not be read.`,
        refusal: state.newestRefusal,
      };
    case "cut":
      return {
        shape: "counted-sentence",
        figure: formatCount(state.servedCount),
        // "the answer for ${subject}" so the verb agrees with a noun supplied here.
        copy:
          `read before the answer for ${subject} was cut ` +
          `short, so what is not shown here may still exist.`,
        refusal: undefined,
      };
  }
}

/**
 * Every notice a view's readings owe, in the order the view holds them. An empty answer means
 * every reading is served, the only way this module says a view shows the whole of it.
 */
export function partialReadNotices(
  states: readonly ReadingState[],
  subject: string,
): readonly PartialReadNotice[] {
  return states
    .map((state) => readingNoticeFor(state, subject))
    .filter((notice) => notice.shape !== "none");
}
