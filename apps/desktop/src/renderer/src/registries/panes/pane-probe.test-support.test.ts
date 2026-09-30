// The probe picker over both arms it can take. It is checked against hand-written claimed sets,
// since a picker that ignored claims or never ran out would pass a mostly empty board.

import { describe, expect, it } from "vitest";

import { PANE_KINDS, type PaneKind } from "@renderer/routing/panes/pane-kinds.js";
import { firstFreePaneKind, registerFreePaneKindProbe } from "./pane-probe.test-support.js";
import { PaneRegistry } from "./pane-registry.js";

/** The set's first three members, named by position. */
const [FIRST_KIND, SECOND_KIND, THIRD_KIND] = PANE_KINDS;

/** What the picker answers for a claimed set. */
interface PickerCase {
  readonly name: string;
  readonly claimed: readonly PaneKind[];
  readonly free: PaneKind | undefined;
}

const PICKER_CASES: readonly PickerCase[] = [
  { name: "nothing claimed", claimed: [], free: FIRST_KIND },
  { name: "the first two claimed", claimed: [FIRST_KIND, SECOND_KIND], free: THIRD_KIND },
  {
    name: "a claim out of declaration order",
    claimed: [SECOND_KIND, FIRST_KIND],
    free: THIRD_KIND,
  },
  { name: "every kind claimed", claimed: PANE_KINDS, free: undefined },
];

describe("pane probe — the kind a composition left free", () => {
  it.each(PICKER_CASES)("answers for $name", ({ claimed, free }) => {
    expect(firstFreePaneKind(claimed)).toBe(free);
  });

  it("negative control: the set it picks from is the closed one and is not empty", () => {
    // Over an empty set every case above would pass vacuously, since `find` answers `undefined`.
    expect(PANE_KINDS.length).toBeGreaterThan(1);
    expect(new Set(PANE_KINDS).size).toBe(PANE_KINDS.length);
  });
});

describe("pane probe — registering it", () => {
  it("puts a body on a free kind and reports which", () => {
    const registry = new PaneRegistry();

    const probed = registerFreePaneKindProbe(registry, "pane-probe.test");

    expect(probed).toBe(FIRST_KIND);
    expect(registry.registeredPaneKinds()).toStrictEqual([FIRST_KIND]);
  });

  it("skips the kinds a composition already claimed", () => {
    const registry = new PaneRegistry();
    registry.register({ kind: FIRST_KIND, owner: "composition", render: () => null });

    const probed = registerFreePaneKindProbe(registry, "pane-probe.test");

    expect(probed).toBe(SECOND_KIND);
    expect(registry.registeredPaneKinds()).toStrictEqual([FIRST_KIND, SECOND_KIND]);
  });

  it("registers nothing when the composition left no kind free", () => {
    // The probe reports it did nothing and must not unregister a body to make room.
    const registry = new PaneRegistry();
    for (const kind of PANE_KINDS) {
      registry.register({ kind, owner: "composition", render: () => null });
    }

    const probed = registerFreePaneKindProbe(registry, "pane-probe.test");

    expect(probed).toBeUndefined();
    expect(registry.registeredPaneKinds()).toStrictEqual([...PANE_KINDS]);
  });

  it("negative control: a fresh registry holds nothing on its own", () => {
    // Without it, a registry reporting a kind nobody registered would pass the first case.
    expect(new PaneRegistry().registeredPaneKinds()).toStrictEqual([]);
  });
});
