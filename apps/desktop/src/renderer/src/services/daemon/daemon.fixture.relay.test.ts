// The relay subscription routes by session, the one key the daemon subscriptions do not have.
// Forwarding every beat to every handler would let a multi-session test read another session's
// log; `subscribeRelay` in `apps/desktop/src/shared/preload-api.ts` takes the session it is
// scoped to. Every case drives the real fixture bridge and engine.

import { describe, expect, it } from "vitest";

import type { SessionId } from "@ai-sidekicks/contracts";
import type { RelayEventHandler } from "@shared/preload-api.js";

import {
  createFixture,
  lastScriptedBeatMs,
  type FixtureUnderTest,
} from "@test/helpers/fixture-bridge.js";
import { CONCURRENT_STREAMING_SCENARIO } from "../../../../../fixtures/scenarios/concurrent-streaming.js";

/** Past the concurrent-streaming script's last beat, read off the script so it cannot go stale. */
const PAST_EVERY_BEAT_MS = lastScriptedBeatMs(CONCURRENT_STREAMING_SCENARIO) + 100;

/** A session the branded id type accepts that no shipped scenario plays. */
const STRANGER_SESSION_ID = "019b79ee-0280-75e5-8510-ada11a5a7777";

/**
 * What one relay handler received, in delivery order. The frame is typed `unknown` on the
 * contract, so the collector keeps it there and reads only the member the assertions name.
 */
function subscribeToRelay(fixture: FixtureUnderTest, sessionId: string): readonly unknown[] {
  const received: unknown[] = [];
  const handler: RelayEventHandler = (event) => {
    received.push(event);
  };
  fixture.bridge.controlPlane.subscribeRelay(sessionId as SessionId, handler);
  return received;
}

/** The event types a collector received, read off the composed envelope. */
function typesOf(received: readonly unknown[]): readonly string[] {
  return received.map((frame) => (frame as { readonly type: string }).type);
}

describe("fixture bridge — a relay subscription delivers only its own session", () => {
  it("delivers nothing to a subscriber for a session the fixture is not playing", () => {
    const fixture = createFixture();
    const stranger = subscribeToRelay(fixture, STRANGER_SESSION_ID);

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    expect(stranger).toStrictEqual([]);
  });

  it("negative control: the subscriber for the played session receives every beat", () => {
    // Without it, a fixture that delivered to nobody satisfies the case above.
    const fixture = createFixture();
    const played = subscribeToRelay(fixture, CONCURRENT_STREAMING_SCENARIO.sessionId);

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    expect(played).toHaveLength(CONCURRENT_STREAMING_SCENARIO.beats.length);
    expect(new Set(typesOf(played)).size).toBeGreaterThan(1);
  });

  it("keeps two relay subscribers apart, so one session's log cannot reach the other", () => {
    // Both halves in one case: the defect was one session's envelopes reaching another's
    // handler.
    const fixture = createFixture();
    const played = subscribeToRelay(fixture, CONCURRENT_STREAMING_SCENARIO.sessionId);
    const stranger = subscribeToRelay(fixture, STRANGER_SESSION_ID);

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    expect(played).toHaveLength(CONCURRENT_STREAMING_SCENARIO.beats.length);
    expect(stranger).toStrictEqual([]);
  });

  it("hands the stranger a disposer that is safe to call, as the contract requires", () => {
    // `Unsubscribe` is idempotent and a caller cannot tell which arm it got, so the no-op
    // disposer must be callable twice.
    const fixture = createFixture();
    const unsubscribe = fixture.bridge.controlPlane.subscribeRelay(
      STRANGER_SESSION_ID as SessionId,
      () => undefined,
    );

    expect(() => {
      unsubscribe();
      unsubscribe();
    }).not.toThrow();
    expect(fixture.engine.sinkCount).toBe(0);
  });

  it("attaches no sink at all for a stranger session, and one for the played session", () => {
    // The stranger's subscription is not a sink that filters everything out; the engine never
    // holds it.
    const fixture = createFixture();

    fixture.bridge.controlPlane.subscribeRelay(STRANGER_SESSION_ID as SessionId, () => undefined);
    expect(fixture.engine.sinkCount).toBe(0);

    fixture.bridge.controlPlane.subscribeRelay(
      CONCURRENT_STREAMING_SCENARIO.sessionId as SessionId,
      () => undefined,
    );
    expect(fixture.engine.sinkCount).toBe(1);
  });
});
