// The one log the visible-window suite and the find walk beside it share. One session id and one
// matching kind, so figures derived in one are comparable with figures derived in the other.

import { type ProjectedSessionEvent } from "#renderer/store/session/entities/entities.js";
import {
  transcriptFixtureStampAt,
  transcriptFixtureStreamCursor,
} from "../transcript-logs.test-support.js";

/** Session id of the shared log. */
const VISIBLE_WINDOW_SESSION_ID = "session-visible-window";
/** Long enough that the cap has something to take, short enough to enumerate. */
export const LOG_EVENT_COUNT = 10;
/** What a capped viewport is left holding, so the difference is a real prune. */
export const RETAINED_ROW_COUNT = 4;
/** A query every row of the log below matches, so a walk is over the whole window. */
export const EVERY_ROW_QUERY = "user.message";

/** A log of `count` events, oldest first, every one matching {@link EVERY_ROW_QUERY}. */
export function syntheticEventLog(
  count: number,
  sessionId: string = VISIBLE_WINDOW_SESSION_ID,
): readonly ProjectedSessionEvent[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `event-${String(index)}`,
    sessionId,
    sequence: index,
    cursor: transcriptFixtureStreamCursor(index),
    kind: EVERY_ROW_QUERY,
    occurredAt: transcriptFixtureStampAt(index),
    payload: {},
  }));
}
