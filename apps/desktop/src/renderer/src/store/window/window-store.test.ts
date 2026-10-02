// Frame state that outlives the route:
//
//   - The retained session. The route projection must not go sticky, because `AppRouter` renders
//     "this session is opening" from it.
//   - The modal-dialog cell, read through the face the frame holds. Claim ownership is tested in
//     `modal-dialog-claims.test.ts`.

import { describe, expect, it } from "vitest";

import { WindowStore } from "./window-store.js";

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
