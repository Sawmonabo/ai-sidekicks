// Frame state that outlives the route:
//
//   - The retained session. The route projection must not go sticky, because `AppRouter` renders
//     "this session is opening" from it.
//   - The banner key. Origin plus code keeps two subsystems that share a code from overwriting
//     each other.
//   - The modal-dialog cell. An unchanged write must publish nothing, since the writer is an
//     effect that re-runs on inputs the cell does not depend on. Claim ownership is tested in
//     `modal-dialog-claims.test.ts`.
//   - The focus seed. It is read from the document, because a window opened without focus never
//     receives the `blur` that would correct an assumed `true`; the last case is the control.

import { describe, expect, it } from "vitest";

import { refuse } from "@renderer/lib/refusal.js";
import {
  FOCUSED_DOCUMENT,
  HIDDEN_DOCUMENT,
  UNFOCUSED_DOCUMENT,
  underDocumentFocus,
} from "@test/helpers/document-focus.js";
import { WindowStore } from "./window-store.js";

const SESSION_ROUTE_HASH = "#/session/session-alpha";
const SETTINGS_ROUTE_HASH = "#/settings";

describe("WindowStore — the session a window has in hand outlives the route", () => {
  it("is seeded from the route the window opened at", () => {
    const store = new WindowStore({
      initialRoute: { kind: "session", sessionId: "session-alpha" },
    });

    expect(store.lastOpenedSessionId).toBe("session-alpha");
  });

  it("is empty in a window that opened on no session", () => {
    expect(new WindowStore().lastOpenedSessionId).toBeUndefined();
  });

  it("survives a navigation to a route that names no session", () => {
    const store = new WindowStore();

    store.navigate({ kind: "session", sessionId: "session-alpha" });
    store.navigate({ kind: "settings", page: undefined });

    expect(store.lastOpenedSessionId).toBe("session-alpha");
  });

  it("survives a hash adoption that names no session", () => {
    // The second route writer; a rule enforced on only one path is one the other opts out of.
    const store = new WindowStore();

    store.adoptHash(SESSION_ROUTE_HASH);
    store.adoptHash(SETTINGS_ROUTE_HASH);

    expect(store.lastOpenedSessionId).toBe("session-alpha");
  });

  it("moves to the newer session when one is opened", () => {
    const store = new WindowStore();

    store.navigate({ kind: "session", sessionId: "session-alpha" });
    store.navigate({ kind: "session", sessionId: "session-beta" });

    expect(store.lastOpenedSessionId).toBe("session-beta");
  });

  it("control: the route projection does NOT go sticky", () => {
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
  it("reports no modal dialog in a window that has just opened", () => {
    expect(new WindowStore().getState().isModalDialogOpen).toBe(false);
  });

  it("publishes the open dialog and clears it again, through the readable", () => {
    // Read through `readable`, the face the frame holds: a cell the read-only face never
    // reported would leave the background reachable with the card up.
    const store = new WindowStore();
    const published: boolean[] = [];
    const unsubscribe = store.readable.subscribe((state) => {
      published.push(state.isModalDialogOpen);
    });

    store.modalDialogClaims.hold("the-sign-in-card");
    expect(store.readable.getState().isModalDialogOpen).toBe(true);

    store.modalDialogClaims.release("the-sign-in-card");
    expect(store.readable.getState().isModalDialogOpen).toBe(false);

    unsubscribe();
    expect(published).toStrictEqual([true, false]);
  });

  it("control: an unchanged write publishes nothing", () => {
    // The publisher re-runs whenever the window hands it a new store, and the register repeats
    // `true` when a card closes under another. Without the guard each would re-render the rail,
    // banners and screen for a fact that did not move.
    const store = new WindowStore();
    let publishCount = 0;
    const unsubscribe = store.readable.subscribe(() => {
      publishCount += 1;
    });

    store.modalDialogClaims.release("a-card-that-never-opened");
    expect(publishCount).toBe(0);

    store.modalDialogClaims.hold("the-sign-in-card");
    store.modalDialogClaims.hold("the-onboarding-walkthrough");
    expect(publishCount).toBe(1);

    // The register republishes `true` here and the cell must absorb it: the sign-in card is
    // still up.
    store.modalDialogClaims.release("the-onboarding-walkthrough");
    expect(publishCount).toBe(1);

    unsubscribe();
  });
});

describe("WindowStore — a refusal banner is keyed by its author and its code", () => {
  it("replaces its own banner when the same act fails twice", () => {
    const store = new WindowStore();

    store.raiseRefusalBanner(refuse("persistence", "quota-exceeded", "the first sentence"));
    store.raiseRefusalBanner(refuse("persistence", "quota-exceeded", "the second sentence"));

    expect(store.getState().banners).toHaveLength(1);
    expect(store.getState().banners[0]?.detail).toBe("the second sentence");
  });

  it("keeps two subsystems' banners apart when they share a code word", () => {
    // One producer's refusal must not overwrite another's because both said `unavailable`.
    const store = new WindowStore();

    store.raiseRefusalBanner(refuse("persistence", "unavailable", "storage is gone"));
    store.raiseRefusalBanner(refuse("sessions", "unavailable", "the daemon is not answering"));

    expect(store.getState().banners.map((banner) => banner.detail)).toStrictEqual([
      "storage is gone",
      "the daemon is not answering",
    ]);
  });

  it("renders the refusal's code and detail and no third string", () => {
    const store = new WindowStore();

    store.raiseRefusalBanner(refuse("persistence", "quota-exceeded", "the disk is full"));

    const banner = store.getState().banners[0];
    expect(banner?.code).toBe("quota-exceeded");
    expect(banner?.detail).toBe("the disk is full");
    expect(banner?.dismissible).toBe(true);
  });

  it("dismisses by the id it was raised under", () => {
    const store = new WindowStore();

    store.raiseRefusalBanner(refuse("persistence", "quota-exceeded", "the disk is full"));
    const raised = store.getState().banners[0];
    expect(raised).toBeDefined();
    store.dismissBanner(raised?.id ?? "");

    expect(store.getState().banners).toStrictEqual([]);
  });

  it("publishes nothing when asked to dismiss a banner it does not hold", () => {
    const store = new WindowStore();
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

describe("WindowStore — window focus is seeded from the window's own document", () => {
  it("opens unfocused where the document does not hold the keyboard", () => {
    // Seeded `true`, this window never received a `blur` (it was never focused), so consumers
    // read an audience that was not there.
    const store = underDocumentFocus(UNFOCUSED_DOCUMENT, () => new WindowStore());

    expect(store.getState().isWindowFocused).toBe(false);
  });

  it("opens unfocused where the document is not on screen at all", () => {
    // Not the first reading twice: a minimized window that had focus reports hidden, and so does
    // a window main creates without showing before anything is focused.
    const store = underDocumentFocus(HIDDEN_DOCUMENT, () => new WindowStore());

    expect(store.getState().isWindowFocused).toBe(false);
  });

  it("opens focused where the document is visible and holds the keyboard — the control", () => {
    const store = underDocumentFocus(FOCUSED_DOCUMENT, () => new WindowStore());

    expect(store.getState().isWindowFocused).toBe(true);
  });

  it("reads the document once, at construction, and not on every read", () => {
    // A seed, not a subscription: the focus and blur listeners move the cell afterwards, and a
    // store that re-read the document on every access could disagree with them.
    const store = underDocumentFocus(UNFOCUSED_DOCUMENT, () => new WindowStore());

    store.setWindowFocused(true);

    expect(store.getState().isWindowFocused).toBe(true);
  });

  it("gives two windows built under different documents different answers", () => {
    // An auxiliary window shares no store with the main one, and only its own document says
    // whether anybody is looking at it.
    const background = underDocumentFocus(UNFOCUSED_DOCUMENT, () => new WindowStore());
    const foreground = underDocumentFocus(FOCUSED_DOCUMENT, () => new WindowStore());

    expect(background.getState().isWindowFocused).toBe(false);
    expect(foreground.getState().isWindowFocused).toBe(true);
  });
});
