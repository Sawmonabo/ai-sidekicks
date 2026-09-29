// How complete the find walk is, said in the console's own vocabulary.
//
// The walk searches the window the viewport is showing and never the log, because a
// match it offers to jump to has to be a row the viewport can reach. Two things cut
// that window short of the session — the cap, which drops the oldest rows for good,
// and the two folds, which hold rows behind a run group header or a rewound band — and
// `useTranscriptFind.ts` counts the matches each one hides.
//
// A COUNT OF WHAT IS HIDDEN IS NOT A NOTICE. Every feature says a list was cut short
// through the one shared reading in `lib/partial-read.ts`: the reading is `cut` — an
// enumeration the producer stopped short — and the shared sentence says so once. What this module decides is the only thing
// left to decide, which is WHETHER the walk was cut at all.
//
// THE FIGURE IS WHAT WAS READ AND NOT WHAT WAS HIDDEN, which is the shared shape's
// rule and costs this transcript something real: `cut` names how many matches lay inside,
// not how many lay outside. That is the honest limit of a sentence every feature shares,
// and it is worth less than a second copy of it. The
// count that decides the arm is still the hidden one, so a walk that reaches every
// match says nothing at all.

import { type ReadingState } from "@renderer/lib/partial-read.js";

/**
 * The reading a find walk is, given what it reached and what it did not.
 *
 * `servedMatchCount` is what the walk holds — the figure the notice leads with —
 * and `unreachedMatchCount` is what lies outside it, which decides the arm and is
 * never rendered. Zero unreached is `served`: the walk answered the whole question,
 * and a view that mounts this then renders nothing.
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
