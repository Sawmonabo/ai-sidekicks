// How complete the find walk is, said in the console's own vocabulary.
//
// The walk searches the window the viewport is showing and never the log, because a
// match it offers to jump to has to be a row the viewport can reach. Two things cut
// that window short of the session — the cap, which drops the oldest rows for good,
// and the replay position, which withholds the rows ahead of it — and `ledger-find.ts`
// counts the matches each one hides.
//
// A COUNT OF WHAT IS HIDDEN IS NOT A NOTICE. This ledger wrote two of its own, and
// six families wrote their own beside them, which is the drift `primitives/partial-read.ts`
// exists to end: the reading is `cut` — an enumeration the producer stopped short —
// and the shared sentence says so once. What this module decides is the only thing
// left to decide, which is WHETHER the walk was cut at all.
//
// THE FIGURE IS WHAT WAS READ AND NOT WHAT WAS HIDDEN, which is the shared shape's
// rule and costs this ledger something real: its own notices named how many matches
// lay outside, and `cut` names how many lay inside. That is the honest limit of a
// sentence six families share, and it is worth less than a seventh copy of it. The
// count that decides the arm is still the hidden one, so a walk that reaches every
// match says nothing at all.

import { type ReadingState } from "../../primitives/index.js";

/**
 * The reading a find walk is, given what it reached and what it did not.
 *
 * `servedMatchCount` is what the walk holds — the figure the notice leads with —
 * and `unreachedMatchCount` is what lies outside it, which decides the arm and is
 * never rendered. Zero unreached is `served`: the walk answered the whole question,
 * and a surface that mounts this then renders nothing.
 */
export function matchWalkReading(
  servedMatchCount: number,
  unreachedMatchCount: number,
): ReadingState {
  if (unreachedMatchCount < 1) {
    return { kind: "served" };
  }
  return { kind: "cut", servedCount: servedMatchCount };
}
