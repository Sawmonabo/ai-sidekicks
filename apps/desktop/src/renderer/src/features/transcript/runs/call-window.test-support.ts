// A long run for the cases about its window: one run's tool calls, each named for its place, with
// a row that draws nothing at a steady interval, so a count that takes rows for calls is wrong.

import { type ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { SessionStore } from "#renderer/store/session/store.js";
import {
  LIVE_RUN_ID,
  SESSION_ID,
  transcriptFixtureEventId,
  transcriptFixtureStampAt,
  transcriptFixtureStreamCursor,
} from "../logs.test-support.js";
import { type TranscriptWindowModel } from "../window/transcript-window.js";
import { type RunGroup } from "./groups.js";

/** How often a long run holds a running row, which joins the run but draws nothing. */
const LONG_RUN_UNDRAWN_INTERVAL = 10;

/**
 * The first `eventCount` events of one live run: tool calls named `tool_<index>`, with every
 * `LONG_RUN_UNDRAWN_INTERVAL`th a running row.
 */
export function longRunEvents(eventCount: number): readonly ProjectedSessionEvent[] {
  return Array.from({ length: eventCount }, (_unused, index) => ({
    id: transcriptFixtureEventId(index),
    sessionId: SESSION_ID,
    sequence: index,
    cursor: transcriptFixtureStreamCursor(index),
    kind:
      index % LONG_RUN_UNDRAWN_INTERVAL === LONG_RUN_UNDRAWN_INTERVAL - 1
        ? "run.running"
        : "tool.invoked",
    occurredAt: transcriptFixtureStampAt(index),
    payload: {
      sessionId: SESSION_ID,
      runId: LIVE_RUN_ID,
      toolName: `tool_${String(index)}`,
      toolCallId: `call-${String(index)}`,
    },
    runStamp: { position: index, epoch: 0 },
  }));
}

/** The ids of the tool calls among `events`: the run's drawn calls, in order. */
export function longRunCallIds(events: readonly ProjectedSessionEvent[]): readonly string[] {
  return events.filter((event) => event.kind === "tool.invoked").map((event) => event.id);
}

/** A store holding the first `eventCount` events of the long run. */
export function openSessionStoreWithLongRun(eventCount: number): SessionStore {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialize({ cursor: -1, entities: [] });
  sessionStore.applyBatch(longRunEvents(eventCount));
  return sessionStore;
}

/** The one run group a window of one unbroken run holds, or throws where it holds another count. */
export function onlyRunGroupOf(model: TranscriptWindowModel): RunGroup {
  const [runGroup, ...others] = model.runGroupByHeaderKey.values();
  if (runGroup === undefined || others.length > 0) {
    throw new Error("the window does not hold exactly one run group");
  }
  return runGroup;
}
