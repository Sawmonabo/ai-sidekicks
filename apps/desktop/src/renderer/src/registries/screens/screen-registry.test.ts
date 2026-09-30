// The screen registry's table and its closed set of screen names, checked at runtime through the
// tuple rather than only at the call sites the compiler visits.

import { describe, expect, it } from "vitest";

import { DuplicateRegistrationError } from "@renderer/lib/keyed-registry.js";
import type { AppRoute } from "@renderer/routing/routes.js";
import {
  SCREEN_NAMES,
  ScreenRegistry,
  findScreenNameForRoute,
  type ScreenDescriptor,
} from "./screen-registry.js";

/** A descriptor whose render is never called. */
function descriptor(name: ScreenDescriptor["name"], owner: string): ScreenDescriptor {
  return { name, owner, render: () => null };
}

describe("screen registry — one owner per screen name", () => {
  it("replaces when the same owner re-claims", () => {
    // A hot reload re-runs a feature's module; keeping the first screen would render a stale one.
    const registry = new ScreenRegistry();
    registry.register(descriptor("settings", "settings"));
    registry.register(descriptor("settings", "settings"));
    expect(registry.registeredScreenNames()).toStrictEqual(["settings"]);
  });

  it("refuses a second owner rather than swapping", () => {
    const registry = new ScreenRegistry();
    registry.register(descriptor("settings", "settings"));
    expect(() => {
      registry.register(descriptor("settings", "another-owner"));
    }).toThrow(DuplicateRegistrationError);
  });
});

describe("screen registry — the screen name set is one declaration", () => {
  it("reports screen names in the declared order, and only registered ones", () => {
    const registry = new ScreenRegistry();
    // Registered back to front, so insertion order would answer differently.
    registry.register(descriptor("settings", "third"));
    registry.register(descriptor("sessions", "first"));
    expect(registry.registeredScreenNames()).toStrictEqual(["sessions", "settings"]);
  });

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

  it("negative control: a route that names nothing resolves to no screen", () => {
    // The loop above would pass over a function that answered `"sessions"` for everything.
    expect(findScreenNameForRoute({ kind: "not-found", attempted: "#/nowhere" })).toBeUndefined();
    expect(SCREEN_NAMES).not.toContain("not-found");
  });
});
