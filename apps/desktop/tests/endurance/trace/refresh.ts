// The display's refresh interval as the window's compositor records it in a trace, the one unit
// the frame-time and scrolling budgets are stated in.
//
// The renderer's compositor scheduler starts each frame from a begin-frame message that carries
// the display's own vsync interval, unthrottled, so the reading is the display's rate and never
// how often the app asked for frames.

import { medianOf } from "../../helpers/sample-statistics.js";
import type { TraceEvent } from "./recording.js";

/** The compositor scheduler's record of one begin-frame, in the `benchmark` category. */
const BEGIN_FRAME_RECORD = "Scheduler::BeginImplFrame";

const MICROSECONDS_PER_MILLISECOND = 1000;

/**
 * One refresh of the display the window drew on, in milliseconds: the median vsync interval the
 * compositor's begin-frames carried. Throws when the trace holds none, since no reading can then be
 * stated in refreshes.
 */
export function readRefreshIntervalMs(events: readonly TraceEvent[]): number {
  const intervalsUs: number[] = [];
  for (const event of events) {
    if (event.name !== BEGIN_FRAME_RECORD) {
      continue;
    }
    const beginFrame = event.args?.["args"] as { unthrottled_interval_us?: unknown } | undefined;
    if (typeof beginFrame?.unthrottled_interval_us === "number") {
      intervalsUs.push(beginFrame.unthrottled_interval_us);
    }
  }
  if (intervalsUs.length === 0) {
    throw new Error(
      `no ${BEGIN_FRAME_RECORD} record in the trace carried the display's vsync interval, so ` +
        "no reading can be stated in refreshes and none is compared",
    );
  }
  return medianOf(intervalsUs) / MICROSECONDS_PER_MILLISECOND;
}
