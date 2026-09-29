// The ways the transcript's window is not the whole session, said as notices.
//
// Three and not one, because a person's next move differs for each: a dropped row is
// the window's cap, a sequence that never arrived is the stream's, and a row sharing
// an identifier with one already drawn is the producer's. The dropped notice counts
// rows; the never-received one carries no count, because what a window knows about
// sequences it never received is that it was told of some.
//
// None of these is a read in flight, so none takes `not-loaded`, the skeleton that
// drops its second line. This module chooses the kind and writes the words; `Nothing`
// owns how a notice looks.

import { formatCount } from "@renderer/lib/wire-figures.js";
import { type NothingKind } from "@renderer/components/Nothing/Nothing.js";

/** One way this window is less than the session it is a window onto. */
export type WindowAbsence =
  /** Rows the window's cap pushed out as the session grew. */
  | { readonly kind: "dropped"; readonly count: number }
  /** Sequences the store was told of and never received. */
  | { readonly kind: "never-received" }
  /**
   * Rows that arrived under an identifier another row in this window carries.
   *
   * The notice says the collision and not what the window did about it, because the
   * window draws the repeat under a key of its own.
   */
  | { readonly kind: "duplicate-key"; readonly count: number };

/** What a notice renders as. */
export interface WindowAbsenceNotice {
  readonly kind: NothingKind;
  readonly title: string;
  readonly detail?: string;
}

/**
 * What a notice says, about `subject`: a lowercase plural noun phrase naming what the
 * window holds ("entries").
 */
export function windowAbsenceNotice(absence: WindowAbsence, subject: string): WindowAbsenceNotice {
  switch (absence.kind) {
    case "dropped":
      return {
        kind: "empty",
        title: `Older ${subject} are no longer in this window.`,
        detail: `${formatCount(absence.count)} left the window as the session grew. Nothing here fetches a range of the log, so there is nothing to press.`,
      };
    case "never-received":
      return { kind: "empty", title: `Some ${subject} never arrived.` };
    case "duplicate-key":
      return { kind: "empty", title: `Some ${subject} share an identifier.` };
  }
}

/**
 * Every notice worth showing, in the caller's order. A counted absence at zero says
 * nothing and is dropped here, so a caller hands over what it derived.
 */
export function windowAbsenceNotices(
  absences: readonly WindowAbsence[],
  subject: string,
): readonly WindowAbsenceNotice[] {
  return absences
    .filter((absence) => absence.kind === "never-received" || absence.count > 0)
    .map((absence) => windowAbsenceNotice(absence, subject));
}
