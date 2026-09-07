// Frame state that outlives the route, and the banner key that keeps two producers
// apart.
//
// Both claims are about the same thing: a store field that exists because reading
// the route was not enough.
//
//   • **The retained session.** `activeSessionId` answers "which session does the
//     route name", and every consumer that wanted "which session is this window in"
//     asked it instead — so opening a session and then going to Settings made a
//     session that was still open unreachable. The two answers are kept apart here
//     rather than reconciled at each caller, and the control below is the one that
//     matters: the route projection must NOT go sticky, because `RouteSurface`
//     renders "this session is opening" off exactly that projection.
//   • **The banner key.** A refusal keyed on its code alone was unambiguous while
//     one producer raised banners. It stopped being unambiguous when a second one
//     did, and two subsystems sharing a code word would have overwritten each
//     other's sentence.

import { describe, expect, it } from "vitest";

import { refuse } from "../core/index.js";
import { FrameStore } from "./frame-store.js";

const SESSION_ROUTE_HASH = "#/session/session-alpha";
const SETTINGS_ROUTE_HASH = "#/settings";

describe("FrameStore — the session a window has in hand outlives the route", () => {
  it("is seeded from the route the window opened at", () => {
    const store = new FrameStore({
      initialRoute: { kind: "workspace", sessionId: "session-alpha" },
    });

    expect(store.lastOpenedSessionId).toBe("session-alpha");
  });

  it("is empty in a window that opened on no session", () => {
    expect(new FrameStore().lastOpenedSessionId).toBeUndefined();
  });

  it("survives a navigation to a route that names no session", () => {
    const store = new FrameStore();

    store.navigate({ kind: "workspace", sessionId: "session-alpha" });
    store.navigate({ kind: "settings", page: undefined });

    expect(store.lastOpenedSessionId).toBe("session-alpha");
  });

  it("survives a hash adoption that names no session", () => {
    // The second writer. A rule enforced on one of the two route paths is a rule
    // the other one silently opts out of.
    const store = new FrameStore();

    store.adoptHash(SESSION_ROUTE_HASH);
    store.adoptHash(SETTINGS_ROUTE_HASH);

    expect(store.lastOpenedSessionId).toBe("session-alpha");
  });

  it("moves to the newer session when one is opened", () => {
    const store = new FrameStore();

    store.navigate({ kind: "workspace", sessionId: "session-alpha" });
    store.navigate({ kind: "workspace", sessionId: "session-beta" });

    expect(store.lastOpenedSessionId).toBe("session-beta");
  });

  it("takes the session an auxiliary route carries, and is not cleared by a bare one", () => {
    const store = new FrameStore();

    store.navigate({ kind: "auxiliary", route: "timeline", sessionId: "session-alpha" });
    expect(store.lastOpenedSessionId).toBe("session-alpha");

    store.navigate({ kind: "auxiliary", route: "timeline" });
    expect(store.lastOpenedSessionId).toBe("session-alpha");
  });

  it("control: the route projection does NOT go sticky", () => {
    // `RouteSurface` renders "this session is opening" whenever the projection
    // names a session and its store is absent. A projection that retained the
    // session would put that message over Settings for as long as the window lived.
    const store = new FrameStore();

    store.navigate({ kind: "workspace", sessionId: "session-alpha" });
    expect(store.activeSessionId).toBe("session-alpha");

    store.navigate({ kind: "settings", page: undefined });
    expect(store.activeSessionId).toBeUndefined();
    expect(store.lastOpenedSessionId).toBe("session-alpha");
  });
});

describe("FrameStore — a refusal banner is keyed by its author and its code", () => {
  it("replaces its own banner when the same act fails twice", () => {
    const store = new FrameStore();

    store.raiseRefusalBanner(refuse("persistence", "quota-exceeded", "the first sentence"));
    store.raiseRefusalBanner(refuse("persistence", "quota-exceeded", "the second sentence"));

    expect(store.getState().banners).toHaveLength(1);
    expect(store.getState().banners[0]?.detail).toBe("the second sentence");
  });

  it("keeps two subsystems' banners apart when they share a code word", () => {
    // The defect the key exists to prevent: one producer's refusal silently
    // overwriting another's because both happened to say `unavailable`.
    const store = new FrameStore();

    store.raiseRefusalBanner(refuse("persistence", "unavailable", "storage is gone"));
    store.raiseRefusalBanner(refuse("growth-port", "unavailable", "the wire is not built"));

    expect(store.getState().banners.map((banner) => banner.detail)).toStrictEqual([
      "storage is gone",
      "the wire is not built",
    ]);
  });

  it("renders the refusal's code and detail and no third string", () => {
    const store = new FrameStore();

    store.raiseRefusalBanner(refuse("persistence", "quota-exceeded", "the disk is full"));

    const banner = store.getState().banners[0];
    expect(banner?.code).toBe("quota-exceeded");
    expect(banner?.detail).toBe("the disk is full");
    expect(banner?.dismissible).toBe(true);
  });

  it("dismisses by the id it was raised under", () => {
    const store = new FrameStore();

    store.raiseRefusalBanner(refuse("persistence", "quota-exceeded", "the disk is full"));
    const raised = store.getState().banners[0];
    expect(raised).toBeDefined();
    store.dismissBanner(raised?.id ?? "");

    expect(store.getState().banners).toStrictEqual([]);
  });

  it("publishes nothing when asked to dismiss a banner it does not hold", () => {
    const store = new FrameStore();
    let notifications = 0;
    const unsubscribe = store.readable.subscribe(() => {
      notifications += 1;
    });
    const before = store.getState().banners;

    store.dismissBanner("version:absent");

    // Positive control: a real dismissal still notifies.
    expect(notifications).toBe(0);
    expect(store.getState().banners).toBe(before);
    store.raiseRefusalBanner(refuse("persistence", "quota-exceeded", "the disk is full"));
    store.dismissBanner("persistence:quota-exceeded");
    expect(notifications).toBe(2);
    unsubscribe();
  });
});
