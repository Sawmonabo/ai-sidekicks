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
//   • **The modal-surface cell.** The frame inerts its background for a modal
//     overlay's lifetime, and it can only ask itself about the palette: a card a
//     VIEW family renders is one `console-view-family-isolation` forbids the frame
//     from naming at all. So the card takes a CLAIM here and the frame reads the one
//     cell that register derives — which makes what the cell PUBLISHES the whole
//     contract, and the control below is the one that matters: an unchanged write
//     must publish nothing, because the writer is an effect that re-runs on inputs
//     the cell does not depend on. Whose claim is whose is
//     `modal-surface-claims.test.ts`; what reaches the readable is here.
//   • **The focus seed.** `isWindowFocused` was `true` at construction and moved only
//     on a transition, so a window that opened without focus received no `blur` to
//     correct it and claimed an audience it never had. It is read from the document
//     now, and the cases below drive both readings the store conjoins — the last of
//     them is the negative control, since a seed that answered `false` everywhere
//     would satisfy the first two and be just as wrong.

import { describe, expect, it } from "vitest";

import { refuse } from "../core/index.js";
import {
  FOCUSED_DOCUMENT,
  HIDDEN_DOCUMENT,
  UNFOCUSED_DOCUMENT,
  underDocumentFocus,
} from "./document-focus.test-support.js";
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

describe("FrameStore — a family-owned modal surface publishes whether it is up", () => {
  it("reports no modal surface in a window that has just opened", () => {
    expect(new FrameStore().getState().isModalSurfaceOpen).toBe(false);
  });

  it("publishes the open surface and clears it again, through the readable", () => {
    // Read through `readable` rather than through `getState`, because that is the
    // face the frame actually holds: a cell the class could set and the read-only
    // face never reported would leave the background reachable with the card up.
    const store = new FrameStore();
    const published: boolean[] = [];
    const unsubscribe = store.readable.subscribe((state) => {
      published.push(state.isModalSurfaceOpen);
    });

    store.modalSurfaceClaims.hold("the-sign-in-card");
    expect(store.readable.getState().isModalSurfaceOpen).toBe(true);

    store.modalSurfaceClaims.release("the-sign-in-card");
    expect(store.readable.getState().isModalSurfaceOpen).toBe(false);

    unsubscribe();
    expect(published).toStrictEqual([true, false]);
  });

  it("control: an unchanged write publishes nothing", () => {
    // The publisher is an effect keyed on the card's open flag AND on the store, so
    // it re-runs whenever the window hands it a new one — and the register speaks on
    // every move it makes, which for a card closing while another is still up is the
    // same `true` again. Without the guard each of those would re-render the rail,
    // the banner stack, and the whole route surface for a fact that did not move.
    const store = new FrameStore();
    let publishCount = 0;
    const unsubscribe = store.readable.subscribe(() => {
      publishCount += 1;
    });

    store.modalSurfaceClaims.release("a-card-that-never-opened");
    expect(publishCount).toBe(0);

    store.modalSurfaceClaims.hold("the-sign-in-card");
    store.modalSurfaceClaims.hold("the-onboarding-walkthrough");
    expect(publishCount).toBe(1);

    // The register republishes `true` here, and the cell must absorb it: the sign-in
    // card is still up, so nothing the frame renders has moved.
    store.modalSurfaceClaims.release("the-onboarding-walkthrough");
    expect(publishCount).toBe(1);

    unsubscribe();
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

describe("FrameStore — window focus is seeded from the window's own document", () => {
  it("opens unfocused where the document does not hold the keyboard", () => {
    // The defect: seeded `true`, this window never received a `blur` — it was never
    // focused to lose it — so every consumer read an audience that was not there.
    const store = underDocumentFocus(UNFOCUSED_DOCUMENT, () => new FrameStore());

    expect(store.getState().isWindowFocused).toBe(false);
  });

  it("opens unfocused where the document is not on screen at all", () => {
    // The second reading, and it is not the first one twice: a minimised window that
    // had focus when it went down reports hidden, and a shell that creates a window
    // without showing it reports hidden before anything is ever focused.
    const store = underDocumentFocus(HIDDEN_DOCUMENT, () => new FrameStore());

    expect(store.getState().isWindowFocused).toBe(false);
  });

  it("opens focused where the document is visible and holds the keyboard — the control", () => {
    const store = underDocumentFocus(FOCUSED_DOCUMENT, () => new FrameStore());

    expect(store.getState().isWindowFocused).toBe(true);
  });

  it("reads the document once, at construction, and not on every read", () => {
    // What makes this a SEED rather than a subscription: the frame's focus and blur
    // listeners are what move the cell afterwards, and a store that re-read the
    // document on every access would be a second answer free to disagree with them.
    const store = underDocumentFocus(UNFOCUSED_DOCUMENT, () => new FrameStore());

    store.setWindowFocused(true);

    expect(store.getState().isWindowFocused).toBe(true);
  });

  it("gives two windows built under different documents different answers", () => {
    // I-023-12: an auxiliary window shares no store with the main one, and each one's
    // document is the only thing that says whether anybody is looking at IT.
    const background = underDocumentFocus(UNFOCUSED_DOCUMENT, () => new FrameStore());
    const foreground = underDocumentFocus(FOCUSED_DOCUMENT, () => new FrameStore());

    expect(background.getState().isWindowFocused).toBe(false);
    expect(foreground.getState().isWindowFocused).toBe(true);
  });
});
