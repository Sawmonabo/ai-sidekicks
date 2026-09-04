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
// is why `partialReadNotice` is TOTAL over the kind tuple and why its `"none"` shape
// is reachable from exactly one arm. A sixth state added to the union without a
// sentence fails to compile here rather than shipping as a silent claim of
// completeness.
//
// THE FOUR CAUSES ARE ONE CLAIM WITH FOUR REASONS. A person reading a notice is
// deciding whether to trust what is in front of them, so every sentence states the
// CONSEQUENCE first and leaves the cause to the refusal rendered beneath it. The one
// thing a caller supplies is the subject — a lowercase noun phrase naming what was
// read ("the queue", "these quotas", "this run's command list") — and it is the only
// variable in the set, because the grammar around it is what must not drift.
//
// TWO INCOMPLETE FACTS ARE TWO NOTICES, NOT A MERGED ONE. A queue whose snapshot
// refused AND whose tail carried an unreadable delivery is incomplete twice over, for
// two reasons a person can act on differently. The surface mounts the notice twice
// with two states rather than this module inventing a combined arm — a merged sentence
// would have to drop one of the two refusals, and the refusal is the half that names
// what to do next.

import type { ConsoleRefusal } from "../core/index.js";
import { formatCount } from "./wire-figures.js";

/**
 * Closed. The tuple is the declaration and `ReadingStateKind` follows from it, so a
 * claim about the SET is countable at runtime — the same construction rule 8's five
 * kinds are declared under, and for the same reason: the vacuity guard walks the
 * tuple, so a kind added to a hand-written union alone would be a state nothing
 * checked.
 */
export const READING_STATE_KINDS = ["served", "reading", "refused", "partial", "cut"] as const;

export type ReadingStateKind = (typeof READING_STATE_KINDS)[number];

/**
 * How completely a surface's reading answered the question it put.
 *
 * `served` is the only member that claims completeness, and it carries nothing:
 * a complete reading has nothing to say about itself. The other four each carry
 * exactly what their sentence spends and nothing more.
 */
export type ReadingState =
  /** The whole of it arrived. The only state that claims completeness. */
  | { readonly kind: "served" }
  /** The read is in flight. Nothing is claimed yet, in either direction. */
  | { readonly kind: "reading" }
  /**
   * The read was refused. What is on screen — if anything — arrived some other way,
   * so it is a fragment of unknown size rather than the answer.
   */
  | { readonly kind: "refused"; readonly refusal: ConsoleRefusal }
  /**
   * Deliveries arrived that this build could not read. They changed no row, which is
   * exactly why the rows alone cannot show it: a list that did not move looks like a
   * list that had nothing to move for.
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
 * What a notice renders. Three shapes over five states, so the component branches on
 * a closed instruction rather than on the state a second time.
 *
 * `"reading"` is its own shape because a read in flight is rule 8's `not-loaded`
 * absence and renders through that primitive; the other three incomplete states are
 * prose beside the rows they qualify.
 */
export type PartialReadNotice =
  | { readonly shape: "none" }
  | { readonly shape: "reading"; readonly title: string }
  | {
      readonly shape: "sentence";
      /** The count, already `Intl`-formatted. Absent where the state carries none. */
      readonly figure: string | undefined;
      /** The sentence, minus the figure that leads it. */
      readonly copy: string;
      readonly refusal: ConsoleRefusal | undefined;
    };

/** The one shape that claims the reading is whole. */
const COMPLETE_NOTICE: PartialReadNotice = { shape: "none" };

/**
 * The sentence a reading state says of itself, about `subject`.
 *
 * `subject` is a lowercase noun phrase naming what was read — "the queue", "these
 * quotas", "this run's command list". It appears mid-sentence in every arm on
 * purpose: a subject at a sentence's head would have to be capitalized by the caller,
 * and a caller that capitalized it in one place and not another is exactly the drift
 * this module exists to remove.
 *
 * Total over `ReadingState` by construction, so a sixth member fails to compile here
 * before it can reach a surface that renders it as complete.
 */
export function partialReadNotice(state: ReadingState, subject: string): PartialReadNotice {
  switch (state.kind) {
    case "served":
      return COMPLETE_NOTICE;
    case "reading":
      return { shape: "reading", title: `Reading ${subject}.` };
    case "refused":
      return {
        shape: "sentence",
        figure: undefined,
        copy: `The read of ${subject} was refused, so what is shown here is not the whole of it.`,
        refusal: state.refusal,
      };
    case "partial":
      return {
        shape: "sentence",
        figure: formatCount(state.unreadableCount),
        copy: `${state.unreadableCount === 1 ? "delivery" : "deliveries"} could not be read, so ${subject} may be behind what the daemon has sent.`,
        refusal: state.newestRefusal,
      };
    case "cut":
      return {
        shape: "sentence",
        figure: formatCount(state.servedCount),
        copy: `read before ${subject} was cut, so what is not shown here may still exist.`,
        refusal: undefined,
      };
  }
}
