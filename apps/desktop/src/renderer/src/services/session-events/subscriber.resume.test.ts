// A session stream that ends while its session is open, as main reports when the daemon or the
// link under it stops the feed. The stream is opened again after the last change it delivered, so
// the daemon catches up from there: nothing is lost and nothing arrives twice. Everything runs on
// the real fixture bridge playing the concurrent-streaming scenario, whose whole-session stream
// catches up past a cursor as the daemon does.

import { EVENT_CURSOR_UNRESOLVABLE_CODE } from "@ai-sidekicks/contracts/error";
import type { EventEnvelope } from "@ai-sidekicks/contracts/event/envelope";
import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/message";
import type { SessionStreamFrame } from "@ai-sidekicks/contracts/session/methods";
import { beforeEach, describe, expect, it } from "vitest";

import type { Scenario } from "#fixtures/scenario.js";
import { CONCURRENT_STREAMING_SCENARIO } from "#fixtures/scenarios/concurrent-streaming.js";
import { windowTripwires } from "#renderer/lib/tripwires/registry.js";
import { SessionStoreRegistry } from "#renderer/store/session/registry.js";
import type { DaemonSubscriptionEnd } from "#shared/daemon/forwarding.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { withDaemonSubscribe } from "#test/helpers/fixture/bridge.js";
import type { ScenarioEngine } from "../daemon/engine.fixture.js";
import { REOPEN_WAITS_MS } from "../transport/reopen-backoff.js";
import { createFixtureBridge } from "../platform/bridge.fixture.js";
import type { PlatformBridge } from "../platform/bridge.js";
import { SessionEventSubscriber } from "./subscriber.js";
import { PAST_EVERY_BEAT_MS, SESSION_ID, landReads } from "./subscriber.test-support.js";

/** One open of the session stream: what it asked for, and how the case ends it. */
interface StreamOpen {
  readonly request: Readonly<Record<string, unknown>>;
  readonly end: (end: DaemonSubscriptionEnd) => void;
}

/** A subscriber whose session stream the case can end, and what crossed the wire. */
interface ResumeHarness {
  readonly registry: SessionStoreRegistry;
  readonly subscriber: SessionEventSubscriber;
  readonly engine: ScenarioEngine;
  readonly bridge: PlatformBridge;
  readonly opens: readonly StreamOpen[];
  /** The sequence of every change the stream delivered, in delivery order. */
  readonly sequencesDelivered: readonly number[];
  /** The cursor of the last change the stream delivered. */
  lastCursorDelivered: () => string | undefined;
  /** Every reason the registry's read was performed for, in order. */
  readonly reasonsSeen: string[];
}

/**
 * The subscriber over the fixture bridge, its session open and its first stream opened after the
 * read landed. Each open of the stream is recorded, and ending one stops the fixture's delivery
 * before telling the subscriber, as main does. A resumed open the case marks refused ends at once,
 * as the daemon ends one whose cursor it cannot resolve.
 */
async function createResumeHarness(
  options: { readonly refuseResumedOpens?: boolean; readonly scenario?: Scenario } = {},
): Promise<ResumeHarness> {
  const refuseResumedOpens = options.refuseResumedOpens ?? false;
  const { bridge: base, scenarioEngine: engine } = createFixtureBridge({
    scenario: options.scenario ?? CONCURRENT_STREAMING_SCENARIO,
  });
  const opens: StreamOpen[] = [];
  const sequencesDelivered: number[] = [];
  let lastCursor: string | undefined;
  const bridge = withDaemonSubscribe(base, (passThrough, handler, request, onEnded) => {
    const streamRequest = request as Readonly<Record<string, unknown>>;
    if (refuseResumedOpens && streamRequest["afterCursor"] !== undefined) {
      opens.push({ request: streamRequest, end: () => undefined });
      queueMicrotask(() => {
        onEnded?.({
          reason: "refused",
          refusal: {
            code: JsonRpcErrorCode.InvalidParams,
            message: "That cursor is not in this session's log.",
            data: { type: EVENT_CURSOR_UNRESOLVABLE_CODE },
          },
        });
      });
      return () => undefined;
    }
    let isHeld = true;
    const release: Unsubscribe = passThrough((delivered) => {
      for (const change of (delivered as SessionStreamFrame<EventEnvelope>).changes) {
        sequencesDelivered.push(change.event.sequence);
        lastCursor = change.cursor;
      }
      handler(delivered);
    });
    opens.push({
      request: streamRequest,
      end: (end) => {
        isHeld = false;
        release();
        onEnded?.(end);
      },
    });
    return () => {
      if (isHeld) {
        release();
      }
    };
  });
  const reasonsSeen: string[] = [];
  const registry = new SessionStoreRegistry({
    read: (_sessionId, reasons) => {
      reasonsSeen.push(...reasons);
      return Promise.resolve({ entities: [] });
    },
    clock: engine.clock,
    refreshDebounceMs: 0,
  });
  const subscriber = new SessionEventSubscriber({ registry, bridge, clock: engine.clock });
  subscriber.attach();
  registry.open(SESSION_ID);
  await landReads(engine);
  return {
    registry,
    subscriber,
    engine,
    bridge,
    opens,
    sequencesDelivered,
    lastCursorDelivered: () => lastCursor,
    reasonsSeen,
  };
}

/** The scenario's halfway beat, so a case ends the stream with changes on both sides of it. */
const HALFWAY_MS =
  CONCURRENT_STREAMING_SCENARIO.beats[Math.floor(CONCURRENT_STREAMING_SCENARIO.beats.length / 2)]
    ?.atMs ?? 0;

