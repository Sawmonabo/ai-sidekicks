// The ways a WINDOW is not the whole of what it is a window onto.
//
// Beside `partial-read.ts` and deliberately not inside it. That module is about a
// READ: how completely the answer a surface asked for came back. This one is about a
// window's own cap — rows the log still holds and this viewport does not, because
// the cap took them, because a replay position is parked in front of them, or
// because this build recognised no category for them. Folding these into
// `ReadingState` would have made "the read was short" and "you are looking through a
// smaller opening than the thing behind it" one word, and they are not: the first is
// about trusting what is on screen, the second about where the rest of it is and
// whether anything brings it back.
//
// FOUR SENTENCES AND NOT ONE, because a person's next move differs for each. An
// unrecognised type is this build's limit. A dropped row is the window's cap, and
// nothing here fetches a range of the log, so there is nothing to press. A row ahead
// of a replay position is a control they are holding, and scrubbing forward is the
// act. A sequence that never arrived is the stream's, and it comes back only when the
// whole is read again. Collapsing any two tells somebody the console failed where it
// merely stopped holding, or the reverse — and collapsing the middle two told them
// rows they could scrub back to in one keystroke were gone for good.
//
// THREE COUNT AND ONE DOES NOT, and that asymmetry is the wire's rather than a
// shortcut. A window can count the rows it dropped and the rows it is withholding;
// what it knows about sequences it never received is that it was told of some, which
// is a fact with no figure in it. The arm carries no count rather than carrying a
// zero or inventing one.
//
// AND THE COUNTLESS ONE NAMES WHOSE NUMBERING IT IS. A window scoped to PART of a
// stream — one channel of a session's entries — has a subject that is the part and a
// sequence that belongs to the whole, so a sentence built from the subject alone
// attributes the gap to the wrong stream and tells somebody this channel lost rows
// when the session's numbering is what has a hole in it. The arm takes an optional
// producer noun for exactly that, and the sentence is the same shape with it and
// without: naming the producer REPLACES the generic word rather than adding a clause,
// which is why one arm serves both callers instead of two arms drifting apart.
//
// THE SHAPES ARE RULE 8'S ABSENCES, AND NONE OF THESE IS A READ IN FLIGHT. That
// matters because `not-loaded` is a skeleton: it announces its title rather than
// setting it and drops the second line entirely, which is right for a read that will
// be replaced a beat later and wrong for a settled fact about a window nothing is
// going to change. Every sentence here has a second line that carries the act — scrub
// forward, or nothing to press — so the three that are answers take `empty` and the
// one that is not takes `not-checked`: an entry this build has no category for is not
// a read that came back short, it is a question nobody could put. This module chooses
// the kind and writes the words; `Nothing` owns how an absence looks. The figure goes
// through the figures chokepoint and then into prose, because an absence's second
// line is a sentence and not a slot: that is the honest limit of the shape, and the
// alternative is a second rendering of the one absence this console already has.

import { formatCount } from "./wire-figures.js";
import { type NothingKind } from "./Nothing.js";

/**
 * Closed. The tuple is the declaration and the union follows from it, so a claim
 * about the SET is countable at runtime and a fifth narrowing added to a caller's
 * pipeline is a compile error here rather than a row that silently renders the
 * fourth one's sentence.
 */
export const WINDOW_ABSENCE_KINDS = [
  "unprojectable",
  "dropped",
  "withheld-by-replay",
  "never-received",
] as const;

export type WindowAbsenceKind = (typeof WINDOW_ABSENCE_KINDS)[number];

