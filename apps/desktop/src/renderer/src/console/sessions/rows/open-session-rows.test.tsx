// What the open-session projection promises, driven against the real registry.
//
// Two properties, and neither is a type. It must follow EVERY open session — the
// defect it exists to close is a list built from one store that was never opened —
// and it must let a closed session go, because a listener left on a store the
// registry has dropped is a leak that grows with every session a window opens and
// closes. Each is asserted with the opposite in the same case: "the closed session
// no longer notifies" is worthless unless the open one still does.
//
// The registry and the stores are the shipped ones. A fake registry could not answer
// the release question at all — releasing is what this module does TO a real
// subscription — so the only stand-in here is the read, which is the collaborator the
// store family's own suites stand in for.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SessionStoreRegistry, worstDegradedCause, type SessionStore } from "../../store/index.js";
import { readsNothing } from "../../store/session-store-registry.test-support.js";
import { OpenSessionRowProjection, useOpenSessionProjection } from "./open-session-rows.js";
import type { SessionListRow } from "./session-rows.js";

/** Establish a base state on an open store, the way a completed read would. */
function establish(
  store: SessionStore,
  options: { readonly cursor: number; readonly touchedAtIso: string },
): void {
  store.initialise({
    cursor: options.cursor,
    entities: [
      {
        kind: "session",
        id: store.sessionId,
        state: "active",
        touchedAt: options.touchedAtIso,
      },
    ],
    participantJoinLog: [],
  });
}

/** A registry holding the named sessions, each with a base state. */
function registryHolding(sessionIds: readonly string[]): SessionStoreRegistry {
  const registry = new SessionStoreRegistry({ read: readsNothing });
  for (const sessionId of sessionIds) {
    establish(registry.open(sessionId), { cursor: 0, touchedAtIso: "2026-01-01T10:00:00.000Z" });
  }
  return registry;
}

describe("OpenSessionRowProjection", () => {
  it("projects a row for every open session, not for one of them", () => {
    const projection = new OpenSessionRowProjection(registryHolding(["session-a", "session-b"]));

    expect(projection.readRows().map((row) => row.sessionId)).toStrictEqual([
      "session-a",
      "session-b",
    ]);
  });

  it("answers before anything has subscribed", () => {
    // React reads a snapshot on the first render, ahead of the effect that
    // subscribes. A projection that only filled its cache from a notification would
    // render an empty list on that first pass.
    const projection = new OpenSessionRowProjection(registryHolding(["session-a"]));

    expect(projection.readRows()).toHaveLength(1);
    expect(projection.subscribedSessionIds).toStrictEqual([]);
  });

  it("keeps the same array while nothing changes", () => {
    // `useSyncExternalStore` compares consecutive reads with `Object.is` and
    // re-renders while they differ, so a read that rebuilt every call would spin.
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

    // The closed session's store is still a live object — closing it disposes its
    // queue and its scheduler, not its subscribers — so a projection that never
    // released would still be woken by it.
    notifications = 0;
    establish(closedStore, { cursor: 1, touchedAtIso: "2026-01-01T12:00:00.000Z" });
    expect(notifications).toBe(0);

    // The negative control: the session that is still open still wakes it.
    establish(openStore, { cursor: 1, touchedAtIso: "2026-01-01T13:00:00.000Z" });
    expect(notifications).toBe(1);
  });

  it("holds no subscription once the last subscriber has gone", () => {
    const registry = registryHolding(["session-a"]);
    const store = registry.peek("session-a");
    if (store === undefined) {
      throw new Error("the registry did not open the session");
    }
    const projection = new OpenSessionRowProjection(registry);
    let notifications = 0;
    const release = projection.subscribe(() => {
      notifications += 1;
    });
    // The negative control, taken first: while it is subscribed, it is woken.
    establish(store, { cursor: 1, touchedAtIso: "2026-01-01T12:00:00.000Z" });
    expect(notifications).toBe(1);

    release();

    expect(projection.subscribedSessionIds).toStrictEqual([]);
    establish(store, { cursor: 2, touchedAtIso: "2026-01-01T13:00:00.000Z" });
    expect(notifications).toBe(1);
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

  it("renders the open sessions and re-renders when one of them changes", () => {
    const registry = registryHolding(["session-a"]);
    const store = registry.peek("session-a");
    if (store === undefined) {
      throw new Error("the registry did not open the session");
    }
    const seen: SessionListRow[][] = [];

    const mounted = render(<OpenSessionRowsProbe registry={registry} seen={seen} />);
    expect(mounted.container.textContent).toBe("session-a");

    act(() => {
      establish(store, { cursor: 1, touchedAtIso: "2026-01-01T12:00:00.000Z" });
    });

    expect(seen.at(-1)?.[0]?.touchedAtIso).toBe("2026-01-01T12:00:00.000Z");
  });

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
  it("reports nothing standing while every open store is following", () => {
    const projection = new OpenSessionRowProjection(registryHolding(["session-a", "session-b"]));

    expect(projection.readDegradedCause()).toBeUndefined();
  });

  it("reports the worst cause standing across the open set, not the newest", () => {
    // Two sessions degrade differently, and the destination has ONE line to say what
    // the list is. Reporting the last one written would make the sentence depend on
    // which store happened to fail second.
    const registry = registryHolding(["session-a", "session-b"]);
    registry.peek("session-a")?.markDegraded("read-failed");
    registry.peek("session-b")?.markDegraded("stream-diverged");
    const projection = new OpenSessionRowProjection(registry);

    expect(projection.readDegradedCause()).toBe(
      worstDegradedCause("read-failed", "stream-diverged"),
    );
  });

  it("would notice a fold that reported one session's cause as none", () => {
    // The negative control: one degraded store out of two still degrades the list,
    // so the reading above is a fold rather than a lookup of the first store.
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
