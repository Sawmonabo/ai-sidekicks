// A stream the daemon marked far behind its head: one frame with no changes carrying the head
// cursor. The page takes one snapshot read, the record and the window at the log's newest rows,
// laid after the rows the window holds with the rows between let go, so a reader scrolled away
// keeps their place, and carries on from the head with the stream opened after the snapshot's
// newest row, so nothing between is drawn and nothing is drawn twice. No scenario falls behind,
// so the cases hand every frame over through the fixture bridge's subscribe arm.

import { encodeEventCursor } from "@ai-sidekicks/contracts/session/event-cursor";
import { START_OF_LOG_POSITION } from "@ai-sidekicks/contracts/session/id";
import type { SessionStreamFrame } from "@ai-sidekicks/contracts/session/methods";
import { beforeEach, describe, expect, it } from "vitest";

import { CONCURRENT_STREAMING_SCENARIO } from "#fixtures/scenarios/concurrent-streaming.js";
import { windowTripwires } from "#renderer/lib/tripwires/registry.js";
import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import type { SessionWindowOpening } from "#renderer/store/session/open/entry.js";
import { SessionStoreRegistry } from "#renderer/store/session/registry.js";
import type { SessionBaseState } from "#renderer/store/session/state.js";
import { withDaemonSubscribe } from "#test/helpers/fixture/bridge.js";
import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { openingPageLimit, offScreenRowLimit } from "#test/helpers/session/store/fixtures.js";
import { composeScenarioEventEnvelope } from "../daemon/event/envelope.fixture.js";
import { createFixtureBridge } from "../platform/bridge.fixture.js";
import { SessionEventSubscriber } from "./subscriber.js";
import { SESSION_ID } from "./subscriber.test-support.js";

/** The log's head when the daemon marks the stream behind, far past what the stream delivered. */
const HEAD = 1_200;

/** A logged event at `sequence`, at the cursor its position encodes. */
function loggedEventAt(sequence: number): ProjectedSessionEvent {
  return {
    id: `019b79ee-0280-7ea1-8110-${String(sequence).padStart(12, "0")}`,
    sessionId: SESSION_ID,
    sequence,
    cursor: encodeEventCursor(sequence),
    kind: "session.pinned",
    occurredAt: "2026-01-01T14:20:00.500Z",
    payload: {},
  };
}

/** A frame of changes at these sequences, as the daemon delivers it. */
function frameAt(sequences: readonly number[]): unknown {
  return {
    kind: "changes",
    changes: sequences.map((sequence) => ({
      cursor: encodeEventCursor(sequence),
      event: composeScenarioEventEnvelope(loggedEventAt(sequence)),
    })),
  };
}

/** The far-behind frame the daemon sends, carrying the head it moved the stream to. */
const BEHIND_FRAME: SessionStreamFrame = { kind: "behind", headCursor: encodeEventCursor(HEAD) };

/**
 * The first read lands an empty window at the log's floor; every later one is the snapshot, the
 * three newest rows through `HEAD`, the stream opening after `HEAD`.
 */
function snapshotReads(): {
  readonly read: (
    sessionId: string,
    reasons: readonly string[],
    opening: SessionWindowOpening,
  ) => Promise<SessionBaseState>;
  readonly reasonsSeen: string[];
  readonly openings: SessionWindowOpening[];
} {
  const reasonsSeen: string[] = [];
  const openings: SessionWindowOpening[] = [];
  return {
    reasonsSeen,
    openings,
    read: (_sessionId, reasons, opening) => {
      reasonsSeen.push(...reasons);
      openings.push(opening);
      if (openings.length === 1) {
        return Promise.resolve({
          shape: "project",
          entities: [],
          streamAfterCursor: encodeEventCursor(START_OF_LOG_POSITION),
        });
      }
      return Promise.resolve({
        shape: "project",
        entities: [],
        cursor: HEAD,
        transcript: [HEAD - 2, HEAD - 1, HEAD].map(loggedEventAt),
        streamAfterCursor: encodeEventCursor(HEAD),
        transcriptHead: { cursor: encodeEventCursor(HEAD - 3), hasMore: true },
      });
    },
  };
}

// Tripwires throw in development; under test they are recorded, since nothing here expects one.
beforeEach(() => {
  windowTripwires.setThrowOnReport(false);
  windowTripwires.reset();
});

