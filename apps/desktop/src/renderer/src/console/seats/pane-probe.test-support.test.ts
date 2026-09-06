// The probe picker, proved over both arms it can take.
//
// The picker is the reason two composition suites can prove the pane-board seam
// without naming a pane kind, so what it answers has to be checked against the
// closed set rather than against today's board: a picker that ignored what was
// claimed and a picker that never ran out both pass a suite whose board is mostly
// empty, and both fail the day the families land. The table below drives the real
// helper over a claimed set written by hand, which is the only way either arm can
// be reached today.

import { describe, expect, it } from "vitest";

import { PANE_KINDS, type PaneKind } from "./pane-kinds.js";
import { firstFreePaneKind, registerFreePaneKindProbe } from "./pane-probe.test-support.js";
import { ConsolePaneRegistry } from "./pane-registry.js";

/** The set's own first and third members, named by position rather than by hand. */
const [FIRST_KIND, SECOND_KIND, THIRD_KIND] = PANE_KINDS;

/** One reading of the picker: what it answers for a claimed set. */
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
    // Every case above compares against a member of `PANE_KINDS`, so all of them
    // would pass vacuously over an empty set — `find` answers `undefined` and the
    // last case expects exactly that. This is what makes the other three mean
    // something.
    expect(PANE_KINDS.length).toBeGreaterThan(1);
    expect(new Set(PANE_KINDS).size).toBe(PANE_KINDS.length);
  });
});

describe("pane probe — registering it", () => {
  it("puts a body on a free kind and reports which", () => {
    const registry = new ConsolePaneRegistry();

    const probed = registerFreePaneKindProbe(registry, "pane-probe.test");

    expect(probed).toBe(FIRST_KIND);
    expect(registry.registeredPaneKinds()).toStrictEqual([FIRST_KIND]);
  });

  it("skips the kinds a composition already claimed", () => {
    const registry = new ConsolePaneRegistry();
    registry.register({ kind: FIRST_KIND, owner: "composition", render: () => null });

    const probed = registerFreePaneKindProbe(registry, "pane-probe.test");

    expect(probed).toBe(SECOND_KIND);
    expect(registry.registeredPaneKinds()).toStrictEqual([FIRST_KIND, SECOND_KIND]);
  });

  it("registers nothing when the composition left no kind free", () => {
    // The arm the board reaches once every family has landed. The probe reports
    // that it did nothing, and it must not have unregistered somebody's body to
    // make room for itself.
    const registry = new ConsolePaneRegistry();
    for (const kind of PANE_KINDS) {
      registry.register({ kind, owner: "composition", render: () => null });
    }

    const probed = registerFreePaneKindProbe(registry, "pane-probe.test");

    expect(probed).toBeUndefined();
    expect(registry.registeredPaneKinds()).toStrictEqual([...PANE_KINDS]);
  });

  it("negative control: a fresh registry holds nothing on its own", () => {
    // Without it, the first case would pass over a registry that reported a kind
    // nobody put in it, which is how a registration assertion goes vacuous.
    expect(new ConsolePaneRegistry().registeredPaneKinds()).toStrictEqual([]);
  });
});
