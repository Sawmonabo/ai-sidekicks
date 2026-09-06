// The subscription: opening it with its registered request, what the pane sees while
// it is open, and what it says when it could not be opened at all.
//
// Split along the seam the module was. A stream that never opened is a refusal to
// report rather than an empty list, and a feed read for one session never answers
// for another — both are properties of the subscription rather than of the fold.

import { createElement } from "react";
import {
  createFixture,
  withCapturedStream,
} from "../../bridge/fixture/fixture-bridge.test-support.js";
import { drainMicrotasks } from "../../core/microtask-drain.test-support.js";
import { RUN_STATE_SUBSCRIBE_STREAM } from "../../bridge/daemon/daemon-streams.js";
import {
  withRecordedStreamSinks,
  withUnopenableStream,
} from "../../bridge/daemon/daemon-streams.test-support.js";
import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ConsoleBridge } from "../../bridge/index.js";
import { ConsoleRefusalError, refuse } from "../../core/index.js";
import { SessionStore } from "../../store/index.js";
import { RUN_STATE_REFUSAL_ORIGIN, useRunFeed, type RunStateFeed } from "./run-state-feed.js";
import {
  SESSION_ID,
  STATE_CHANGE_DELIVERY,
  mountStateFeed,
  openStateFeed,
} from "./run-state-feed.test-support.js";
import { RUN_ID } from "./runs-pane.test-support.js";

describe("the run-state stream is opened with its registered request", () => {
  it("opens the stream for a session the registered request shape accepts", async () => {
    const opened = await openStateFeed(SESSION_ID);
    expect(opened.openedStreams).toStrictEqual(["run.subscribeState"]);
    expect(opened.feed.openRefusal).toBeUndefined();
  });

  it("refuses rather than opening an unscoped stream when the session does not parse", async () => {
    const opened = await openStateFeed("not-a-session");
    expect(opened.openedStreams).toStrictEqual([]);
    expect(opened.feed.openRefusal?.code).toBe("session-unreadable");
  });
});

describe("an empty read completes", () => {
  it("is not read until the session's snapshot lands", async () => {
    const opened = await openStateFeed(SESSION_ID);
    expect(opened.feed.hasRead).toBe(false);
    expect(opened.feed.runs).toHaveLength(0);
  });

  it("reads complete on a snapshot that names no run at all", async () => {
    // The state the old rule could not reach: `hasRead` true with an empty list, so
    // a session that has never run anything can say so instead of reading forever.
    const opened = await openStateFeed(SESSION_ID, (store) => {
      store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
    });
    expect(opened.feed.hasRead).toBe(true);
    expect(opened.feed.runs).toHaveLength(0);
  });

  it("reads complete on a snapshot that names runs", async () => {
    const opened = await openStateFeed(SESSION_ID, (store) => {
      store.initialise({
        cursor: 3,
        entities: [{ kind: "run", id: RUN_ID, state: "running" }],
        participantJoinLog: [],
      });
    });
    expect(opened.feed.hasRead).toBe(true);
  });

  it("negative control: a delivery alone does not complete the read", async () => {
    // The old rule flipped `hasRead` on exactly this, which is what made
    // `hasRead && runs.length === 0` unreachable.
    const { bridge, deliver } = withCapturedStream(
      createFixture().bridge,
      RUN_STATE_SUBSCRIBE_STREAM,
    );
    const sessionStore = new SessionStore({ sessionId: SESSION_ID });
    const readFeed = await mountStateFeed(bridge, sessionStore);
    await act(async () => {
      deliver(STATE_CHANGE_DELIVERY);
      await drainMicrotasks();
    });
    expect(readFeed().runs).toHaveLength(1);
    expect(readFeed().hasRead).toBe(false);
  });
});

/** The refusal the shipped Tier-1 preload raises when a stream is opened: a throw. */
const TIER_ONE_STUB_REFUSAL = { code: "bridge.not_wired", message: "no daemon is attached" };

/** The shipped fixture with its run-state subscription refusing to open. */
function unopenableBridge(thrown: unknown): ConsoleBridge {
  return withUnopenableStream(createFixture().bridge, RUN_STATE_SUBSCRIBE_STREAM, thrown);
}

