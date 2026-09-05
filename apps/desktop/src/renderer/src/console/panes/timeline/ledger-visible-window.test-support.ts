// The one log, and the two names, both visible-window suites are driven over.
//
// ONE HOME, because the two suites next door measure two different things about the
// same seam: `ledger-visible-window.test.ts` asks what the viewport's own reconciled
// window keeps and what it counts, and `ledger-rail-geometry.test.ts` asks where the
// rail puts a mark and a thumb over that window's ordering. A second session id or a
// second matching kind would be two fixture epochs, and a case comparing a figure
// derived under one against a figure derived under the other would be measuring the
// setup.

import { type ConsoleSessionEvent } from "../../store/index.js";
import { ledgerFixtureStampAt } from "./ledger-feed-logs.test-support.js";

export const VISIBLE_WINDOW_SESSION_ID = "session-visible-window";
/** Long enough that the cap has something to take, short enough to enumerate. */
export const LOG_EVENT_COUNT = 10;
/** What a capped viewport is left holding, so the difference is a real prune. */
export const RETAINED_ROW_COUNT = 4;
/** A query every row of the log below matches, so a walk is over the whole window. */
export const EVERY_ROW_QUERY = "user.message";

/** A log whose every row matches `EVERY_ROW_QUERY`, oldest first. */
export function syntheticLog(count: number): readonly ConsoleSessionEvent[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `event-${String(index)}`,
    sessionId: VISIBLE_WINDOW_SESSION_ID,
    sequence: index,
    kind: EVERY_ROW_QUERY,
    occurredAt: ledgerFixtureStampAt(index),
    payload: {},
  }));
}
