// The family claims what it says it claims, and composes into the caller's registry.
//
// This is the one place the four subtrees are visible as one family, so it is the
// place to assert the property the seat board depends on: three distinct slots,
// three distinct owners, and no reach for the module-scope singleton. A family that
// registered globally would leave a test's own registry empty while still "working"
// in a running window, which is exactly the failure the registry-as-parameter
// signature exists to prevent.

import { describe, expect, it } from "vitest";

import { registerCollaborationFamily } from "./index.js";
import { ConsoleSurfaceRegistry } from "../frame/surface-registry.js";

describe("collaboration family — composition", () => {
  it("claims the three slots this family owns", () => {
    const registry = new ConsoleSurfaceRegistry();
    registerCollaborationFamily(registry);
    expect(registry.registeredSlots()).toStrictEqual(["sessions", "settings", "agent-console"]);
  });

  it("claims each one under an owner of its own", () => {
    // Owner-scoped duplication is what turns a second claim into a conflict rather
    // than a swap. Two subtrees sharing one owner string would silently replace
    // each other instead.
    const registry = new ConsoleSurfaceRegistry();
    registerCollaborationFamily(registry);
    const owners = registry
      .registeredSlots()
      .map((slot) => registry.descriptorFor(slot)?.owner ?? "");
    expect(new Set(owners).size).toBe(owners.length);
  });

  it("composes into the registry it is handed, not a singleton", () => {
    const first = new ConsoleSurfaceRegistry();
    const second = new ConsoleSurfaceRegistry();
    registerCollaborationFamily(first);
    expect(second.registeredSlots()).toStrictEqual([]);
    registerCollaborationFamily(second);
    expect(second.registeredSlots()).toStrictEqual(first.registeredSlots());
  });

  it("survives being composed twice, as a hot reload does it", () => {
    const registry = new ConsoleSurfaceRegistry();
    registerCollaborationFamily(registry);
    const afterFirst = registry.registeredSlots();
    registerCollaborationFamily(registry);
    expect(registry.registeredSlots()).toStrictEqual(afterFirst);
  });

  it("negative control: a fresh registry claims nothing on its own", () => {
    expect(new ConsoleSurfaceRegistry().registeredSlots()).toStrictEqual([]);
  });
});
