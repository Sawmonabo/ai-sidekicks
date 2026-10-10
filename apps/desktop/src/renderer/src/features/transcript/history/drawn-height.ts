// How tall the rows the feed would draw for a window are, before the feed has drawn them. The
// window is folded and filtered as the feed's own list is, and each row it would draw is estimated
// by the viewport's measurement table, so a stretch is counted in the same heights the window is
// laid out in rather than in rows.

import { DrawnRowFilter } from "../feed/drawn-rows.js";
import { estimatedRowHeightPxOf, runWindowMeasureOf } from "../feed/row-height-inputs.js";
import { RunGroupFold } from "../feed/run-group-fold.js";
import { RunCallWindows } from "../runs/call-window.js";
import { type TranscriptRowRenderer } from "../rows/renderer.js";
import { type TranscriptViewportBinding } from "../viewport/hooks/useTranscriptViewport.js";
import { type TranscriptWindowModel } from "../window/transcript-window.js";

/** What a window's rows are drawn and estimated by: the feed's own rules and the viewport's table. */
export interface DrawnHeightInputs {
  readonly estimatedRowHeightPx: TranscriptViewportBinding["estimatedRowHeightPx"];
  /** The viewport's height in pixels, which a long run's window is cut in. */
  readonly screenHeightPx: () => number;
  readonly drawsBody: TranscriptRowRenderer["drawsBody"];
  /** The run groups the reader folded; every other one draws open. */
  readonly foldedRunGroupKeys: ReadonlySet<string>;
  /** The calls the reader folded; every other call with a body draws open. */
  readonly foldedCallRowIds: ReadonlySet<string>;
}

/** The estimated height, in pixels, of the rows the feed would draw for an unfurled window. */
export function estimateDrawnHeightPx(
  unfurledWindow: TranscriptWindowModel,
  inputs: DrawnHeightInputs,
): number {
  // Rows read from history are drawn whole: none of them is still being revealed.
  const estimates = {
    estimatedRowHeightPx: inputs.estimatedRowHeightPx,
    screenHeightPx: inputs.screenHeightPx,
    foldedCallRowIds: inputs.foldedCallRowIds,
    isRevealing: isNeverRevealing,
  };
  // A long run draws its newest calls, as the feed's window opens on a run it has not windowed
  // before.
  const folded = new RunGroupFold().fold(unfurledWindow, inputs.foldedRunGroupKeys, {
    windows: new RunCallWindows(),
    measureOf: (model) => runWindowMeasureOf(model, estimates),
    moveCount: 0,
  }).window;
  const drawn = new DrawnRowFilter().filter(folded, inputs.drawsBody);
  let heightPx = 0;
  for (const row of drawn.viewportRows) {
    heightPx += estimatedRowHeightPxOf(drawn, estimates, row.key);
  }
  return heightPx;
}

function isNeverRevealing(): boolean {
  return false;
}