/** One way this window is less than the thing it is a window onto. */
export type WindowAbsence =
  /** Entries this build registers no category for, so they are placed nowhere. */
  | { readonly kind: "unprojectable"; readonly count: number }
  /** Entries the window's cap pushed out as the session grew. */
  | { readonly kind: "dropped"; readonly count: number }
  /** Entries this window holds and is not showing, because a replay is parked. */
  | { readonly kind: "withheld-by-replay"; readonly count: number }
  /**
   * The producer numbered entries this window never received.
   *
   * No count: a gap in a sequence says that something is missing and not how much,
   * and a figure here would be one the console made up.
   *
   * `producer` names WHOSE numbering the gap is in, as a lowercase SINGULAR noun —
   * "session", "relay". A window onto part of a stream needs it, for the reason this
   * module's header gives; it is omitted where the window has one producer and
   * naming it would say nothing, and the sentence then reads as it always has.
   */
  | { readonly kind: "never-received"; readonly producer?: string };

/** What an absence renders as: rule 8's shape, and the two lines this module writes. */
export interface WindowAbsenceNotice {
  readonly kind: NothingKind;
  readonly title: string;
  readonly detail: string;
}

/** What the sentence calls a producer the caller did not name. */
const UNNAMED_PRODUCER = "producer";

/**
 * The noun the never-received sentence opens with.
 *
 * A blank name is not a name: an unnamed producer and one named `"   "` are the same
 * fact, and rendering the second would leave "The  numbered entries" on screen. So
 * an empty name falls back to the generic noun rather than to a broken sentence —
 * the posture `core/refusal.ts` takes for every other caller-supplied identifier.
 */
function producerNoun(named: string | undefined): string {
  const trimmed = named?.trim() ?? "";
  return trimmed.length === 0 ? UNNAMED_PRODUCER : trimmed;
}

/**
 * What an absence says of itself, about `subject`.
 *
 * `subject` is a lowercase PLURAL noun phrase naming what the window holds —
 * "entries", "rows", "deliveries". Plural because every sentence here is about some
 * of them, and mid-sentence in every arm for the reason `partial-read.ts` gives:
 * a caller that capitalized it in one place and not another is the drift these
 * modules exist to remove.
 *
 * Total over `WindowAbsence` by construction, so a fifth kind fails to compile here
 * before it can reach a surface that renders it as one of the other four.
 */
export function windowAbsenceNotice(absence: WindowAbsence, subject: string): WindowAbsenceNotice {
  switch (absence.kind) {
    case "unprojectable":
      return {
        // `not-checked` and not `error`: nothing failed. The question of what these
        // are was never put, because this build has nothing to put it to.
        kind: "not-checked",
        title: `Some ${subject} could not be placed.`,
        detail: `${formatCount(absence.count)} arrived with a type this build does not recognise, so they are not shown.`,
      };
    case "dropped":
      return {
        // `empty` and not `not-loaded`: nothing is in flight. This is what the window
        // settled on, and the second line is where the reason lives.
        kind: "empty",
        title: `Older ${subject} are no longer in this window.`,
        detail: `${formatCount(absence.count)} left the window as the session grew. Nothing here fetches a range of the log, so there is nothing to press.`,
      };
    case "withheld-by-replay":
      return {
        kind: "empty",
        title: `Later ${subject} are behind the replay position.`,
        detail: `${formatCount(absence.count)} in this window come after where the replay is parked. Scrub forward, or play on, and they come back.`,
      };
    case "never-received":
      return {
        kind: "empty",
        title: `Some ${subject} never arrived.`,
        detail: `The ${producerNoun(absence.producer)} numbered ${subject} this window did not receive. They come back only when the whole of it is read again; no read here fetches a range.`,
      };
  }
}

/**
 * Every absence worth saying out loud, in the order the caller holds them.
 *
 * The door, for the reason `partialReadNotices` is one: a window learns each of these
 * from a different part of its own pipeline and owes a person all of them at once. A
 * counted absence at zero is dropped here rather than at each call site — a sentence
 * about no rows is a sentence about nothing — so a caller hands over what it derived
 * and this decides what there is to say.
 */
export function windowAbsenceNotices(
  absences: readonly WindowAbsence[],
  subject: string,
): readonly WindowAbsenceNotice[] {
  return absences
    .filter((absence) => absence.kind === "never-received" || absence.count > 0)
    .map((absence) => windowAbsenceNotice(absence, subject));
}
