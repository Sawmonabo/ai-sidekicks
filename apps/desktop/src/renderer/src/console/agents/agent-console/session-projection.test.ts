// The re-read that actually re-reads.
//
// The FOLD it reads back through is `store/peer-invocation-projection.ts`' and is
// held to its own cases beside that module. What is asserted here is the act this
// family owns — that pressing the offered recovery asks the daemon and lands the
// reply — and the fold is the instrument the cases read the store back with.
//
// The property under test is the one a counter could not give: pressing the offered
// recovery has to ask the daemon and land its reply in the store. So every case
// below counts the reads the scheduler performed and reads the store back, rather
// than asserting on anything this file holds.

import { describe, expect, it } from "vitest";

import { growthRefusing, growthServing } from "../../bridge/fixture/fixture-bridge.test-support.js";
import { REFRESH_DEBOUNCE_MS, REFRESH_MAX_WAIT_MS } from "../../core/index.js";
import { SessionStore } from "../../store/index.js";
import {
  PROJECTION_SESSION_ID as SESSION_ID,
  SETTLE_ADVANCE_MS,
  bridgeReadingProjection as bridgeReading,
  drainScheduledReads,
  snapshotEnabling,
} from "./agent-console.test-support.js";
import { SessionProjectionReRead } from "./session-projection.js";

/**
 * What the store's session row says about the grant, read straight off the partition.
 *
 * The projected ROW rather than the fold over it, because what these cases are about
 * is the re-read: whether the reply landed in the store at all. The fold's own rule —
 * that an absent member is never `false` — is `store/peer-invocation-projection.ts`'s
 * to state and its own co-located test's to check.
 */
function projectedGrantIn(sessionStore: SessionStore): unknown {
  return sessionStore.snapshot().partitions.session[SESSION_ID]?.body?.["peerInvocationEnabled"];
}

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

describe("session projection — the re-read", () => {
  it("asks the daemon and lands the reply in the store", async () => {
    const bridge = bridgeReading(growthServing(snapshotEnabling(true)));
    const sessionStore = new SessionStore({ sessionId: SESSION_ID });
    const reRead = new SessionProjectionReRead({ bridge, sessionStore });

    expect(projectedGrantIn(sessionStore)).toBeUndefined();

    reRead.request();
    await drainScheduledReads(bridge);

    expect(reRead.readCount).toBe(1);
    expect(reRead.refusal).toBeUndefined();
    expect(projectedGrantIn(sessionStore)).toBe(true);
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
    expect(projectedGrantIn(sessionStore)).toBe(false);
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
