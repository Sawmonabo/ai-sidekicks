// What a reading is, when it is not the whole of what was asked for — and the one
// sentence set that says so.
//
// `Spec-023 §Console Design (Meridian)` rule 8 closes the FIVE absences a surface may
// render. It says nothing about the case that is not an absence at all: a reading that
// arrived, is being shown, and is INCOMPLETE. Every family met that case separately
// and each wrote its own notice — a queue whose snapshot refused while the tail kept
// delivering, a quota tail whose deliveries this build could not parse, a provider
// enumeration the daemon cut, a definitions browser answering per scope. The shapes
// agreed by accident and the sentences did not, so one console said "may be stale",
// another "may be behind the registry", and a third said nothing at all and rendered
// a list that looked exhaustive.
//
// THE CLAIM THIS MODULE MAKES IS RULE 8'S, EXTENDED BY ONE STEP: a surface never
// claims a completeness it cannot prove. `served` is the only state that claims it,
// and it is the only state that renders no notice. Everything else renders one — which
// is why `readingNoticeFor` is TOTAL over the kind tuple and why its `"none"` shape
// is reachable from exactly one arm. A seventh state added to the union without a
// sentence fails to compile here rather than shipping as a silent claim of
// completeness.
//
// A SURFACE HANDS OVER EVERY READING IT HOLDS, NOT ONE OF THEM. A queue whose
// snapshot refused AND whose tail carried an unreadable delivery is incomplete twice
// over, for two reasons a person can act on differently, and the first version of
// this module answered that with discipline: "the surface mounts the notice twice
// with two states". Discipline is the thing this branch exists to replace with a
// mechanism, so `partialReadNotices` takes the SET and answers a notice per member.
// `"none"` comes back only when every member is `served`, which is what makes a
// surface holding a served snapshot beside an unreadable tail unable to render as
// exhaustive: there is no call shape that shows one reading and hides the other. Two
// notices and not a merged one, still — a merged sentence would have to drop one of
// the two refusals, and the refusal is the half that names what to do next.
//
// THE CAUSES ARE ONE CLAIM WITH SEVERAL REASONS. A person reading a notice is
// deciding whether to trust what is in front of them, so every sentence states the
// CONSEQUENCE first and leaves the cause to the refusal rendered beneath it. The one
// thing a caller supplies is the subject — a lowercase noun phrase naming what was
// read ("the queue", "these quotas", "this run's command list") — and it is the only
// variable in the set, because the grammar around it is what must not drift.

import type { ConsoleRefusal } from "../core/index.js";
import { formatCount } from "./wire-figures.js";

/**
 * Closed. The tuple is the declaration and `ReadingStateKind` follows from it, so a
 * claim about the SET is countable at runtime — the same construction rule 8's five
 * kinds are declared under, and for the same reason: the vacuity guard walks the
 * tuple, so a kind added to a hand-written union alone would be a state nothing
 * checked.
 */
export const READING_STATE_KINDS = [
  "served",
  "reading",
  "refused",
  "stale",
  "partial",
  "cut",
] as const;

export type ReadingStateKind = (typeof READING_STATE_KINDS)[number];

/**
 * What a refusal is the answer TO. Closed, and closed at two.
 *
 * A refusal that IS the whole answer and a refusal that arrived BESIDE one are two
 * different facts, and the sentence for one is false of the other: "what is shown
 * here is not the whole of it" says there is something shown, which is not true of a
 * read that returned nothing at all. The scope is decided where the outcomes are
 * counted and never re-derived in a render body — two views would eventually
 * disagree about whether one refusal is the surface's result or a note beside one.
 */
export const REFUSAL_SCOPES = ["whole-answer", "beside-an-answer"] as const;

export type RefusalScope = (typeof REFUSAL_SCOPES)[number];

/**
 * How completely a surface's reading answered the question it put.
 *
 * `served` is the only member that claims completeness, and it carries nothing:
 * a complete reading has nothing to say about itself. The others each carry
 * exactly what their sentence spends and nothing more.
 */
export type ReadingState =
  /** The whole of it arrived. The only state that claims completeness. */
  | { readonly kind: "served" }
  /** The read is in flight. Nothing is claimed yet, in either direction. */
  | { readonly kind: "reading" }
  /**
   * The read was refused. `scope` says whether anything else answered: on
   * `whole-answer` the refusal is all there is, and on `beside-an-answer` what is on
   * screen arrived some other way and is a fragment of unknown size.
   */
  | { readonly kind: "refused"; readonly scope: RefusalScope; readonly refusal: ConsoleRefusal }
  /**
   * The reading is behind its producer and by how much is not known.
   *
   * The distinct case from `partial`, and the distinction is the wire's: a producer
   * that counted what it could not read supplies a figure and a producer that only
   * knows it fell behind supplies none. Rendering the second as the first would need
   * a count nobody sent, and rendering it as `served` would claim a completeness the
   * producer has just said it cannot vouch for.
   */
  | { readonly kind: "stale"; readonly refusal: ConsoleRefusal | undefined }
  /**
   * Deliveries arrived that this build could not read. They changed no row, which is
   * exactly why the rows alone cannot show it: a list that did not move looks like a
   * list that had nothing to move for.
   *
   * `unreadableCount` is at least one — a count of zero is nothing to report rather
   * than a partial reading, and `unreadableDeliveryReading` is what holds that.
   */
  | {
      readonly kind: "partial";
      readonly unreadableCount: number;
      /** The newest unreadable delivery's own parse refusal, where one was kept. */
      readonly newestRefusal: ConsoleRefusal | undefined;
    }
  /**
   * The producer cut its own enumeration. How many were dropped is not on the wire
   * and is not invented here — `servedCount` is what did arrive, which is the only
   * figure the reply supplies.
   */
  | { readonly kind: "cut"; readonly servedCount: number };

