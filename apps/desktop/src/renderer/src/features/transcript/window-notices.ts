// The way the transcript's window is not the whole session, said as a notice.
//
// One kind today: rows the window's cap let go as the session grew, counted. The notice
// sits at the top of the history that is loaded, where the control that loads earlier
// history will stand. What a window never received is said once, under the session
// header, and a row that shares an identifier is the producer's fault and goes to the
// diagnostic capture; neither is a notice here.
//
// None of these is a read in flight, so none takes `not-loaded`, the skeleton that
// drops its second line. This module chooses the kind and writes the words; `Nothing`
// owns how a notice looks.

import { formatCount } from "@renderer/lib/wire-figures.js";
import { type NothingKind } from "@renderer/components/Nothing/Nothing.js";

/** One way this window is less than the session it is a window onto. */
export type WindowAbsence =
  /** Rows the window's cap pushed out as the session grew. */
  { readonly kind: "dropped"; readonly count: number };

/** What a notice renders as. */
export interface WindowNoticeText {
  readonly kind: NothingKind;
  readonly title: string;
  readonly detail?: string;
}

/**
 * What a notice says, about `subject`: a lowercase plural noun phrase naming what the
 * window holds ("entries").
 */
export function buildWindowNoticeText(absence: WindowAbsence, subject: string): WindowNoticeText {
  return {
    kind: "empty",
    title: `Older ${subject} are no longer in this window.`,
    detail: `${formatCount(absence.count)} left the window as the session grew. Nothing here fetches a range of the log, so there is nothing to press.`,
  };
}

/**
 * Every notice worth showing, in the caller's order. A counted absence at zero says
 * nothing and is dropped here, so a caller hands over what it derived.
 */
export function buildWindowNoticeTexts(
  absences: readonly WindowAbsence[],
  subject: string,
): readonly WindowNoticeText[] {
  return absences
    .filter((absence) => absence.count > 0)
    .map((absence) => buildWindowNoticeText(absence, subject));
}
