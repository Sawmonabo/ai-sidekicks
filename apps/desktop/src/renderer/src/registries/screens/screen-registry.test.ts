// The two doors into the screen registry, and the closed set behind both.
//
// `registerScreen` is the door a plan-owned subtree uses: those subtrees
// mount into the console and the console imports none of them, so the layering
// gate bans the import and this call is the whole channel. Nothing in the tree
// calls it yet because no such subtree has shipped — which makes it exactly the
// kind of contract that rots unexercised, and the reason it is driven here rather
// than left to its first caller to discover.
//
// The slot set is checked for the same reason its declaration was collapsed: a
// tuple and a union that agree today are two closed sets, and a test that reads
// the tuple is what keeps the agreement checkable at runtime rather than only at
// the one call site the compiler happens to visit.

import { describe, expect, it } from "vitest";

import { DuplicateRegistrationError } from "@renderer/lib/keyed-registry.js";
import type { AppRoute } from "@renderer/routing/routes.js";
import {
  SCREEN_NAMES,
  ScreenRegistry,
  screenRegistry,
  registerScreen,
  findScreenNameForRoute,
  type ScreenDescriptor,
} from "./screen-registry.js";

/** A descriptor whose render is never called: these cases are about the table. */
function descriptor(slot: ScreenDescriptor["slot"], owner: string): ScreenDescriptor {
  return { slot, owner, render: () => null };
}

describe("screen registry — the module-scope door", () => {
  it("claims a slot on the process-wide registry", () => {
    // `pane-harness` deliberately: only the fixture composition claims it, and this
    // case is about the door rather than about who got there first.
    try {
      registerScreen(descriptor("pane-harness", "screen-registry-test"));
      expect(screenRegistry.descriptorFor("pane-harness")?.owner).toBe("screen-registry-test");
      expect(screenRegistry.registeredSlots()).toContain("pane-harness");
    } finally {
      screenRegistry.unregister("pane-harness");
    }
  });

  it("negative control: the slot is absent once released", () => {
    // Without this the case above would pass against a registry that had been
    // holding the descriptor since some earlier file ran, and would keep passing
    // if `registerScreen` stopped registering anything at all.
    expect(screenRegistry.descriptorFor("pane-harness")).toBeUndefined();
    expect(screenRegistry.registeredSlots()).not.toContain("pane-harness");
  });
});

describe("screen registry — one owner per slot", () => {
  it("replaces when the same owner re-claims", () => {
    // A hot reload re-runs a family's module. Refusing that would make the
    // console unreloadable; silently keeping the FIRST would leave the window
    // rendering the pre-edit screen, which reads as an edit that did nothing.
    const registry = new ScreenRegistry();
    registry.register(descriptor("settings", "settings-family"));
    registry.register(descriptor("settings", "settings-family"));
    expect(registry.registeredSlots()).toStrictEqual(["settings"]);
  });

  it("refuses a second owner rather than swapping", () => {
    const registry = new ScreenRegistry();
    registry.register(descriptor("settings", "settings-family"));
    expect(() => {
      registry.register(descriptor("settings", "another-family"));
    }).toThrow(DuplicateRegistrationError);
  });
});

describe("screen registry — the slot set is one declaration", () => {
  it("reports slots in the declared order, and only registered ones", () => {
    const registry = new ScreenRegistry();
    // Registered back to front, so an implementation that reported insertion
    // order rather than declaration order would answer differently.
    registry.register(descriptor("settings", "third"));
    registry.register(descriptor("sessions", "first"));
    expect(registry.registeredSlots()).toStrictEqual(["sessions", "settings"]);
  });

  it("routes every navigable address to a declared slot", () => {
    // The union and the tuple are one declaration now, so this asserts the other
    // half: every slot the route table can produce is a slot the registry knows.
    const routes: readonly AppRoute[] = [
      { kind: "sessions" },
      { kind: "session", sessionId: "s-1" },
      { kind: "workflows" },
      { kind: "settings", page: undefined },
      { kind: "pane-harness", paneKind: "terminal", sessionId: "s-1" },
    ];
    const slots = routes.map((route) => findScreenNameForRoute(route));
    expect(slots).toStrictEqual(["sessions", "session", "workflows", "settings", "pane-harness"]);
    for (const slot of slots) {
      expect(SCREEN_NAMES).toContain(slot);
    }
  });

  it("negative control: a route that names nothing resolves to no slot", () => {
    // The loop above would be vacuous over an empty list and would pass over a
    // `findScreenNameForRoute` that answered `"sessions"` for everything, so the case
    // that must NOT produce a slot is asserted separately.
    expect(findScreenNameForRoute({ kind: "not-found", attempted: "#/nowhere" })).toBeUndefined();
    expect(SCREEN_NAMES).not.toContain("not-found");
  });
});
