// A bare auxiliary route offers what this window has, and never a read in flight —
// and a reserved slot says so rather than painting nothing.
//
// The case this file exists for: `#/window/timeline` with no session id is the one
// route the context picker is FOR, and it is exactly the route on which the picker
// used to read its candidates off `context.sessionStore` — the store for the
// route's own session, which a bare route does not have. The picker therefore sat
// on "loading" forever and could never offer anything. The assertions below are
// about the source, so they drive a real `SessionStoreRegistry` with real sessions
// open in it rather than a stand-in that would agree with whatever the code did.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { FrameStore, SessionStoreRegistry } from "../store/index.js";
import type { ConsoleRoute } from "../routing/index.js";
import { RouteSurface } from "./RouteSurface.js";
import {
  consoleSurfaceRegistry,
  registerConsoleSurface,
  type ConsoleSurfaceContext,
} from "./surface-registry.js";

/** The bare auxiliary address a Window-menu open lands on. */
const BARE_TIMELINE_ROUTE: ConsoleRoute = { kind: "auxiliary", route: "timeline" };

/** The rail's middle destination, whose family (T-023p-1C-6) ships separately. */
const WORKFLOWS_ROUTE: ConsoleRoute = { kind: "workflows" };

/**
 * A registry with real sessions open, and a reader that answers nothing.
 *
 * `undefined` is the reader the frame actually supplies — the console has no
 * session-read wire — so a test that supplied a snapshot would be asserting
 * against a console that does not exist.
 */
function registryWithOpenSessions(...sessionIds: readonly string[]): SessionStoreRegistry {
  const registry = new SessionStoreRegistry({ read: () => Promise.resolve(undefined) });
  for (const sessionId of sessionIds) {
    registry.open(sessionId);
  }
  return registry;
}

/**
 * The fields the picker branch reads, and nothing else.
 *
 * The frame store and the registry are the real classes, because they are the
 * subject; the two persistence stores are cast away because constructing them
 * opens a database to hand a branch that never touches them — the same reason
 * `legacy-surfaces.test.ts` casts.
 */
function contextFor(
  route: ConsoleRoute,
  registry: SessionStoreRegistry,
): { context: ConsoleSurfaceContext; frameStore: FrameStore } {
  const frameStore = new FrameStore({ initialRoute: route });
  const context = {
    route,
    frameStore,
    sessionStore: undefined,
    sessionStoreRegistry: registry,
  } as unknown as ConsoleSurfaceContext;
  return { context, frameStore };
}

describe("RouteSurface — the picker on a bare auxiliary route", () => {
  afterEach(() => {
    cleanup();
  });

  it("offers the sessions this window has open", () => {
    const registry = registryWithOpenSessions("session-alpha", "session-beta");
    const { context } = contextFor(BARE_TIMELINE_ROUTE, registry);

    render(<RouteSurface context={context} />);

    expect(screen.getByRole("button", { name: "session-alpha" })).toBeDefined();
    expect(screen.getByRole("button", { name: "session-beta" })).toBeDefined();
  });

  it("never renders a read in flight, because no read is in flight", () => {
    // The defect this file was written for renders as the `not-loaded` kind of
    // nothing, whose block form is the only thing on this surface that carries
    // `aria-busy`. Asserting its absence names the failure rather than merely
    // asserting the success beside it.
    const registry = registryWithOpenSessions("session-alpha");
    const { context } = contextFor(BARE_TIMELINE_ROUTE, registry);

    const { container } = render(<RouteSurface context={context} />);

    expect(container.querySelector("[aria-busy='true']")).toBeNull();
  });

  it("navigates the window to the session that was chosen", () => {
    const registry = registryWithOpenSessions("session-alpha");
    const { context, frameStore } = contextFor(BARE_TIMELINE_ROUTE, registry);

    render(<RouteSurface context={context} />);
    screen.getByRole("button", { name: "session-alpha" }).click();

    expect(frameStore.getState().route).toStrictEqual({
      kind: "auxiliary",
      route: "timeline",
      sessionId: "session-alpha",
    });
  });

  it("negative control: with nothing open it says so, and offers no session", () => {
    // Without this, a picker that rendered every id it was ever handed — or one
    // that rendered a row per nothing — would satisfy the cases above.
    const registry = registryWithOpenSessions();
    const { context } = contextFor(BARE_TIMELINE_ROUTE, registry);

    const { container } = render(<RouteSurface context={context} />);

    expect(screen.queryAllByRole("button")).toStrictEqual([]);
    expect(container.textContent).toContain("This window has no session open.");
    expect(container.querySelector("[aria-busy='true']")).toBeNull();
  });

  it("negative control: a route that names a session takes the opening arm instead", () => {
    // The picker branch is guarded on the route having no session, and a guard
    // that had stopped guarding would show the picker on every auxiliary route.
    const registry = registryWithOpenSessions("session-alpha");
    const { context } = contextFor(
      { kind: "auxiliary", route: "timeline", sessionId: "session-alpha" },
      registry,
    );

    const { container } = render(<RouteSurface context={context} />);

    expect(container.textContent).not.toContain("Which session should this timeline follow?");
  });
});

describe("RouteSurface — a declared slot with no registrant", () => {
  afterEach(() => {
    cleanup();
  });

  it("says the workflows surface is reserved rather than rendering nothing", () => {
    // The rail's middle destination is reachable before the family that fills it
    // has shipped, which is exactly the state "reserved, not stubbed" is for: the
    // frame names the slot and says nobody has built it, and the alternative — an
    // empty pane — reads as a feature that is broken rather than absent.
    const { context } = contextFor(WORKFLOWS_ROUTE, registryWithOpenSessions());

    const { container } = render(<RouteSurface context={context} />);

    expect(container.querySelector(".meridian-frame__absence")).not.toBeNull();
    expect(container.textContent).toContain("This surface has not been built yet.");
    expect(container.textContent).toContain("workflows");
    expect(container.querySelector("[aria-busy='true']")).toBeNull();
  });

  it("negative control: the same route mounts the family once one claims the slot", () => {
    // Without this, a frame that had stopped resolving the registry at all would
    // satisfy the case above by rendering the absence for every route forever.
    const owner = "route-surface-test";
    try {
      registerConsoleSurface({
        slot: "workflows",
        owner,
        render: () => <p>the workflow builder rendered</p>,
      });
      const { context } = contextFor(WORKFLOWS_ROUTE, registryWithOpenSessions());

      const { container } = render(<RouteSurface context={context} />);

      expect(container.textContent).toContain("the workflow builder rendered");
      expect(container.querySelector(".meridian-frame__absence")).toBeNull();
    } finally {
      consoleSurfaceRegistry.unregister("workflows");
    }
  });
});
