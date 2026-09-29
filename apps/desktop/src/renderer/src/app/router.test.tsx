// A route mounts the surface registered for its slot.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { WindowStore } from "@renderer/store/window/window-store.js";
import { type AppRoute } from "@renderer/routing/routes.js";
import { AppRouter } from "./router.js";
import { screenRegistry, type ScreenContext } from "@renderer/console/seats/index.js";
// The module-scope registration door by its own specifier: the seats door does not
// publish it, no production module calling it having landed yet.
import { registerScreen } from "@renderer/registries/screens/screen-registry.js";

/** The rail's middle destination, whose slot this suite claims for one case. */
const WORKFLOWS_ROUTE: AppRoute = { kind: "workflows" };

/**
 * The fields the route switch reads, and nothing else.
 *
 * The frame store is the real class, because it is the subject; the rest of the
 * context is cast away because constructing it opens a database to hand a branch that
 * never touches it — the same reason `app/pane-harness/PaneHarnessScreen.test.tsx`
 * casts.
 */
function contextFor(route: AppRoute): ScreenContext {
  return {
    route,
    frameStore: new WindowStore({ initialRoute: route }),
    sessionStore: undefined,
  } as unknown as ScreenContext;
}

describe("AppRouter — a registered slot", () => {
  afterEach(() => {
    cleanup();
  });

  it("mounts the family that claims the slot", () => {
    const owner = "route-surface-test";
    try {
      registerScreen({
        slot: "workflows",
        owner,
        render: () => <p>the workflow builder rendered</p>,
      });
      const context = contextFor(WORKFLOWS_ROUTE);

      const { container } = render(<AppRouter context={context} />);

      expect(container.textContent).toContain("the workflow builder rendered");
      expect(container.querySelector(".meridian-screen-notice")).toBeNull();
    } finally {
      screenRegistry.unregister("workflows");
    }
  });
});
