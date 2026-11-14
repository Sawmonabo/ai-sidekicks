// What a reading is when it is not the whole of what was asked for, and the one sentence set
// that says so, so every view words it the same way.
//
// A view never claims a completeness it cannot prove: `served` and a read still in flight, which
// its view draws its own loading line for, are the only states with no notice, and
// `readingNoticeFor` is total over the union, so a state without a sentence fails to compile.
// `partialReadNotices` takes every reading a view holds, so a served snapshot beside an unreadable
// tail cannot render as exhaustive.

import type { Refusal } from "./refusal/contract.js";
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
    };

/**
 * What a notice says, so its reader branches on a closed instruction. The counted sentence is led
 * by its figure.
 */
export type PartialReadNotice =
  | { readonly shape: "none" }
  | {
      readonly shape: "counted-sentence";
      /** The count, already `Intl`-formatted. */
      readonly figure: string;
      /** The rest of the sentence, which the figure leads. */
      readonly copy: string;
      readonly refusal: Refusal | undefined;
    };

/** The one shape that owes no notice: the reading is whole, or still in flight. */
const NO_NOTICE: PartialReadNotice = { shape: "none" };

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
 * Every notice a view's readings owe, in the order the view holds them. An empty answer means
 * every reading is served or still in flight, the only way this module says a view owes no notice.
 */
export function partialReadNotices(states: readonly ReadingState[]): readonly PartialReadNotice[] {
  return states.map((state) => readingNoticeFor(state)).filter((notice) => notice.shape !== "none");
}

/** The notice a reading state owes. Total over `ReadingState`. */
function readingNoticeFor(state: ReadingState): PartialReadNotice {
  switch (state.kind) {
    case "served":
    case "reading":
      return NO_NOTICE;
    case "partial":
      return {
        shape: "counted-sentence",
        figure: formatCount(state.unreadableCount),
        copy: `${state.unreadableCount === 1 ? "delivery" : "deliveries"} could not be read.`,
        refusal: state.newestRefusal,
      };
  }
}
