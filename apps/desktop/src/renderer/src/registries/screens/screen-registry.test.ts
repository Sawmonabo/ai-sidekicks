// The screen registry's table, and the closed set of screen names behind it.
//
// The name set is checked for the same reason its declaration was collapsed: a
// tuple and a union that agree today are two closed sets, and a test that reads
// the tuple is what keeps the agreement checkable at runtime rather than only at
// the one call site the compiler happens to visit.

import { describe, expect, it } from "vitest";

import { DuplicateRegistrationError } from "@renderer/lib/keyed-registry.js";
import type { AppRoute } from "@renderer/routing/routes.js";
import {
  SCREEN_NAMES,
  ScreenRegistry,
  findScreenNameForRoute,
  type ScreenDescriptor,
} from "./screen-registry.js";

/** A descriptor whose render is never called: these cases are about the table. */
function descriptor(name: ScreenDescriptor["name"], owner: string): ScreenDescriptor {
  return { name, owner, render: () => null };
}

describe("screen registry — one owner per screen name", () => {
  it("replaces when the same owner re-claims", () => {
    // A hot reload re-runs a feature's module. Refusing that would make the
    // console unreloadable; silently keeping the FIRST would leave the window
    // rendering the pre-edit screen, which reads as an edit that did nothing.
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
    // Registered back to front, so an implementation that reported insertion
    // order rather than declaration order would answer differently.
    registry.register(descriptor("settings", "third"));
    registry.register(descriptor("sessions", "first"));
    expect(registry.registeredScreenNames()).toStrictEqual(["sessions", "settings"]);
  });

  it("routes every navigable address to a declared screen name", () => {
    // The union and the tuple are one declaration now, so this asserts the other
    // half: every screen name the route table can produce is one the registry knows.
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
    // The loop above would be vacuous over an empty list and would pass over a
    // `findScreenNameForRoute` that answered `"sessions"` for everything, so the case
    // that must NOT produce a screen name is asserted separately.
    expect(findScreenNameForRoute({ kind: "not-found", attempted: "#/nowhere" })).toBeUndefined();
    expect(SCREEN_NAMES).not.toContain("not-found");
  });
});
