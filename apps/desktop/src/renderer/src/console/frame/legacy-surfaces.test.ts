// The slot table the shipped Tier-1 families used to hold, now empty — asserted.
//
// A registrar that registers nothing reads exactly like a registrar nobody calls, and
// the difference is this file's whole claim: every slot this table held is claimed by
// a console-authored family through its own door — `sessions` by the sessions
// family's list, `agent-console` by the agents family's console, `workspace` by the
// ledger's workspace — and the registry refuses a second owner on one slot, so a row
// here would be a composition conflict rather than a fallback.
//
// `seats/absorbed-surfaces.test.ts` covers the mounts those console surfaces make and
// the bridge-source guard they carry. What was left here was the TABLE, and the table
// is empty.

import { describe, expect, it } from "vitest";

import { registerLegacySurfaces } from "./legacy-surfaces.js";
import { ConsoleSurfaceRegistry } from "../seats/index.js";

function registeredLegacySurfaces(): ConsoleSurfaceRegistry {
  const registry = new ConsoleSurfaceRegistry();
  registerLegacySurfaces(registry);
  return registry;
}

describe("legacy surfaces — which family holds which slot", () => {
  it("claims nothing: every slot it held has a console-authored owner now", () => {
    expect(registeredLegacySurfaces().registeredSlots()).toStrictEqual([]);
  });

  it("negative control: a claim this registrar did not make is still visible here", () => {
    // Without this the case above passes over a registrar that was never called at
    // all, which is the failure it exists to catch: the assertion is that this
    // registrar adds nothing to a registry, not that the registry is always empty.
    const registry = new ConsoleSurfaceRegistry();
    registry.register({ slot: "sessions", owner: "a-family", render: () => null });
    registerLegacySurfaces(registry);
    const claims = registry
      .registeredSlots()
      .map((slot) => [slot, registry.descriptorFor(slot)?.owner]);
    expect(claims).toStrictEqual([["sessions", "a-family"]]);
  });
});