/**
 * What a notice renders. Four shapes over six states, so the component branches on
 * a closed instruction rather than on the state a second time.
 *
 * `"reading"` is its own shape because a read in flight is rule 8's `not-loaded`
 * absence and renders through that primitive; the prose shapes are prose beside the
 * rows they qualify.
 *
 * The two prose shapes are separate because a figure and the copy that leads with it
 * are one sentence cut in half. A single shape typing the figure as optional admits
 * `{ figure: undefined, copy: "deliveries could not be read, so …" }`, which renders
 * as a headless fragment — so the whole-sentence case and the figure-first case are
 * two shapes and neither can be half-supplied.
 */
export type PartialReadNotice =
  | { readonly shape: "none" }
  | { readonly shape: "reading"; readonly title: string }
  | {
      readonly shape: "sentence";
      /** A whole sentence, leading with nothing. */
      readonly copy: string;
      readonly refusal: ConsoleRefusal | undefined;
    }
  | {
      readonly shape: "counted-sentence";
      /** The count, already `Intl`-formatted. */
      readonly figure: string;
      /** The rest of the sentence, which the figure leads. */
      readonly copy: string;
      readonly refusal: ConsoleRefusal | undefined;
    };

/** The one shape that claims the reading is whole. */
const COMPLETE_NOTICE: PartialReadNotice = { shape: "none" };

/**
 * The reading a count of unreadable deliveries is.
 *
 * The producer's shape across the families that have one: a running count and the
 * newest parse refusal it kept. Zero is `served` and not `partial` — a notice
 * reading "0 deliveries could not be read" is a notice for an absence of anything to
 * notice — and `served` is admissible here precisely because this producer proved
 * it: nothing it received failed to parse. That is a claim about the DELIVERIES and
 * not about the read they arrive after, which is why a surface holding both hands
 * both to `partialReadNotices` rather than choosing between them.
 */
export function unreadableDeliveryReading(
  unreadableCount: number,
  newestRefusal: ConsoleRefusal | undefined,
): ReadingState {
  if (!Number.isInteger(unreadableCount) || unreadableCount < 1) {
    return { kind: "served" };
  }
  return { kind: "partial", unreadableCount, newestRefusal };
}

/**
 * The reading a behind-the-producer flag is, where no count is on the wire.
 *
 * The second producer shape, and it is a different rule rather than a second spelling
 * of the first: this one has a boolean and no figure, so its `false` proves only that
 * nothing reported it behind. Written here so no surface has to decide for itself
 * what a bare flag means, which is how one console came to say "may be stale" and
 * another "may be behind the registry" for the same fact.
 */
export function behindProducerReading(
  isBehind: boolean,
  refusal: ConsoleRefusal | undefined,
): ReadingState {
  return isBehind ? { kind: "stale", refusal } : { kind: "served" };
}

/**
 * The sentence a reading state says of itself, about `subject`.
 *
 * `subject` is a lowercase noun phrase naming what was read — "the queue", "these
 * quotas", "this run's command list". It appears mid-sentence in every arm on
 * purpose: a subject at a sentence's head would have to be capitalized by the caller,
 * and a caller that capitalized it in one place and not another is exactly the drift
 * this module exists to remove.
 *
 * Total over `ReadingState` by construction, so a seventh member fails to compile
 * here before it can reach a surface that renders it as complete.
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
        copy: `Some of what arrived could not be read, so ${subject} may be behind what the daemon has sent.`,
        refusal: state.refusal,
      };
    case "partial":
      return {
        shape: "counted-sentence",
        figure: formatCount(state.unreadableCount),
        copy: `${state.unreadableCount === 1 ? "delivery" : "deliveries"} could not be read, so ${subject} may be behind what the daemon has sent.`,
        refusal: state.newestRefusal,
      };
    case "cut":
      return {
        shape: "counted-sentence",
        figure: formatCount(state.servedCount),
        copy: `read before ${subject} was cut, so what is not shown here may still exist.`,
        refusal: undefined,
      };
  }
}

/**
 * Every notice a surface's readings owe, in the order the surface holds them.
 *
 * The door, and the reason `readingNoticeFor` is not it: a surface takes ONE reading
 * at a time from its producers and owes a person all of them at once, so the shape
 * that composes is the shape callers reach for. An empty answer means every reading
 * served — the only way this module ever says a surface is showing the whole of it.
 */
export function partialReadNotices(
  states: readonly ReadingState[],
  subject: string,
): readonly PartialReadNotice[] {
  return states
    .map((state) => readingNoticeFor(state, subject))
    .filter((notice) => notice.shape !== "none");
}
