// A route mounts the surface registered for its slot.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { FrameStore } from "../../store/index.js";
import { type ConsoleRoute } from "../../routing/index.js";
import { RouteSurface } from "./RouteSurface.js";
import { consoleSurfaceRegistry, type ConsoleSurfaceContext } from "../../seats/index.js";
// The module-scope registration door by its own specifier: the seats door does not
// publish it, no production module calling it having landed yet.
import { registerConsoleSurface } from "../../seats/surface/surface-registry.js";

/** The rail's middle destination, whose slot this suite claims for one case. */
const WORKFLOWS_ROUTE: ConsoleRoute = { kind: "workflows" };

/**
 * The fields the route switch reads, and nothing else.
 *
 * The frame store is the real class, because it is the subject; the rest of the
 * context is cast away because constructing it opens a database to hand a branch that
 * never touches it — the same reason `frame/pane-harness/PaneHarnessSurface.test.tsx`
 * casts.
 */
function contextFor(route: ConsoleRoute): ConsoleSurfaceContext {
  return {
    route,
    frameStore: new FrameStore({ initialRoute: route }),
    sessionStore: undefined,
  } as unknown as ConsoleSurfaceContext;
}

describe("RouteSurface — a registered slot", () => {
  afterEach(() => {
    cleanup();
  });

  it("mounts the family that claims the slot", () => {
    const owner = "route-surface-test";
    try {
      registerConsoleSurface({
        slot: "workflows",
        owner,
        render: () => <p>the workflow builder rendered</p>,
      });
      const context = contextFor(WORKFLOWS_ROUTE);

      const { container } = render(<RouteSurface context={context} />);

      expect(container.textContent).toContain("the workflow builder rendered");
      expect(container.querySelector(".meridian-surface-absence")).toBeNull();
    } finally {
      consoleSurfaceRegistry.unregister("workflows");
    }
  });
});
