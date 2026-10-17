// Frame state that outlives the route:
//
//   - The retained session. The route projection must not go sticky, because `AppRouter` renders
//     "this session is opening" from it.
//   - The modal-dialog cell, read through the face the frame holds. Claim ownership is tested in
//     `modal-dialog-claims.test.ts`.

import { describe, expect, it } from "vitest";

import { DEFAULT_ROUTE, formatRoute } from "#renderer/routing/routes.js";
import { WindowStore } from "./store.js";

describe("WindowStore — the session a window has in hand outlives the route", () => {
  it("keeps the retained session while the route projection stops naming it", () => {
    // `AppRouter` renders "this session is opening" while the projection names a session with no
    // store, so a sticky projection would show it over Settings for the window's life.
    const store = new WindowStore();

    store.navigate({ kind: "session", sessionId: "session-alpha" });
    expect(store.activeSessionId).toBe("session-alpha");

    store.navigate({ kind: "settings", page: undefined });
    expect(store.activeSessionId).toBeUndefined();
    expect(store.lastOpenedSessionId).toBe("session-alpha");
  });
});

describe("WindowStore — leaving a session the background service does not hold", () => {
  it("moves a window an address opened at it, in place, to the start screen saying it is not here", () => {
    const store = new WindowStore({
      initialRoute: { kind: "session", sessionId: "session-gone" },
      openingCause: "address",
    });

    store.leaveGoneSession("session-gone");

    const state = store.getState();
    expect(state.route).toStrictEqual(DEFAULT_ROUTE);
    expect(state.routeHistoryWrite).toBe("replace");
    expect(state.sessionsTrackList).toBe("sessions");
    expect(state.goneSessionRaise).toStrictEqual({
      raisedAt: state.routeWriteCount,
      standsAt: state.routeWriteCount,
      target: "session-not-here",
      pressedControl: undefined,
    });
    expect(store.lastOpenedSessionId).toBeUndefined();
  });

  it("says Session not found for a window the kept layout reopened at a deleted session", () => {
    const store = new WindowStore({
      initialRoute: { kind: "session", sessionId: "session-gone" },
      openingCause: "kept-layout",
    });

    store.leaveGoneSession("session-gone");

    expect(store.getState().route).toStrictEqual(DEFAULT_ROUTE);
    expect(store.getState().goneSessionRaise?.target).toBe("session");
  });

  it("steps back to the screen shown before, on the control pressed, saying Session not found", () => {
    const store = new WindowStore();
    store.navigate({ kind: "session", sessionId: "session-alpha" });
    const runRoute = { kind: "workflows", tab: "runs", runId: "run-one" } as const;
    store.navigate(runRoute);
    store.navigate(
      { kind: "session", sessionId: "session-gone" },
      { pressedControl: "run-fix-session" },
    );

    store.leaveGoneSession("session-gone");

    const state = store.getState();
    expect(state.route).toStrictEqual(runRoute);
    expect(state.routeHistoryWrite).toBe("back");
    expect(state.goneSessionRaise).toStrictEqual({
      raisedAt: state.routeWriteCount,
      standsAt: state.routeWriteCount,
      target: "session",
      pressedControl: "run-fix-session",
    });
    expect(state.sessionsTrackList).toBeUndefined();
    expect(store.lastOpenedSessionId).toBe("session-alpha");

    // The screen leaving a missing run for the list carries the line; once any other move has
    // put it away, nothing carries it again.
    const listRoute = { kind: "workflows", tab: "runs" } as const;
    store.navigate(listRoute, { carriesGoneSessionRaise: true });
    const carried = store.getState();
    expect(carried.goneSessionRaise).toStrictEqual({
      ...state.goneSessionRaise,
      standsAt: carried.routeWriteCount,
    });
    store.navigate(runRoute);
    store.navigate(listRoute, { carriesGoneSessionRaise: true });
    expect(store.getState().goneSessionRaise?.standsAt).toBe(carried.routeWriteCount);
  });

  it("takes a gone session's entry in place when Back led into it, so nothing leads there again", () => {
    // History A, G, X; Back from X into G, which the address change entered.
    const store = new WindowStore();
    store.navigate({ kind: "session", sessionId: "session-alpha" });
    store.navigate({ kind: "session", sessionId: "session-gone" });
    const settingsRoute = { kind: "settings", page: undefined } as const;
    store.navigate(settingsRoute);
    store.adoptHash(formatRoute({ kind: "session", sessionId: "session-gone" }));

    store.leaveGoneSession("session-gone");

    const state = store.getState();
    expect(state.route).toStrictEqual(settingsRoute);
    expect(state.routeHistoryWrite).toBe("replace");
    expect(state.goneSessionRaise).toMatchObject({
      raisedAt: state.routeWriteCount,
      target: "session",
    });
    expect(store.lastOpenedSessionId).toBeUndefined();
  });

  it("never keeps a gone session in hand after a pointer back into it from a screen naming none", () => {
    const store = new WindowStore();
    store.navigate({ kind: "session", sessionId: "session-gone" });
    store.navigate({ kind: "workflows", tab: "runs" });
    store.navigate(
      { kind: "session", sessionId: "session-gone" },
      { pressedControl: "run-fix-session" },
    );

    store.leaveGoneSession("session-gone");

    expect(store.getState().route).toStrictEqual({ kind: "workflows", tab: "runs" });
    expect(store.lastOpenedSessionId).toBeUndefined();
  });

  it("never steps back into a gone session when the screen it returned to goes too", () => {
    const store = new WindowStore({
      initialRoute: { kind: "session", sessionId: "session-alpha" },
      openingCause: "address",
    });
    store.navigate({ kind: "session", sessionId: "session-gone" });
    store.leaveGoneSession("session-gone");
    expect(store.getState().route).toStrictEqual({ kind: "session", sessionId: "session-alpha" });

    store.leaveGoneSession("session-alpha");

    const state = store.getState();
    expect(state.route).toStrictEqual(DEFAULT_ROUTE);
    expect(state.routeHistoryWrite).toBe("replace");
    // The address named the window's first screen, not this one, which the person had moved to.
    expect(state.goneSessionRaise?.target).toBe("session");
    expect(store.lastOpenedSessionId).toBeUndefined();
  });
});

describe("WindowStore — a feature's modal dialog publishes whether it is up", () => {
  it("publishes the open dialog and clears it again, through the readable", () => {
    // Read through `readable`, the face the frame holds: a cell the read-only face never
    // reported would leave the background reachable with the card up.
    const store = new WindowStore();
    const published: boolean[] = [];
    const unsubscribe = store.readable.subscribe((state) => {
      published.push(state.isModalDialogOpen);
    });

    store.modalDialogClaims.hold("a-modal-dialog");
    expect(store.readable.getState().isModalDialogOpen).toBe(true);

    store.modalDialogClaims.release("a-modal-dialog");
    expect(store.readable.getState().isModalDialogOpen).toBe(false);

    unsubscribe();
    expect(published).toStrictEqual([true, false]);
  });
});