describe("SessionEventSubscriber — a stream marked far behind its head", () => {
  it("takes one snapshot read and applies the next change from the head", async () => {
    const { bridge: base, scenarioEngine: engine } = createFixtureBridge({
      scenario: { ...CONCURRENT_STREAMING_SCENARIO, id: "far-behind-probe", beats: [] },
    });
    const opens: unknown[] = [];
    const handlers: ((frame: unknown) => void)[] = [];
    // Every frame is one the case hands over; no open reaches the fixture's stream.
    const bridge = withDaemonSubscribe(base, (_passThrough, handler, request) => {
      opens.push(request);
      handlers.push(handler);
      return () => undefined;
    });
    const reads = snapshotReads();
    const registry = new SessionStoreRegistry({
      read: reads.read,
      clock: engine.clock,
      openingPageLimit,
      offScreenRowLimit,
      refreshDebounceMs: 0,
    });
    const subscriber = new SessionEventSubscriber({ registry, bridge, clock: engine.clock });
    subscriber.attach();
    registry.open(SESSION_ID);
    registry.markOnScreen(SESSION_ID);
    engine.advance(0);
    await crossMacrotaskBoundary();
    const sequencesHeld = (): number[] | undefined =>
      registry
        .peek(SESSION_ID)
        ?.snapshot()
        .transcript.map((event) => event.sequence);

    const [firstStream] = handlers;
    firstStream!(frameAt([1, 2]));
    engine.runFrame();
    expect(sequencesHeld()).toEqual([1, 2]);

    firstStream!(BEHIND_FRAME);
    // Nothing reads the window as whole while the snapshot is still to land.
    expect(registry.peek(SESSION_ID)?.snapshot().degradedCause).toBe("stream-diverged");
    engine.advance(0);
    await crossMacrotaskBoundary();

    // One snapshot read at the log's newest rows, and the stream opened again after its newest.
    expect(reads.reasonsSeen).toEqual(["subscribe", "gap-repull"]);
    expect(reads.openings.map((opening) => opening.opensAt)).toEqual(["latest", "latest"]);
    expect(opens).toEqual([
      { sessionId: SESSION_ID, afterCursor: encodeEventCursor(START_OF_LOG_POSITION) },
      { sessionId: SESSION_ID, afterCursor: encodeEventCursor(HEAD) },
    ]);

    // A frame the closed stream still hands over is not applied; the next change applies once.
    firstStream!(frameAt([3]));
    handlers[1]!(frameAt([HEAD + 1]));
    engine.runFrame();
    // The rows held before stay, so a reader on them keeps their place; the skipped rows are a
    // stretch a read inside brings back.
    expect(sequencesHeld()).toEqual([1, 2, HEAD - 2, HEAD - 1, HEAD, HEAD + 1]);
    const state = registry.peek(SESSION_ID)?.snapshot();
    expect(state?.releasedStretches).toEqual([
      { lastHeldSequenceBefore: 2, firstHeldCursorAfter: encodeEventCursor(HEAD - 2) },
    ]);
    expect(state?.gaps).toEqual([]);
    expect(state?.degradedCause).toBeUndefined();

    subscriber.dispose();
  });

  it("keeps the session waiting on its snapshot read when the mark lands inside the open", async () => {
    // The catch-up delivers before `daemon.subscribe` returns: the far-behind frame closes the
    // stream and the session waits on its snapshot read, which the open must not forget.
    const { bridge: base, scenarioEngine: engine } = createFixtureBridge({
      scenario: { ...CONCURRENT_STREAMING_SCENARIO, id: "behind-inside-open-probe", beats: [] },
    });
    const bridge = withDaemonSubscribe(base, (_passThrough, handler) => {
      handler(frameAt([1]));
      handler(BEHIND_FRAME);
      return () => undefined;
    });
    // The first read lands an empty window at the log's start; the snapshot read never lands.
    let readCount = 0;
    const registry = new SessionStoreRegistry({
      read: () => {
        readCount += 1;
        return readCount === 1
          ? Promise.resolve({ shape: "project", entities: [] })
          : new Promise<SessionBaseState>(() => undefined);
      },
      clock: engine.clock,
      openingPageLimit,
      offScreenRowLimit,
      refreshDebounceMs: 0,
    });
    const subscriber = new SessionEventSubscriber({ registry, bridge, clock: engine.clock });
    subscriber.attach();
    registry.open(SESSION_ID);
    engine.advance(0);
    await crossMacrotaskBoundary();
    // The far-behind frame landed inside the open; its snapshot read falls due on the next tick.
    engine.advance(0);
    await crossMacrotaskBoundary();

    expect(readCount).toBe(2);
    expect(subscriber.boundSessionIds).toEqual([]);
    // Retained, so a returning edge asks for the read again if it could not reach the daemon.
    expect(subscriber.unboundSessionIds).toEqual([SESSION_ID]);

    subscriber.dispose();
  });
});
