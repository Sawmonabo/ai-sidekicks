// Notice text for the ways the transcript window is less than the session. One kind today: rows
// the window cap dropped as the session grew. A repeated row id goes to the diagnostic capture
// (`useDuplicateRowKeyCapture`), not to a notice.

import { formatCount } from "@renderer/lib/wire-figures.js";
import { type NothingKind } from "@renderer/components/Nothing/Nothing.js";

/** One way the window holds less than the session. */
export type WindowAbsence =
  /** Rows the window cap dropped as the session grew. */
  { readonly kind: "dropped"; readonly count: number };

/** The kind and words of one notice. */
export interface WindowNoticeText {
  readonly kind: NothingKind;
  readonly title: string;
  readonly detail?: string;
}

/**
 * The notice for one absence. `subject` is a lowercase plural noun phrase naming what the window
 * holds ("entries").
 */
export function buildWindowNoticeText(absence: WindowAbsence, subject: string): WindowNoticeText {
  return {
    kind: "empty",
    title: `Older ${subject} are no longer in this window.`,
    detail: `${formatCount(absence.count)} left the window as the session grew. Nothing here fetches a range of the log, so there is nothing to press.`,
  };
}

/** The notices worth showing, in the caller's order; an absence counted at zero yields none. */
export function buildWindowNoticeTexts(
  absences: readonly WindowAbsence[],
  subject: string,
): readonly WindowNoticeText[] {
  return absences
    .filter((absence) => absence.count > 0)
    .map((absence) => buildWindowNoticeText(absence, subject));
}
