// The catalog reading two of this family's suites drive against.
//
// Hoisted on its second use rather than copied: `driver-catalog.test.ts` measures
// the selectors over it and `ProviderSwitch.test.tsx` measures which controls it
// produces, and two copies would eventually disagree about which driver declares
// what — which is the exact distinction both suites exist to hold.
//
// The flag record is TOTAL by construction, derived from the contract's own closed
// list, so a flag added upstream cannot leave a fixture silently missing a member.

import { DRIVER_CAPABILITY_FLAGS, type DriverCapabilityFlag } from "@ai-sidekicks/contracts";

import type { DriverCatalogReading } from "./driver-catalog.js";

/** Every capability flag `false` except the ones named. */
export function driverCapabilityFlags(
  declared: Partial<Record<DriverCapabilityFlag, boolean>>,
): Record<DriverCapabilityFlag, boolean> {
  const flags = {} as Record<DriverCapabilityFlag, boolean>;
  for (const flag of DRIVER_CAPABILITY_FLAGS) {
    flags[flag] = declared[flag] ?? false;
  }
  return flags;
}

/**
 * Two drivers that differ on exactly the axes the console branches on.
 *
 * `claude` declares model mutation AND an output-speed vocabulary; `codex` declares
 * model mutation and no speed axis at all. One model publishes an effort vocabulary
 * and its sibling publishes none, which is the per-model shape the wire actually has.
 */
export const DRIVER_CATALOG_FIXTURE: DriverCatalogReading = {
  models: {
    drivers: [
      {
        driverName: "claude",
        models: [
          { id: "claude-sonnet", name: "Sonnet", capabilities: [], effortLevels: ["low", "high"] },
          { id: "claude-haiku", name: "Haiku", capabilities: [] },
        ],
      },
      { driverName: "codex", models: [{ id: "gpt-5.6", name: "GPT", capabilities: [] }] },
    ],
  },
  capabilities: {
    drivers: [
      {
        driverName: "claude",
        capabilities: {
          flags: driverCapabilityFlags({ model_mutation: true, output_speed: true }),
          contractVersion: "1.0.0",
        },
        outputSpeedLevels: ["standard", "fast"],
      },
      {
        driverName: "codex",
        capabilities: {
          flags: driverCapabilityFlags({ model_mutation: true }),
          contractVersion: "1.0.0",
        },
      },
    ],
  },
};
