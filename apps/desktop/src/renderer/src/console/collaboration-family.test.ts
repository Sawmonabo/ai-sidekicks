// The family claims what it says it claims, and composes into the caller's registry.
//
// This is the one place the four subtrees are visible as one family, so it is the
// place to assert the property the seat board depends on: three distinct slots,
// three distinct owners, one claimed event kind, the frame-lifetime binding one of
// them keeps, and no reach for a module-scope singleton. A family that registered
// globally would leave a test's own registry empty while still "working" in a running
// window, which is exactly the failure the registry-as-parameter signature exists to
// prevent.

import { describe, expect, it } from "vitest";

import { registerCollaborationFamily } from "./collaboration-family.js";
import {
  ConsoleSurfaceRegistry,
  FrameBindingRegistry,
  SidebarSectionRegistry,
} from "./seats/index.js";
import type { SessionsSurfaceComposition } from "./sessions/index.js";
import { ConsoleEntityProjectorRegistry } from "./store/index.js";

/** The four boards this family writes into, all owned by the case that built them. */
function ownedBoards(): {
  readonly surfaces: ConsoleSurfaceRegistry;
  readonly sections: SidebarSectionRegistry;
  readonly projectors: ConsoleEntityProjectorRegistry;
  readonly bindings: FrameBindingRegistry;
} {
  return {
    surfaces: new ConsoleSurfaceRegistry(),
    sections: new SidebarSectionRegistry(),
    projectors: new ConsoleEntityProjectorRegistry(),
    bindings: new FrameBindingRegistry(),
  };
}

/**
 * The composed-session control, as a stand-in.
 *
 * The real one is the workspace family's, which this family may not import and this
 * test has no need of: every claim below is about which slots are claimed, under
 * which owners, on whose board. What the sessions destination does with the control
 * is asserted where that surface is rendered.
 */
const standInComposition: SessionsSurfaceComposition = { newSessionControl: () => null };

describe("collaboration family — composition", () => {
  it("claims the three slots this family owns", () => {
    const { surfaces, sections, projectors, bindings } = ownedBoards();
    registerCollaborationFamily(surfaces, sections, projectors, bindings, standInComposition);
    expect(surfaces.registeredSlots()).toStrictEqual(["sessions", "settings", "agent-console"]);
  });

  it("passes the sidebar board down rather than dropping it", () => {
    // `families.test.ts` proves the process-wide board stays empty, which a family
    // that silently DISCARDED its board would also satisfy. This is the other half:
    // the board handed in comes back filled.
    const { surfaces, sections, projectors, bindings } = ownedBoards();
    registerCollaborationFamily(surfaces, sections, projectors, bindings, standInComposition);
    // Three, not two: the `agents` section is this family's as well, and its body
    // lives in the agents subtree rather than in `collaboration/` because a body
    // belongs to the family whose vocabulary it renders. The ids come back in the
    // seat's own declared order rather than in registration order.
    expect(sections.registeredSectionIds()).toStrictEqual(["channels", "agents", "members"]);
  });

  it("claims each one under an owner of its own", () => {
    // Owner-scoped duplication is what turns a second claim into a conflict rather
    // than a swap. Two subtrees sharing one owner string would silently replace
    // each other instead.
    const { surfaces, sections, projectors, bindings } = ownedBoards();
    registerCollaborationFamily(surfaces, sections, projectors, bindings, standInComposition);
    const owners = surfaces
      .registeredSlots()
      .map((slot) => surfaces.descriptorFor(slot)?.owner ?? "");
    expect(new Set(owners).size).toBe(owners.length);
  });

  it("composes into the registry it is handed, not a singleton", () => {
    const first = ownedBoards();
    const second = ownedBoards();
    registerCollaborationFamily(
      first.surfaces,
      first.sections,
      first.projectors,
      first.bindings,
      standInComposition,
    );
    expect(second.surfaces.registeredSlots()).toStrictEqual([]);
    registerCollaborationFamily(
      second.surfaces,
      second.sections,
      second.projectors,
      second.bindings,
      standInComposition,
    );
    expect(second.surfaces.registeredSlots()).toStrictEqual(first.surfaces.registeredSlots());
  });

  it("survives being composed twice, as a hot reload does it", () => {
    const { surfaces, sections, projectors, bindings } = ownedBoards();
    registerCollaborationFamily(surfaces, sections, projectors, bindings, standInComposition);
    const afterFirst = surfaces.registeredSlots();
    registerCollaborationFamily(surfaces, sections, projectors, bindings, standInComposition);
    expect(surfaces.registeredSlots()).toStrictEqual(afterFirst);
  });

  it("folds all five membership kinds, so the store's membership state stays live", () => {
    // The admission fold is what lets this family read a person's handle, membership
    // identifier and role once instead of reaching the wire for a fact the store
    // already had. The four transitions are the other half, and the half that decides
    // whether a membership is still one the session can address: without them a
    // revoked member stays a direct-channel candidate and a roster row forever,
    // because nothing else in the window ever hears that the membership ended.
    const { surfaces, sections, projectors, bindings } = ownedBoards();
    registerCollaborationFamily(surfaces, sections, projectors, bindings, standInComposition);
    expect(Object.keys(projectors.snapshot())).toStrictEqual([
      "membership.created",
      "membership.role_changed",
      "membership.suspended",
      "membership.revoked",
      "membership.reactivated",
    ]);
  });

  it("passes the frame-binding board down rather than dropping it", () => {
    // The sidebar case's other half, on the board whose seats are not bodies. This
    // family owns the window's one attention read, and a registrar that took the board
    // and never wrote to it would leave the rail with no producer at all — which looks
    // exactly like a machine with nothing waiting on anyone.
    const { surfaces, sections, projectors, bindings } = ownedBoards();
    registerCollaborationFamily(surfaces, sections, projectors, bindings, standInComposition);
    expect(bindings.registeredSlots()).toStrictEqual(["session-attention"]);
  });

  it("negative control: a fresh registry claims nothing on its own", () => {
    expect(new ConsoleSurfaceRegistry().registeredSlots()).toStrictEqual([]);
    expect(Object.keys(new ConsoleEntityProjectorRegistry().snapshot())).toStrictEqual([]);
    expect(new FrameBindingRegistry().registeredSlots()).toStrictEqual([]);
  });
});
