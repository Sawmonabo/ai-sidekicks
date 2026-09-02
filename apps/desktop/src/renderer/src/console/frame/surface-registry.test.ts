// The two doors into the surface registry, and the closed set behind both.
//
// `registerConsoleSurface` is the door a plan-owned subtree uses: those subtrees
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

import { DuplicateRegistrationError } from "../core/index.js";
import type { ConsoleRoute } from "../routing/index.js";
import {
  CONSOLE_SURFACE_SLOTS,
  ConsoleSurfaceRegistry,
  consoleSurfaceRegistry,
  registerConsoleSurface,
  surfaceSlotFor,
  type ConsoleSurfaceDescriptor,
} from "./surface-registry.js";

/** A descriptor whose render is never called: these cases are about the table. */
function descriptor(
  slot: ConsoleSurfaceDescriptor["slot"],
  owner: string,
): ConsoleSurfaceDescriptor {
  return { slot, owner, render: () => null };
}

describe("surface registry — the module-scope door", () => {
  it("claims a slot on the process-wide registry", () => {
    // `timeline` deliberately: the composition root claims `sessions`,
    // `workspace`, and `agent-console` for the shipped Tier-1 families at import
    // time, and this case is about the door rather than about who got there
    // first.
    try {
      registerConsoleSurface(descriptor("timeline", "surface-registry-test"));
      expect(consoleSurfaceRegistry.descriptorFor("timeline")?.owner).toBe("surface-registry-test");
      expect(consoleSurfaceRegistry.registeredSlots()).toContain("timeline");
    } finally {
      consoleSurfaceRegistry.unregister("timeline");
    }
  });

  it("negative control: the slot is absent once released", () => {
    // Without this the case above would pass against a registry that had been
    // holding the descriptor since some earlier file ran, and would keep passing
    // if `registerConsoleSurface` stopped registering anything at all.
    expect(consoleSurfaceRegistry.descriptorFor("timeline")).toBeUndefined();
    expect(consoleSurfaceRegistry.registeredSlots()).not.toContain("timeline");
  });
});

describe("surface registry — one owner per slot", () => {
  it("replaces when the same owner re-claims", () => {
    // A hot reload re-runs a family's module. Refusing that would make the
    // console unreloadable; silently keeping the FIRST would leave the window
    // rendering the pre-edit surface, which reads as an edit that did nothing.
    const registry = new ConsoleSurfaceRegistry();
    registry.register(descriptor("settings", "settings-family"));
    registry.register(descriptor("settings", "settings-family"));
    expect(registry.registeredSlots()).toStrictEqual(["settings"]);
  });

  it("refuses a second owner rather than swapping", () => {
    const registry = new ConsoleSurfaceRegistry();
    registry.register(descriptor("settings", "settings-family"));
    expect(() => {
      registry.register(descriptor("settings", "another-family"));
    }).toThrow(DuplicateRegistrationError);
  });
});

describe("surface registry — the slot set is one declaration", () => {
  it("reports slots in the declared order, and only registered ones", () => {
    const registry = new ConsoleSurfaceRegistry();
    // Registered back to front, so an implementation that reported insertion
    // order rather than declaration order would answer differently.
    registry.register(descriptor("settings", "third"));
    registry.register(descriptor("sessions", "first"));
    expect(registry.registeredSlots()).toStrictEqual(["sessions", "settings"]);
  });

  it("routes every navigable address to a declared slot", () => {
    // The union and the tuple are one declaration now, so this asserts the other
    // half: every slot the route table can produce is a slot the registry knows.
    const routes: readonly ConsoleRoute[] = [
      { kind: "sessions" },
      { kind: "workspace", sessionId: "s-1" },
      { kind: "workflows" },
      { kind: "settings", page: undefined },
      { kind: "auxiliary", route: "timeline" },
      { kind: "auxiliary", route: "agent-console", sessionId: "s-1", agentId: "a-1" },
    ];
    const slots = routes.map((route) => surfaceSlotFor(route));
    expect(slots).toStrictEqual([
      "sessions",
      "workspace",
      "workflows",
      "settings",
      "timeline",
      "agent-console",
    ]);
    for (const slot of slots) {
      expect(CONSOLE_SURFACE_SLOTS).toContain(slot);
    }
  });

  it("negative control: a route that names nothing resolves to no slot", () => {
    // The loop above would be vacuous over an empty list and would pass over a
    // `surfaceSlotFor` that answered `"sessions"` for everything, so the case
    // that must NOT produce a slot is asserted separately.
    expect(surfaceSlotFor({ kind: "not-found", attempted: "#/nowhere" })).toBeUndefined();
    expect(CONSOLE_SURFACE_SLOTS).not.toContain("not-found");
  });
});
