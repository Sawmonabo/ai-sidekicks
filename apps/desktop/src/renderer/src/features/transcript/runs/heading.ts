// A run group header's line, read once from the run group: who ran it, its newest state, the
// account it was billed to and how many entries it holds. The header draws it, and a copy of a
// header the window let go reads its text from the same reading, so both say the same words.

import { formatCount } from "#renderer/lib/wire/figures.js";
import { type RunGroup } from "./groups.js";

/** What a run group header's line draws, each part absent where the run group has none. */
export interface RunGroupHeading {
  readonly actorId: string | undefined;
  readonly runState: string | undefined;
  readonly payingAccountId: string | undefined;
  readonly entryCount: string;
  /** The word after the entry count, read with it: `" entry"` or `" entries"`. */
  readonly entryWord: string;
}

/** The words before the billed account. */
export const BILLED_TO_LABEL = "billed to ";

/** The line a run group header draws, counting the whole stretch, in its window or not. */
export function runGroupHeadingOf(runGroup: RunGroup): RunGroupHeading {
  const entryCount = runGroup.drawnRowPositions.length;
  return {
    actorId: runGroup.actorId,
    runState: runGroup.runStateEventType,
    payingAccountId: runGroup.payingAccountId,
    entryCount: formatCount(entryCount),
    entryWord: entryCount === 1 ? " entry" : " entries",
  };
}

/** The line's words as one string, in the order the header draws them. */
export function runGroupHeadingText(heading: RunGroupHeading): string {
  return [
    ...(heading.actorId === undefined ? [] : [heading.actorId]),
    ...(heading.runState === undefined ? [] : [heading.runState]),
    ...(heading.payingAccountId === undefined ? [] : [BILLED_TO_LABEL + heading.payingAccountId]),
    heading.entryCount + heading.entryWord,
  ].join(" ");
}
