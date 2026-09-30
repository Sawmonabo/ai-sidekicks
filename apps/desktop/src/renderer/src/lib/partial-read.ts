// What a reading is when it is not the whole of what was asked for, and the one sentence set
// that says so, so no view says "may be stale" where another says "may be behind".
//
// A view never claims a completeness it cannot prove: `served` is the only state with no notice,
// and `readingNoticeFor` is total over the kind tuple, so a state without a sentence fails to
// compile. `partialReadNotices` takes every reading a view holds, so a served snapshot beside an
// unreadable tail cannot render as exhaustive. Notices stay separate because a merged sentence
// would drop a refusal, which names what to do next.
//
// Sentences state the consequence first and leave the cause to the refusal beneath. The subject
// is a caller-written noun phrase of unknown number ("the queue", "these quotas"), so no arm puts
// it in front of a verb: each uses a modal, makes it a modifier of a noun supplied here, or keeps
// it clear of the verb.

import type { Refusal } from "./refusal.js";
import { formatCount } from "./wire-figures.js";

/** Every reading state kind; tests walk the tuple at runtime. */
export const READING_STATE_KINDS = [
  "served",
  "reading",
  "refused",
  "stale",
  "partial",
  "cut",
  "unchecked",
] as const;

/** One of {@link READING_STATE_KINDS}. */
export type ReadingStateKind = (typeof READING_STATE_KINDS)[number];

/**
 * Whether a refusal is the whole answer or arrived beside one. The sentence for one is false of
 * the other ("what is shown here is not the whole of it" is untrue of a read that returned
 * nothing), so the scope is decided where outcomes are counted, not in a render body.
 */
export const REFUSAL_SCOPES = ["whole-answer", "beside-an-answer"] as const;

/** One of {@link REFUSAL_SCOPES}. */
export type RefusalScope = (typeof REFUSAL_SCOPES)[number];

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
   * The read was refused. On `whole-answer` the refusal is all there is; on `beside-an-answer`
   * what is on screen arrived another way and is a fragment of unknown size.
   */
  | { readonly kind: "refused"; readonly scope: RefusalScope; readonly refusal: Refusal }
  /**
   * The reading is behind its producer by an unknown amount. Distinct from `partial`: a producer
   * that counted what it could not read supplies a figure, one that only knows it fell behind
   * supplies none.
   */
  | { readonly kind: "stale"; readonly refusal: Refusal | undefined }
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
  | { readonly kind: "cut"; readonly servedCount: number }
  /**
   * A read that asked several sources and did not hear back from all of them: parts of the
   * question were put and never answered, as when a fan-out across sessions, mounts or nodes has
   * refusals. An empty result over incomplete coverage is not an all-clear. This is a counted
   * part of a read that did answer, not a wholly unchecked read. `uncheckedCount` is at least
   * one; zero is `served`.
   */
  | {
      readonly kind: "unchecked";
      readonly uncheckedCount: number;
      /** The newest refusal among the parts that went unanswered, where one was kept. */
      readonly newestRefusal: Refusal | undefined;
    };

/**
 * What a notice renders: fewer shapes than states, so the component branches on a closed
 * instruction. `"reading"` renders as the skeleton; the prose shapes sit beside the rows they
 * qualify. The two prose shapes are separate so a figure-led fragment can never lack its figure.
 */
export type PartialReadNotice =
  | { readonly shape: "none" }
  | { readonly shape: "reading"; readonly title: string }
  | {
      readonly shape: "sentence";
      /** A whole sentence, leading with nothing. */
      readonly copy: string;
      readonly refusal: Refusal | undefined;
    }
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
    case "refused":
      return {
        shape: "sentence",
        copy:
          state.scope === "whole-answer"
            ? `The read of ${subject} was refused, so none of it is shown here.`
            : `The read of ${subject} was refused, so what is shown here is not the whole of it.`,
        refusal: state.refusal,
      };
    case "stale":
      return {
        shape: "sentence",
        copy: `Some of what arrived could not be read, so ${subject} may be behind what the background service has sent.`,
        refusal: state.refusal,
      };
    case "partial":
      return {
        shape: "counted-sentence",
        figure: formatCount(state.unreadableCount),
        copy: `${state.unreadableCount === 1 ? "delivery" : "deliveries"} could not be read, so ${subject} may be behind what the background service has sent.`,
        refusal: state.newestRefusal,
      };
    case "cut":
      return {
        shape: "counted-sentence",
        figure: formatCount(state.servedCount),
        // "the answer for ${subject}" so the verb agrees with a noun supplied here.
        copy: `read before the answer for ${subject} was cut short, so what is not shown here may still exist.`,
        refusal: undefined,
      };
    case "unchecked":
      return {
        shape: "counted-sentence",
        figure: formatCount(state.uncheckedCount),
        copy: `${state.uncheckedCount === 1 ? "part" : "parts"} of ${subject} could not be checked, so what is shown here covers less than was asked for.`,
        refusal: state.newestRefusal,
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