/**
 * The scenario with every beat a millisecond later, so nothing is due when the first stream
 * opens: ending it before the clock moves ends a stream that delivered nothing.
 */
const LATE_START_SCENARIO: Scenario = {
  ...CONCURRENT_STREAMING_SCENARIO,
  id: "concurrent-streaming-late-start",
  beats: CONCURRENT_STREAMING_SCENARIO.beats.map((beat) => ({ ...beat, atMs: beat.atMs + 1 })),
};

const LINK_FAILED: DaemonSubscriptionEnd = {
  reason: "failed",
  message: "The connection to the background service closed: the service ended it",
};

// Tripwires throw in development; under test they are recorded.
beforeEach(() => {
  windowTripwires.setThrowOnReport(false);
  windowTripwires.reset();
});

describe("SessionEventSubscriber: a stream that ends while its session is open", () => {
  it.each<DaemonSubscriptionEnd>([{ reason: "completed" }, LINK_FAILED])(
    "opens it again after its last cursor, losing and repeating nothing, when it ends $reason",
    async (end) => {
      const { subscriber, engine, opens, sequencesDelivered, lastCursorDelivered } =
        await createResumeHarness();
      engine.advance(HALFWAY_MS);
      const cursorAtEnd = lastCursorDelivered();
      expect(cursorAtEnd).toBeDefined();

      opens[0]?.end(end);
      engine.advance(PAST_EVERY_BEAT_MS);

      expect(opens.map((open) => open.request)).toEqual([
        { sessionId: SESSION_ID },
        { sessionId: SESSION_ID, afterCursor: cursorAtEnd },
      ]);
      expect(sequencesDelivered).toEqual(engine.deliveredEvents().map((event) => event.sequence));
      expect(subscriber.appliedEventCountFor(SESSION_ID)).toBe(
        CONCURRENT_STREAMING_SCENARIO.beats.length,
      );
      expect(subscriber.boundSessionIds).toEqual([SESSION_ID]);

      subscriber.dispose();
    },
  );

  it("opens a stream that delivers and ends every time again only after growing waits", async () => {
    const { subscriber, engine, opens, sequencesDelivered } = await createResumeHarness();
    const beats = CONCURRENT_STREAMING_SCENARIO.beats;
    engine.advance(beats[0]!.atMs);
    opens[0]?.end(LINK_FAILED);
    expect(opens).toHaveLength(2);

    // The re-opened stream delivers and ends at once: the next open waits.
    engine.advance(beats[1]!.atMs - beats[0]!.atMs);
    const deliveredBeforeSecondEnd = sequencesDelivered.length;
    expect(deliveredBeforeSecondEnd).toBeGreaterThan(0);
    opens[1]?.end(LINK_FAILED);
    engine.advance(REOPEN_WAITS_MS[1]! - 1);
    expect(opens).toHaveLength(2);
    engine.advance(1);
    expect(opens).toHaveLength(3);

    subscriber.dispose();
  });

  it("waits for the service to come back when the stream ended before delivering", async () => {
    const { subscriber, bridge, opens } = await createResumeHarness({
      scenario: LATE_START_SCENARIO,
    });

    opens[0]?.end(LINK_FAILED);

    expect(opens).toHaveLength(1);
    expect(subscriber.unboundSessionIds).toEqual([SESSION_ID]);

    bridge.transportReconnect.observe("unreachable");
    bridge.transportReconnect.observe("reachable");

    expect(opens.map((open) => open.request)).toEqual([
      { sessionId: SESSION_ID },
      { sessionId: SESSION_ID },
    ]);
    expect(subscriber.boundSessionIds).toEqual([SESSION_ID]);

    subscriber.dispose();
  });

  it.each<DaemonSubscriptionEnd>([
    {
      reason: "refused",
      refusal: { code: JsonRpcErrorCode.InternalError, message: "The stream is not available." },
    },
    { reason: "completed" },
  ])(
    "opens a stream the daemon ended $reason before delivering again after a wait",
    async (end) => {
      const { subscriber, registry, engine, opens } = await createResumeHarness({
        scenario: LATE_START_SCENARIO,
      });

      opens[0]?.end(end);
      expect(opens).toHaveLength(1);

      // No returning edge comes, since the wire never went away: the wait alone opens it again.
      engine.advance(REOPEN_WAITS_MS[1]!);
      expect(opens.map((open) => open.request)).toEqual([
        { sessionId: SESSION_ID },
        { sessionId: SESSION_ID },
      ]);
      expect(registry.peek(SESSION_ID)?.snapshot().degradedCause).toBeUndefined();

      subscriber.dispose();
    },
  );

  it("re-reads the session when the daemon can no longer resolve the cursor", async () => {
    const { subscriber, engine, opens, reasonsSeen } = await createResumeHarness({
      refuseResumedOpens: true,
    });
    engine.advance(HALFWAY_MS);
    await crossMacrotaskBoundary();
    expect(reasonsSeen).toEqual(["subscribe"]);

    opens[0]?.end(LINK_FAILED);
    await crossMacrotaskBoundary();
    engine.advance(1);
    await crossMacrotaskBoundary();

    expect(opens.map((open) => open.request["afterCursor"] === undefined)).toEqual([
      true,
      false,
      true,
    ]);
    expect(subscriber.boundSessionIds).toEqual([SESSION_ID]);
    // The refused position is handed to the read, which places the window again.
    expect(reasonsSeen).toEqual(["subscribe", "gap-repull"]);

    subscriber.dispose();
  });
});
