// The re-read that actually re-reads, and the fold that never turns absence into
// "off".
//
// The property under test is the one a counter could not give: pressing the offered
// recovery has to ask the daemon and land its reply in the store. So every case
// below counts the reads the scheduler performed and reads the store back, rather
// than asserting on anything this file holds.

import { describe, expect, it } from "vitest";

import { growthRefusing, growthServing } from "../../bridge/fixture-bridge.test-support.js";
import { REFRESH_DEBOUNCE_MS, REFRESH_MAX_WAIT_MS } from "../../core/index.js";
import { SessionStore } from "../../store/index.js";
import {
  PROJECTION_SESSION_ID as SESSION_ID,
  SETTLE_ADVANCE_MS,
  bridgeReadingProjection as bridgeReading,
  drainScheduledReads,
  sessionEntity,
  snapshotEnabling,
} from "./agent-console.test-support.js";
import { SessionProjectionReRead, peerInvocationEnabledIn } from "./session-projection.js";

describe("session projection — the settle window", () => {
  it("clears the trailing debounce without reaching the absolute deadline", () => {
    // The claim the shared settle rests on, asserted rather than assumed: a shorter
    // advance would leave requested reads unfired and every case counting them would
    // read zero, and one past the deadline would fire the starvation arm, so a burst
    // that must cost one read would cost two.
    expect(SETTLE_ADVANCE_MS).toBeGreaterThan(REFRESH_DEBOUNCE_MS);
    expect(SETTLE_ADVANCE_MS).toBeLessThan(REFRESH_MAX_WAIT_MS);
  });
});

describe("session projection — the peer-invocation fold", () => {
  it("reads a projected boolean through", () => {
    const partition = { [SESSION_ID]: sessionEntity({ peerInvocationEnabled: true }) };
    expect(peerInvocationEnabledIn(partition, SESSION_ID)).toBe(true);
  });

  it("negative control: a projected FALSE is false and never unknown", () => {
    // Without this, the absence cases below would pass over a fold that answered
    // `undefined` for everything — which would hide a session that reported off.
    const partition = { [SESSION_ID]: sessionEntity({ peerInvocationEnabled: false }) };
    expect(peerInvocationEnabledIn(partition, SESSION_ID)).toBe(false);
  });

  it("answers unknown for an absent member, an absent row, and a wrong type", () => {
    // None of the three says the grant is off, and rendering `false` for any of
    // them would present an enabled session as safe.
    expect(
      peerInvocationEnabledIn({ [SESSION_ID]: sessionEntity({}) }, SESSION_ID),
    ).toBeUndefined();
    expect(peerInvocationEnabledIn({}, SESSION_ID)).toBeUndefined();
    expect(
      peerInvocationEnabledIn(
        { [SESSION_ID]: sessionEntity({ peerInvocationEnabled: "true" }) },
        SESSION_ID,
      ),
    ).toBeUndefined();
  });
});

describe("session projection — the re-read", () => {
  it("asks the daemon and lands the reply in the store", async () => {
    const bridge = bridgeReading(growthServing(snapshotEnabling(true)));
    const sessionStore = new SessionStore({ sessionId: SESSION_ID });
    const reRead = new SessionProjectionReRead({ bridge, sessionStore });

    expect(peerInvocationEnabledIn(sessionStore.snapshot().partitions.session, SESSION_ID)) //
      .toBeUndefined();

    reRead.request();
    await drainScheduledReads(bridge);

    expect(reRead.readCount).toBe(1);
    expect(reRead.refusal).toBeUndefined();
    expect(peerInvocationEnabledIn(sessionStore.snapshot().partitions.session, SESSION_ID)).toBe(
      true,
    );
  });

  it("negative control: without the request nothing is read and nothing lands", async () => {
    // Without this, the case above would pass over a model that read on
    // construction — which is a second unbidden `sessionRead` per mount.
    const bridge = bridgeReading(growthServing(snapshotEnabling(true)));
    const sessionStore = new SessionStore({ sessionId: SESSION_ID });
    const reRead = new SessionProjectionReRead({ bridge, sessionStore });

    await drainScheduledReads(bridge);

    expect(reRead.readCount).toBe(0);
    expect(sessionStore.snapshot().initialised).toBe(false);
  });

  it("costs one read for a burst of presses", async () => {
    const bridge = bridgeReading(growthServing(snapshotEnabling(false)));
    const sessionStore = new SessionStore({ sessionId: SESSION_ID });
    const reRead = new SessionProjectionReRead({ bridge, sessionStore });

    reRead.request();
    reRead.request();
    reRead.request();
    await drainScheduledReads(bridge);

    expect(reRead.readCount).toBe(1);
    expect(peerInvocationEnabledIn(sessionStore.snapshot().partitions.session, SESSION_ID)).toBe(
      false,
    );
  });

  it("renders the port's own refusal and leaves the projection untouched", async () => {
    const bridge = bridgeReading(growthRefusing("sessionRead"));
    const sessionStore = new SessionStore({ sessionId: SESSION_ID });
    const reRead = new SessionProjectionReRead({ bridge, sessionStore });

    reRead.request();
    await drainScheduledReads(bridge);

    expect(reRead.refusal?.code).toBe("wire-unregistered");
    expect(reRead.refusal?.origin).toBe("growth-port");
    expect(sessionStore.snapshot().initialised).toBe(false);
  });

  it("clears a standing refusal once a later read is served", async () => {
    let served = false;
    const bridge = bridgeReading(async (request) =>
      served
        ? await growthServing(snapshotEnabling(true))(request)
        : await growthRefusing("sessionRead")(request),
    );
    const sessionStore = new SessionStore({ sessionId: SESSION_ID });
    const reRead = new SessionProjectionReRead({ bridge, sessionStore });

    reRead.request();
    await drainScheduledReads(bridge);
    expect(reRead.refusal).not.toBeUndefined();

    served = true;
    reRead.request();
    await drainScheduledReads(bridge);

    expect(reRead.readCount).toBe(2);
    expect(reRead.refusal).toBeUndefined();
  });

  it("performs no read after dispose, so an unmounted pane holds no timer", async () => {
    const bridge = bridgeReading(growthServing(snapshotEnabling(true)));
    const sessionStore = new SessionStore({ sessionId: SESSION_ID });
    const reRead = new SessionProjectionReRead({ bridge, sessionStore });

    reRead.dispose();
    reRead.request();
    await drainScheduledReads(bridge);

    expect(reRead.readCount).toBe(0);
  });
});
