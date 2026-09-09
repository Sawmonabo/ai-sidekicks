// How this window says what is waiting behind the prompt on screen.
//
// ONE MODULE BECAUSE THE FIGURE HAS TWO READERS AND ONE HONESTY PROBLEM. The window's
// notice and the confirmation's footnote both count what is behind the head, and both
// composed that sentence themselves off `waitingBehind` alone — an exact figure over a
// BOUNDED queue. `pending-invite-arrivals.ts` turns arrivals away past that bound and
// records the debt on a second member, `hasDeferredArrivals`, which the count
// deliberately excludes: the queue holds eight, so a window holding eleven printed
// "8 invitations are waiting" while main still held three for the replay, and a person
// read a floor as a total. Both readers now take their figure from here, and here it
// is a floor whenever the window is holding more than it can show — "at least 8" is a
// claim this queue can keep and "8" is not.
//
// THE FLOOR IS IN THE FIGURE RATHER THAN IN A CLAUSE BESIDE IT. A trailing sentence
// saying more had arrived would leave the number itself reading as complete, and the
// number is what a person scanning a notice takes away. It also collapses the awkward
// arm: a debt recorded while the count reads zero — which the machine reaches only
// through a reading taken before the release that clears it — states "at least 1"
// rather than "0 more, and also more", because one arrival held back is exactly what
// the debt means.
//
// EVERY FIGURE THROUGH `formatCount`, the console's one reading of a quantity
// (`primitives/figures/wire-figures.ts`). A `String(count)` here would be this family deciding
// how a number looks, in a locale it does not know.

import { formatCount } from "../../primitives/index.js";
import type { PendingInviteSnapshot } from "./pending-invite-reading.js";

/**
 * What a surface needs to say how much is waiting: the count, and whether it is all.
 *
 * The two members read together and never apart — which is the whole finding — so they
 * travel as one value rather than as two arguments a caller can pass one of.
 */
export type InviteQueueReading = Pick<
  PendingInviteSnapshot,
  "waitingBehind" | "hasDeferredArrivals"
>;

/**
 * The notice's own sentence about the head, whichever of the two states it is in.
 *
 * The two readings are genuinely different claims and neither can stand in for the
 * other: "an invitation is waiting" is an offer, and "a link did not open" is a
 * report. The count rides both, because a person deciding whether to look now is
 * deciding about the queue rather than about its first entry.
 */
export function inviteNoticeLede(snapshot: PendingInviteSnapshot): string {
  if (snapshot.invite === undefined) {
    const behind = waitingCount(snapshot, snapshot.waitingBehind);
    return behind.count === 0
      ? UNOPENED_LINK_LEDE
      : `${UNOPENED_LINK_LEDE} There ${behind.count === 1 ? "is" : "are"} ${behind.figure} more waiting.`;
  }
  // The head is one of them, so the notice counts it: what a person is being told is
  // how many invitations this window is holding, not how many are queued behind the
  // one it would open.
  const waiting = waitingCount(snapshot, snapshot.waitingBehind + 1);
  if (waiting.count === 1 && !snapshot.hasDeferredArrivals) {
    return "You have an invitation waiting.";
  }
  return `You have ${waiting.figure} ${waiting.count === 1 ? "invitation" : "invitations"} waiting.`;
}

/**
 * What the confirmation's footnote adds about the queue, or `undefined` where nothing
 * is behind the prompt at all.
 *
 * `undefined` rather than an empty sentence, so the caller composes one string and
 * never a trailing space: what is absent here is a whole clause and not a blank one.
 */
export function waitingBehindSentence(reading: InviteQueueReading): string | undefined {
  const behind = waitingCount(reading, reading.waitingBehind);
  if (behind.count === 0) {
    return undefined;
  }
  const noun = behind.count === 1 ? "invitation" : "invitations";
  return `There ${behind.count === 1 ? "is" : "are"} ${behind.figure} more ${noun} behind it.`;
}

/** The report's opening sentence about a deep link that produced no invitation. */
const UNOPENED_LINK_LEDE = "An invitation link did not open.";

/**
 * One waiting figure and the number its words have to agree with.
 *
 * The two travel together because the floor moves both: "at least 1" is plural in
 * neither its noun nor its verb, and a caller that took the string alone would have to
 * re-derive the number the string was built from.
 */
interface WaitingCount {
  /** The figure as it is printed, marked as a floor where the window holds more. */
  readonly figure: string;
  /** What the figure counts, for the noun and the verb beside it. */
  readonly count: number;
}

function waitingCount(reading: InviteQueueReading, counted: number): WaitingCount {
  if (!reading.hasDeferredArrivals) {
    return { figure: formatCount(counted), count: counted };
  }
  // At least one arrival is held back, so a zero reads as one: the debt is recorded
  // when the bound turns an arrival away, and that arrival is waiting whether or not
  // anything else is.
  const floor = Math.max(counted, 1);
  return { figure: `at least ${formatCount(floor)}`, count: floor };
}
