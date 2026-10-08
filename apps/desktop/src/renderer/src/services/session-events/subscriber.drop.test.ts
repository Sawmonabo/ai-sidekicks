// A frame carrying the daemon's drop mark, and the repair it takes, on its two arms. A hole within
// the repairable bound is filled by opening the stream again after the last change delivered. A
// wider one is repaired by a read: the window is replaced with the log's newest rows and the
// stream opened after the newest of them, so the store ends holding the window a reader that was
// never dropped holds at the log's newest end. No scenario drops, so the cases set frames aside
// and stamp the mark through the fixture bridge's subscribe arm.

import type { EventEnvelope } from "@ai-sidekicks/contracts/event/envelope";
import { STREAM_FRAME_MAX_CHANGES } from "@ai-sidekicks/contracts/jsonrpc/streaming";
import { encodeEventCursor, START_OF_LOG_POSITION } from "@ai-sidekicks/contracts/session/event-cursor";
import type {
  SessionReadResponse,
  SessionStreamFrame,
} from "@ai-sidekicks/contracts/session/methods";
import { beforeEach, describe, expect, it } from "vitest";

import { CONCURRENT_STREAMING_SCENARIO } from "#fixtures/scenarios/concurrent-streaming.js";
import type { Clock } from "#renderer/lib/clock.js";
import { APPLY_COALESCE_MS } from "#renderer/lib/reads/refresh/caps.js";
import { windowTripwires } from "#renderer/lib/tripwires/registry.js";
import { MAX_REPAIRABLE_SEQUENCE_GAP } from "#renderer/store/session/caps.js";
import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { SessionStoreRegistry } from "#renderer/store/session/registry.js";
import { type SessionStoreState } from "#renderer/store/session/state.js";
import { withDaemonCall, withDaemonSubscribe } from "#test/helpers/fixture/bridge.js";
import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { OPENING_PAGE_LIMIT, openingPageLimit } from "#test/helpers/session/store/fixtures.js";
import { composeScenarioEventEnvelope } from "../daemon/event/envelope.fixture.js";
import { sessionReadThroughDaemon } from "../daemon/session/read/base-state.js";
import { createFixtureBridge } from "../platform/bridge.fixture.js";
import type { PlatformBridge } from "../platform/bridge.js";
import { SessionEventSubscriber } from "./subscriber.js";
import { SESSION_ID } from "./subscriber.test-support.js";

/** One reader of the session: its registry, its subscriber and the reasons its reads ran for. */
interface SessionReader {
  readonly registry: SessionStoreRegistry;
  readonly subscriber: SessionEventSubscriber;
  readonly reasonsSeen: string[];
  /** The state the reader's store holds now. */
  readonly state: () => SessionStoreState | undefined;
}

/**
 * A subscriber over `bridge` with the session open, its reads landing an empty base state so the
 * store admits what the stream sends: at the bottom of the stream, or through the read client
 * where the case names `session.read`'s reply.
 */
function openSessionReader(
  bridge: PlatformBridge,
  clock: Clock,
  readThroughDaemon = false,
): SessionReader {
  const reasonsSeen: string[] = [];
  const readSession = sessionReadThroughDaemon(bridge);
  const registry = new SessionStoreRegistry({
    read: (sessionId, reasons, opening) => {
      reasonsSeen.push(...reasons);
      return readThroughDaemon
        ? readSession(sessionId, reasons, opening)
        : Promise.resolve({ entities: [] });
    },
    clock,
    openingPageLimit,
    refreshDebounceMs: 0,
  });
  const subscriber = new SessionEventSubscriber({ registry, bridge, clock });
  subscriber.attach();
  registry.open(SESSION_ID);
  return { registry, subscriber, reasonsSeen, state: () => registry.peek(SESSION_ID)?.snapshot() };
}

/** The scenario's first beat, re-numbered for frames no scenario plays. */
const TEMPLATE_EVENT = CONCURRENT_STREAMING_SCENARIO.beats[0]!.event;

