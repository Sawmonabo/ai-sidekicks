// Composition holds: every family that fills a seat gets a slot of its own.
//
// The seat board is edited by concurrent branches — that is the whole reason it
// exists — and the failure it invites is two families claiming one slot. The
// registry refuses that rather than letting module evaluation order pick a
// winner, so the conflict IS caught; the question is where. Without this file it
// surfaces at import time in a running window, as a blank console with a message
// in a devtools log nobody has open. With it, it surfaces in the unit tier, named
// by slot, before the branch merges.
//
// The assertions are deliberately about the SHAPE of the composition rather than
// about which families are in it. A test pinning today's occupants would have to
// be edited by every branch that adds a seat, which makes it a second seat board
// and reintroduces exactly the conflict the first one exists to avoid.

import { describe, expect, it } from "vitest";

import { registerConsoleFamilies } from "./families.js";
import { CONSOLE_SURFACE_SLOTS, ConsoleSurfaceRegistry } from "./frame/surface-registry.js";

describe("console families — composing every shipped family", () => {
  it("claims no slot twice", () => {
    // The registry throws `DuplicateRegistrationError` naming the slot when two
    // owners claim one, so "does not throw" is a real assertion here rather than
    // the absence of one: the raise is the mechanism being checked.
    const registry = new ConsoleSurfaceRegistry();
    expect(() => {
      registerConsoleFamilies(registry);
    }).not.toThrow();
  });

  it("claims at least one slot, and only declared ones", () => {
    const registry = new ConsoleSurfaceRegistry();
    registerConsoleFamilies(registry);
    const slots = registry.registeredSlots();
    // Non-empty, or "only declared ones" below is a claim about nothing and the
    // case passes over a composition root that silently registered no family.
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(CONSOLE_SURFACE_SLOTS).toContain(slot);
    }
  });

  it("composes into a registry the caller owns, not a singleton", () => {
    // The seat signature takes a registry so a test can compose into its own and
    // an auxiliary window can compose a subset. A registrar that reached for the
    // module-scope singleton would leave this one empty while still "working".
    const first = new ConsoleSurfaceRegistry();
    const second = new ConsoleSurfaceRegistry();
    registerConsoleFamilies(first);
    expect(second.registeredSlots()).toStrictEqual([]);
    registerConsoleFamilies(second);
    expect(second.registeredSlots()).toStrictEqual(first.registeredSlots());
  });

  it("survives being composed twice, as a hot reload does it", () => {
    // Same owners re-claiming the same slots: the owner-scoped policy replaces.
    // A family that changed its owner string between composes would raise here,
    // which is the correct answer — the owner is what the policy is about.
    const registry = new ConsoleSurfaceRegistry();
    registerConsoleFamilies(registry);
    const afterFirst = registry.registeredSlots();
    registerConsoleFamilies(registry);
    expect(registry.registeredSlots()).toStrictEqual(afterFirst);
  });

  it("negative control: a fresh registry claims nothing on its own", () => {
    // Every case above reads `registeredSlots`, and all of them would pass over a
    // registry that reported slots nobody registered.
    expect(new ConsoleSurfaceRegistry().registeredSlots()).toStrictEqual([]);
  });
});
