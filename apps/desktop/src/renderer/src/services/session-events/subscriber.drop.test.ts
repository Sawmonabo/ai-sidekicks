// A frame carrying the daemon's drop mark, and the repair it takes. A hole within the repairable
// bound is filled by opening the stream again after the last change delivered, so the store ends
// with the rows a reader that was never dropped holds; a wider one is repaired by a read instead.
// No scenario drops, so the cases set frames aside and stamp the mark through the fixture bridge's
// subscribe arm.

import type { EventEnvelope } from "@ai-sidekicks/contracts/event/envelope";
import { encodeEventCursor } from "@ai-sidekicks/contracts/session/id";
import type { SessionStreamFrame } from "@ai-sidekicks/contracts/session/methods";
import { beforeEach, describe, expect, it } from "vitest";

import { CONCURRENT_STREAMING_SCENARIO } from "#fixtures/scenarios/concurrent-streaming.js";
import type { Clock } from "#renderer/lib/clock.js";
import { APPLY_COALESCE_MS } from "#renderer/lib/reads/refresh/caps.js";
import { windowTripwires } from "#renderer/lib/tripwires/registry.js";
import { MAX_REPAIRABLE_SEQUENCE_GAP } from "#renderer/store/session/caps.js";
import { SessionStoreRegistry } from "#renderer/store/session/registry.js";
import { BASE_STATE_CURSOR, type SessionStoreState } from "#renderer/store/session/state.js";
import { withDaemonSubscribe } from "#test/helpers/fixture/bridge.js";
import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { composeScenarioEventEnvelope } from "../daemon/event/envelope.fixture.js";
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
 * store admits what the stream sends.
 */
function openSessionReader(bridge: PlatformBridge, clock: Clock): SessionReader {
  const reasonsSeen: string[] = [];
  const registry = new SessionStoreRegistry({
    read: (_sessionId, reasons) => {
      reasonsSeen.push(...reasons);
      return Promise.resolve({ cursor: BASE_STATE_CURSOR, entities: [] });
    },
    clock,
    refreshDebounceMs: 0,
  });
  const subscriber = new SessionEventSubscriber({ registry, bridge, clock });
  subscriber.attach();
  registry.open(SESSION_ID);
  return { registry, subscriber, reasonsSeen, state: () => registry.peek(SESSION_ID)?.snapshot() };
}

/** The scenario's first beat, re-numbered for frames no scenario plays. */
const TEMPLATE_EVENT = CONCURRENT_STREAMING_SCENARIO.beats[0]!.event;

/** A frame of changes at these sequences, each at the cursor its position encodes. */
function frameAt(sequences: readonly number[]): SessionStreamFrame<unknown> {
  return {
    changes: sequences.map((sequence) => ({
      cursor: encodeEventCursor(sequence),
      event: composeScenarioEventEnvelope({ ...TEMPLATE_EVENT, sequence }),
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
      expect(opens).toEqual([{ sessionId: SESSION_ID }]);
      expect(reader.reasonsSeen).toContain("gap-repull");
      expect(reader.state()?.degradedCause).toBeDefined();
    }

    reader.subscriber.dispose();
  });
});