/** The scenario's first beat at `sequence`, at the cursor its position encodes. */
function loggedEventAt(sequence: number): ProjectedSessionEvent {
  return { ...TEMPLATE_EVENT, sequence, cursor: encodeEventCursor(sequence) };
}

/** The sequences from `first` to `last`, both included. */
function sequencesFrom(first: number, last: number): number[] {
  return Array.from({ length: last - first + 1 }, (_unused, index) => first + index);
}

/** Hand a stream the sequences from `first` to `last` in frames no larger than the daemon sends. */
function deliverInFrames(deliver: (frame: unknown) => void, first: number, last: number): void {
  const sequences = sequencesFrom(first, last);
  for (let start = 0; start < sequences.length; start += STREAM_FRAME_MAX_CHANGES) {
    deliver(frameAt(sequences.slice(start, start + STREAM_FRAME_MAX_CHANGES)));
  }
}

/** A frame of changes at these sequences, each at the cursor its position encodes. */
function frameAt(sequences: readonly number[]): SessionStreamFrame<unknown> {
  return {
    changes: sequences.map((sequence) => ({
      cursor: encodeEventCursor(sequence),
      event: composeScenarioEventEnvelope(loggedEventAt(sequence)),
    })),
  };
}

// Tripwires throw in development; under test they are recorded, since nothing here expects one.
beforeEach(() => {
  windowTripwires.setThrowOnReport(false);
  windowTripwires.reset();
});

