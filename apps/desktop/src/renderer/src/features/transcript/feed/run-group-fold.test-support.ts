// Run window inputs for a fold driven with no viewport: every run whole, runs cut in a fixed
// measure, or runs held where another fold's windows stood.

import { RunCallWindows, type RunCallWindow, type RunWindowMeasure } from "../runs/call-window.js";
import { type RunGroup } from "../runs/groups.js";
import { type TranscriptWindowModel } from "../window/transcript-window.js";
import { type RunWindowInputs } from "./run-group-fold.js";

/** Each open run group's window as one fold resolved it, by the row its header stands above. */
export type RunWindowPositions = ReadonlyMap<string, RunCallWindow>;

/**
 * Inputs that draw every run whole, under a screen no run outgrows, for a test whose subject is
 * not the run window. One object per held fold, so the fold can apply growth in place.
 */
export function wholeRunWindowInputs(): RunWindowInputs {
  return measuredRunWindowInputs({
    screenHeightPx: () => Number.POSITIVE_INFINITY,
    rowHeightPx: () => 1,
  });
}

/** Inputs that cut each run in `measure`, over windows no reader has moved. */
export function measuredRunWindowInputs(
  measure: RunWindowMeasure,
): RunWindowInputs & { readonly windows: RunCallWindows } {
  return { windows: new RunCallWindows(), measureOf: () => measure, moveCount: 0 };
}

/**
 * A copy of the windows `windows` last resolved for `model`'s run groups. Keyed by header row,
 * which a second derivation of the same log shares though it mints its own group keys.
 */
export function runWindowPositionsOf(
  windows: RunCallWindows,
  model: TranscriptWindowModel,
): RunWindowPositions {
  const positions = new Map<string, RunCallWindow>();
  for (const runGroup of model.runGroupByHeaderKey.values()) {
    const window = windows.resolvedWindowOf(runGroup.key);
    if (window !== undefined) {
      positions.set(runGroup.headerRowId, { ...window });
    }
  }
  return positions;
}

/** Inputs that hold each run's window where `positions` says, reading and changing nothing else. */
export function fixedRunWindowInputs(positions: RunWindowPositions): RunWindowInputs {
  return {
    windows: new FixedRunWindows(positions),
    measureOf: () => ({ screenHeightPx: () => 0, rowHeightPx: () => 0 }),
    moveCount: 0,
  };
}

/** Windows that stand where a copy of another fold's stood; a group the copy lacks throws. */
class FixedRunWindows {
  readonly #positions: RunWindowPositions;

  public constructor(positions: RunWindowPositions) {
    this.#positions = positions;
  }

  public windowOf(runGroup: RunGroup): RunCallWindow {
    const window = this.#positions.get(runGroup.headerRowId);
    if (window === undefined) {
      throw new Error(`no window was copied for the run group above ${runGroup.headerRowId}`);
    }
    return window;
  }

  public keepOnly(): void {
    // A copy holds no group to forget.
  }
}
