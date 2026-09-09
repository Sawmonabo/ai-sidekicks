// What composing the pane seat board DOES.
//
// The board's whole value is that six branches can each fill one seat without
// touching another's, which survives only while the file stays composition-only —
// a structure rule, and no part of what this file drives. What it drives is the
// composition itself: which registry the seats are written into, and which they
// are not.

import { describe, expect, it } from "vitest";

import { ConsolePaneRegistry, consolePaneRegistry } from "../seats/index.js";
import { registerFreePaneKindProbe } from "../seats/pane/pane-probe.test-support.js";
import { registerConsolePanes } from "./index.js";

describe("pane seat board — composing it today", () => {
  it("writes into the registry it was handed and into no singleton", () => {
    // The probe is what keeps this from being vacuous, and it is registered AFTER
    // the composition on a kind the composition left free — never before it on a
    // kind named here. A named kind is claimed twice the day the family that owns
    // it lands, and the closed set has no member left to name once all six have
    // landed.
    // On a board with every kind claimed the composition's own registrations are
    // the probe, which is the arm `seats/pane/pane-probe.test-support.test.ts` proves.
    const registry = new ConsolePaneRegistry();

    registerConsolePanes(registry);
    registerFreePaneKindProbe(registry, "panes-test");

    expect(registry.registeredPaneKinds().length).toBeGreaterThan(0);
    // THE DISCRIMINATING ASSERTION, AND THE ONE THE PROBE CANNOT MAKE. A probe put
    // straight into the owned board never travels through the composition, so a
    // board registrar that reached for the module-scope singleton would leave this
    // registry holding the probe alone — non-empty, and disjoint from a singleton
    // holding the seats' claims, which is to say green over the leak. What names it
    // is the production board being EXACTLY empty once a caller has composed its
    // own: no family registers into it at import time, by this board's own
    // contract, so anything in it after this line arrived through a composition
    // that ignored the registry it was handed.
    expect(consolePaneRegistry.registeredPaneKinds()).toStrictEqual([]);
  });

  it("survives being composed twice, as a hot reload does it", () => {
    const registry = new ConsolePaneRegistry();
    expect(() => {
      registerConsolePanes(registry);
      registerConsolePanes(registry);
    }).not.toThrow();
  });

  it("negative control: a fresh registry reports only what was put in it", () => {
    // Without it, the non-empty reading above could come from a
    // `registeredPaneKinds` that answered from somewhere other than the instance it
    // belongs to — the module-scope singleton, or a constant — and the emptiness
    // claim beside it would be reading that same wrong place.
    expect(new ConsolePaneRegistry().registeredPaneKinds()).toStrictEqual([]);
  });
});