describe("SessionEventSubscriber — the drop mark", () => {
  it("fills a dropped hole from the last change delivered, ending with a whole reader's rows", async () => {
    const { bridge: base, scenarioEngine: engine } = createFixtureBridge({
      scenario: CONCURRENT_STREAMING_SCENARIO,
    });
    const opens: unknown[] = [];
    let framesOnFirstOpen = 0;
    let cursorBeforeDrop: string | undefined;
    // On the first stream the daemon's queue is full for the third and fourth frames, and the
    // fifth carries the mark; every later stream delivers whole.
    const droppingBridge = withDaemonSubscribe(base, (passThrough, handler, request) => {
      opens.push(request);
      const isFirstOpen = opens.length === 1;
      return passThrough((delivered) => {
        if (!isFirstOpen) {
          handler(delivered);
          return;
        }
        framesOnFirstOpen += 1;
        const frame = delivered as SessionStreamFrame<EventEnvelope>;
        if (framesOnFirstOpen === 3 || framesOnFirstOpen === 4) {
          return;
        }
        if (framesOnFirstOpen === 5) {
          handler({ ...frame, dropped: true });
          return;
        }
        if (framesOnFirstOpen < 3) {
          cursorBeforeDrop = frame.changes.at(-1)?.cursor;
        }
        handler(delivered);
      });
    });
    const whole = openSessionReader(base, engine.clock);
    const dropped = openSessionReader(droppingBridge, engine.clock);
    engine.advance(0);
    await crossMacrotaskBoundary();

    // Beat by beat, so each lands in its own frame and the drop falls mid-session.
    let elapsedMs = 0;
    for (const beat of CONCURRENT_STREAMING_SCENARIO.beats) {
      engine.advance(beat.atMs - elapsedMs);
      elapsedMs = beat.atMs;
    }
    engine.advance(APPLY_COALESCE_MS + 1);

    expect(framesOnFirstOpen).toBe(5);
    expect(cursorBeforeDrop).toBeDefined();
    expect(opens).toEqual([
      { sessionId: SESSION_ID },
      { sessionId: SESSION_ID, afterCursor: cursorBeforeDrop },
    ]);
    expect(whole.state()?.transcript).toHaveLength(CONCURRENT_STREAMING_SCENARIO.beats.length);
    expect(dropped.state()?.transcript).toEqual(whole.state()?.transcript);
    expect(dropped.state()?.gaps).toEqual([]);
    expect(dropped.state()?.degradedCause).toBeUndefined();

    whole.subscriber.dispose();
    dropped.subscriber.dispose();
  });

  it.each<{ readonly name: string; readonly droppedFrame: unknown; readonly isFilled: boolean }>([
    {
      name: "fills after the caught-up frame, which names no sequence",
      droppedFrame: { changes: [], dropped: true, cursor: encodeEventCursor(40) },
      isFilled: true,
    },
    {
      name: "fills a hole exactly as wide as the bound",
      droppedFrame: { ...frameAt([MAX_REPAIRABLE_SEQUENCE_GAP + 2]), dropped: true },
      isFilled: true,
    },
    {
      name: "re-reads instead of filling a hole one wider than the bound",
      droppedFrame: { ...frameAt([MAX_REPAIRABLE_SEQUENCE_GAP + 3]), dropped: true },
      isFilled: false,
    },
  ])("$name", async ({ droppedFrame, isFilled }) => {
    // No beats, so every frame the subscriber sees is one the case hands it; a later open never
    // reaches the fixture, whose empty log would refuse the cursor it names.
    const { bridge: base, scenarioEngine: engine } = createFixtureBridge({
      scenario: { ...CONCURRENT_STREAMING_SCENARIO, id: "drop-mark-probe", beats: [] },
    });
    const opens: unknown[] = [];
    const handlers: ((frame: unknown) => void)[] = [];
    const bridge = withDaemonSubscribe(base, (passThrough, handler, request) => {
      opens.push(request);
      handlers.push(handler);
      return opens.length === 1 ? passThrough() : () => undefined;
    });
    const reader = openSessionReader(bridge, engine.clock);
    engine.advance(0);
    await crossMacrotaskBoundary();
    reader.reasonsSeen.length = 0;
    const deliver = handlers[0]!;

    deliver(frameAt([1]));
    deliver(droppedFrame);
    engine.advance(APPLY_COALESCE_MS + 1);
    await crossMacrotaskBoundary();

    if (isFilled) {
      expect(opens).toEqual([
        { sessionId: SESSION_ID },
        { sessionId: SESSION_ID, afterCursor: encodeEventCursor(1) },
      ]);
      expect(reader.reasonsSeen).toEqual([]);
      // A frame the closed stream still hands over is not applied, or it would move the
      // position past the hole the new stream is filling.
      deliver(frameAt([2]));
      engine.advance(APPLY_COALESCE_MS + 1);
      expect(reader.state()?.transcript.map((event) => event.sequence)).toEqual([1]);
      expect(reader.state()?.degradedCause).toBeUndefined();
    } else {
      // The read replaces the window with the log's newest rows, here none, and the stream opens
      // again after the read's position, not after the last change.
      expect(opens).toEqual([{ sessionId: SESSION_ID }, { sessionId: SESSION_ID }]);
      expect(reader.reasonsSeen).toEqual(["gap-repull"]);
      expect(reader.state()?.transcript).toEqual([]);
      expect(reader.state()?.degradedCause).toBeUndefined();
    }

    reader.subscriber.dispose();
  });

  it("re-reads past a hole too wide to fill, ending with a whole reader's newest window", async () => {
    // The log holds sequences 0 to 1,105, all logged after the first reads landed on an empty log.
    // The dropped reader receives 0 to 2, then a frame whose drop mark opens a hole of 1,100; its
    // repair read takes the log's newest rows. The whole reader receives everything once.
    const lastBeforeDrop = 2;
    const firstAfterDrop = lastBeforeDrop + MAX_REPAIRABLE_SEQUENCE_GAP + 77;
    const newestRow = firstAfterDrop + 2;
    const { bridge: base, scenarioEngine: engine } = createFixtureBridge({
      scenario: {
        ...CONCURRENT_STREAMING_SCENARIO,
        id: "drop-mark-reread-probe",
        beats: sequencesFrom(0, newestRow).map((sequence) => ({
          atMs: 1,
          event: loggedEventAt(sequence),
        })),
      },
    });
    // The record names this log's newest row as `latest`.
    const { bridge: recording } = withDaemonCall(base, async (call, passThrough) => {
      const reply = await passThrough();
      if (call.method !== "session.read") {
        return reply;
      }
      const record = reply as SessionReadResponse;
      return {
        ...record,
        transcriptCursors: { ...record.transcriptCursors, latest: encodeEventCursor(newestRow) },
      };
    });
    const opens: unknown[] = [];
    const handlers: ((frame: unknown) => void)[] = [];
    // Every frame is one the case hands over; no open reaches the fixture's stream.
    const bridge = withDaemonSubscribe(recording, (_passThrough, handler, request) => {
      opens.push(request);
      handlers.push(handler);
      return () => undefined;
    });
    const whole = openSessionReader(bridge, engine.clock, true);
    const dropped = openSessionReader(bridge, engine.clock, true);
    engine.advance(0);
    await crossMacrotaskBoundary();
    engine.advance(1);
    const [wholeStream, droppedStream] = handlers;

    deliverInFrames(wholeStream!, 0, newestRow);
    deliverInFrames(droppedStream!, 0, lastBeforeDrop);
    droppedStream!({ ...frameAt([firstAfterDrop, firstAfterDrop + 1]), dropped: true });
    // Nothing reads the window as whole while the read is still to land.
    expect(dropped.state()?.degradedCause).toBe("stream-diverged");
    engine.advance(APPLY_COALESCE_MS + 1);
    await crossMacrotaskBoundary();
    engine.advance(APPLY_COALESCE_MS + 1);

    // Each stream first opened at the floor the first read named; the dropped one opened again
    // after the newest row of its repair read, not after the last change it delivered.
    const floor = encodeEventCursor(START_OF_LOG_POSITION);
    expect(opens).toEqual([
      { sessionId: SESSION_ID, afterCursor: floor },
      { sessionId: SESSION_ID, afterCursor: floor },
      { sessionId: SESSION_ID, afterCursor: encodeEventCursor(newestRow) },
    ]);
    expect(dropped.reasonsSeen).toEqual(["subscribe", "gap-repull"]);
    const sequencesHeld = (reader: SessionReader): number[] | undefined =>
      reader.state()?.transcript.map((event) => event.sequence);
    expect(sequencesHeld(whole)).toEqual(sequencesFrom(0, newestRow));
    expect(sequencesHeld(dropped)).toEqual(sequencesHeld(whole)?.slice(-OPENING_PAGE_LIMIT));
    expect(dropped.state()?.transcriptHead.hasMore).toBe(true);
    expect(dropped.state()?.gaps).toEqual([]);
    expect(dropped.state()?.cursor).toBe(newestRow);
    expect(dropped.state()?.degradedCause).toBeUndefined();
    expect(whole.state()?.gaps).toEqual([]);

    whole.subscriber.dispose();
    dropped.subscriber.dispose();
  });

  it("keeps the session waiting on its repair read when the drop lands inside the open", async () => {
    // The catch-up delivers before `daemon.subscribe` returns: the frame past the bound closes
    // the stream and the session waits on its repair read, which the open must not forget.
    const { bridge: base, scenarioEngine: engine } = createFixtureBridge({
      scenario: { ...CONCURRENT_STREAMING_SCENARIO, id: "drop-inside-open-probe", beats: [] },
    });
    const bridge = withDaemonSubscribe(base, (_passThrough, handler) => {
      handler(frameAt([1]));
      handler({ ...frameAt([MAX_REPAIRABLE_SEQUENCE_GAP + 3]), dropped: true });
      return () => undefined;
    });
    const reader = openSessionReader(bridge, engine.clock);
    engine.advance(0);
    await crossMacrotaskBoundary();

    expect(reader.subscriber.boundSessionIds).toEqual([]);
    // Retained, so a returning edge asks for the read again if it could not reach the daemon.
    expect(reader.subscriber.unboundSessionIds).toEqual([SESSION_ID]);

    reader.subscriber.dispose();
  });
});
