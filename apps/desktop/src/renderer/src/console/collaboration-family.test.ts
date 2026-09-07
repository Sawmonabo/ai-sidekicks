// The family claims what it says it claims, and composes into the caller's registry.
//
// This is the one place the four subtrees are visible as one family, so it is the
// place to assert the property the seat board depends on: three distinct slots,
// three distinct owners, one claimed event kind, and no reach for a module-scope
// singleton. A family that registered globally would leave a test's own registry
// empty while still "working" in a running window, which is exactly the failure the
// registry-as-parameter signature exists to prevent.

import { describe, expect, it } from "vitest";

import { registerCollaborationFamily } from "./collaboration-family.js";
import { ConsoleSurfaceRegistry, SidebarSectionRegistry } from "./seats/index.js";
import { ConsoleEntityProjectorRegistry } from "./store/index.js";

/** The three boards this family writes into, all owned by the case that built them. */
function ownedBoards(): {
  readonly surfaces: ConsoleSurfaceRegistry;
  readonly sections: SidebarSectionRegistry;
  readonly projectors: ConsoleEntityProjectorRegistry;
} {
  return {
    surfaces: new ConsoleSurfaceRegistry(),
    sections: new SidebarSectionRegistry(),
    projectors: new ConsoleEntityProjectorRegistry(),
  };
}

describe("collaboration family — composition", () => {
  it("claims the three slots this family owns", () => {
    const { surfaces, sections, projectors } = ownedBoards();
    registerCollaborationFamily(surfaces, sections, projectors);
    expect(surfaces.registeredSlots()).toStrictEqual(["sessions", "settings", "agent-console"]);
  });

  it("passes the sidebar board down rather than dropping it", () => {
    // `families.test.ts` proves the process-wide board stays empty, which a family
    // that silently DISCARDED its board would also satisfy. This is the other half:
    // the board handed in comes back filled.
    const { surfaces, sections, projectors } = ownedBoards();
    registerCollaborationFamily(surfaces, sections, projectors);
    expect(sections.registeredSectionIds()).toStrictEqual(["channels", "members"]);
  });

  it("claims each one under an owner of its own", () => {
    // Owner-scoped duplication is what turns a second claim into a conflict rather
    // than a swap. Two subtrees sharing one owner string would silently replace
    // each other instead.
    const { surfaces, sections, projectors } = ownedBoards();
    registerCollaborationFamily(surfaces, sections, projectors);
    const owners = surfaces
      .registeredSlots()
      .map((slot) => surfaces.descriptorFor(slot)?.owner ?? "");
    expect(new Set(owners).size).toBe(owners.length);
  });

  it("composes into the registry it is handed, not a singleton", () => {
    const first = ownedBoards();
    const second = ownedBoards();
    registerCollaborationFamily(first.surfaces, first.sections, first.projectors);
    expect(second.surfaces.registeredSlots()).toStrictEqual([]);
    registerCollaborationFamily(second.surfaces, second.sections, second.projectors);
    expect(second.surfaces.registeredSlots()).toStrictEqual(first.surfaces.registeredSlots());
  });

  it("survives being composed twice, as a hot reload does it", () => {
    const { surfaces, sections, projectors } = ownedBoards();
    registerCollaborationFamily(surfaces, sections, projectors);
    const afterFirst = surfaces.registeredSlots();
    registerCollaborationFamily(surfaces, sections, projectors);
    expect(surfaces.registeredSlots()).toStrictEqual(afterFirst);
  });

  it("folds the one membership kind whose payload the contract declares", () => {
    // The fold is what lets this family read `membership.created` once. Without it
    // the roster, the typing indicators, the direct-channel labels and the membership
    // ledger each reach the wire for a fact the store already had — or, as they did,
    // render a raw participant id and an absent membership identifier instead.
    const { surfaces, sections, projectors } = ownedBoards();
    registerCollaborationFamily(surfaces, sections, projectors);
    expect(Object.keys(projectors.snapshot())).toStrictEqual(["membership.created"]);
  });

  it("negative control: a fresh registry claims nothing on its own", () => {
    expect(new ConsoleSurfaceRegistry().registeredSlots()).toStrictEqual([]);
    expect(Object.keys(new ConsoleEntityProjectorRegistry().snapshot())).toStrictEqual([]);
  });
});
