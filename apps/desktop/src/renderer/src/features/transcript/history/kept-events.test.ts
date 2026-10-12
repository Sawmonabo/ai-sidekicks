// What a long run's header and edge lines count once the store lets go of the calls its window
// leaves out, and once they are read back: the same figures throughout.

import { describe, expect, it } from "vitest";

import { type ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { type ReleasedEventStretch } from "#renderer/store/session/state.js";
import { SessionStore } from "#renderer/store/session/store.js";
import { RunGroupFold } from "../feed/run-group-fold.js";
import { SESSION_ID, transcriptFixtureStreamCursor } from "../logs.test-support.js";
import { RunCallWindows, runWindowEdgeKey, type RunWindowMeasure } from "../runs/call-window.js";
import { longRunEvents, onlyRunGroupOf } from "../runs/call-window.test-support.js";
import { runGroupHeadingOf } from "../runs/heading.js";
import { TranscriptWindowDerivation } from "../window/transcript-window.js";
import { keptEventCursors } from "./kept-events.js";

/** The run's own events, between the person's two messages. */
const RUN_EVENT_COUNT = 400;
/** A screen ten calls tall. */
const MEASURE: RunWindowMeasure = { screenHeightPx: () => 100, rowHeightPx: () => 10 };

/** The long run of `runEventCount` events between two messages of the person. */
function runBetweenMessages(runEventCount: number): readonly ProjectedSessionEvent[] {
  const events = longRunEvents(runEventCount + 2);
  return [messageOf(events[0]!), ...events.slice(1, -1), messageOf(events.at(-1)!)];
}

/** `event` as a message of the person, at its place in the log. */
function messageOf(event: ProjectedSessionEvent): ProjectedSessionEvent {
  return {
    id: event.id,
    sessionId: event.sessionId,
    sequence: event.sequence,
    cursor: event.cursor,
    kind: "user.message",
    occurredAt: event.occurredAt,
    payload: { message: "user.message" },
  };
}

/** A store holding `events`, as the stream delivered them. */
function storeHolding(events: readonly ProjectedSessionEvent[]): SessionStore {
  const store = new SessionStore({ sessionId: SESSION_ID });
  store.initialize({ shape: "project", cursor: -1, entities: [] });
  store.applyBatch(events);
  return store;
}

describe("letting go of the calls a long run's window leaves out", () => {
  it("keeps the header's entries and both edges' counts, through the release and read-back", () => {
    const events = runBetweenMessages(RUN_EVENT_COUNT);
    const store = storeHolding(events);
    const derivation = new TranscriptWindowDerivation();
    const windows = new RunCallWindows();
    const derive = () =>
      derivation.derive(store.snapshot().transcript, store.snapshot().partitions.run);
    const figures = () => {
      const runGroup = onlyRunGroupOf(derive());
      const window = windows.windowOf(runGroup, MEASURE);
      return {
        entries: runGroupHeadingOf(runGroup).entryCount,
        earlier: window.earlierCount,
        later: window.laterCount,
        releasedEarlier: runGroup.releasedEarlier?.count,
        releasedLater: runGroup.releasedLater?.count,
      };
    };
    // A press on the earlier edge leaves calls out of the window on both sides.
    const model = derive();
    windows.openStretch(onlyRunGroupOf(model), "earlier", MEASURE);
    const before = figures();
    expect(before.earlier).toBeGreaterThan(0);
    expect(before.later).toBeGreaterThan(0);

    const drawn = new RunGroupFold().fold(model, new Set(), {
      windows,
      measureOf: () => MEASURE,
      moveCount: 0,
    }).window;
    const kept = keptEventCursors([], drawn.viewportRows, {
      unfurledWindow: model,
      transcriptWindow: drawn,
      log: store.snapshot().transcript,
      callWindowOf: (runGroupKey) => windows.resolvedWindowOf(runGroupKey),
    });
    expect(kept?.releasedBetween).toHaveLength(2);
    store.releaseOutside(kept!.firstKeptCursor, kept!.lastKeptCursor, kept!.releasedBetween);
    const released = figures();
    expect(store.snapshot().transcript.length).toBeLessThan(events.length / 2);
    expect(released).toEqual({
      ...before,
      releasedEarlier: before.earlier,
      releasedLater: before.later,
    });

    // The earlier stretch read back a page at a time, nearest the window first, then the later.
    const pageInside = (
      stretch: ReleasedEventStretch,
      direction: "backward" | "forward",
      rowLimit: number,
    ) => {
      const upperSequence = events.find(
        (event) => event.cursor === stretch.firstHeldCursorAfter,
      )!.sequence;
      const inside = events.filter(
        (event) =>
          event.sequence > stretch.lastHeldSequenceBefore && event.sequence < upperSequence,
      );
      const pageEvents =
        direction === "backward" ? inside.slice(-rowLimit) : inside.slice(0, rowLimit);
      store.readReleasedStretch(stretch, direction, {
        events: pageEvents,
        edge: { cursor: undefined, hasMore: pageEvents.length < inside.length },
        runs: [],
      });
    };
    const [earlierStretch, laterStretch] = store.snapshot().releasedStretches;
    pageInside(earlierStretch!, "backward", 30);
    const partly = figures();
    expect(partly).toMatchObject({ entries: before.entries, earlier: before.earlier });
    expect(partly.releasedEarlier).toBeLessThan(before.earlier);
    pageInside(store.snapshot().releasedStretches[0]!, "backward", RUN_EVENT_COUNT);
    pageInside(laterStretch!, "forward", RUN_EVENT_COUNT);

    expect(store.snapshot().releasedStretches).toEqual([]);
    expect(store.snapshot().transcript.length).toBe(events.length);
    expect(figures()).toEqual(before);
  });

  it("keeps a notification in the stretch whose cards before it were let go", () => {
    // Five calls, a notice that the context was compacted, four more calls.
    const runEvents = runBetweenMessages(10).map((event) =>
      event.sequence === 6
        ? { ...event, kind: "usage.context_compacted", payload: { ...event.payload } }
        : event,
    );
    const [message, ...rest] = runEvents;
    const notice = runEvents[6]!;
    const store = storeHolding(runEvents);
    const derivation = new TranscriptWindowDerivation();
    const windows = new RunCallWindows();
    const drawnKeys = () => {
      const model = derivation.derive(store.snapshot().transcript, store.snapshot().partitions.run);
      const runGroup = onlyRunGroupOf(model);
      const drawn = new RunGroupFold().fold(model, new Set(), {
        windows,
        measureOf: () => MEASURE,
        moveCount: 0,
      }).window;
      return {
        entries: runGroupHeadingOf(runGroup).entryCount,
        rows: drawn.viewportRows.map((row) =>
          row.key === runGroup.key
            ? "header"
            : row.key === runWindowEdgeKey(runGroup.key, "earlier")
              ? "earlier"
              : row.key,
        ),
      };
    };
    const before = drawnKeys();
    expect(before.rows).toEqual([message!.id, "header", ...rest.map((event) => event.id)]);

    // The calls before the notice go, as a stretch the run's window left out.
    store.releaseOutside(
      transcriptFixtureStreamCursor(message!.sequence),
      transcriptFixtureStreamCursor(runEvents.at(-1)!.sequence),
      [
        {
          lastHeldCursorBefore: transcriptFixtureStreamCursor(message!.sequence),
          firstHeldCursorAfter: transcriptFixtureStreamCursor(notice.sequence),
        },
      ],
    );

    // The notice still stands under the header, the five calls counted past the earlier edge.
    expect(drawnKeys()).toEqual({
      entries: before.entries,
      rows: [message!.id, "header", "earlier", ...runEvents.slice(6).map((event) => event.id)],
    });
  });
});