describe("a stream that cannot be opened is a refusal, not a crash", () => {
  it("publishes the open refusal rather than throwing out of the effect commit", async () => {
    const readFeed = await mountStateFeed(
      unopenableBridge(TIER_ONE_STUB_REFUSAL),
      new SessionStore({ sessionId: SESSION_ID }),
    );
    const feed = readFeed();
    expect(feed.openRefusal?.origin).toBe(RUN_STATE_REFUSAL_ORIGIN);
    expect(feed.openRefusal?.code).toBe("bridge.not_wired");
    expect(feed.runs).toHaveLength(0);
  });

  it("renders a refusal the wrapper already raised rather than re-wrapping it", async () => {
    // The unscoped-open guard throws a refusal that already names the defect; a
    // second wrap would replace that sentence with one naming the exception.
    const carried = refuse(
      "console-daemon-stream",
      "stream-request-unscoped",
      "The stream is session-scoped and was opened with no session.",
    );
    const readFeed = await mountStateFeed(
      unopenableBridge(new ConsoleRefusalError(carried)),
      new SessionStore({ sessionId: SESSION_ID }),
    );
    expect(readFeed().openRefusal).toStrictEqual(carried);
  });

  it("still reports the read from the store rather than inventing one", async () => {
    const sessionStore = new SessionStore({ sessionId: SESSION_ID });
    sessionStore.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
    const readFeed = await mountStateFeed(unopenableBridge(TIER_ONE_STUB_REFUSAL), sessionStore);
    expect(readFeed().hasRead).toBe(true);
    expect(readFeed().openRefusal?.code).toBe("bridge.not_wired");
  });

  it("negative control: that bridge does throw synchronously when subscribed directly", () => {
    // Without this the cases above would pass over a bridge that quietly answered
    // an unsubscribe, and would prove nothing about the guard.
    const bridge = unopenableBridge(TIER_ONE_STUB_REFUSAL);
    const bypassed = bridge.sidekicks.daemon.subscribe as (event: string) => unknown;
    expect(() => bypassed("run.subscribeState")).toThrow();
  });
});

/**
 * A bridge that keeps EVERY subscription's handler, not only the newest.
 *
 * The rebind cases below need to deliver into the subscription a previous session
 * opened, which a bridge holding one handler cannot express: overwriting it makes
 * every delivery the current session's and hides the failure entirely.
 */
function multiSubscriptionBridge(): {
  readonly bridge: ConsoleBridge;
  readonly handlers: readonly ((payload: unknown) => void)[];
} {
  const { bridge, sinks } = withRecordedStreamSinks(
    createFixture().bridge,
    RUN_STATE_SUBSCRIBE_STREAM,
  );
  return { bridge, handlers: sinks };
}

/**
 * Mount the feed against a store the case can swap, recording what every render
 * COMMITTED.
 *
 * Recorded during render rather than in an effect, because the interval this is
 * about is exactly one commit long: a feed cleared in a passive effect is already
 * gone by the time an effect could observe it, and the pane has meanwhile rendered
 * and seated the previous session's runs.
 */
function mountRebindableFeed(
  bridge: ConsoleBridge,
  sessionStore: SessionStore,
): {
  readonly renderedFeeds: readonly RunStateFeed[];
  readonly rebindTo: (store: SessionStore) => Promise<void>;
  readonly forgetRenders: () => void;
} {
  const renderedFeeds: RunStateFeed[] = [];
  function StateFeedProbe(props: { readonly store: SessionStore }): null {
    renderedFeeds.push(useRunFeed(bridge, props.store));
    return null;
  }
  const view = render(createElement(StateFeedProbe, { store: sessionStore }));
  return {
    renderedFeeds,
    rebindTo: async (store) => {
      await act(async () => {
        view.rerender(createElement(StateFeedProbe, { store }));
        await drainMicrotasks();
      });
    },
    forgetRenders: () => {
      renderedFeeds.length = 0;
    },
  };
}

const OTHER_SESSION_ID = "1b2c3d4e-5f60-4172-8394-a5b6c7d8e9f0";

