// The one log, and the two names, the visible-window suite is driven over.
//
// ONE HOME, because the suite next door and the find walk beside it measure two
// different things about the same seam: what the viewport's own reconciled window
// keeps, and what a query over it counts. A second session id or a second matching
// kind would be two fixture epochs, and a case comparing a figure derived under one
// against a figure derived under the other would be measuring the setup.

import { type ConsoleSessionEvent } from "../../../store/index.js";
import { ledgerFixtureStampAt } from "../feed/ledger-feed-logs.test-support.js";

export const VISIBLE_WINDOW_SESSION_ID = "session-visible-window";
/** Long enough that the cap has something to take, short enough to enumerate. */
export const LOG_EVENT_COUNT = 10;
/** What a capped viewport is left holding, so the difference is a real prune. */
export const RETAINED_ROW_COUNT = 4;
/** A query every row of the log below matches, so a walk is over the whole window. */
export const EVERY_ROW_QUERY = "user.message";

/**
 * A log whose every row matches {@link EVERY_ROW_QUERY}, oldest first.
 *
 * ONE HOME FOR THIS ROLE. Three suites held this builder verbatim, differing only in
 * the session id, and two of them called it `syntheticLog` beside a `syntheticLog` in
 * `frame/viewport/` that answers with window ROWS — so which one an import resolved to
 * was a question about the specifier rather than about the name. Named for the log it
 * opens, and the one axis the copies differed on is a parameter.
 */
export function syntheticEventLog(
  count: number,
  sessionId: string = VISIBLE_WINDOW_SESSION_ID,
): readonly ConsoleSessionEvent[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `event-${String(index)}`,
    sessionId,
    sequence: index,
    kind: EVERY_ROW_QUERY,
    occurredAt: ledgerFixtureStampAt(index),
    payload: {},
  }));
}
