// The family claims what it says it claims, and composes into the caller's registry.
//
// This is the one place the subtrees are visible as one family, so it is the place
// to assert the property the seat board depends on: two distinct slots, two
// distinct owners, and no reach for a module-scope singleton. A family that registered
// globally would leave a test's own registry empty while still "working" in a running
// window, which is exactly the failure the registry-as-parameter signature exists to
// prevent.

import { describe, expect, it } from "vitest";

import { registerSessionSurfacesFamily } from "./session-surfaces-family.js";
import { ConsoleSurfaceRegistry } from "./seats/index.js";

describe("session surfaces family — composition", () => {
  it("claims the two slots this family owns", () => {
    const surfaces = new ConsoleSurfaceRegistry();
    registerSessionSurfacesFamily(surfaces);
    expect(surfaces.registeredSlots()).toStrictEqual(["sessions", "settings"]);
  });

  it("claims each one under an owner of its own", () => {
    // Owner-scoped duplication is what turns a second claim into a conflict rather
    // than a swap. Two subtrees sharing one owner string would silently replace
    // each other instead.
    const surfaces = new ConsoleSurfaceRegistry();
    registerSessionSurfacesFamily(surfaces);
    const owners = surfaces
      .registeredSlots()
      .map((slot) => surfaces.descriptorFor(slot)?.owner ?? "");
    expect(new Set(owners).size).toBe(owners.length);
  });

  it("composes into the registry it is handed, not a singleton", () => {
    const first = new ConsoleSurfaceRegistry();
    const second = new ConsoleSurfaceRegistry();
    registerSessionSurfacesFamily(first);
    expect(second.registeredSlots()).toStrictEqual([]);
    registerSessionSurfacesFamily(second);
    expect(second.registeredSlots()).toStrictEqual(first.registeredSlots());
  });

  it("survives being composed twice, as a hot reload does it", () => {
    const surfaces = new ConsoleSurfaceRegistry();
    registerSessionSurfacesFamily(surfaces);
    const afterFirst = surfaces.registeredSlots();
    registerSessionSurfacesFamily(surfaces);
    expect(surfaces.registeredSlots()).toStrictEqual(afterFirst);
  });

  it("negative control: a fresh registry claims nothing on its own", () => {
    expect(new ConsoleSurfaceRegistry().registeredSlots()).toStrictEqual([]);
  });
});
