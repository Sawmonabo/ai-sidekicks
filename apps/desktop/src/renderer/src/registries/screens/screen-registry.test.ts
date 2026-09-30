// Which screen the frame mounts for each navigable address.

import { describe, expect, it } from "vitest";

import type { AppRoute } from "@renderer/routing/routes.js";
import { SCREEN_NAMES, findScreenNameForRoute } from "./screen-registry.js";

describe("screen registry — the screen a route mounts", () => {
  it("routes every navigable address to a declared screen name", () => {
    // Every screen name the route table can produce is one the registry knows.
    const routes: readonly AppRoute[] = [
      { kind: "sessions" },
      { kind: "session", sessionId: "s-1" },
      { kind: "workflows" },
      { kind: "settings", page: undefined },
      { kind: "pane-harness", paneKind: "terminal", sessionId: "s-1" },
    ];
    const screenNames = routes.map((route) => findScreenNameForRoute(route));
    expect(screenNames).toStrictEqual([
      "sessions",
      "session",
      "workflows",
      "settings",
      "pane-harness",
    ]);
    for (const screenName of screenNames) {
      expect(SCREEN_NAMES).toContain(screenName);
    }
  });
});