describe("the feed belongs to the session it was read for", () => {
  it("renders nothing of the previous session on the pass that commits the new one", async () => {
    // The failure this closes: the pane seats every projected run, so for one
    // commit the previous session's rows — and the run-addressed controls on them —
    // were live under a session they do not belong to.
    const { bridge, handlers } = multiSubscriptionBridge();
    const mounted = mountRebindableFeed(bridge, new SessionStore({ sessionId: SESSION_ID }));
    await act(async () => {
      handlers[0]?.(STATE_CHANGE_DELIVERY);
      await drainMicrotasks();
    });
    expect(mounted.renderedFeeds.at(-1)?.runs).toHaveLength(1);

    mounted.forgetRenders();
    await mounted.rebindTo(new SessionStore({ sessionId: OTHER_SESSION_ID }));
    // The FIRST render under the new session, not the settled one: clearing in the
    // effect passes the second assertion and fails this one.
    expect(mounted.renderedFeeds[0]?.runs).toHaveLength(0);
    expect(mounted.renderedFeeds.at(-1)?.runs).toHaveLength(0);
  });

  it("drops a delivery from the previous session's subscription", async () => {
    const { bridge, handlers } = multiSubscriptionBridge();
    const mounted = mountRebindableFeed(bridge, new SessionStore({ sessionId: SESSION_ID }));
    await mounted.rebindTo(new SessionStore({ sessionId: OTHER_SESSION_ID }));
    mounted.forgetRenders();
    await act(async () => {
      handlers[0]?.(STATE_CHANGE_DELIVERY);
      await drainMicrotasks();
    });
    expect(mounted.renderedFeeds.every((feed) => feed.runs.length === 0)).toBe(true);
  });

  it("negative control: a delivery on the new session's own subscription is published", async () => {
    // Without this, a feed that answered the empty reading unconditionally would
    // pass both cases above and never show a run again after a rebind.
    const { bridge, handlers } = multiSubscriptionBridge();
    const mounted = mountRebindableFeed(bridge, new SessionStore({ sessionId: SESSION_ID }));
    await mounted.rebindTo(new SessionStore({ sessionId: OTHER_SESSION_ID }));
    await act(async () => {
      handlers.at(-1)?.(STATE_CHANGE_DELIVERY);
      await drainMicrotasks();
    });
    expect(mounted.renderedFeeds.at(-1)?.runs).toHaveLength(1);
  });
});

describe("an addressing move out and back inside one mount still publishes", () => {
  it("publishes a delivery taken after the pane returns to the session it left", async () => {
    // A -> B -> A without an unmount. The publisher the subscribe effect writes
    // through is bound to the ADDRESSING, which is strictly finer than the
    // `(bridge, sessionId)` pair the effect used to depend on; a subscription left
    // holding a publisher from an addressing the holder no longer honours folds
    // every delivery and renders the empty feed for the life of the mount, with
    // `openRefusal` undefined, so nothing on screen says the reading is stale.
    const { bridge, handlers } = multiSubscriptionBridge();
    const mounted = mountRebindableFeed(bridge, new SessionStore({ sessionId: SESSION_ID }));
    await mounted.rebindTo(new SessionStore({ sessionId: OTHER_SESSION_ID }));
    await mounted.rebindTo(new SessionStore({ sessionId: SESSION_ID }));
    mounted.forgetRenders();
    await act(async () => {
      handlers.at(-1)?.(STATE_CHANGE_DELIVERY);
      await drainMicrotasks();
    });
    expect(mounted.renderedFeeds.at(-1)?.runs).toHaveLength(1);
    expect(mounted.renderedFeeds.at(-1)?.openRefusal).toBeUndefined();
  });

  it("negative control: the subscription opened on the first visit publishes nothing", async () => {
    // Without this, a feed that published every delivery whatever subscription it
    // arrived on would pass the case above while re-admitting the visit that is over.
    const { bridge, handlers } = multiSubscriptionBridge();
    const mounted = mountRebindableFeed(bridge, new SessionStore({ sessionId: SESSION_ID }));
    await mounted.rebindTo(new SessionStore({ sessionId: OTHER_SESSION_ID }));
    await mounted.rebindTo(new SessionStore({ sessionId: SESSION_ID }));
    mounted.forgetRenders();
    await act(async () => {
      handlers[0]?.(STATE_CHANGE_DELIVERY);
      await drainMicrotasks();
    });
    expect(mounted.renderedFeeds.every((feed) => feed.runs.length === 0)).toBe(true);
  });
});
