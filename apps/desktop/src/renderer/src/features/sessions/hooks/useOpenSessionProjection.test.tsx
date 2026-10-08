// What the open-session projection promises, driven against the real registry. It follows
// every open session, and it lets a closed one go, because a listener left on a store the
// registry dropped leaks with every session a window opens and closes. Each is asserted with
// its opposite in the same case. Only the read is stood in for: releasing acts on a real
// subscription.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SessionStoreRegistry } from "#renderer/store/session/registry.js";
import { worstDegradedCause } from "#renderer/store/session/degradation.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { readsNothing, openingPageLimit } from "#test/helpers/session/store/fixtures.js";
import { countStoreListeners } from "#test/helpers/session/store/listeners.js";
import { OpenSessionRowProjection, useOpenSessionProjection } from "./useOpenSessionProjection.js";
import type { SessionListRow } from "../rows/list-row.js";

/**
 * Establish a base state on an open store, the way a completed read would. A store holding one
 * takes another only as a repair, so a later one lands after a failed read.
 */
function establish(
  store: SessionStore,
  options: { readonly cursor: number; readonly touchedAtIso: string },
): void {
  if (store.snapshot().initialized) {
    store.markReadFailed();
  }
  store.initialize({
    cursor: options.cursor,
    entities: [
      {
        kind: "session",
        id: store.sessionId,
        state: "active",
        touchedAt: options.touchedAtIso,
      },
    ],
  });
}

/** A registry holding the named sessions, each with a base state. */
function registryHolding(sessionIds: readonly string[]): SessionStoreRegistry {
  const registry = new SessionStoreRegistry({ openingPageLimit, read: readsNothing });
  for (const sessionId of sessionIds) {
    establish(registry.open(sessionId), { cursor: 0, touchedAtIso: "2026-01-01T10:00:00.000Z" });
  }
  return registry;
}

describe("OpenSessionRowProjection", () => {
  it("answers before anything has subscribed", () => {
    // React reads a snapshot before the subscribing effect runs, so a cache filled only by
    // notifications would render an empty list first.
    const projection = new OpenSessionRowProjection(registryHolding(["session-a"]));

    expect(projection.readRows()).toHaveLength(1);
    expect(projection.subscribedSessionIds).toStrictEqual([]);
  });

  it("keeps the same array while nothing changes", () => {
    // `useSyncExternalStore` compares reads with `Object.is`; rebuilding every call would spin.
    const projection = new OpenSessionRowProjection(registryHolding(["session-a"]));

    expect(projection.readRows()).toBe(projection.readRows());
  });

  it("follows a session opened after the projection was subscribed", () => {
    const registry = registryHolding(["session-a"]);
    const projection = new OpenSessionRowProjection(registry);
    let notifications = 0;
    projection.subscribe(() => {
      notifications += 1;
    });

    establish(registry.open("session-b"), { cursor: 0, touchedAtIso: "2026-01-01T11:00:00.000Z" });

    expect(notifications).toBeGreaterThan(0);
    expect(projection.readRows().map((row) => row.sessionId)).toStrictEqual([
      "session-a",
      "session-b",
    ]);
    expect(projection.subscribedSessionIds).toStrictEqual(["session-a", "session-b"]);
  });

  it("releases a closed session's subscription, and keeps the open one's", () => {
    const registry = registryHolding(["session-a", "session-b"]);
    const closedStore = registry.peek("session-a");
    const openStore = registry.peek("session-b");
    if (closedStore === undefined || openStore === undefined) {
      throw new Error("the registry did not open both sessions");
    }
    const projection = new OpenSessionRowProjection(registry);
    let notifications = 0;
    projection.subscribe(() => {
      notifications += 1;
    });

    registry.close("session-a");
    expect(projection.subscribedSessionIds).toStrictEqual(["session-b"]);

    // The closed store is still live (closing disposes its queue and scheduler, not its
    // subscribers), so a projection that never released would still be woken by it.
    notifications = 0;
    establish(closedStore, { cursor: 1, touchedAtIso: "2026-01-01T12:00:00.000Z" });
    expect(notifications).toBe(0);

    // Negative control: the session still open still wakes it.
    establish(openStore, { cursor: 1, touchedAtIso: "2026-01-01T13:00:00.000Z" });
    expect(notifications).toBeGreaterThan(0);
  });

  it("holds no subscription once the last subscriber has gone", () => {
    const registry = registryHolding(["session-a"]);
    const store = registry.peek("session-a");
    if (store === undefined) {
      throw new Error("the registry did not open the session");
    }
    const liveListeners = countStoreListeners(store);
    const projection = new OpenSessionRowProjection(registry);
    let notifications = 0;
    const release = projection.subscribe(() => {
      notifications += 1;
    });
    // Negative control, taken first: while subscribed, it is woken.
    establish(store, { cursor: 1, touchedAtIso: "2026-01-01T12:00:00.000Z" });
    const wokenWhileSubscribed = notifications;
    expect(wokenWhileSubscribed).toBeGreaterThan(0);
    expect(liveListeners()).toBe(1);

    release();

    expect(projection.subscribedSessionIds).toStrictEqual([]);
    // Counted on the store: with no subscriber left, a listener left behind notifies nobody.
    expect(liveListeners()).toBe(0);
    establish(store, { cursor: 2, touchedAtIso: "2026-01-01T13:00:00.000Z" });
    expect(notifications).toBe(wokenWhileSubscribed);
  });

  it("re-reads when an open session's projection moves", () => {
    const registry = registryHolding(["session-a"]);
    const store = registry.peek("session-a");
    if (store === undefined) {
      throw new Error("the registry did not open the session");
    }
    const projection = new OpenSessionRowProjection(registry);
    projection.subscribe(() => undefined);
    const before = projection.readRows();

    establish(store, { cursor: 1, touchedAtIso: "2026-01-01T12:00:00.000Z" });

    expect(projection.readRows()).not.toBe(before);
    expect(projection.readRows()[0]?.touchedAtIso).toBe("2026-01-01T12:00:00.000Z");
  });
});

