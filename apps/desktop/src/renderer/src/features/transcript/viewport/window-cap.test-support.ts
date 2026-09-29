// The synthetic logs both window-cap suites are driven over, and the conditions a
// prune is asked under.
//
// SHARED RATHER THAN COPIED. `window-cap.test.ts` is about the cap, its refusals and
// the reading floor; `window-cap.test.ts` is about the seam to the lease table
// and the rules that decide what COUNTS as one row. Both need the same ten-thousand-row
// log and the same all-clear conditions, and a second copy of either is a second
// answer to what the window is being shown.
//
// Ten thousand rows because the properties that matter — that children never trip the
// cap, that a closure never orphans, that a held row survives however old it is — are
// all invisible at a hundred and all obvious at ten thousand. The logs are generated,
// so a case states the shape it is testing rather than hiding it in a fixture.

import { TranscriptWindow, type PruneConditions } from "./window-cap.js";
import type { WindowRow } from "./window-cap.js";

/** Top-level rows in the log {@link loadedWindow} is built over. */
export const TOP_LEVEL_ROW_COUNT = 10_000;

/** Children hanging from each run group in that log. */
export const CHILDREN_PER_RUN_GROUP = 3;

/** A log of run groups, each with children, oldest first. */
export function syntheticWindowRows(topLevelCount: number): readonly WindowRow[] {
  const rows: WindowRow[] = [];
  for (let index = 0; index < topLevelCount; index += 1) {
    const key = `run-group-${String(index)}`;
    rows.push({ key, parentKey: undefined, rootCursor: `cursor-${String(index)}` });
    for (let child = 0; child < CHILDREN_PER_RUN_GROUP; child += 1) {
      rows.push({
        key: `${key}-child-${String(child)}`,
        parentKey: key,
        rootCursor: `cursor-${String(index)}`,
      });
    }
  }
  return rows;
}

/**
 * A log of FOLDED run groups, as the transcript emits one: a header row keyed by the run,
 * and the terminal receipt hanging from it.
 *
 * The shape `foldRunGroupHeaders` produces. It is here rather than in the transcript's
 * own suite because what it exercises is the CAP's counting rule, and the rule only
 * became reachable when a row started existing for the key every run row names.
 */
export function foldedRunGroupLog(runGroupCount: number): readonly WindowRow[] {
  const rows: WindowRow[] = [];
  for (let index = 0; index < runGroupCount; index += 1) {
    const runKey = `run-${String(index)}`;
    rows.push({ key: runKey, parentKey: undefined, rootCursor: runKey });
    rows.push({
      key: `${runKey}-receipt`,
      parentKey: runKey,
      rootCursor: `cursor-${String(index)}`,
    });
  }
  return rows;
}

/** A log whose every row names one run, and where no row IS that run. */
export function runOnlyLog(entryCount: number): readonly WindowRow[] {
  return Array.from({ length: entryCount }, (_unused, index) => ({
    key: `run-1-entry-${String(index)}`,
    parentKey: "run-1",
    rootCursor: `cursor-${String(index)}`,
  }));
}

/** Conditions under which nothing refuses a prune: the all-clear. */
export const PRUNABLE: PruneConditions = {
  hasActiveTurn: false,
  scrollControllerVetoes: false,
  revealDrainInFlight: false,
  pinnedRootCursor: undefined,
  heldRowKeys: [],
  readingFloorRowKey: undefined,
};

/** A window holding the whole synthetic log, well over its own cap. */
export function loadedWindow(): TranscriptWindow {
  const window = new TranscriptWindow();
  window.ingest(syntheticWindowRows(TOP_LEVEL_ROW_COUNT));
  return window;
}
