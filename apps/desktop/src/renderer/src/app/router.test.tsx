// A route mounts the screen registered under its name.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { WindowStore } from "@renderer/store/window/window-store.js";
import { type AppRoute } from "@renderer/routing/routes.js";
import { AppRouter } from "./router.js";
import { screenRegistry } from "@renderer/registries/screens/screen-registry.js";
import { type ScreenContext } from "@renderer/registries/screens/screen-context.js";

/** The rail's middle destination, whose screen this suite claims for one case. */
const WORKFLOWS_ROUTE: AppRoute = { kind: "workflows" };

/**
 * The fields the route switch reads, and nothing else.
 *
 * The frame store is real; the rest of the context is cast away because constructing it opens a
 * database for a branch that never touches it.
 */
function contextFor(route: AppRoute): ScreenContext {
  return {
    route,
    frameStore: new WindowStore({ initialRoute: route }),
    sessionStore: undefined,
  } as unknown as ScreenContext;
}

describe("AppRouter — a registered screen", () => {
  afterEach(() => {
    cleanup();
  });

  it("mounts the screen its owner registered", () => {
    const owner = "router-test";
    try {
      screenRegistry.register({
        name: "workflows",
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