describe("useOpenSessionProjection", () => {
  function OpenSessionRowsProbe(props: {
    readonly registry: SessionStoreRegistry;
    readonly seen: SessionListRow[][];
  }): React.JSX.Element {
    const { rows } = useOpenSessionProjection(props.registry);
    props.seen.push([...rows]);
    return <p>{rows.map((row) => row.sessionId).join(",")}</p>;
  }

  it("follows a replaced registry rather than the one it dropped", () => {
    const seen: SessionListRow[][] = [];
    const mounted = render(
      <OpenSessionRowsProbe registry={registryHolding(["session-a"])} seen={seen} />,
    );

    mounted.rerender(
      <OpenSessionRowsProbe registry={registryHolding(["session-b"])} seen={seen} />,
    );

    expect(mounted.container.textContent).toBe("session-b");
  });
});

describe("the degradation fold beside the rows", () => {
  it("reports the worst cause standing across the open set, not the newest", () => {
    // The destination has one line to say what the list is; the last store written must not
    // decide it.
    const registry = registryHolding(["session-a", "session-b"]);
    registry.peek("session-a")?.markReadFailed();
    registry.peek("session-b")?.markDegraded("stream-diverged");
    const projection = new OpenSessionRowProjection(registry);

    expect(projection.readDegradedCause()).toBe(
      worstDegradedCause("read-failed", "stream-diverged"),
    );
  });

  it("would notice a fold that reported one session's cause as none", () => {
    // Negative control: one degraded store of two still degrades the list, so the reading
    // above is a fold rather than a lookup of the first store.
    const registry = registryHolding(["session-a", "session-b"]);
    registry.peek("session-b")?.markDegraded("subscription-closed");

    expect(new OpenSessionRowProjection(registry).readDegradedCause()).toBe("subscription-closed");
  });

  it("re-reads when a store degrades under a live projection", () => {
    const registry = registryHolding(["session-a"]);
    const projection = new OpenSessionRowProjection(registry);
    let notifications = 0;
    projection.subscribe(() => {
      notifications += 1;
    });

    registry.peek("session-a")?.markDegraded("sequence-gap");

    expect(notifications).toBeGreaterThan(0);
    expect(projection.readDegradedCause()).toBe("sequence-gap");
  });
});
