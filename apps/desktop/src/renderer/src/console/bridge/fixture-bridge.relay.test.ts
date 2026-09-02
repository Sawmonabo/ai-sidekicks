// The relay subscription routes by SESSION, which is the one key the daemon
// subscriptions do not have.
//
// Its own file rather than a case in `fixture-bridge.test.ts`, because the claim is
// a different one with a different failure mode: those cases hold a subscription to
// the EVENT it named, and these hold it to the SESSION it named. The fixture used to
// ignore `subscribeRelay`'s session argument and forward every beat to every
// handler, so a multi-session or auxiliary-window test could read a stranger
// session's log and pass against behaviour the live bridge does not exhibit —
// `packages/contracts/src/desktop-bridge.ts` scopes the subscription to the session
// it is opened for.
//
// Every case drives the REAL fixture bridge over a real scenario and the real
// engine, so what is asserted is the seam a surface actually calls.

import { describe, expect, it } from "vitest";

import type { RelayEventHandler, SessionId } from "@ai-sidekicks/contracts";

import {
  createFixture,
  lastScriptedBeatMs,
  type FixtureUnderTest,
} from "./fixture-bridge.test-support.js";
import { FLAGSHIP_SCENARIO } from "./scenarios/flagship.js";

/** Past the flagship script's last beat, read off the script so it cannot go stale. */
const PAST_EVERY_BEAT_MS = lastScriptedBeatMs(FLAGSHIP_SCENARIO) + 100;

/** A session the branded id type accepts that no scenario on the seat board plays. */
const STRANGER_SESSION_ID = "019b79ee-0280-75e5-8510-ada11a5a7777";

/**
 * What one relay handler received, in delivery order.
 *
 * The frame is a Plan-008 stub typed `unknown` on the contract, so the collector
 * keeps it at that type and reads only the envelope member the assertions name —
 * asserting through a shape the corpus has not registered would be this test
 * teaching the fixture a wire nobody ships.
 */
function subscribeToRelay(fixture: FixtureUnderTest, sessionId: string): readonly unknown[] {
  const received: unknown[] = [];
  const handler: RelayEventHandler = (event) => {
    received.push(event);
  };
  fixture.bridge.sidekicks.controlPlane.subscribeRelay(sessionId as SessionId, handler);
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
    // Without this, an implementation that delivered to nobody would satisfy the
    // case above — and the relay is a real delivery path, not one to silence.
    const fixture = createFixture();
    const played = subscribeToRelay(fixture, FLAGSHIP_SCENARIO.sessionId);

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    expect(played).toHaveLength(FLAGSHIP_SCENARIO.beats.length);
    expect(new Set(typesOf(played)).size).toBeGreaterThan(1);
  });

  it("keeps two relay subscribers apart, so one session's log cannot reach the other", () => {
    // Both halves in one case, because the defect was exactly that they were one:
    // A's envelopes reached B's handler, and every assertion B made was about a log
    // it is not entitled to.
    const fixture = createFixture();
    const played = subscribeToRelay(fixture, FLAGSHIP_SCENARIO.sessionId);
    const stranger = subscribeToRelay(fixture, STRANGER_SESSION_ID);

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    expect(played).toHaveLength(FLAGSHIP_SCENARIO.beats.length);
    expect(stranger).toStrictEqual([]);
  });

  it("hands the stranger a disposer that is safe to call, as the contract requires", () => {
    // `Unsubscribe` is declared idempotent, and a caller cannot tell which arm it
    // got — so the no-op disposer has to be callable twice like every other one.
    const fixture = createFixture();
    const unsubscribe = fixture.bridge.sidekicks.controlPlane.subscribeRelay(
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
    // The mechanical half of the scoping claim: the stranger's subscription is not
    // a sink that filters everything out, it is a sink the engine never holds.
    const fixture = createFixture();

    fixture.bridge.sidekicks.controlPlane.subscribeRelay(
      STRANGER_SESSION_ID as SessionId,
      () => undefined,
    );
    expect(fixture.engine.sinkCount).toBe(0);

    fixture.bridge.sidekicks.controlPlane.subscribeRelay(
      FLAGSHIP_SCENARIO.sessionId as SessionId,
      () => undefined,
    );
    expect(fixture.engine.sinkCount).toBe(1);
  });
});
