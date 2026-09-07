// A bare auxiliary route offers what this window has and what the node reports,
// never a read in flight — and a reserved slot says so rather than painting nothing.
//
// The case this file exists for: `#/window/timeline` with no session id is the one
// route the context picker is FOR, and it is exactly the route on which the picker
// used to read its candidates off `context.sessionStore` — the store for the
// route's own session, which a bare route does not have. The picker therefore sat
// on "loading" forever and could never offer anything. A read in flight is a state
// the picker has again, and legitimately: the directory read is a real one and it
// SETTLES, which is the property the old defect lacked and the property these
// cases assert. The assertions are about the sources, so they drive a real
// `SessionStoreRegistry` with real sessions open in it and a real growth port
// rather than stand-ins that would agree with whatever the code did.
//
// The route whose grammar takes two identifiers, and the hash binding around it,
// are `RouteSurface.agent-console.test.tsx`.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { GrowthPort } from "../bridge/index.js";
import { createFixtureBridge } from "../bridge/index.js";
import { createRefusingGrowthPort } from "../bridge/growth-port/growth-port.js";
import { settle as settleReactWork } from "../core/settle.test-support.js";
import { FLAGSHIP_SCENARIO } from "../bridge/scenarios/flagship.js";
import { FrameStore, SessionStoreRegistry } from "../store/index.js";
import { type ConsoleRoute } from "../routing/index.js";
import { RouteSurface } from "./RouteSurface.js";
import { BARE_TIMELINE_ROUTE } from "./RouteSurface.test-support.js";
import { consoleSurfaceRegistry, type ConsoleSurfaceContext } from "../seats/index.js";
// The module-scope registration door by its own specifier: the seats door does not
// publish it, no production module calling it having landed yet.
import { registerConsoleSurface } from "../seats/surface-registry.js";

/** The rail's middle destination, whose slot this suite deliberately leaves unclaimed. */
const WORKFLOWS_ROUTE: ConsoleRoute = { kind: "workflows" };

/**
 * A registry with real sessions open, and a reader that answers nothing.
 *
 * The picker reads its candidates off the registry's open set and the directory
 * read, never a session snapshot, so a reader that answers `undefined` keeps these
 * cases about the two sources the picker actually consults.
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
  growth: GrowthPort = createRefusingGrowthPort(),
): { context: ConsoleSurfaceContext; frameStore: FrameStore } {
  const frameStore = new FrameStore({ initialRoute: route });
  const context = {
    route,
    // A REAL growth port, defaulting to the refusing one so a case that says
    // nothing about the directory gets the live bridge's answer rather than a
    // convenient one.
    bridge: { growth },
    frameStore,
    sessionStore: undefined,
    sessionStoreRegistry: registry,
  } as unknown as ConsoleSurfaceContext;
  return { context, frameStore };
}

/** The fixture's port, which serves the directory read the live bridge refuses. */
function fixtureGrowthPort(): GrowthPort {
  return createFixtureBridge({ scenario: FLAGSHIP_SCENARIO }).growth;
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

  it("never leaves a read in flight on screen, because the read it makes settles", async () => {
    // The defect this file was written for renders as the `not-loaded` kind of
    // nothing, whose block form is the only thing on this surface that carries
    // `aria-busy`, and it never went away. Asserting its absence AFTER the
    // directory read settles names that failure rather than forbidding a loading
    // state the surface is now entitled to show for one frame.
    const registry = registryWithOpenSessions();
    const { context } = contextFor(BARE_TIMELINE_ROUTE, registry);

    const { container } = render(<RouteSurface context={context} />);
    await settleReactWork();

    expect(container.querySelector("[aria-busy='true']")).toBeNull();
  });

  it("offers the node's sessions when the bridge serves the directory read", async () => {
    // The window has none open, so every row on screen came from the directory —
    // which is what the picker could not do at all before the read had a producer.
    const registry = registryWithOpenSessions();
    const { context } = contextFor(BARE_TIMELINE_ROUTE, registry, fixtureGrowthPort());

    render(<RouteSurface context={context} />);
    await settleReactWork();

    expect(screen.getByRole("button", { name: FLAGSHIP_SCENARIO.sessionId })).toBeDefined();
  });

  it("navigates the window to the session that was chosen", async () => {
    const registry = registryWithOpenSessions("session-alpha");
    const { context, frameStore } = contextFor(BARE_TIMELINE_ROUTE, registry);

    render(<RouteSurface context={context} />);
    screen.getByRole("button", { name: "session-alpha" }).click();
    // AWAITED, because the choice warms the chosen surface before it commits — the
    // window has nothing but the picker under it, so committing first would replace a
    // working control with a reserved frame. `RouteSurface.agent-console.test.tsx`
    // holds that claim; here the wait is only what makes the navigation observable.
    await settleReactWork();

    expect(frameStore.getState().route).toStrictEqual({
      kind: "auxiliary",
      route: "timeline",
      sessionId: "session-alpha",
    });
  });

  it("negative control: with nothing open and a refused directory it says so, and offers no session", async () => {
    // Without this, a picker that rendered every id it was ever handed — or one
    // that rendered a row per nothing — would satisfy the cases above. The wording
    // is the `not-checked` one on purpose: the console did not ask the node, and
    // reporting an empty node for a question never put is the conflation the five
    // kinds of nothing exist to prevent.
    const registry = registryWithOpenSessions();
    const { context } = contextFor(BARE_TIMELINE_ROUTE, registry);

    const { container } = render(<RouteSurface context={context} />);
    await settleReactWork();

    expect(screen.queryAllByRole("button")).toStrictEqual([]);
    expect(container.textContent).toContain("This window has no session open.");
    // The picker's absence renders as a badge, whose second line can only travel as
    // a tooltip — so the refusal is read off the attribute that actually carries it
    // rather than off text that was never going to be in the tree.
    expect(
      container.querySelector(".meridian-nothing__badge-label")?.getAttribute("title"),
    ).toContain("has not asked the node for the rest");
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
    // The rail's middle destination is reachable whether or not any family has
    // claimed its slot, and unclaimed is exactly the state "reserved, not stubbed" is
    // for: the frame names the slot and says nobody has built it, and the alternative
    // — an empty pane — reads as a feature that is broken rather than absent. Nothing
    // in this suite registers a family, so the frame is read over an empty board here
    // however the console composes one elsewhere.
    const { context } = contextFor(WORKFLOWS_ROUTE, registryWithOpenSessions());

    const { container } = render(<RouteSurface context={context} />);

    expect(container.querySelector(".meridian-surface-absence")).not.toBeNull();
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
      expect(container.querySelector(".meridian-surface-absence")).toBeNull();
    } finally {
      consoleSurfaceRegistry.unregister("workflows");
    }
  });
});
