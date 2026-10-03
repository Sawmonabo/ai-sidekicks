// How complete the find walk is, in the shared partial-read vocabulary. The walk searches
// the window the viewport shows, which the cap and the folds cut short of the session;
// `useTranscriptFind.ts` counts the matches each hides. The reading is `cut` only when some
// match is unreached, and its figure is what the walk holds, not what was hidden.

import { type ReadingState } from "@renderer/lib/partial-read.js";

/**
 * The reading a find walk is, given what it reached and what it did not.
 *
 * `unreachedMatchCount` decides the arm and is never rendered; zero unreached is `served`.
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
